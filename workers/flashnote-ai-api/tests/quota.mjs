import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {quotaDecision} from '../quota.mjs';

// Deterministic clock tests, including Beijing midnight and a sliding minute.
const start=Date.parse('2026-10-22T12:00:00+08:00');
let d=quotaDecision(null,start);let state=d.state;
d=quotaDecision(state,start+1);state=d.state;
assert.equal(quotaDecision(state,start+59999).code,'MINUTE_LIMIT');
assert.equal(quotaDecision(state,start+60000).allowed,true);
state=null;
for(let i=0;i<20;i++){d=quotaDecision(state,start+i*60001);assert.equal(d.allowed,true);state=d.state;}
assert.equal(quotaDecision(state,start+20*60001).code,'DAILY_LIMIT');
assert.equal(quotaDecision(state,Date.parse('2026-10-23T00:00:00+08:00')).allowed,true);
assert.equal(quotaDecision(state,Date.parse('2026-10-22T23:59:59+08:00')).code,'DAILY_LIMIT');
const nearMidnight=Date.parse('2026-10-22T23:59:59+08:00');
state=quotaDecision(null,nearMidnight).state;
state=quotaDecision(state,nearMidnight+1).state;
assert.equal(quotaDecision(state,nearMidnight+1000).code,'MINUTE_LIMIT','daily reset must not bypass the sliding minute');
assert.equal(quotaDecision(state,nearMidnight+60000).allowed,true);

let providerCalls=0,verificationCalls=0;
let rejectChallenge=false;
const options={
  modules:true,
  modulesRoot:new URL('../',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),
  scriptPath:new URL('../worker.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),
  compatibilityDate:'2026-08-06',
  durableObjects:{GENERATION_QUOTA:{className:'GenerationQuota',useSQLite:true}},
  durableObjectsPersist:new URL('./state',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),
  bindings:{TURNSTILE_SECRET_KEY:'local-test-secret',DEEPSEEK_API_KEY:'local-test-secret'},
  outboundService:async req=>{
    if(req.url.includes('siteverify')){
      verificationCalls++;
      return Response.json(rejectChallenge?{success:false,'error-codes':['invalid-input-response']}:{success:true,hostname:'kangcnm.github.io',action:'generate'});
    }
    if(req.url.includes('api.deepseek.com')){
      providerCalls++;
      return Response.json({choices:[{message:{content:JSON.stringify({cards:[{question:'问题',answer:'答案'}]})}}]});
    }
    throw Error('Unexpected outbound request');
  }
};
let mf=new Miniflare(options);
const unique=String(Date.now());
const request=(ip,token='mock-token')=>mf.dispatchFetch('https://local.example/api/generate',{
  method:'POST',headers:{Origin:'https://kangcnm.github.io','Content-Type':'application/json','CF-Connecting-IP':ip},
  body:JSON.stringify({notes:'本地模拟测试',amount:5,turnstileToken:token})
});
try{
  const ip='test-ip-'+unique;
  let responses=await Promise.all(Array.from({length:10},()=>request(ip)));
  assert.equal(responses.filter(r=>r.status===200).length,2);
  assert.equal(responses.filter(r=>r.status===429).length,8);
  assert.equal(providerCalls,2);
  const blocked=responses.find(r=>r.status===429);
  assert.ok(Number(blocked.headers.get('Retry-After'))>0);
  assert.equal(blocked.headers.get('Access-Control-Allow-Origin'),'https://kangcnm.github.io');
  assert.equal((await blocked.json()).code,'MINUTE_LIMIT');
  assert.equal((await request('other-ip-'+unique)).status,200);
  const before=providerCalls;
  rejectChallenge=true;
  assert.equal((await request('invalid-'+unique)).status,403);
  assert.equal(providerCalls,before);
  rejectChallenge=false;
  assert.equal((await request('invalid-'+unique)).status,200);
  assert.equal((await request('invalid-'+unique)).status,200);
  assert.equal((await request('invalid-'+unique)).status,429);
  await mf.dispose();
  mf=new Miniflare(options);
  assert.equal((await request(ip)).status,429,'restart must preserve quota');
  const namespace=await mf.getDurableObjectNamespace('GENERATION_QUOTA');
  const doid=namespace.idFromName('daily-test-'+unique);
  const stub=namespace.get(doid);
  // Verify storage-backed object by consuming across real requests; daily boundary math above uses the same decision function.
  assert.equal((await stub.fetch('https://quota.internal/consume',{method:'POST'})).status,200);
  console.log('PASS: 10 concurrent requests allow exactly 2 AI calls; rejected requests never call AI; separate IPs; restart persistence; CORS/Retry-After; rolling minute and Beijing day reset.');
}finally{await mf.dispose()}

