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
const { periodKeys, withTimeout, toCount, DAY_LIMIT, WEEK_LIMIT, DAY_KEY_TTL, WEEK_KEY_TTL } = require('./usage-limits');

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

// 2026-11-19 (Manas): an unlocked skill counts against the account's allowance. The trial ran on paid models,
// so a full skill delivered to an account is one of that account's 3 a day, however it was made: a new account
// gets 3 on its first day, not the free try plus 3. One claim costs ONE run credit (the same unit as a signed-in
// upload of up to 3 files), from the same usage:v1 day/week counters reserveRun uses (lib/usage-limits.js).
//
// Every check and every write happens in this one script, so a claim racing a run (or a second tab claiming)
// cannot pass the limit or be charged twice:
//   KEYS[1] claim owner   KEYS[2] the account's one-free-claim marker   KEYS[3] day counter   KEYS[4] week counter
//   ARGV[1] userId  ARGV[2] claimId  ARGV[3] day limit  ARGV[4] week limit  ARGV[5] day TTL  ARGV[6] week TTL
//   ARGV[7] claim TTL  ARGV[8] marker TTL
// Returns { code, day count, week count }. code: 0 a reload by the owner (already paid, not charged again),
// 1 claimed now and charged, 2 taken by another account, 3 this account's one claim is used, 4 daily allowance
// used, 5 weekly allowance used. On 2-5 nothing is written: the skill stays held for its 24 hours, so an account
// at 3 of 3 can still unlock it after the 00:00 UTC reset.
const CLAIM_SCRIPT = `
local owner = redis.call('GET', KEYS[1])
local day = tonumber(redis.call('GET', KEYS[3]) or '0')
local week = tonumber(redis.call('GET', KEYS[4]) or '0')
if owner == ARGV[1] then return {0, day, week} end
if owner then return {2, day, week} end
local once = redis.call('GET', KEYS[2])
if once and once ~= ARGV[2] then return {3, day, week} end
if day >= tonumber(ARGV[3]) then return {4, day, week} end
if week >= tonumber(ARGV[4]) then return {5, day, week} end
redis.call('SET', KEYS[3], day + 1, 'EX', ARGV[5])
redis.call('SET', KEYS[4], week + 1, 'EX', ARGV[6])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[7])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[8])
return {1, day + 1, week + 1}
`;

/**
 * Hands a held skill to a signed-in account. First claim wins the claim id for that account and costs one run
 * credit; the same account may claim again (a reload) without being charged or counted twice. Records the
 * conversion on the first claim only. Returns { status, body, quota? }; quota is { limitType, dailyCount,
 * weeklyCount } when the allowance refused it (api/claim.js turns that into the usual QUOTA_REACHED body).
 */
async function claim(redis, { claimId, userId, mode, method, action }, now = new Date()) {
  if (!UUID_V4.test(String(claimId))) return { status: 400, body: { error: 'INVALID_CLAIM_ID' } };
  if (!userId) throw new Error('missing userId');
  const items = (await redis.lrange(`claim:${claimId}:items`, 0, -1)).map(parseItem).filter((i) => i && typeof i.enriched === 'string');
  if (!items.length) return { status: 404, body: { error: 'CLAIM_NOT_FOUND' } };
  // ONE free claim per account, ever (found 2026-11-15 in the adversarial pass): kept now that a claim also costs a
  // credit (Manas's brief, 2026-11-19: it stops repeat farming of free tries). A reload of the SAME claim stays fine.
  const { day, week } = periodKeys(now);
  const reply = await withTimeout(redis.eval(CLAIM_SCRIPT, [
    `claim:${claimId}:owner`,
    `anonconv:claimed:${userId}`,
    `usage:v1:${userId}:day:${day}`,
    `usage:v1:${userId}:week:${week}`,
  ], [userId, claimId, DAY_LIMIT, WEEK_LIMIT, DAY_KEY_TTL, WEEK_KEY_TTL, CLAIM_TTL, DAY_TTL]));
  const values = Array.isArray(reply) && reply.length === 3 ? reply.map(toCount) : null;
  if (!values || values.includes(null) || values[0] > 5) throw new Error('unexpected claim store reply');
  const [code, dailyCount, weeklyCount] = values;
  if (code === 2) return { status: 409, body: { error: 'CLAIM_TAKEN' } };
  if (code === 3) return { status: 429, body: { error: 'CLAIM_LIMIT' } };
  if (code === 4 || code === 5) return { status: 429, body: { error: 'QUOTA_REACHED' }, quota: { limitType: code === 5 ? 'weekly' : 'daily', dailyCount, weeklyCount } };
  if (code === 1) await record(redis, { claimId, userId, mode, method, action, agent: items[0].target, skills: items.length });
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
