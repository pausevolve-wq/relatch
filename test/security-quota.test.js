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
test('concurrent same batch permits only 25 attempts total across 5 sessions', async () => {
 const rows = await Promise.all(Array.from({length:60}, () => reserveGeneration(redis,'same','one')));
 assert.equal(rows.filter(x=>x.allowed).length,25);
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
test('same client session is not shared across users or UTC days',async()=>{
 for(let i=0;i<5;i++)await reserveGeneration(redis,'day-boundary','same',{},new Date('2026-10-21T12:00:00Z'));
 const next=await reserveGeneration(redis,'day-boundary','same',{},new Date('2026-10-22T12:00:00Z'));
 assert.equal(next.dailyCount,1);assert.equal(next.allowed,true);
 assert.equal((await reserveGeneration(redis,'different-user','same')).dailyCount,1);
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
test('per-endpoint session caps still bind inside a paid run', async () => {
 for(let i=0;i<5;i++)assert.equal((await reserveGeneration(redis,'caps','run-1')).allowed,true);
 const sixth=await reserveGeneration(redis,'caps','run-1');
 assert.equal(sixth.allowed,true);assert.equal(sixth.dailyCount,2);
 for(let i=0;i<5;i++)assert.equal((await reserveOcr(redis,{userId:'caps',sessionId:'run-1'})).allowed,true);
 const ocrSixth=await reserveOcr(redis,{userId:'caps',sessionId:'run-1'});
 assert.equal(ocrSixth.dailyCount,3);
});
