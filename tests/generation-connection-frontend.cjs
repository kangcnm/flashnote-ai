const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const html=fs.readFileSync('index.html','utf8');
for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const start=html.indexOf("const GENERATE_URL="),end=html.indexOf("$('btnGenerateAI').addEventListener",start);
async function scenario(mode){
 const nodes={btnGenerateAI:{textContent:'AI 生成卡片'},generateStatus:{textContent:''},btnCheckConnection:{},connectionStatus:{},notes:{value:'测试笔记'},topic:{value:'测试'},amount:{value:'5'},level:{value:'入门'}};
 let config,post=0,health=0,aborted=0;
 const ctx=vm.createContext({$:id=>nodes[id],Date,Number,String,Array,JSON,Error,AbortController,navigator:{onLine:mode!=='offline'},activeTab:'create',setInterval:()=>1,clearInterval:()=>{},setTimeout:(fn,ms)=>{if(mode==='timeout'&&ms===65000)queueMicrotask(fn);return 1},clearTimeout:()=>{},toast:()=>{},window:{turnstile:{render:(_id,o)=>{config=o;return 'widget'},reset:()=>{}}},fetch:async(url,options)=>{
   if(url.endsWith('/health')){health++;if(mode==='unreachable')throw new TypeError('network');return {ok:true,json:async()=>({ok:true,service:'flashnote-ai-api'})}}
   post++;
   if(mode==='timeout')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(new Error('abort'),{name:'AbortError'}))}));
   if(mode==='null-json')return {ok:true,status:200,json:async()=>null};
   if(mode==='provider-timeout')return {ok:false,status:504,json:async()=>({ok:false,code:'PROVIDER_TIMEOUT',error:'AI 服务响应超过45秒'})};
   throw Object.assign(new Error('network'),{name:'TypeError'});
 }});
 vm.runInContext(html.slice(start,end),ctx);vm.runInContext('initChallenge()',ctx);config.callback('mock-token');
 await vm.runInContext('generateWithAI()',ctx);
 const message=nodes.generateStatus.textContent;
 assert.equal(nodes.btnGenerateAI.disabled,mode!=='offline');
 config.callback('next-token');assert.equal(nodes.generateStatus.textContent,message,'verification must not replace failure details');
 if(mode==='offline'){assert.equal(post,0);assert.match(message,/离线/)}
 else {assert.equal(post,1,'never automatically retry the AI request');
  if(mode==='network'){assert.equal(health,1);assert.match(message,/当前可连接/)}
  if(mode==='unreachable'){assert.equal(health,1);assert.match(message,/无法连接制卡服务器/)}
  if(mode==='timeout'){assert.equal(aborted,1);assert.match(message,/65秒/)}
  if(mode==='provider-timeout'){assert.equal(health,0);assert.match(message,/45秒/)}
  if(mode==='null-json'){assert.equal(health,0);assert.match(message,/返回内容异常/)}
 }
 await vm.runInContext('showConnectionCheck()',ctx);assert.equal(nodes.btnCheckConnection.disabled,false);
}
(async()=>{for(const mode of ['offline','network','unreachable','timeout','provider-timeout','null-json'])await scenario(mode);console.log('PASS: offline guard, failed generation diagnosis with no AI retry, client timeout, provider timeout, malformed response, error preservation, free connection-check button.');})();

