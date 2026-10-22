// Atomic, fail-closed reservations BEFORE provider work. Failed attempts remain counted.
// Redis is authoritative; Clerk metadata is used only to seed existing period usage.
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const RESERVE = `
local day = tonumber(redis.call('GET', KEYS[1]) or ARGV[1])
local week = tonumber(redis.call('GET', KEYS[2]) or ARGV[2])
local calls = tonumber(redis.call('GET', KEYS[3]) or '0')
local same = calls > 0 and calls < tonumber(ARGV[5])
if not same and day >= tonumber(ARGV[3]) then return {0, day, week, 1} end
if not same and week >= tonumber(ARGV[4]) then return {0, day, week, 2} end
if not same then day = day + 1; week = week + 1 end
redis.call('SET', KEYS[1], day, 'EX', ARGV[6])
redis.call('SET', KEYS[2], week, 'EX', ARGV[7])
if same then redis.call('INCR', KEYS[3])
else redis.call('SET', KEYS[3], 1, 'EX', ARGV[8]) end
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
async function reserveGeneration(redis, userId, sessionId, stored = {}, now = new Date()) {
  if (!redis) throw new Error('Quota storage unavailable');
  const p = periods(now), owner = hash(userId);
  // Missing session ids cannot reuse a shared session key.
  const session = sessionId || require('node:crypto').randomUUID();
  const result = await boundedEval(redis, RESERVE, [
    `quota:v2:generate:${owner}:day:${p.day}`, `quota:v2:generate:${owner}:week:${p.week}`,
    `quota:v2:generate:${owner}:session:${p.day}:${hash(session)}`,
  ], [stored.lastDayKey === p.day ? count(stored.dailyCount) : 0,
    stored.lastWeekKey === p.week ? count(stored.weeklyCount) : 0, 5, 35, 5, p.dayTtl, p.weekTtl, 600]);
  if (!Array.isArray(result) || result.length !== 4 || result.some(v => !Number.isSafeInteger(Number(v)) || v === null) || ![0, 1].includes(Number(result[0]))) throw new Error('Invalid quota reply');
  return { allowed: Number(result[0]) === 1, dailyCount: Number(result[1]), weeklyCount: Number(result[2]),
    limitType: Number(result[3]) === 2 ? 'weekly' : 'daily' };
}
async function reserveCap(redis, key, limit, ttl, baseline = 0) {
  if (!redis) throw new Error('Quota storage unavailable');
  const result = await boundedEval(redis, CAP, [key], [limit, ttl, count(baseline)]);
  if (result !== 0 && result !== 1 && result !== '0' && result !== '1') throw new Error('Invalid quota reply');
  return Number(result) === 1;
}
async function reserveOcr(redis, { userId, anonToken }, now = new Date()) {
  const p = periods(now);
  // Same token lifetime as issuance. Counter is shared across Mistral and OCR.space.
  if (anonToken) return reserveCap(redis, `quota:v2:ocr:anon:${hash(anonToken)}`, 5, 600);
  // 5 daily sessions x 5 files/retries, independently bounded before any OCR provider call.
  return reserveCap(redis, `quota:v2:ocr:user:${hash(userId)}:${p.day}`, 25, p.dayTtl);
}
async function reserveDatalab(redis, userId, stored = {}, now = new Date()) {
  const p = periods(now);
  return reserveCap(redis, `quota:v2:datalab:${hash(userId)}:${p.day}`, 3, p.dayTtl,
    stored.lastDayKey === p.day ? stored.dailyCount : 0);
}
module.exports = { reserveGeneration, reserveOcr, reserveDatalab, periods, _scripts: { RESERVE, CAP } };
