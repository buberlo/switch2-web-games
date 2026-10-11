/* Local diagnostic profile, not a Switch performance qualification.
 * PROFILE_WEB_ROOT selects an immutable web snapshot; PROFILE_ENTRY=legacy|direct
 * selects its startup flow. PROFILE_RATES=1,4,12 throttles the PAGE, not the worker.
 * Example: PLAYWRIGHT_MODULE=/path/to/playwright node tests/performance_probe.cjs
 */
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawn}=require('child_process');
const assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..');
const source=path.resolve(process.env.PROFILE_WEB_ROOT||path.join(root,'web'));
const label=(process.env.PROFILE_LABEL||'current').replace(/[^a-zA-Z0-9_-]/g,'_');
const entry=process.env.PROFILE_ENTRY||'direct';
const duration=Number(process.env.PROFILE_DURATION_MS||4000);
const rates=(process.env.PROFILE_RATES||'1,4,12').split(',').map(Number);
const port=Number(process.env.PROFILE_PORT||8092),origin='http://127.0.0.1:'+port;
const output=path.join(root,'data','qa','performance-'+label);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'switch-arcade-profile-'));
fs.mkdirSync(output,{recursive:true});
fs.cpSync(source,path.join(temp,'web'),{recursive:true});
fs.mkdirSync(path.join(temp,'data','assets'),{recursive:true});
fs.copyFileSync(path.join(root,'data','assets','spawn.mpq'),path.join(temp,'data','assets','spawn.mpq'));
const server=spawn(process.env.PYTHON||'python3',[path.join(root,'server','portal.py'),'--root',temp,'--host','127.0.0.1','--port',String(port)],{stdio:['ignore','pipe','pipe']});
let serverLog='',browser;
server.stderr.on('data',chunk=>{serverLog+=String(chunk);});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// These wrappers are added to test responses only, after the real host source.
const workerInstrumentation=`
(function(){
 var stats=self.__probe={calls:{},renderMessages:0,renderBytes:0};
 self.__probeReset=function(){stats=self.__probe={calls:{},renderMessages:0,renderBytes:0};};
 function record(name,elapsed){var item=stats.calls[name]||(stats.calls[name]={count:0,totalMs:0,maxMs:0,samples:[]});item.count++;item.totalMs+=elapsed;item.maxMs=Math.max(item.maxMs,elapsed);if(item.samples.length<4000)item.samples.push(elapsed);}
 function wrap(object,name,key){var original=object[name];if(typeof original!=='function')return;var timed=function(){var start=performance.now();try{return original.apply(this,arguments);}finally{record(key,performance.now()-start);}};Object.defineProperty(object,name,{configurable:true,get:function(){return timed;},set:function(value){original=value;}});}
 var factory=self.DiabloSpawn;
 self.DiabloSpawn=function(options){var start=performance.now();return factory(options).then(function(module){record('moduleFactory',performance.now()-start);wrap(module,'_DApi_Init','engineInit');wrap(module,'_DApi_Render','engineRenderInclusive');return module;});};
 var create=self.createDiabloHost;
 self.createDiabloHost=function(emit){
  var host=create(function(message,transfers){
   if(message.action==='render'){
    message.__probeEpoch=performance.timeOrigin+performance.now();stats.renderMessages++;
    if(message.batch&&message.batch.images)message.batch.images.forEach(function(rect){stats.renderBytes+=rect.bytes.byteLength;});
   }
   var start=performance.now();try{return emit(message,transfers);}finally{record('emit-'+message.action,performance.now()-start);}
  });
  wrap(self.DApi,'draw_blit','adapterCopyRect');wrap(self.DApi,'draw_end','adapterDrawEndInclusive');
  return host;
 };
})();`;

function summarize(stats){
  const result=JSON.parse(JSON.stringify(stats));
  for(const key of Object.keys(result.calls||{})){
    const item=result.calls[key],values=item.samples.slice().sort((a,b)=>a-b);
    item.meanMs=item.count?item.totalMs/item.count:0;
    item.p50Ms=values.length?values[Math.floor((values.length-1)*.5)]:0;
    item.p95Ms=values.length?values[Math.floor((values.length-1)*.95)]:0;
    delete item.samples;
  }
  return result;
}

