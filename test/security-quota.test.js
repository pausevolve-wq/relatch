const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { reserveGeneration, reserveOcr, reserveDatalab, periods } = require('../lib/security-quota');
const socket = `/tmp/relatch-test-${process.pid}.sock`;
let server;
const redis = { async eval(script, keys, args) {
  const { stdout } = await exec('redis-cli', ['-s', socket, '--raw', 'EVAL', script, String(keys.length), ...keys, ...args.map(String)]);
  const values = stdout.trim().split('\n').map(Number);
  return values.length === 1 ? values[0] : values;
} };
before(async () => {
  server = spawn(process.env.REDIS_SERVER || 'redis-server', ['--port', '0', '--unixsocket', socket, '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    let tries = 0;
    const check = async () => { try { await exec('redis-cli', ['-s', socket, 'PING']); resolve(); }
      catch { if (++tries > 100) reject(new Error('Redis did not start')); else setTimeout(check, 20); } };
    check();
  });
});
after(async () => { if (server) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); } });
test('UTC ISO week boundaries', () => {
 assert.equal(periods(new Date('2027-01-01T12:00:00Z')).week, '2026-W53');
 assert.equal(periods(new Date('2026-10-22T12:00:00Z')).week, '2026-W43');
});
test('concurrent generation reservations cannot exceed 5 daily sessions', async () => {
 const rows = await Promise.all(Array.from({length:40}, (_,i) => reserveGeneration(redis,'burst',`s${i}`)));
 assert.equal(rows.filter(x=>x.allowed).length, 5);
 assert.equal(rows.filter(x=>!x.allowed).length,35);
});
test('an exhausted batch is denied without silently charging a second credit', async () => {
 const rows = await Promise.all(Array.from({length:60}, () => reserveGeneration(redis,'same','one')));
 assert.equal(rows.filter(x=>x.allowed).length,5);
 const denied = rows.filter(x=>!x.allowed);
 assert.equal(denied.length,55);
 assert.ok(denied.every(x=>x.limitType==='session' && x.dailyCount===1 && x.weeklyCount===1));
});
test('existing Clerk daily and weekly usage seed the first atomic reservation', async () => {
 const p=periods();
 assert.equal((await reserveGeneration(redis,'seed-day','a',{dailyCount:5,lastDayKey:p.day})).allowed,false);
 assert.equal((await reserveGeneration(redis,'seed-week','a',{weeklyCount:35,lastWeekKey:p.week})).limitType,'weekly');
});
test('anonymous OCR limited to 5 regardless of concurrent calls', async () => {
 const rows=await Promise.all(Array.from({length:30},()=>reserveOcr(redis,{anonToken:'ticket'})));
 assert.equal(rows.filter(r=>r.allowed).length,5);
});
test('signed-in OCR without a batch session is charged per call and bounded by the shared 5/day allowance', async () => {
 const rows=await Promise.all(Array.from({length:40},()=>reserveOcr(redis,{userId:'ocr-a'})));
 assert.equal(rows.filter(r=>r.allowed).length,5);
 assert.equal((await reserveOcr(redis,{userId:'ocr-b'})).allowed,true);
});
test('OCR and generation in the same batch share one credit', async () => {
 const first=await reserveOcr(redis,{userId:'shared',sessionId:'batch-1'});
 assert.equal(first.allowed,true);assert.equal(first.dailyCount,1);
 // three OCR-preprocessed files plus their three generation calls: one credit total
 for(let i=0;i<2;i++)assert.equal((await reserveOcr(redis,{userId:'shared',sessionId:'batch-1'})).allowed,true);
 for(let i=0;i<3;i++){
  const gen=await reserveGeneration(redis,'shared','batch-1');
  assert.equal(gen.allowed,true);assert.equal(gen.dailyCount,1);
 }
 // a genuinely new batch charges the next credit
 assert.equal((await reserveGeneration(redis,'shared','batch-2')).dailyCount,2);
});
test('OCR-first runs count toward the weekly cap and recover next ISO week', async () => {
 for(let d=0;d<7;d++){
  const now=new Date(Date.UTC(2026,9,19+d,12));
  for(let i=0;i<5;i++)assert.equal((await reserveOcr(redis,{userId:'ocr-week',sessionId:`${d}-${i}`},{},now)).allowed,true);
 }
 assert.equal((await reserveOcr(redis,{userId:'ocr-week',sessionId:'extra'},{},new Date('2026-10-25T12:00:00Z'))).allowed,false);
 assert.equal((await reserveOcr(redis,{userId:'ocr-week',sessionId:'new-week'},{},new Date('2026-10-26T12:00:00Z'))).allowed,true);
});
test('Clerk usage seeds an OCR-first reservation too', async () => {
 const p=periods();
 assert.equal((await reserveOcr(redis,{userId:'ocr-seed',sessionId:'a'},{dailyCount:5,lastDayKey:p.day})).allowed,false);
});
test('paid OCR reserves before completion and honors migrated baseline', async () => {
 const rows=await Promise.all(Array.from({length:20},()=>reserveDatalab(redis,'paid')));
 assert.equal(rows.filter(Boolean).length,3);
 assert.equal(await reserveDatalab(redis,'paid-seed',{dailyCount:3,lastDayKey:periods().day}),false);
});
test('all provider reservations fail closed without quota storage', async () => {
 await assert.rejects(reserveGeneration(null,'a','b'));
 await assert.rejects(reserveOcr(null,{anonToken:'x'}));
 await assert.rejects(reserveOcr(null,{userId:'a',sessionId:'b'}));
 await assert.rejects(reserveDatalab(null,'a'));
});
test('a backend storage failure or malformed reply never allows work', async () => {
 const broken={eval:async()=>{throw new Error('offline')}};
 await assert.rejects(reserveGeneration(broken,'a','b'));
 await assert.rejects(reserveOcr({eval:async()=>null},{userId:'a'}));
});

