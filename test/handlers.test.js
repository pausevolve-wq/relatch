const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function loadHandler(file, { quota = {}, auth = 'valid', redis = {}, env = {}, fetch = async()=>{throw Error('UNEXPECTED PROVIDER')} } = {}) {
  const calls=[];
  const client={users:{getUser:async()=>({privateMetadata:{}})}};
  const mocks={
    '../lib/security-quota': { reserveGeneration:async()=>({allowed:true}),reserveOcr:async()=>({allowed:true}),reserveDatalab:async()=>false,...quota },
    '@clerk/backend':{verifyToken:async()=>{if(auth==='invalid')throw Error('bad');return{sub:'owner'}},createClerkClient:()=>client},
    '@upstash/redis':{Redis:function(){return redis}},
    '@axiomhq/js':{Axiom:function(){return{ingest(){},flush:async()=>{}}}},
    '../lib/planner':new Proxy({}, {get:()=>async()=>null}),
    '../lib/parachute':{},
  };
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../api',file),'utf8'),{
    module,exports:module.exports,require:n=>mocks[n]||require(n),
    process:{env:{CLERK_SECRET_KEY:'test',UPSTASH_REDIS_REST_URL:'test',UPSTASH_REDIS_REST_TOKEN:'test',...env}},
    console:{log(){},error(){}},fetch:async(...a)=>{calls.push(a);return fetch(...a)},
    setTimeout,clearTimeout,AbortController,Date,Buffer,FormData,Blob,
  },{filename:file});
  return {handler:module.exports,calls};
}
async function invoke(handler, body={}, authorization='Bearer fixture'){
 const response={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(body){this.body=body;return this},end(){return this}};
 await handler({method:'POST',headers:authorization?{authorization}:{},body},response);
 return response;
}
const enrich={rawText:Array.from({length:70},(_,i)=>`instruction${i} explains procedure${i} for task${i}`).join(' '),category:'knowledge',fileName:'test.txt',sessionId:'one'};
const ocr={base64:'YQ==',fileName:'test.pdf',mimeType:'application/pdf'};
for(const file of ['enrich.js','ocr.js']){
 test(`${file}: invalid auth never reaches quota/provider`,async()=>{
  const {handler,calls}=loadHandler(file,{auth:'invalid',quota:{reserveGeneration:()=>{throw Error('NOT REACHED')},reserveOcr:()=>{throw Error('NOT REACHED')}}});
  assert.equal((await invoke(handler,file==='ocr.js'?ocr:enrich)).statusCode,401);assert.equal(calls.length,0);
 });
}
test('generation denied quota stops before planner and provider',async()=>{
 const {handler,calls}=loadHandler('enrich.js',{quota:{reserveGeneration:async()=>({allowed:false,limitType:'daily',weeklyCount:9})}});
 assert.equal((await invoke(handler,enrich)).statusCode,429);assert.equal(calls.length,0);
});
test('generation storage exception fails closed',async()=>{
 const {handler,calls}=loadHandler('enrich.js',{quota:{reserveGeneration:async()=>{throw Error('offline')}}});
 assert.equal((await invoke(handler,enrich)).statusCode,503);assert.equal(calls.length,0);
});
test('invalid generation input never consumes a reservation',async()=>{
 let reservations=0;
 const {handler}=loadHandler('enrich.js',{quota:{reserveGeneration:async()=>{reservations++;return{allowed:true}}}});
 assert.equal((await invoke(handler,{...enrich,rawText:'tiny'})).statusCode,422);assert.equal(reservations,0);
});
test('OCR denied quota never calls any provider',async()=>{
 const {handler,calls}=loadHandler('ocr.js',{quota:{reserveOcr:async()=>({allowed:false,limitType:'daily',weeklyCount:9})}});
 assert.equal((await invoke(handler,ocr)).statusCode,429);assert.equal(calls.length,0);
});
test('OCR storage exception fails closed',async()=>{
 const {handler,calls}=loadHandler('ocr.js',{quota:{reserveOcr:async()=>{throw Error('offline')}}});
 assert.equal((await invoke(handler,ocr)).statusCode,503);assert.equal(calls.length,0);
});
test('OCR malformed input never reaches quota/provider',async()=>{
 let reservations=0;
 const {handler,calls}=loadHandler('ocr.js',{quota:{reserveOcr:async()=>{reservations++;return{allowed:true}}}});
 assert.equal((await invoke(handler,{base64:123,fileName:'x'})).statusCode,400);assert.equal(reservations,0);assert.equal(calls.length,0);
});

