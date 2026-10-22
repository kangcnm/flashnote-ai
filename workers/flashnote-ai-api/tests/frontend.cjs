const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('../../index.html','utf8');
const start=html.indexOf("let turnstileToken=''");
const end=html.indexOf("$('btnGenerateAI').addEventListener",start);
const nodes={btnGenerateAI:{textContent:'AI 生成卡片'},generateStatus:{textContent:''},notes:{value:'测试笔记'},topic:{value:'测试'},amount:{value:'5'},level:{value:'入门'}};
let options,fetchCalls=0,resetCalls=0;
const ctx=vm.createContext({$:id=>nodes[id],Date,Number,String,Array,JSON,Error,AbortSignal,activeTab:'create',setInterval:()=>0,toast:()=>{},window:{turnstile:{render:(_id,o)=>{options=o;return 'widget'},reset:()=>resetCalls++}},fetch:async()=>{fetchCalls++;return {status:429,ok:false,headers:new Headers({'Retry-After':'60'}),json:async()=>({ok:false,code:'MINUTE_LIMIT',error:'生成太频繁',retryAfter:60})}}});
vm.runInContext(html.slice(start,end),ctx);
vm.runInContext('initChallenge()',ctx);
options.callback('test-token');assert.equal(nodes.btnGenerateAI.disabled,false);
awaitPromise();
async function awaitPromise(){
  await vm.runInContext('generateWithAI()',ctx);
  assert.equal(fetchCalls,1);assert.equal(resetCalls,1);
  assert.equal(nodes.btnGenerateAI.disabled,true);assert.match(nodes.generateStatus.textContent,/生成失败：生成太频繁/);
  options.callback('second-token');
  assert.equal(nodes.btnGenerateAI.disabled,true);assert.match(nodes.generateStatus.textContent,/生成失败：生成太频繁/);
  await vm.runInContext('generateWithAI()',ctx);assert.equal(fetchCalls,1);
  vm.runInContext('blockedUntil=Date.now()-1;syncGenerateButton()',ctx);assert.equal(nodes.btnGenerateAI.disabled,false);
  options['expired-callback']();assert.equal(nodes.btnGenerateAI.disabled,true);
  console.log('PASS: 429 countdown blocks clicks, verification refresh preserves the failure message, cooldown release still requires a valid token.');
}

