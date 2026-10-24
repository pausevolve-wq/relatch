// Tests for lib/usage-limits.js against a REAL redis-server (the Lua script and INCR semantics
// are the whole point, so a mock would prove nothing).
//   REDIS_SERVER=/path/to/redis-server node --test test/usage-limits.test.js
// Skips when REDIS_SERVER is not set.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { reserveRun, reserveDatalab, reserveAnonOcr, reserveAnonLlamaParse, reserveAnonDatalab, readUsage, markSessionComplete, isSessionComplete, quotaReachedBody, periodKeys } = require('../lib/usage-limits');

const SERVER = process.env.REDIS_SERVER;
const PORT = 6390 + Math.floor(Math.random() * 500);
let server;

// Minimal RESP client: one connection per command, enough for tests.
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

// Same method shapes lib/usage-limits.js calls on @upstash/redis.
const redis = {
  eval: (script, keys, args) => command('EVAL', script, keys.length, ...keys, ...args),
  incr: key => command('INCR', key),
  expire: (key, ttl) => command('EXPIRE', key, ttl),
  get: key => command('GET', key),
  set: (key, value, opts) => command('SET', key, value, 'EX', opts.ex),
};

const skip = !SERVER && 'REDIS_SERVER not set';

before(async () => {
  if (!SERVER) return;
  server = spawn(SERVER, ['--port', String(PORT), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { await command('PING'); return; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error('redis-server did not start');
});
after(() => { if (server) server.kill(); });

const NOW = new Date('2026-10-23T12:00:00Z'); // a Friday

test('40 parallel new batches: exactly 5 pass the daily limit', { skip }, async () => {
  const rows = await Promise.all(Array.from({ length: 40 }, (_, i) =>
    reserveRun(redis, { userId: 'u-burst', sessionId: `s${i}`, kind: 'gen' }, NOW)));
  assert.equal(rows.filter(r => r.allowed).length, 5);
  assert.ok(rows.filter(r => !r.allowed).every(r => r.limitType === 'daily' && r.dailyCount === 5));
});

test('one batch: 3 OCR + 3 generation calls in parallel cost ONE credit', { skip }, async () => {
  const calls = ['ocr', 'ocr', 'ocr', 'gen', 'gen', 'gen'].map(kind =>
    reserveRun(redis, { userId: 'u-batch', sessionId: 'session_1_abc', kind }, NOW));
  const rows = await Promise.all(calls);
  assert.ok(rows.every(r => r.allowed));
  assert.equal(Math.max(...rows.map(r => r.dailyCount)), 1);
  assert.equal(await command('GET', `usage:v1:u-batch:day:2026-10-23`), '1');
});

test('the 6th call of one endpoint in a batch buys a new credit (same rule as the old gate)', { skip }, async () => {
  const counts = [];
  for (let i = 0; i < 6; i++) counts.push((await reserveRun(redis, { userId: 'u-cap', sessionId: 'same', kind: 'gen' }, NOW)).dailyCount);
  assert.deepEqual(counts, [1, 1, 1, 1, 1, 2]);
});

test('a new credit restarts BOTH endpoint counters of the batch', { skip }, async () => {
  const u = { userId: 'u-reset', sessionId: 'r' };
  for (let i = 0; i < 5; i++) await reserveRun(redis, { ...u, kind: 'gen' }, NOW);
  for (let i = 0; i < 5; i++) await reserveRun(redis, { ...u, kind: 'ocr' }, NOW);
  assert.equal((await reserveRun(redis, { ...u, kind: 'gen' }, NOW)).dailyCount, 2); // 6th gen buys credit 2
  assert.equal((await reserveRun(redis, { ...u, kind: 'ocr' }, NOW)).dailyCount, 2); // ocr rides credit 2
});

test('replaying one sessionId forever is bounded by the daily limit', { skip }, async () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(await reserveRun(redis, { userId: 'u-replay', sessionId: 'fixed', kind: 'gen' }, NOW));
  assert.equal(rows.filter(r => r.allowed).length, 25); // 5 credits x 5 calls each
  assert.equal(rows.at(-1).dailyCount, 5);
});

test('an expired batch is charged again', { skip }, async () => {
  await reserveRun(redis, { userId: 'u-exp', sessionId: 'b', kind: 'ocr' }, NOW);
  await command('DEL', 'usage:v1:u-exp:run:b'); // what the 1800s TTL does
  assert.equal((await reserveRun(redis, { userId: 'u-exp', sessionId: 'b', kind: 'gen' }, NOW)).dailyCount, 2);
});

test('missing sessionId: every call is its own run', { skip }, async () => {
  const a = await reserveRun(redis, { userId: 'u-nosid', kind: 'ocr' }, NOW);
  const b = await reserveRun(redis, { userId: 'u-nosid', sessionId: '', kind: 'ocr' }, NOW);
  assert.deepEqual([a.dailyCount, b.dailyCount], [1, 2]);
});

test('weekly limit, then the next week starts fresh', { skip }, async () => {
  await command('SET', 'usage:v1:u-week:week:2026-10-19', 35);
  const denied = await reserveRun(redis, { userId: 'u-week', sessionId: 'x', kind: 'gen' }, NOW);
  assert.equal(denied.allowed, false);
  assert.equal(denied.limitType, 'weekly');
  assert.equal(quotaReachedBody(denied).limitValue, 35);
  const nextMonday = await reserveRun(redis, { userId: 'u-week', sessionId: 'y', kind: 'gen' }, new Date('2026-10-26T00:00:01Z'));
  assert.equal(nextMonday.allowed, true);
  assert.equal(nextMonday.weeklyCount, 1);
});

test('a denied call charges nothing and does not touch the run', { skip }, async () => {
  await command('SET', 'usage:v1:u-full:day:2026-10-23', 5);
  const r = await reserveRun(redis, { userId: 'u-full', sessionId: 'z', kind: 'gen' }, NOW);
  assert.equal(r.allowed, false);
  assert.equal(await command('GET', 'usage:v1:u-full:day:2026-10-23'), '5');
  assert.equal(await command('EXISTS', 'usage:v1:u-full:run:z'), 0);
});

test('keys expire on their own', { skip }, async () => {
  await reserveRun(redis, { userId: 'u-ttl', sessionId: 't', kind: 'gen' }, NOW);
  const [day, week, run] = await Promise.all(['day:2026-10-23', 'week:2026-10-19', 'run:t'].map(k => command('TTL', `usage:v1:u-ttl:${k}`)));
  assert.ok(day > 0 && day <= 172800 && week > 0 && week <= 691200 && run > 0 && run <= 1800);
});

test('Datalab: 10 parallel attempts, exactly 3 pass, per user per day', { skip }, async () => {
  const rows = await Promise.all(Array.from({ length: 10 }, () => reserveDatalab(redis, 'u-dl', NOW)));
  assert.equal(rows.filter(Boolean).length, 3);
  assert.equal(await reserveDatalab(redis, 'u-dl-other', NOW), true);
  assert.equal(await reserveDatalab(redis, 'u-dl', new Date('2026-10-24T00:00:01Z')), true);
});

test('anonymous OCR: 10 parallel calls on one token, exactly 5 pass', { skip }, async () => {
  const rows = await Promise.all(Array.from({ length: 10 }, () => reserveAnonOcr(redis, 'tok-1')));
  assert.equal(rows.filter(Boolean).length, 5);
  const ttl = await command('TTL', 'anon:tok-1:ocr');
  assert.ok(ttl > 0 && ttl <= 600);
});

test('anonymous LlamaParse: one site-wide budget of 200 calls per UTC day', { skip }, async () => {
  const day = new Date('2026-10-23T12:00:00Z');
  await command('SET', 'usage:v1:anon:llamaparse:2026-10-23', 195);
  const rows = await Promise.all(Array.from({ length: 10 }, () => reserveAnonLlamaParse(redis, day)));
  assert.equal(rows.filter(Boolean).length, 5);
  assert.equal(await reserveAnonLlamaParse(redis, new Date('2026-10-24T00:00:01Z')), true);
});

test('anonymous Datalab: its own site-wide budget of 50 calls per UTC day', { skip }, async () => {
  const day = new Date('2026-10-23T12:00:00Z');
  await command('SET', 'usage:v1:anon:datalab:2026-10-23', 45);
  const rows = await Promise.all(Array.from({ length: 10 }, () => reserveAnonDatalab(redis, day)));
  assert.equal(rows.filter(Boolean).length, 5);
  assert.equal(await command('GET', 'usage:v1:anon:datalab:2026-10-23'), '55'); // separate from LlamaParse's key
  assert.equal(await reserveAnonDatalab(redis, new Date('2026-10-24T00:00:01Z')), true);
});

test('usage: reads the day counter reserveRun writes, 0 on a fresh day, never above the limit', { skip }, async () => {
  const u = 'usage-read';
  assert.deepEqual(await readUsage(redis, u, NOW), { used: 0, limit: 5 });
  await reserveRun(redis, { userId: u, sessionId: 'a', kind: 'gen' }, NOW);
  await reserveRun(redis, { userId: u, sessionId: 'a', kind: 'ocr' }, NOW); // same batch, same credit
  await reserveRun(redis, { userId: u, sessionId: 'b', kind: 'gen' }, NOW);
  assert.deepEqual(await readUsage(redis, u, NOW), { used: 2, limit: 5 });
  assert.deepEqual(await readUsage(redis, u, new Date('2026-10-24T00:00:01Z')), { used: 0, limit: 5 }); // next UTC day
  await command('SET', `usage:v1:${u}:day:2026-10-23`, 9);
  assert.deepEqual(await readUsage(redis, u, NOW), { used: 5, limit: 5 });
  assert.equal(await command('GET', `usage:v1:${u}:day:2026-10-23`), '9'); // reading never writes
});

test('session complete: shuts only that user + session, for RUN_TTL', { skip }, async () => {
  const a = { userId: 'done-a', sessionId: 'session_1_abc' };
  assert.equal(await isSessionComplete(redis, a), false);
  await markSessionComplete(redis, a);
  assert.equal(await isSessionComplete(redis, a), true);
  assert.equal(await isSessionComplete(redis, { ...a, sessionId: 'session_2_def' }), false); // the next skill
  assert.equal(await isSessionComplete(redis, { ...a, userId: 'done-b' }), false); // same id, other person
  assert.equal(await isSessionComplete(redis, { userId: 'done-a' }), false); // no sessionId = its own run
  const ttl = await command('TTL', 'usage:v1:done-a:done:session_1_abc');
  assert.ok(ttl > 1790 && ttl <= 1800, `ttl ${ttl}`);
  await markSessionComplete(redis, a); // a repeat is harmless
  assert.equal(await isSessionComplete(redis, a), true);
});

test('session complete, anonymous: per trial token, for the token life', { skip }, async () => {
  assert.equal(await isSessionComplete(redis, { anonToken: 'tok-1' }), false);
  await markSessionComplete(redis, { anonToken: 'tok-1', sessionId: 'session_9_xyz' });
  assert.equal(await isSessionComplete(redis, { anonToken: 'tok-1' }), true);
  assert.equal(await isSessionComplete(redis, { anonToken: 'tok-2' }), false);
  const ttl = await command('TTL', 'anon:tok-1:done');
  assert.ok(ttl > 590 && ttl <= 600, `ttl ${ttl}`);
});

test('usage + session reads/writes throw on store failure (callers decide open or closed)', async () => {
  const down = { get: async () => { throw new Error('down'); }, set: async () => { throw new Error('down'); } };
  await assert.rejects(readUsage(down, 'u'));
  await assert.rejects(readUsage(null, 'u'));
  await assert.rejects(readUsage({ get: async () => 'garbage' }, 'u'), /unexpected/);
  await assert.rejects(markSessionComplete(down, { userId: 'u', sessionId: 's' }));
  await assert.rejects(isSessionComplete(down, { userId: 'u', sessionId: 's' }));
  await assert.rejects(isSessionComplete(null, { anonToken: 't' }));
  assert.deepEqual(await readUsage({ get: async () => 3 }, 'u'), { used: 3, limit: 5 }); // Upstash JSON number
});

test('store failures throw (callers fail closed)', async () => {
  await assert.rejects(reserveRun(null, { userId: 'u', sessionId: 's', kind: 'gen' }));
  await assert.rejects(reserveRun({ eval: async () => { throw new Error('down'); } }, { userId: 'u', sessionId: 's', kind: 'gen' }));
  for (const bad of [null, 'OK', [1, 0, 1], [1, 0, 1, null], [7, 0, 1, 1], [1, 9, 1, 1], ['x', 0, 1, 1], [1, 0, -1, 1]]) {
    await assert.rejects(reserveRun({ eval: async () => bad }, { userId: 'u', sessionId: 's', kind: 'gen' }), undefined, JSON.stringify(bad));
  }
  await assert.rejects(reserveDatalab({ incr: async () => 'nope', expire: async () => 1 }, 'u'));
  await assert.rejects(reserveAnonOcr(null, 't'));
});

test('a hung store times out and throws', async () => {
  const started = Date.now();
  await assert.rejects(reserveRun({ eval: () => new Promise(() => {}) }, { userId: 'u', sessionId: 's', kind: 'gen' }), /timeout/);
  assert.ok(Date.now() - started < 3000);
});

test('numeric-string replies are accepted', async () => {
  const r = await reserveRun({ eval: async () => ['1', '0', '2', '3'] }, { userId: 'u', sessionId: 's', kind: 'gen' });
  assert.deepEqual([r.allowed, r.dailyCount, r.weeklyCount], [true, 2, 3]);
});

test('periodKeys: UTC day and the Monday that starts the week', () => {
  assert.deepEqual(periodKeys(new Date('2026-10-23T23:59:59Z')), { day: '2026-10-23', week: '2026-10-19' });
  assert.deepEqual(periodKeys(new Date('2026-10-25T23:59:59Z')), { day: '2026-10-25', week: '2026-10-19' }); // Sunday
  assert.deepEqual(periodKeys(new Date('2026-10-26T00:00:00Z')), { day: '2026-10-26', week: '2026-10-26' }); // Monday
  assert.deepEqual(periodKeys(new Date('2027-01-01T08:00:00Z')), { day: '2027-01-01', week: '2026-12-28' }); // year boundary
  assert.deepEqual(periodKeys(new Date('2028-03-01T00:00:00Z')), { day: '2028-03-01', week: '2028-02-28' }); // leap year
});
