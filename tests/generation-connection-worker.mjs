import assert from 'node:assert/strict';
import worker from '../workers/flashnote-ai-api/worker.mjs';
const realTimeout=globalThis.setTimeout,realClear=globalThis.clearTimeout;
let timeoutCallback,cleared=0,aiCalls=0,mode='ok';
globalThis.setTimeout=(fn,ms)=>{assert.equal(ms,45000);timeoutCallback=fn;return 1};
globalThis.clearTimeout=()=>cleared++;
globalThis.fetch=async(url,options)=>{
  if(url.includes('siteverify'))return Response.json({success:true,hostname:'kangcnm.github.io',action:'generate'});
  aiCalls++;
  const payload=JSON.parse(options.body);assert.ok(payload.max_tokens<4096);assert.equal(payload.thinking.type,'disabled');
  if(mode==='network')throw new TypeError('mock network');
  if(mode==='timeout')return new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));queueMicrotask(timeoutCallback)});
  if(mode==='body-timeout')return {ok:true,json:()=>new Promise((_resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')));queueMicrotask(timeoutCallback)})};
  if(mode==='html')return new Response('not JSON');
  if(mode==='unauthorized')return new Response('',{status:401});
  return Response.json({choices:[{finish_reason:mode==='length'?'length':'stop',message:{content:JSON.stringify({cards:[null,{question:'问题',answer:'答案'}]})}}]});
};
async function run(selected,status,code){mode=selected;const before=cleared;const res=await worker.fetch(new Request('https://local.example/api/generate',{method:'POST',headers:{Origin:'https://kangcnm.github.io','Content-Type':'application/json'},body:JSON.stringify({notes:'笔记',amount:5,turnstileToken:'mock'})}),{DEEPSEEK_API_KEY:'mock',TURNSTILE_SECRET_KEY:'mock'});assert.equal(res.status,status);assert.equal(res.headers.get('Access-Control-Allow-Origin'),'https://kangcnm.github.io');assert.equal(cleared,before+1);const data=await res.json();if(code)assert.equal(data.code,code);return data;}
try{
  assert.equal((await run('ok',200)).cards.length,1);
  await run('network',502,'PROVIDER_NETWORK');
  await run('timeout',504,'PROVIDER_TIMEOUT');
  await run('body-timeout',504,'PROVIDER_TIMEOUT');
  await run('html',502,'PROVIDER_RESPONSE');
  await run('length',502,'OUTPUT_LIMIT');
  assert.equal((await run('unauthorized',502)).providerStatus,401);
  assert.equal(aiCalls,7,'no automatic provider retries');
  console.log('PASS: timeout before headers and during body, network failure, invalid provider JSON, truncated output, null-card filtering, CORS, timer cleanup, no paid retries.');
}finally{globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear}

