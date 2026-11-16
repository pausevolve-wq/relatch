// Anonymous trial, hybrid plan (Manas, 2026-11-15). The free skill is still generated in full, but an
// anonymous caller only ever RECEIVES a preview: the skill's header and its first sections in full, then the
// remaining section headings only. The full text waits in Redis for 24 hours under a random claim id; once the
// visitor signs up or logs in, /api/claim hands it to that account (and records the conversion).
//
// Why: recognising a returning visitor across browsers and VPNs is not possible client-side (measured
// 2026-11-15, vault + memory `relatch-anon-trial-recognition-stress-test`). Gating the VALUE instead makes a
// repeat trial worthless: another browser only gets another preview.
//
// Off until ANON_PREVIEW_ONLY=on. The current production frontend (App.tsx) has no unlock step, so turning this
// on before V3 takes "/" would leave anonymous visitors with a preview and no way to get the rest.
const crypto = require('crypto');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_TTL = 24 * 3600;
/** Per-account conversion record: 90 days (Manas, 2026-11-15). Daily counters hold no personal data: 400 days. */
const CONV_TTL = 90 * 86400;
const DAY_TTL = 400 * 86400;
/** Sections shown in full; and never more than this share of the body, whatever the shape of the skill */
const PREVIEW_SECTIONS = 2;
const PREVIEW_MAX_SHARE = 0.4;
/** A run is at most 5 enrich calls (ANON_MAX_ENRICH_CALLS); a little slack, never unbounded */
const MAX_ITEMS = 10;
const LOCKED_NOTE = '> The rest of this skill unlocks when you create a free account.';

const previewOn = () => process.env.ANON_PREVIEW_ONLY === 'on';

/** Splits a skill into its YAML header (if any) and body */
function splitHeader(text) {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { header: '', body: text };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { header: '', body: text };
  const close = text.indexOf('\n', end + 4);
  const cut = close === -1 ? text.length : close + 1;
  return { header: text.slice(0, cut), body: text.slice(cut) };
}

/**
 * The preview an anonymous caller receives. Sections are `## ` headings outside code fences.
 * Returns the preview text and the counts the app shows ("9 sections").
 */
