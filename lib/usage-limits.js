// 2026-10-23: atomic usage limits in Upstash Redis.
//
// Replaces the old Clerk privateMetadata read-modify-write quota (enrich.js) and the Datalab
// daily counter (ocr.js). Both read a count over the network, did the provider work, then
// wrote the count back - so parallel requests (a 3-file batch is fired as Promise.allSettled)
// all read the same stale count and all passed. Signed-in OCR through Mistral/OCR.space had
// no limit at all. Here every check-and-count happens inside Redis in one step, BEFORE any
// provider call, so concurrency cannot push anyone past a limit.
//
// The rules (same allowance and batch rule as before, now also covering OCR):
// - Signed-in users get 5 runs per UTC day and 35 per week (week starts Monday 00:00 UTC).
// - A run is one upload batch, identified by the frontend's sessionId. The FIRST call of a
//   batch (OCR or generation, whichever comes first) costs one credit; later calls with the
//   same sessionId ride that credit, up to RUN_CALL_CAP calls per endpoint, for RUN_TTL.
// - Past the per-endpoint cap or after RUN_TTL, the same sessionId simply buys a new credit -
//   exactly what the old Clerk gate did ("renewing the free window still costs one real
//   counted generation"). So replaying a sessionId is never free: the daily/weekly allowance
//   bounds every path.
// - A call with no sessionId is its own run and costs a credit.
// - A credit is spent when the run starts, not after success, so a request that makes the
//   providers fail cannot loop for free.
// - Any Redis error, timeout or unexpected reply throws; callers fail CLOSED (no provider call).
//
// Redis keys (all self-expiring):
//   usage:v1:<userId>:day:<YYYY-MM-DD>        runs started that UTC day      (TTL 2 days)
//   usage:v1:<userId>:week:<monday date>      runs started that week         (TTL 8 days)
//   usage:v1:<userId>:run:<sessionId>         hash { gen: n, ocr: n }        (TTL RUN_TTL)
//   usage:v1:<userId>:datalab:<YYYY-MM-DD>    paid Datalab attempts that day (TTL 2 days)
//   anon:<token>:ocr                          OCR calls on one trial token   (TTL 600s)
//   usage:v1:anon:llamaparse|datalab:<day>    site-wide anonymous paid OCR   (TTL 2 days)
//   usage:v1:<userId>:done:<sessionId>        skill downloaded, session shut (TTL RUN_TTL)
//   anon:<token>:done                         trial skill downloaded         (TTL 600s)

const DAY_LIMIT = 5;
const WEEK_LIMIT = 35;
// The frontend caps a batch at 3 files, so an honest batch makes at most 3 calls per endpoint.
// 5 leaves room for a stray retry, same headroom as the old MAX_FREE_REQUESTS_PER_SESSION.
const RUN_CALL_CAP = 5;
// Worst real batch: 60s OCR function cap + 300s generation cap. 30 minutes is far above it.
const RUN_TTL = 1800;
const DAY_KEY_TTL = 2 * 86400;
const WEEK_KEY_TTL = 8 * 86400;
const DATALAB_DAILY_LIMIT = 3;
// Same 10-minute life as the trial token itself (anon-token.js), same 5 as enrich.js's
// ANON_MAX_ENRICH_CALLS.
const ANON_OCR_CAP = 5;
const ANON_TTL = 600;
const REDIS_TIMEOUT_MS = 2000;

// KEYS[1] day counter, KEYS[2] week counter, KEYS[3] run hash
// ARGV[1] endpoint field ('gen' | 'ocr'), ARGV[2] day limit, ARGV[3] week limit,
// ARGV[4] per-endpoint run cap, ARGV[5] day TTL, ARGV[6] week TTL, ARGV[7] run TTL
// Returns { allowed (0/1), reason (0 ok, 1 daily, 2 weekly), day count, week count }.
// Redis runs the whole script atomically, so no other call can interleave with it.
const RESERVE_RUN = `
local day = tonumber(redis.call('GET', KEYS[1]) or '0')
local week = tonumber(redis.call('GET', KEYS[2]) or '0')
if redis.call('EXISTS', KEYS[3]) == 1 then
  local calls = tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0')
  if calls < tonumber(ARGV[4]) then
    redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
    return {1, 0, day, week}
  end
end
if day >= tonumber(ARGV[2]) then return {0, 1, day, week} end
if week >= tonumber(ARGV[3]) then return {0, 2, day, week} end
redis.call('SET', KEYS[1], day + 1, 'EX', ARGV[5])
redis.call('SET', KEYS[2], week + 1, 'EX', ARGV[6])
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[3], ARGV[1], 1)
redis.call('EXPIRE', KEYS[3], ARGV[7])
return {1, 0, day + 1, week + 1}
`;