test('quota storage hang fails closed within bounded time', async()=>{
 const started=Date.now();
 await assert.rejects(reserveOcr({eval:()=>new Promise(()=>{})},{userId:'hang'}),/timeout/);
 assert.ok(Date.now()-started < 3000);
});
test('weekly cap survives UTC day changes and resets next ISO week', async()=>{
 for(let d=0;d<7;d++){
  const now=new Date(Date.UTC(2026,9,19+d,12));
  for(let i=0;i<5;i++)assert.equal((await reserveGeneration(redis,'week-boundary',`${d}-${i}`,{},now)).allowed,true);
 }
 const last=new Date('2026-10-25T12:00:00Z');
 assert.equal((await reserveGeneration(redis,'week-boundary','extra',{},last)).allowed,false);
 assert.equal((await reserveGeneration(redis,'week-boundary','new-week',{},new Date('2026-10-26T12:00:00Z'))).allowed,true);
});
test('a batch replayed on a later UTC day is denied; a new upload charges normally',async()=>{
 // Redis TTLs are real time, so the day-1 charge uses a short claim TTL to simulate
 // the day rollover; the tombstone (real 24h TTL) outlives it as in production.
 const ttl=2, day1=new Date('2026-10-21T12:00:00Z'), day2=new Date('2026-10-22T12:00:00Z');
 assert.equal((await reserveGeneration(redis,'day-boundary','same',{},day1,ttl)).allowed,true);
 await new Promise(r=>setTimeout(r,2300));
 const replay=await reserveGeneration(redis,'day-boundary','same',{},day2,ttl);
 assert.equal(replay.allowed,false);assert.equal(replay.limitType,'session_expired');assert.equal(replay.dailyCount,0);
 // a genuinely new upload on the new day charges its first credit
 const fresh=await reserveGeneration(redis,'day-boundary','same-day2',{},day2,ttl);
 assert.equal(fresh.allowed,true);assert.equal(fresh.dailyCount,1);
 // tombstones and counters are isolated per user
 assert.equal((await reserveGeneration(redis,'different-user','same')).dailyCount,1);
});
test('a retry after an ambiguous provider timeout (credit consumed, response lost) never charges twice',async()=>{
 // First attempt's reservation lands on real storage; the caller never learns the result.
 assert.equal((await reserveGeneration(redis,'ambiguous','batch-1')).dailyCount,1);
 // Retry of the SAME batch on the same endpoint rides the live claim.
 const sameEndpoint=await reserveGeneration(redis,'ambiguous','batch-1');
 assert.equal(sameEndpoint.allowed,true);assert.equal(sameEndpoint.dailyCount,1);
 // Retry reaching the OTHER endpoint of the batch also rides the same credit.
 const otherEndpoint=await reserveOcr(redis,{userId:'ambiguous',sessionId:'batch-1'});
 assert.equal(otherEndpoint.allowed,true);assert.equal(otherEndpoint.dailyCount,1);
});
test('concurrent OCR and generation calls in one batch charge exactly one credit', async () => {
 const rows=await Promise.all([
  ...Array.from({length:3},()=>reserveOcr(redis,{userId:'mix',sessionId:'batch-x'})),
  ...Array.from({length:3},()=>reserveGeneration(redis,'mix','batch-x')),
 ]);
 assert.equal(rows.filter(r=>r.allowed).length,6);
 const probe=await reserveOcr(redis,{userId:'mix',sessionId:'batch-y'});
 assert.equal(probe.dailyCount,2); // batch-x cost exactly one credit; batch-y is the second
});
test('per-endpoint attempt caps deny inside a paid run without charging again', async () => {
 for(let i=0;i<5;i++)assert.equal((await reserveGeneration(redis,'caps','run-1')).allowed,true);
 const sixth=await reserveGeneration(redis,'caps','run-1');
 assert.equal(sixth.allowed,false);assert.equal(sixth.limitType,'session');assert.equal(sixth.dailyCount,1);
 for(let i=0;i<5;i++)assert.equal((await reserveOcr(redis,{userId:'caps',sessionId:'run-1'})).allowed,true);
 const ocrSixth=await reserveOcr(redis,{userId:'caps',sessionId:'run-1'});
 assert.equal(ocrSixth.allowed,false);assert.equal(ocrSixth.limitType,'session');assert.equal(ocrSixth.dailyCount,1);
 // a genuinely new batch still charges the next credit
 assert.equal((await reserveGeneration(redis,'caps','run-2')).dailyCount,2);
});
test('generation-first runs let later OCR calls of the batch ride the same credit', async () => {
 assert.equal((await reserveGeneration(redis,'late-ocr','batch-1')).dailyCount,1);
 for(let i=0;i<3;i++){
  const ocr=await reserveOcr(redis,{userId:'late-ocr',sessionId:'batch-1'});
  assert.equal(ocr.allowed,true);assert.equal(ocr.dailyCount,1);
 }
});
test('an expired run claim denies the same batch without charging again', async () => {
 const ttl=2;
 assert.equal((await reserveOcr(redis,{userId:'expiry',sessionId:'s'}, {}, new Date(), ttl)).dailyCount,1);
 await new Promise(r=>setTimeout(r,2300));
 const after=await reserveOcr(redis,{userId:'expiry',sessionId:'s'}, {}, new Date(), ttl);
 assert.equal(after.allowed,false);assert.equal(after.limitType,'session_expired');assert.equal(after.dailyCount,1);
 // a genuinely new upload (new sessionId) still charges normally
 assert.equal((await reserveOcr(redis,{userId:'expiry',sessionId:'s2'}, {}, new Date(), ttl)).dailyCount,2);
});
test('a cross-endpoint counter created late in the window dies with the claim', async () => {
 const ttl=2;
 assert.equal((await reserveGeneration(redis,'aligned','s',{},new Date(),ttl)).allowed,true);
 await new Promise(r=>setTimeout(r,1800)); // late in the window
 assert.equal((await reserveOcr(redis,{userId:'aligned',sessionId:'s'},{},new Date(),ttl)).allowed,true);
 await new Promise(r=>setTimeout(r,700)); // claim now expired
 const next=await reserveOcr(redis,{userId:'aligned',sessionId:'s'},{},new Date(),ttl);
 // denied via the tombstone, NOT charged - the late counter did not outlive the claim
 assert.equal(next.allowed,false);assert.equal(next.limitType,'session_expired');assert.equal(next.dailyCount,1);
});
test('a timed-out reservation denies but never corrupts the retry', async () => {
 const hanging={eval:()=>new Promise(()=>{})};
 await assert.rejects(reserveOcr(hanging,{userId:'timeout-retry',sessionId:'s'}),/timeout/);
 const retry=await reserveOcr(redis,{userId:'timeout-retry',sessionId:'s'});
 assert.equal(retry.allowed,true);assert.equal(retry.dailyCount,1);
});
test('a stale frontend-minted session id is denied as expired even after tombstone retention', async () => {
 const stale = `session_${Date.now() - 8 * 86400 * 1000}_abc123`;
 const r = await reserveGeneration(redis, 'stale-user', stale);
 assert.equal(r.allowed, false); assert.equal(r.limitType, 'session_expired'); assert.equal(r.dailyCount, 0);
 // the stale denial wrote no counters: a genuinely fresh id still charges the first credit
 const fresh = await reserveGeneration(redis, 'stale-user', `session_${Date.now()}_xyz789`);
 assert.equal(fresh.allowed, true); assert.equal(fresh.dailyCount, 1);
});
test('session ids outside the frontend format charge within the allowance (tombstone-bounded)', async () => {
 const r = await reserveGeneration(redis, 'legacy-user', 'legacy-id-without-timestamp');
 assert.equal(r.allowed, true); assert.equal(r.dailyCount, 1);
});
