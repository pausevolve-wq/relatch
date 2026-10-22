// Atomic, fail-closed reservations BEFORE provider work. Failed attempts remain counted.
// Redis is authoritative; Clerk metadata is used only to seed existing period usage.
//
// One shared allowance covers a whole run (approved product policy, 2026-10-22): the
// first call of an upload batch - an OCR preprocessing call or the generation call
// itself - reserves ONE credit from the signed-in 5/day + 35/week generation
// allowance. Every later call carrying the same batch sessionId (OCR and generation
// calls alike, up to each endpoint's per-session attempt cap) belongs to that same
// paid run and is never charged again, so a scanned document never costs two credits.
// A run whose attempt budget is spent is DENIED without silently buying a second
// credit; a genuinely new batch arrives with a new sessionId. Scripted OCR without
// generation is bounded by the same shared allowance - OCR has no separate budget.
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
// KEYS[1] daily counter, KEYS[2] weekly counter, KEYS[3] this endpoint's per-session
// attempt counter, KEYS[4] the run claim shared by every endpoint in the batch,
// KEYS[5] the run tombstone recording that this batch already consumed its credit.
// Redis executes the whole script atomically, so the claim check, the cap check and
// the counter write cannot interleave with another call or with key expiry.
//
// Uncharged path (live claim, attempts left): the endpoint counter is written with
// the claim's REMAINING lifetime, so every key of the run shares one absolute
// deadline - a late-arriving call of the other endpoint can never create a counter
// that outlives the claim and skips reservation logic later.
//
// Run exhausted (live claim, attempt cap reached): deny WITHOUT charging - a credit
// is never silently spent twice on one batch.
//
// Claim gone but tombstone present (window expired, day rolled over, or a replayed
// sessionId): deny WITHOUT charging. One batch is one credit, full stop - there is
// no automatic repurchase on timeout or expiry. A genuinely new upload always
// carries a new sessionId (App.tsx handleFiles mints one per explicit upload
// action) and charges below, bounded by the daily/weekly allowance.
//
// New run (no claim, no tombstone): enforce the daily/weekly allowance, then charge
// one credit, start the claim and write the tombstone. The 1800s claim window sits
// comfortably above the worst-case batch (60s OCR function cap + 300s generation
// function cap plus margin); the tombstone lives 24h so a batch that crosses the
// window or the UTC day boundary is still recognized as already-paid.
const RESERVE = `
local day = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
local week = tonumber(redis.call('GET', KEYS[2]) or ARGV[2])
local calls = tonumber(redis.call('GET', KEYS[3]) or '0')
local run = redis.call('GET', KEYS[4])
if run then
  if calls < tonumber(ARGV[5]) then
    local ttl = redis.call('PTTL', KEYS[4])
    if ttl < 1 then ttl = 1 end
    redis.call('SET', KEYS[3], calls + 1, 'PX', ttl)
    return {1, day, week, 0}
  end
  return {0, day, week, 3}
end
if redis.call('GET', KEYS[5]) then
  return {0, day, week, 4}
end
if day >= tonumber(ARGV[3]) then return {0, day, week, 1} end
if week >= tonumber(ARGV[4]) then return {0, day, week, 2} end
day = day + 1
week = week + 1
redis.call('SET', KEYS[1], day, 'EX', ARGV[6])
redis.call('SET', KEYS[2], week, 'EX', ARGV[7])
redis.call('SET', KEYS[3], 1, 'EX', ARGV[8])
redis.call('SET', KEYS[4], 1, 'EX', ARGV[8])
redis.call('SET', KEYS[5], 1, 'EX', ARGV[9])
return {1, day, week, 0}
`;
// Single atomic capped counter. Denied attempts never extend the window or increment it.
const CAP = `
local count = tonumber(redis.call('GET', KEYS[1]) or ARGV[3])
if count >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], count + 1, 'EX', ARGV[2])
return 1
`;
// Timeout denies the request. A late reservation may still count, but never grants work.
async function boundedEval(redis, script, keys, args) {
  let timer;
  try {
    return await Promise.race([redis.eval(script, keys, args), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Quota storage timeout')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
function periods(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = (now.getUTCDay() + 6) % 7;
  const monday = midnight - weekday * 86400000;
  const thursday = new Date(monday + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstMonday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000;
  const week = `${year}-W${String(1 + Math.round((monday - firstMonday) / 604800000)).padStart(2, '0')}`;
  return { day, week, dayTtl: Math.max(1, Math.ceil((midnight + 86400000 - now.getTime()) / 1000)),
    weekTtl: Math.max(1, Math.ceil((monday + 604800000 - now.getTime()) / 1000)) };
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
const DAY_LIMIT = 5, WEEK_LIMIT = 35, SESSION_MAX_CALLS = 5, SESSION_TTL = 1800, TOMBSTONE_TTL = 86400;
// sessionTtl is a test seam only; production callers use SESSION_TTL.
async function reserveRun(redis, { userId, sessionId, callPrefix }, stored = {}, now = new Date(), sessionTtl = SESSION_TTL) {
  if (!redis) throw new Error('Quota storage unavailable');
  const p = periods(now), owner = hash(userId);
  // Missing session ids cannot reuse a shared session key; each call is charged alone.
  const session = sessionId || require('node:crypto').randomUUID();
  const result = await boundedEval(redis, RESERVE, [
    `quota:v2:generate:${owner}:day:${p.day}`, `quota:v2:generate:${owner}:week:${p.week}`,
    `${callPrefix}:${owner}:session:${hash(session)}`,
    `quota:v2:generate:${owner}:run:${hash(session)}`,
    `quota:v2:generate:${owner}:used:${hash(session)}`,
  ], [stored.lastDayKey === p.day ? count(stored.dailyCount) : 0,
    stored.lastWeekKey === p.week ? count(stored.weeklyCount) : 0, DAY_LIMIT, WEEK_LIMIT,
    SESSION_MAX_CALLS, p.dayTtl, p.weekTtl, sessionTtl, TOMBSTONE_TTL]);
  if (!Array.isArray(result) || result.length !== 4 || result.some(v => !Number.isSafeInteger(Number(v)) || v === null) || ![0, 1].includes(Number(result[0])) || ![0, 1, 2, 3, 4].includes(Number(result[3]))) throw new Error('Invalid quota reply');
  const reason = Number(result[3]);
  return { allowed: Number(result[0]) === 1, dailyCount: Number(result[1]), weeklyCount: Number(result[2]),
    limitType: reason === 2 ? 'weekly' : reason === 3 ? 'session' : reason === 4 ? 'session_expired' : 'daily' };
}
async function reserveGeneration(redis, userId, sessionId, stored = {}, now = new Date(), sessionTtl = SESSION_TTL) {
  return reserveRun(redis, { userId, sessionId, callPrefix: 'quota:v2:generate' }, stored, now, sessionTtl);
}
async function reserveCap(redis, key, limit, ttl, baseline = 0) {
  if (!redis) throw new Error('Quota storage unavailable');
  const result = await boundedEval(redis, CAP, [key], [limit, ttl, count(baseline)]);
  if (result !== 0 && result !== 1 && result !== '0' && result !== '1') throw new Error('Invalid quota reply');
  return Number(result) === 1;
}
async function reserveOcr(redis, { userId, anonToken, sessionId }, stored = {}, now = new Date(), sessionTtl = SESSION_TTL) {
  // Anonymous trial: ocr.js binds the token to the batch's sessionId (SET NX), the
  // same claim enrich.js enforces, so one token really is one batch; this cap only
  // bounds OCR calls within that one trial (same token lifetime as issuance, shared
  // across Mistral and OCR.space).
  if (anonToken) {
    return { allowed: await reserveCap(redis, `quota:v2:ocr:anon:${hash(anonToken)}`, 5, 600),
      dailyCount: 0, weeklyCount: 0, limitType: 'daily' };
  }
  // Signed-in: OCR draws from the SAME run credit as generation (shared run claim), so
  // a batch's OCR calls and its generation calls together cost one credit.
  return reserveRun(redis, { userId, sessionId, callPrefix: 'quota:v2:ocr' }, stored, now, sessionTtl);
}
async function reserveDatalab(redis, userId, stored = {}, now = new Date()) {
  const p = periods(now);
  return reserveCap(redis, `quota:v2:datalab:${hash(userId)}:${p.day}`, 3, p.dayTtl,
    stored.lastDayKey === p.day ? stored.dailyCount : 0);
}
module.exports = { reserveGeneration, reserveOcr, reserveDatalab, periods, _scripts: { RESERVE, CAP } };