function withTimeout(promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('usage store timeout')), REDIS_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

function periodKeys(now) {
  const day = now.toISOString().slice(0, 10);
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysSinceMonday));
  return { day, week: monday.toISOString().slice(0, 10) };
}

// Upstash's REST client returns integer replies as JSON numbers; accept numeric strings too so a
// client-side serialization change fails closed only on genuinely bad data.
function toCount(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

// kind: 'gen' (/api/enrich) or 'ocr' (/api/ocr). Both share one run per sessionId.
async function reserveRun(redis, { userId, sessionId, kind }, now = new Date()) {
  if (!redis) throw new Error('usage store not configured');
  if (!userId) throw new Error('missing userId');
  const { day, week } = periodKeys(now);
  const run = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 128) : require('crypto').randomUUID();
  const reply = await withTimeout(redis.eval(RESERVE_RUN, [
    `usage:v1:${userId}:day:${day}`,
    `usage:v1:${userId}:week:${week}`,
    `usage:v1:${userId}:run:${run}`,
  ], [kind, DAY_LIMIT, WEEK_LIMIT, RUN_CALL_CAP, DAY_KEY_TTL, WEEK_KEY_TTL, RUN_TTL]));
  const values = Array.isArray(reply) && reply.length === 4 ? reply.map(toCount) : null;
  if (!values || values.includes(null) || values[0] > 1 || values[1] > 2) throw new Error('unexpected usage store reply');
  const [allowed, reason, dailyCount, weeklyCount] = values;
  return { allowed: allowed === 1, limitType: reason === 2 ? 'weekly' : 'daily', dailyCount, weeklyCount };
}

// The 429 body both endpoints send. Same shape App.tsx already handles for /api/enrich.
function quotaReachedBody(quota) {
  const limitValue = quota.limitType === 'weekly' ? WEEK_LIMIT : DAY_LIMIT;
  return {
    error: 'QUOTA_REACHED',
    limitType: quota.limitType,
    limitValue,
    weeklyCount: quota.weeklyCount,
    weeklyLimit: WEEK_LIMIT,
    message: `You have used all ${limitValue} free generations for this ${quota.limitType === 'daily' ? 'day' : 'week'}. Your quota resets automatically ${quota.limitType === 'daily' ? 'tomorrow' : 'next week'}.`,
  };
}

// Plain INCR is enough for single-counter caps: INCR is atomic, so N parallel calls get N
// distinct values and exactly `limit` of them pass. A denied call still counts, which only
// ever makes the cap stricter. If the EXPIRE after the first INCR fails, the key is still
// scoped by date or by a 10-minute token, so it can never lock anyone out later.
async function incrementWithin(redis, key, limit, ttl) {
  if (!redis) throw new Error('usage store not configured');
  const count = toCount(await withTimeout(redis.incr(key)));
  if (count === null) throw new Error('unexpected usage store reply');
  if (count === 1) await withTimeout(redis.expire(key, ttl));
  return count <= limit;
}

// Paid Datalab tier: at most 3 attempts per user per UTC day, counted BEFORE the submit
// (a submitted job can bill even if it later fails).
function reserveDatalab(redis, userId, now = new Date()) {
  return incrementWithin(redis, `usage:v1:${userId}:datalab:${periodKeys(now).day}`, DATALAB_DAILY_LIMIT, DAY_KEY_TTL);
}

// Anonymous trial: at most 5 OCR calls per trial token.
function reserveAnonOcr(redis, anonToken) {
  return incrementWithin(redis, `anon:${anonToken}:ocr`, ANON_OCR_CAP, ANON_TTL);
}

// 2026-10-23: LlamaParse (paid, ~$0.004/page) is the first OCR tier. Signed-in use is already
// bounded by the run credits above; anonymous use is bounded per token but anyone can rotate IPs
// for new tokens, so all anonymous LlamaParse calls together get one site-wide daily budget.
// Past it, anonymous OCR falls through to the next tier instead.
const ANON_LLAMAPARSE_DAILY_LIMIT = 200;
function reserveAnonLlamaParse(redis, now = new Date()) {
  return incrementWithin(redis, `usage:v1:anon:llamaparse:${periodKeys(now).day}`, ANON_LLAMAPARSE_DAILY_LIMIT, DAY_KEY_TTL);
}

