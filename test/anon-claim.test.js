// Tests for lib/anon-claim.js claim() against a REAL redis-server: the claim's Lua script (owner, one-claim marker
// and the day/week allowance in one step) is the whole point, so a mock would prove nothing.
//   REDIS_SERVER=/path/to/redis-server node --test test/anon-claim.test.js
// Skips when REDIS_SERVER is not set. Same minimal RESP client as test/usage-limits.test.js.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { claim } = require('../lib/anon-claim');
const { reserveRun, readUsage, DAY_LIMIT, WEEK_LIMIT } = require('../lib/usage-limits');

const SERVER = process.env.REDIS_SERVER;
const PORT = 6900 + Math.floor(Math.random() * 500);
let server;

function command(...args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1');
    let buf = '';
    sock.on('data', d => {
      buf += d.toString();
      try { const [value] = parse(buf, 0); sock.end(); value instanceof Error ? reject(value) : resolve(value); }
      catch (e) { if (e !== INCOMPLETE) { sock.end(); reject(e); } }
    });
    sock.on('error', reject);
    sock.write(`*${args.length}\r\n` + args.map(a => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join(''));
  });
}
const INCOMPLETE = new Error('incomplete');
function parse(s, i) {
  const end = s.indexOf('\r\n', i);
  if (end < 0) throw INCOMPLETE;
  const type = s[i], line = s.slice(i + 1, end);
  if (type === '+') return [line, end + 2];
  if (type === '-') return [new Error(line), end + 2];
  if (type === ':') return [Number(line), end + 2];
  if (type === '$') {
    const len = Number(line);
    if (len < 0) return [null, end + 2];
    if (s.length < end + 2 + len + 2) throw INCOMPLETE;
    return [s.slice(end + 2, end + 2 + len), end + 2 + len + 2];
  }
  if (type === '*') {
    const out = []; let pos = end + 2;
    for (let k = 0; k < Number(line); k++) { const [v, p] = parse(s, pos); out.push(v); pos = p; }
    return [out, pos];
  }
  throw new Error('bad reply');
}

// The @upstash/redis method shapes lib/anon-claim.js and lib/usage-limits.js call.
const redis = {
  eval: (script, keys, args) => command('EVAL', script, keys.length, ...keys, ...args),
  get: key => command('GET', key),
  set: (key, value, opts) => command('SET', key, value, ...(opts?.nx ? ['NX'] : []), 'EX', opts.ex),
  incr: key => command('INCR', key),
  expire: (key, ttl) => command('EXPIRE', key, ttl),
  lrange: (key, a, b) => command('LRANGE', key, a, b),
  rpush: (key, v) => command('RPUSH', key, v),
  hset: (key, obj) => command('HSET', key, ...Object.entries(obj).flat()),
  hincrby: (key, f, n) => command('HINCRBY', key, f, n),
};

const skip = !SERVER && 'REDIS_SERVER not set';
const NOW = new Date('2026-11-19T10:00:00Z'); // a Thursday: day and week counters both apply