async function attachWorkerCDP(browserSession,targetId){
  const attached=await browserSession.send('Target.attachToTarget',{targetId,flatten:false});
  let nextId=0;
  const pending=new Map();
  browserSession.on('Target.receivedMessageFromTarget',event=>{
    if(event.sessionId!==attached.sessionId)return;
    const message=JSON.parse(event.message),job=pending.get(message.id);
    if(!job)return;pending.delete(message.id);clearTimeout(job.timer);
    if(message.error)job.reject(new Error(message.error.message));else job.resolve(message.result);
  });
  return {send(method,params={}){
    const id=++nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},5000);
      pending.set(id,{resolve,reject,timer});
      browserSession.send('Target.sendMessageToTarget',{sessionId:attached.sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{clearTimeout(timer);pending.delete(id);reject(error);});
    });
  }};
}

(async()=>{
  let healthy=false;
  for(let i=0;i<60;i++){try{const response=await fetch(origin+'/healthz');if(response.ok&&(await response.json()).pid===server.pid){healthy=true;break;}}catch{}await delay(100);}
  assert(healthy,'Temporary profile server did not start: '+serverLog);
  browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('**/js/diablo-host.js',route=>route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(temp,'web','js','diablo-host.js'),'utf8')+workerInstrumentation}));
  await context.addInitScript(()=>{
    window.WebAssembly=undefined;window.SharedArrayBuffer=undefined;
    const originalContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).includes('webgl'))return null;return originalContext.call(this,type,...args);};
    let stats=window.__probe={calls:{},renderMessages:0};
    window.__probeReset=()=>{stats=window.__probe={calls:{},renderMessages:0};};
    function record(name,elapsed){const item=stats.calls[name]||(stats.calls[name]={count:0,totalMs:0,maxMs:0,samples:[]});item.count++;item.totalMs+=elapsed;item.maxMs=Math.max(item.maxMs,elapsed);if(item.samples.length<4000)item.samples.push(elapsed);}
    for(const name of ['createImageData','putImageData','drawImage','fillText']){
      const method=CanvasRenderingContext2D.prototype[name];
      CanvasRenderingContext2D.prototype[name]=function(...args){const start=performance.now();try{return method.apply(this,args);}finally{if(this.canvas.id==='screen')record(name,performance.now()-start);}};
    }
    const NativeWorker=window.Worker,descriptor=Object.getOwnPropertyDescriptor(NativeWorker.prototype,'onmessage');
    window.Worker=function(...args){
      const worker=new NativeWorker(...args);let handler=null;
      Object.defineProperty(worker,'onmessage',{configurable:true,get(){return handler;},set(value){handler=value;descriptor.set.call(worker,typeof value!=='function'?value:function(event){
        const isRender=event.data&&event.data.action==='render',start=performance.now();
        if(isRender&&typeof event.data.__probeEpoch==='number')record('workerToPageLag',performance.timeOrigin+start-event.data.__probeEpoch);
        try{return value.call(this,event);}finally{if(isRender){record('renderHandlerInclusive',performance.now()-start);stats.renderMessages++;}}
      });}});
      return worker;
    };
    window.Worker.prototype=NativeWorker.prototype;
  });
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const pageCDP=await context.newCDPSession(page),browserCDP=await browser.newBrowserCDPSession();
  await pageCDP.send('Performance.enable');
  await page.goto(origin+'/play/diablo?compat=1');
  const began=Date.now();
  const workerPromise=page.waitForEvent('worker');
  await page.getByRole('button',{name:'Play Diablo',exact:true}).click();
  const worker=await workerPromise;
  await page.waitForFunction(()=>window.diabloStatus.loaded||window.diabloStatus.error,{},{timeout:120000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  const result={label,entry,browserVersion:browser.version(),source,sourceHashes:{},loadedWallMs:Date.now()-began,instrumentation:'Test response wrappers; engineRenderInclusive includes adapter callbacks. Page CDP CPU throttling does not throttle the Worker. Synthetic slowdown is not a model of the Switch CPU.',segments:[]};
  for(const file of ['engine/DiabloSpawn.js','js/diablo-host.js','js/diablo.js'])result.sourceHashes[file]=crypto.createHash('sha256').update(fs.readFileSync(path.join(temp,'web',file))).digest('hex');
  const targets=(await browserCDP.send('Target.getTargets')).targetInfos;
  const workerTarget=targets.find(target=>target.type==='worker'&&target.url===worker.url());
  let workerCDP=null;
  if(workerTarget){
    try{
      workerCDP=await attachWorkerCDP(browserCDP,workerTarget.targetId);
      await workerCDP.send('Profiler.enable');
      // A neutral rate probes support without changing Worker speed.
      try{await workerCDP.send('Emulation.setCPUThrottlingRate',{rate:1});result.workerThrottle='Worker accepted the neutral command; only page throttling is used below.';}
      catch(error){result.workerThrottle='Unsupported on Worker target: '+error.message;}
    }catch(error){result.workerProfilerError=error.message;workerCDP=null;}
  }
  result.initialWorker=summarize(await worker.evaluate(()=>self.__probe));

  async function segment(scene,rate,ms=duration){
    await pageCDP.send('Emulation.setCPUThrottlingRate',{rate});
    await delay(200);
    await page.evaluate(()=>window.__probeReset());
    await worker.evaluate(()=>self.__probeReset());
    const before=await page.evaluate(()=>({frames:window.diabloStatus.frames,at:performance.now()}));
    if(workerCDP)await workerCDP.send('Profiler.start');
    await delay(ms);
    let cpuProfile=null;if(workerCDP)cpuProfile=(await workerCDP.send('Profiler.stop')).profile;
    const after=await page.evaluate(()=>({frames:window.diabloStatus.frames,at:performance.now(),error:window.diabloStatus.error,state:window.diabloStatus,stats:window.__probe}));
    assert.equal(after.error,null);
    const workerStats=await worker.evaluate(()=>self.__probe);
    const item={scene,pageCPUThrottle:rate,workerCPUThrottle:1,wallMs:after.at-before.at,presentedFrames:after.frames-before.frames,presentedFPS:(after.frames-before.frames)*1000/(after.at-before.at),worker:summarize(workerStats),page:summarize(after.stats),state:after.state};
    if(cpuProfile){
      const counts=new Map();for(const node of cpuProfile.samples||[])counts.set(node,(counts.get(node)||0)+1);
      item.workerCPUTop=cpuProfile.nodes.filter(node=>counts.has(node.id)).map(node=>({function:node.callFrame.functionName||'(anonymous)',url:node.callFrame.url,line:node.callFrame.lineNumber+1,samples:counts.get(node.id)})).sort((a,b)=>b.samples-a.samples).slice(0,12);
      fs.writeFileSync(path.join(output,scene+'-'+rate+'x.cpuprofile'),JSON.stringify(cpuProfile));
    }
    await page.screenshot({path:path.join(output,scene+'-'+rate+'x.png')});
    result.segments.push(item);
    console.log(JSON.stringify({scene,rate,fps:item.presentedFPS,engineRender:item.worker.calls.engineRenderInclusive,mainRender:item.page.calls.renderHandlerInclusive,delivery:item.page.calls.workerToPageLag}));
  }

  await segment(entry==='legacy'?'startup-intro-or-title':'startup-direct-menu',1,2500);
  if(entry==='legacy'){await page.keyboard.press('Escape');await delay(500);await page.keyboard.press('Enter');await delay(500);}
  // The fresh main menu is stable before selecting Single Player.
  for(const rate of rates)await segment('main-menu',rate);
  await pageCDP.send('Emulation.setCPUThrottlingRate',{rate:1});
  await page.keyboard.press('Enter');await delay(500);
  await page.keyboard.press('Enter');
  await page.locator('#game-text').waitFor({state:'visible',timeout:20000});
  await page.locator('#game-text').fill('ProfileHero');
  await page.locator('#text-entry').getByRole('button',{name:'Confirm',exact:true}).click();
  await delay(3500);
  for(const rate of rates)await segment('town-idle',rate);
  result.errors=errors;assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'profile.json'),JSON.stringify(result,null,2));
  console.log('Profile saved to '+path.join(output,'profile.json'));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();fs.rmSync(temp,{recursive:true,force:true});});