// 2026-10-24: Mistral (the last free OCR tier) is gone, so anonymous OCR also falls back to
// Datalab (~$0.004/page) when LlamaParse fails or returns weak text - under its own site-wide
// daily budget, for the same IP-rotation reason as above. 50 calls x 10 pages = ~$2/day at most.
const ANON_DATALAB_DAILY_LIMIT = 50;
function reserveAnonDatalab(redis, now = new Date()) {
  return incrementWithin(redis, `usage:v1:anon:datalab:${periodKeys(now).day}`, ANON_DATALAB_DAILY_LIMIT, DAY_KEY_TTL);
}

// 2026-10-24: skill-history saves (PUT /api/skills/:id), at most 60 per user per hour from the
// first save. The caller fails OPEN on a store error (runbook Section 12): the person is already
// signed in, and their own history is the only thing a burst can fill (it is trimmed to 30).
const SKILL_SAVES_PER_HOUR = 60;
function reserveSkillSave(redis, userId) {
  return incrementWithin(redis, `rl:skills:${userId}`, SKILL_SAVES_PER_HOUR, 3600);
}

// 2026-10-25: every /api/skills request (list, open, save, delete) also counts against ONE daily
// budget per user, because each one can wake Neon. Daily, not hourly: Neon suspends after 5 idle
// minutes, so a request every 5 minutes keeps it awake for good, and 12 an hour passes any hourly
// cap (the 60/hour save limit above included). At 100 a day one account can keep the compute
// awake at most 100 x 5 min = ~8.3 h a day (~62 CU-h a month at 0.25 CU, under Neon's free 100).
// A heavy real user needs ~30-50 (a new device's full restore is 31: the list + 30 skills).
// The caller fails OPEN on a store error, like saves.
const SKILL_REQUESTS_PER_DAY = 100;
function reserveSkillRequest(redis, userId, now = new Date()) {
  return incrementWithin(redis, `usage:v1:${userId}:skills:${periodKeys(now).day}`, SKILL_REQUESTS_PER_DAY, DAY_KEY_TTL);
}

// 2026-10-25: GET /api/usage (V3 Settings > Plan) reads the same day counter reserveRun writes.
// The day is the whole answer: the weekly cap can never bind first (5 a day x 7 days = 35).
async function readUsage(redis, userId, now = new Date()) {
  if (!redis) throw new Error('usage store not configured');
  if (!userId) throw new Error('missing userId');
  const raw = await withTimeout(redis.get(`usage:v1:${userId}:day:${periodKeys(now).day}`));
  const used = raw === null ? 0 : toCount(raw);
  if (used === null) throw new Error('unexpected usage store reply');
  return { used: Math.min(used, DAY_LIMIT), limit: DAY_LIMIT };
}

// 2026-10-25: a downloaded skill shuts its session (POST /api/session-complete), and
// /api/enrich then answers 409 SESSION_COMPLETE for it, so a stale tab cannot add documents
// to a finished skill. Signed in: per user + sessionId, for as long as the run can live (after
// RUN_TTL the same sessionId would buy a new credit anyway). Anonymous: the trial token is
// already bound to one session, so the marker is per token, for the token's life.
function sessionDoneKey({ userId, anonToken, sessionId }) {
  return userId ? `usage:v1:${userId}:done:${String(sessionId).slice(0, 128)}` : `anon:${anonToken}:done`;
}

async function markSessionComplete(redis, who) {
  if (!redis) throw new Error('usage store not configured');
  await withTimeout(redis.set(sessionDoneKey(who), 1, { ex: who.userId ? RUN_TTL : ANON_TTL }));
}

// A signed-in call with no sessionId is its own run (see reserveRun), so it is never complete.
async function isSessionComplete(redis, who) {
  if (!redis) throw new Error('usage store not configured');
  if (who.userId && !(typeof who.sessionId === 'string' && who.sessionId)) return false;
  return (await withTimeout(redis.get(sessionDoneKey(who)))) !== null;
}

module.exports = { reserveRun, reserveDatalab, reserveAnonOcr, reserveAnonLlamaParse, reserveAnonDatalab, reserveSkillSave, reserveSkillRequest, readUsage, markSessionComplete, isSessionComplete, quotaReachedBody, periodKeys, withTimeout, toCount, RESERVE_RUN };