function previewOf(text) {
  const full = typeof text === 'string' ? text : '';
  const { header, body } = splitHeader(full);
  const lines = body.split('\n');
  const heads = [];
  let fence = null;
  lines.forEach((line, i) => {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { fence = fence === f[1] ? null : fence ?? f[1]; return; }
    if (!fence && /^##\s+\S/.test(line)) heads.push(i);
  });
  const limit = Math.floor(body.length * PREVIEW_MAX_SHARE);
  let kept;
  let rest = [];
  if (heads.length > PREVIEW_SECTIONS) {
    kept = lines.slice(0, heads[PREVIEW_SECTIONS]).join('\n');
    rest = heads.slice(PREVIEW_SECTIONS).map((i) => lines[i]);
  } else {
    kept = body;
  }
  // Whatever the shape (few headings, one huge section), never more than the share above
  if (kept.length > limit) {
    const at = kept.lastIndexOf('\n', limit);
    kept = kept.slice(0, at > 0 ? at : limit);
  }
  const preview = `${header}${kept.trimEnd()}\n\n${LOCKED_NOTE}\n${rest.length ? `\n${rest.join('\n\n')}\n` : ''}`;
  return { preview, sections: heads.length, lockedSections: rest.length };
}

/**
 * Keeps the full skill for this trial token's claim (one claim id per token, every file of the run under it).
 * Returns the claim id, or null when Redis failed (then the visitor still gets the preview, never the full text).
 */
async function holdForClaim(redis, anonToken, item) {
  if (!redis || !UUID_V4.test(String(anonToken))) return null;
  try {
    const claimKey = `anon:${anonToken}:claim`;
    await redis.set(claimKey, crypto.randomUUID(), { nx: true, ex: CLAIM_TTL });
    const claimId = await redis.get(claimKey);
    if (!UUID_V4.test(String(claimId))) return null;
    const listKey = `claim:${claimId}:items`;
    await redis.rpush(listKey, JSON.stringify(item));
    await redis.ltrim(listKey, -MAX_ITEMS, -1);
    await redis.expire(listKey, CLAIM_TTL);
    return claimId;
  } catch (err) {
    console.error('[anon-claim] hold failed:', err?.message || err);
    return null;
  }
}

/** The anonymous version of a successful enrich body: preview text, plus what the app needs to unlock it */
async function anonBody(redis, anonToken, body, target) {
  const { preview, sections, lockedSections } = previewOf(body.enriched);
  const claimId = await holdForClaim(redis, anonToken, { enriched: body.enriched, target, model: body.model || null, at: Date.now() });
  return { ...body, enriched: preview, preview: { claimId, sections, lockedSections } };
}

const ENUMS = {
  mode: ['signup', 'login'],
  method: ['google', 'github', 'email_code', 'password'],
  action: ['download', 'copy', 'read'],
};
/** A client-sent label, only ever one of the known values: these become hash fields */
const label = (kind, v) => (ENUMS[kind].includes(v) ? v : 'unknown');

const parseItem = (x) => {
  if (x && typeof x === 'object') return x;
  try { return JSON.parse(x); } catch { return null; }
};

/**
 * Hands a held skill to a signed-in account. First claim wins the claim id for that account; the same account
 * may claim again (a reload) without being counted twice. Records the conversion on the first claim only.
 * Returns { status, body }.
 */
async function claim(redis, { claimId, userId, mode, method, action }) {
  if (!UUID_V4.test(String(claimId))) return { status: 400, body: { error: 'INVALID_CLAIM_ID' } };
  const items = (await redis.lrange(`claim:${claimId}:items`, 0, -1)).map(parseItem).filter((i) => i && typeof i.enriched === 'string');
  if (!items.length) return { status: 404, body: { error: 'CLAIM_NOT_FOUND' } };
  const ownerKey = `claim:${claimId}:owner`;
  const owner = await redis.get(ownerKey);
  if (owner === userId) return { status: 200, body: { claimId, items: items.map(({ enriched, target, model }) => ({ enriched, target, model })) } };
  if (owner) return { status: 409, body: { error: 'CLAIM_TAKEN' } };
  // ONE free claim per account, ever (found 2026-11-15 in the adversarial pass): a claim does not use the daily
  // allowance, so without this one account could sign out, run anonymous trials and claim each of them -
  // unlimited free skills past the 3 a day. A reload of the SAME claim stays fine (owner check above).
  const onceKey = `anonconv:claimed:${userId}`;
  const once = (await redis.set(onceKey, claimId, { nx: true, ex: DAY_TTL })) === 'OK';
  if (!once && (await redis.get(onceKey)) !== claimId) return { status: 429, body: { error: 'CLAIM_LIMIT' } };
  const first = (await redis.set(ownerKey, userId, { nx: true, ex: CLAIM_TTL })) === 'OK';
  if (!first && (await redis.get(ownerKey)) !== userId) return { status: 409, body: { error: 'CLAIM_TAKEN' } };
  if (first) await record(redis, { claimId, userId, mode, method, action, agent: items[0].target, skills: items.length });
  return { status: 200, body: { claimId, items: items.map(({ enriched, target, model }) => ({ enriched, target, model })) } };
}

/** The Upstash record of a visitor who signed up or logged in through the unlock sheet. Never fails a claim. */
async function record(redis, { claimId, userId, mode, method, action, agent, skills }) {
  try {
    const now = new Date();
    const m = label('mode', mode);
    const userKey = `anonconv:user:${userId}`;
    await redis.hset(userKey, { claimedAt: now.toISOString(), mode: m, method: label('method', method), action: label('action', action), agent: ['claude', 'codex', 'agents'].includes(agent) ? agent : 'unknown', claimId, skills });
    await redis.expire(userKey, CONV_TTL);
    const dayKey = `anonconv:day:${now.toISOString().slice(0, 10)}`;
    await redis.hincrby(dayKey, 'claims', 1);
    await redis.hincrby(dayKey, `mode:${m}`, 1);
    await redis.hincrby(dayKey, `method:${label('method', method)}`, 1);
    await redis.expire(dayKey, DAY_TTL);
  } catch (err) {
    console.error('[anon-claim] record failed:', err?.message || err);
  }
}

module.exports = { previewOn, previewOf, holdForClaim, anonBody, claim, record, UUID_V4, CLAIM_TTL, CONV_TTL };