before(async () => {
  if (!SERVER) return;
  server = spawn(SERVER, ['--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await command('PING'); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('redis-server did not start');
});
after(() => { if (server) server.kill(); });
beforeEach(async () => { if (SERVER) await command('FLUSHALL'); });

// A held free-try skill, as holdForClaim leaves it
async function held(n = 1) {
  const claimId = crypto.randomUUID();
  for (let i = 0; i < n; i++) await redis.rpush(`claim:${claimId}:items`, JSON.stringify({ enriched: `# skill ${i}\n## A\nx`, target: 'claude', model: null, at: 1 }));
  return claimId;
}
const user = () => `user_${crypto.randomUUID().slice(0, 8)}`;
const usedToday = async (u) => (await readUsage(redis, u, NOW)).used;

test('a first claim delivers the skill and costs exactly one credit', { skip }, async () => {
  const u = user(); const id = await held();
  const r = await claim(redis, { claimId: id, userId: u, mode: 'signup' }, NOW);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.equal(await usedToday(u), 1);
  assert.equal(await redis.get(`claim:${id}:owner`), u);
});

test('a 3-file free try claimed at once is ONE credit, like a signed-in batch', { skip }, async () => {
  const u = user(); const id = await held(3);
  const r = await claim(redis, { claimId: id, userId: u }, NOW);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 3);
  assert.equal(await usedToday(u), 1);
});

test('reloading the same claim is free', { skip }, async () => {
  const u = user(); const id = await held();
  await claim(redis, { claimId: id, userId: u }, NOW);
  for (let i = 0; i < 4; i++) assert.equal((await claim(redis, { claimId: id, userId: u }, NOW)).status, 200);
  assert.equal(await usedToday(u), 1);
});

test('a reload still works when the account is at 3 of 3 (already paid)', { skip }, async () => {
  const u = user(); const id = await held();
  await claim(redis, { claimId: id, userId: u }, NOW);
  for (let i = 0; i < DAY_LIMIT - 1; i++) assert.equal((await reserveRun(redis, { userId: u, sessionId: `s${i}`, kind: 'gen' }, NOW)).allowed, true);
  assert.equal(await usedToday(u), DAY_LIMIT);
  assert.equal((await claim(redis, { claimId: id, userId: u }, NOW)).status, 200);
  assert.equal(await usedToday(u), DAY_LIMIT);
});

test('after a claim, the account has only DAY_LIMIT - 1 runs left today', { skip }, async () => {
  const u = user(); const id = await held();
  await claim(redis, { claimId: id, userId: u }, NOW);
  for (let i = 0; i < DAY_LIMIT - 1; i++) assert.equal((await reserveRun(redis, { userId: u, sessionId: `s${i}`, kind: 'gen' }, NOW)).allowed, true);
  const next = await reserveRun(redis, { userId: u, sessionId: 'over', kind: 'gen' }, NOW);
  assert.equal(next.allowed, false);
  assert.equal(next.limitType, 'daily');
});

test('at 3 of 3 the claim is refused, nothing is written, and it unlocks after the reset', { skip }, async () => {
  const u = user(); const id = await held();
  for (let i = 0; i < DAY_LIMIT; i++) await reserveRun(redis, { userId: u, sessionId: `s${i}`, kind: 'gen' }, NOW);
  const r = await claim(redis, { claimId: id, userId: u }, NOW);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'QUOTA_REACHED');
  assert.deepEqual(r.quota, { limitType: 'daily', dailyCount: DAY_LIMIT, weeklyCount: DAY_LIMIT });
  assert.equal(await redis.get(`claim:${id}:owner`), null, 'no owner taken');
  assert.equal(await redis.get(`anonconv:claimed:${u}`), null, 'one-claim marker not spent');
  assert.equal(await usedToday(u), DAY_LIMIT, 'not charged past the limit');
  const tomorrow = new Date('2026-11-20T01:00:00Z');
  const later = await claim(redis, { claimId: id, userId: u }, tomorrow);
  assert.equal(later.status, 200);
  assert.equal((await readUsage(redis, u, tomorrow)).used, 1);
});

test('the weekly allowance refuses a claim too', { skip }, async () => {
  const u = user(); const id = await held();
  const { periodKeys } = require('../lib/usage-limits');
  await command('SET', `usage:v1:${u}:week:${periodKeys(NOW).week}`, WEEK_LIMIT, 'EX', 600);
  const r = await claim(redis, { claimId: id, userId: u }, NOW);
  assert.equal(r.status, 429);
  assert.equal(r.quota.limitType, 'weekly');
  assert.equal(await usedToday(u), 0);
});

test('one free claim per account: a second, different claim is CLAIM_LIMIT and not charged', { skip }, async () => {
  const u = user(); const a = await held(); const b = await held();
  assert.equal((await claim(redis, { claimId: a, userId: u }, NOW)).status, 200);
  const r = await claim(redis, { claimId: b, userId: u }, NOW);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'CLAIM_LIMIT');
  assert.equal(await usedToday(u), 1);
});

test('another account cannot take a claimed skill, and is not charged', { skip }, async () => {
  const u = user(); const v = user(); const id = await held();
  await claim(redis, { claimId: id, userId: u }, NOW);
  const r = await claim(redis, { claimId: id, userId: v }, NOW);
  assert.equal(r.status, 409);
  assert.equal(await usedToday(v), 0);
});

test('parallel claims of the same skill by one account charge once', { skip }, async () => {
  const u = user(); const id = await held();
  const rs = await Promise.all(Array.from({ length: 8 }, () => claim(redis, { claimId: id, userId: u }, NOW)));
  assert.ok(rs.every(r => r.status === 200));
  assert.equal(await usedToday(u), 1);
  assert.equal(await command('HGET', `anonconv:day:${new Date().toISOString().slice(0, 10)}`, 'claims'), '1', 'conversion recorded once');
});

test('a claim racing runs at 2 of 3 never pushes the account past the limit', { skip }, async () => {
  const u = user(); const id = await held();
  for (let i = 0; i < DAY_LIMIT - 1; i++) await reserveRun(redis, { userId: u, sessionId: `s${i}`, kind: 'gen' }, NOW);
  const [c, ...runs] = await Promise.all([
    claim(redis, { claimId: id, userId: u }, NOW),
    ...Array.from({ length: 5 }, (_, i) => reserveRun(redis, { userId: u, sessionId: `race${i}`, kind: 'gen' }, NOW)),
  ]);
  const passed = (c.status === 200 ? 1 : 0) + runs.filter(r => r.allowed).length;
  assert.equal(passed, 1, 'exactly one of the racers gets the last credit');
  assert.equal(await usedToday(u), DAY_LIMIT);
});

test('a missing claim is 404 and costs nothing', { skip }, async () => {
  const u = user();
  const r = await claim(redis, { claimId: crypto.randomUUID(), userId: u }, NOW);
  assert.equal(r.status, 404);
  assert.equal(await usedToday(u), 0);
});