test('OCR authorized request reserves before provider and preserves extracted result',async()=>{
 const order=[];
 const {handler,calls}=loadHandler('ocr.js',{env:{MISTRALOCR_API_KEY:'fixture'},quota:{reserveOcr:async()=>{order.push('reserve');return{allowed:true}}},fetch:async()=>{order.push('provider');return{ok:true,json:async()=>({pages:[{markdown:'Source text with enough words to be a useful OCR result. '.repeat(3)}]})}}});
 const result=await invoke(handler,ocr);assert.equal(result.statusCode,200);assert.equal(result.body.source,'mistral');assert.equal(calls.length,1);assert.deepEqual(order,['reserve','provider']);
});
test('anonymous OCR is bounded too, without accepting a forged identity',async()=>{
 let identity;
 const {handler,calls}=loadHandler('ocr.js',{redis:{get:async()=>1,set:async()=>'OK'},quota:{reserveOcr:async(_,value)=>{identity=value;return{allowed:false}}}});
 const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
 await handler({method:'POST',headers:{'x-anon-token':'fixture'},body:{...ocr,sessionId:'batch-1'}},res);
 assert.equal(res.statusCode,429);assert.equal(identity.anonToken,'fixture');assert.equal(identity.userId,null);assert.equal(calls.length,0);
});
test('anonymous OCR without a batch sessionId is rejected before any quota or provider work',async()=>{
 let reached=false;
 const {handler,calls}=loadHandler('ocr.js',{redis:{get:async()=>1,set:async()=>'OK'},quota:{reserveOcr:async()=>{reached=true;return{allowed:true}}}});
 const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
 await handler({method:'POST',headers:{'x-anon-token':'fixture'},body:ocr},res);
 assert.equal(res.statusCode,401);assert.equal(reached,false);assert.equal(calls.length,0);
});
test('anonymous OCR bound to one batch sessionId rejects a second session',async()=>{
 const store={'anon:fixture':1};
 const redis={
  get:async k=>store[k]??null,
  set:async(k,v)=>{ if(k in store){} else {store[k]=v;return 'OK'} return null },
 };
 store['anon:fixture:session']='batch-1';
 let reached=false;
 const {handler,calls}=loadHandler('ocr.js',{redis,quota:{reserveOcr:async()=>{reached=true;return{allowed:true}}}});
 const res={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
 // same session: claim matches, reaches quota
 await handler({method:'POST',headers:{'x-anon-token':'fixture'},body:{...ocr,sessionId:'batch-1'}},res);
 assert.equal(reached,true);
 // different session: rejected as a genuinely new run
 const res2={statusCode:200,setHeader(){},status(n){this.statusCode=n;return this},json(body){this.body=body;return this}};
 await handler({method:'POST',headers:{'x-anon-token':'fixture'},body:{...ocr,sessionId:'batch-2'}},res2);
 assert.equal(res2.statusCode,401);assert.equal(calls.length,0);
});
test('a batch that exhausted its attempt budget is denied without a second charge',async()=>{
 for(const [file,body,quotaKey] of [['enrich.js',enrich,'reserveGeneration'],['ocr.js',{...ocr,sessionId:'one'},'reserveOcr']]){
  const {handler,calls}=loadHandler(file,{quota:{[quotaKey]:async()=>({allowed:false,limitType:'session',dailyCount:1,weeklyCount:1})}});
  const res=await invoke(handler,body);
  assert.equal(res.statusCode,429);assert.equal(res.body.limitType,'session');
  assert.match(res.body.message,/new upload/);assert.equal(calls.length,0);
 }
});
test('signed-in OCR forwards the batch sessionId and migrated Clerk usage to the shared allowance',async()=>{
 let seen;
 const {handler}=loadHandler('ocr.js',{quota:{reserveOcr:async(_r,value,stored)=>{seen={value,stored};return{allowed:false,limitType:'daily',weeklyCount:0}}}});
 const res=await invoke(handler,{...ocr,sessionId:'batch-9'});
 assert.equal(res.statusCode,429);assert.equal(seen.value.sessionId,'batch-9');assert.equal(seen.value.anonToken,null);assert.deepEqual(seen.stored,undefined);
});
