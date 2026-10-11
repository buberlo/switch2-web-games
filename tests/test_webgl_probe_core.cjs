'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/js/webgl-probe.js'),'utf8');
const acorn=require('acorn');
acorn.parse(source,{ecmaVersion:5});
const output=path.join(root,'data/qa/webgl-research');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-webgl','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const observations=[],errors=[];
 async function page(mode='normal', owner=browser){
  const item=await owner.newPage();item.on('pageerror',error=>errors.push(error.message));
  await item.route('http://webgl-probe.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><button id="tap">Run trusted</button><main id="target"></main>'}));
  await item.goto('http://webgl-probe.test/');
  await item.evaluate(mode=>{
   window.WebAssembly=undefined;window.__mode=mode;window.__calls=[];window.__canvasId=0;window.__lossRequests=0;window.__resources={created:0,deleted:0,live:0,maxLive:0,released:0,callbacks:0};
   if(mode==='no-activation')Object.defineProperty(navigator,'userActivation',{value:undefined});
   const original=HTMLCanvasElement.prototype.getContext,wrapped=new WeakSet();
   HTMLCanvasElement.prototype.getContext=function(name,attrs){
    if(!this.__probeTestId)this.__probeTestId=++window.__canvasId;
    const rect=this.getBoundingClientRect();
    window.__calls.push({name,args:arguments.length,canvasId:this.__probeTestId,attached:!!this.parentNode,trusted:!!window.__trustedEvent,inViewport:!!this.parentNode&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.right>0&&rect.top<innerHeight&&rect.left<innerWidth,rect:{top:rect.top,left:rect.left,width:rect.width,height:rect.height}});
    if(mode==='null'||mode==='no-activation')return null;
    if(mode==='throw')throw new DOMException('Synthetic blocked context','SecurityError');
    if(mode==='creation-error'){setTimeout(()=>{const event=new Event('webglcontextcreationerror');event.statusMessage='Synthetic backend initialization failure';this.dispatchEvent(event);},15);return null;}
    const gl=original.apply(this,arguments);if(!gl)return gl;
    if(!wrapped.has(gl)){
     wrapped.add(gl);window.__resources.live++;window.__resources.maxLive=Math.max(window.__resources.maxLive,window.__resources.live);
     this.addEventListener('webglcontextlost',()=>{window.__resources.live--;window.__resources.released++;});
     for(const kind of ['Buffer','Texture','Shader','Program']){
      const create=gl['create'+kind].bind(gl),remove=gl['delete'+kind].bind(gl);
      gl['create'+kind]=function(){const result=create.apply(null,arguments);if(result)window.__resources.created++;return result;};
      gl['delete'+kind]=function(value){if(value)window.__resources.deleted++;return remove(value);};
     }
     if(mode==='shader-failure')gl.getShaderParameter=function(){return false;};
     if(mode==='readback-failure')gl.readPixels=function(x,y,w,h,format,type,bytes){bytes.fill(0);};
     if(mode==='no-release'||mode==='release-timeout'){
      const get=gl.getExtension.bind(gl);gl.getExtension=function(name){return name==='WEBGL_lose_context'?(mode==='no-release'?null:{loseContext(){}}):get(name);};
     }
     if(mode==='delayed-release'){
      const get=gl.getExtension.bind(gl);gl.getExtension=function(name){const extension=get(name);return name==='WEBGL_lose_context'&&extension?{loseContext(){window.__lossRequests++;setTimeout(()=>extension.loseContext(),150);}}:extension;};
     }
     if(mode==='animation-timeout')window.requestAnimationFrame=function(){return 42;};
    }
    return gl;
   };
  },mode);
  await item.addScriptTag({content:source});return item;
 }
 async function run(item,id){return item.evaluate(id=>new Promise((resolve,reject)=>{
  const spec=SwitchWebGLProbe.cases().find(x=>x.id===id),before=window.__calls.length;let sync=true;
  window.__cancel=SwitchWebGLProbe.runCase(spec,{container:document.getElementById('target')},(error,result)=>{
   window.__resources.callbacks++;if(sync){reject(new Error('Callback was synchronous'));return;}error?reject(error):resolve({result,resources:window.__resources,calls:window.__calls,canvases:document.querySelectorAll('canvas').length});
  });
  if(window.__calls.length!==before+1)reject(new Error('getContext did not execute synchronously'));
  sync=false;
 }),id);}
 try{
  let item=await page();
  const specs=await item.evaluate(()=>SwitchWebGLProbe.cases());assert.equal(specs.length,18);assert.equal(new Set(specs.map(x=>x.id)).size,18);
  for(const id of ['visible-auto-webgl-default','detached-auto-experimental-webgl-minimal','visible-auto-webgl2-minimal']){
   const data=await run(item,id);assert.equal(data.result.contextStatus,'created',JSON.stringify(data.result));
   for(const name of ['clear-readback','triangle','diablo-palette','animation','context-recreation'])assert.equal(data.result.checks.find(x=>x.name===name)?.status,'passed',JSON.stringify(data.result));
   assert.equal(data.result.userActivation.available,true);assert.equal(typeof data.result.userActivation.isActive,'boolean');assert.equal(data.result.visibility,'visible');
   assert.deepEqual(data.result.checks.find(x=>x.name==='diablo-palette').details,{paletteEntries:256,mixedRGBA:true,rowOrientation:true});
   assert.equal(data.result.animation.width,640);assert.equal(data.result.animation.height,480);assert.ok(data.result.animation.frames>1);
   assert.equal(data.result.canvasAtCreation.inViewport,!id.startsWith('detached-auto'));assert.equal(data.result.animation.canvasAtStart.inViewport,true);
   assert.equal(data.result.animation.attached,true);assert.equal(data.result.requiresReload,false);assert.equal(data.result.cleanup.contextLostAcknowledged,true);assert.equal(data.result.cleanup.recreatedReleased,true);
   assert.equal(data.resources.created,data.resources.deleted);assert.equal(data.resources.live,0);assert.equal(data.resources.maxLive,1);assert.equal(data.canvases,0);
   observations.push({scenario:id,...data});
  }
  // The browser supplies a trusted click; context acquisition must be in its stack.
  await item.evaluate(()=>{document.getElementById('tap').addEventListener('click',event=>{
   window.__trustedEvent=event.isTrusted;
   window.__trustedResult=new Promise((resolve,reject)=>SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases().find(x=>x.id==='trusted-tap-webgl-default'),{container:document.getElementById('target'),trustedGesture:event.isTrusted},(error,result)=>error?reject(error):resolve(result)));
   window.__trustedEvent=false;
  });});
  await item.click('#tap');const trusted=await item.evaluate(()=>window.__trustedResult);assert.equal(trusted.trustedGesture,true);assert.equal(trusted.userActivation.isActive,true);assert.equal(trusted.userActivation.hasBeenActive,true);assert.equal(trusted.contextStatus,'created');
  assert.equal(await item.evaluate(()=>window.__calls.some(x=>x.trusted)),true);observations.push({scenario:'actual trusted gesture',result:trusted});await item.close();

  for(const viewport of [{width:1280,height:720},{width:390,height:400}]){
   item=await page();await item.setViewportSize(viewport);
   await item.evaluate(()=>{document.documentElement.style.scrollBehavior='smooth';document.getElementById('target').style.marginTop='2000px';window.scrollTo(0,0);});
   const visible=await run(item,'visible-auto-webgl-minimal');
   assert.equal(visible.calls[0].inViewport,true);assert.equal(visible.result.canvasAtCreation.fullyInViewport,true);assert.equal(visible.result.animation.canvasAtStart.fullyInViewport,true);
   assert.ok(visible.calls.every(x=>x.name!=='2d'));assert.equal(await item.evaluate(()=>document.documentElement.style.scrollBehavior),'smooth');
   observations.push({scenario:'far-below visible container '+viewport.width+'x'+viewport.height,...visible});
   await item.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';window.scrollTo(0,0);});
   const detached=await run(item,'detached-auto-webgl-minimal');
   assert.equal(detached.result.canvasAtCreation.attached,false);assert.equal(detached.result.canvasAtCreation.inViewport,false);assert.equal(detached.result.animation.canvasAtStart.fullyInViewport,true);
   observations.push({scenario:'detached request then onscreen animation '+viewport.width+'x'+viewport.height,...detached});
   await item.evaluate(()=>{document.getElementById('tap').addEventListener('click',event=>{window.__trustedEvent=event.isTrusted;window.__trustedResult=new Promise((resolve,reject)=>SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases().find(x=>x.id==='trusted-tap-webgl-default'),{container:document.getElementById('target'),trustedGesture:event.isTrusted},(error,result)=>error?reject(error):resolve(result)));window.__trustedEvent=false;});});
   await item.click('#tap');const trustedBelow=await item.evaluate(()=>window.__trustedResult);assert.equal(trustedBelow.trustedGesture,true);assert.equal(trustedBelow.userActivation.isActive,true);assert.equal(trustedBelow.canvasAtCreation.fullyInViewport,true);
   const trustedCall=await item.evaluate(()=>window.__calls.find(x=>x.trusted));assert.equal(trustedCall.inViewport,true);
   observations.push({scenario:'far-below canvas scrolled synchronously inside trusted tap '+viewport.width+'x'+viewport.height,result:trustedBelow});await item.close();
  }
  for(const mode of ['null','no-activation','throw','creation-error','shader-failure','readback-failure','no-release','release-timeout','animation-timeout']){
   item=await page(mode);const data=await run(item,'visible-auto-webgl-default');
   if(mode==='null'||mode==='no-activation')assert.equal(data.result.contextStatus,'null');
   if(mode==='no-activation')assert.deepEqual(data.result.userActivation,{available:false,isActive:null,hasBeenActive:null});
   if(mode==='throw'){assert.equal(data.result.contextStatus,'threw');assert.equal(data.result.exception.name,'SecurityError');}
   if(mode==='creation-error'){assert.equal(data.result.contextStatus,'null');assert.deepEqual(data.result.creationErrors,['Synthetic backend initialization failure']);}
   if(mode==='shader-failure')assert.equal(data.result.checks.find(x=>x.name==='triangle').status,'failed');
   if(mode==='readback-failure')assert.equal(data.result.checks.find(x=>x.name==='clear-readback').status,'failed');
   if(mode==='animation-timeout')assert.match(data.result.checks.find(x=>x.name==='animation'&&x.status==='failed').details.message,/five-second/);
   if(mode==='no-release'||mode==='release-timeout'){
    assert.equal(data.result.requiresReload,true);assert.equal(data.result.cleanup.recreated,false);
    const refused=await item.evaluate(()=>new Promise(resolve=>SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases()[0],{container:document.getElementById('target')},error=>resolve(error&&error.message))));assert.match(refused,/Reload/);assert.equal(data.calls.length,1);
   }else{assert.equal(data.resources.live,0);assert.equal(data.result.requiresReload,false);}
   assert.equal(data.resources.created,data.resources.deleted);assert.equal(data.resources.callbacks,1);assert.equal(data.canvases,0);
   observations.push({scenario:mode,...data});await item.close();
  }
  item=await page();const cancellation=await item.evaluate(()=>new Promise(resolve=>{
   let count=0;const cancel=SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases()[0],{container:document.getElementById('target')},(error,result)=>{count++;setTimeout(()=>resolve({result,count,resources:window.__resources,error:error&&error.message}),100);});
   SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases()[0],{container:document.getElementById('target')},error=>{if(!error||!/already running/.test(error.message))throw new Error('Concurrent context was accepted');});
   setTimeout(()=>{cancel();cancel();},100);
  }));assert.equal(cancellation.count,1);assert.equal(cancellation.result.cancelled,true);assert.equal(cancellation.resources.live,0);assert.equal(cancellation.resources.maxLive,1);assert.equal(cancellation.resources.created,cancellation.resources.deleted);observations.push({scenario:'cancel and concurrency',...cancellation});await item.close();
  item=await page('delayed-release');
  const lifecycleCancellation=await item.evaluate(()=>new Promise(resolve=>{
   let count=0;const cancel=SwitchWebGLProbe.runCase(SwitchWebGLProbe.cases()[0],{container:document.getElementById('target')},(error,result)=>{count++;setTimeout(()=>resolve({result,count,resources:window.__resources,calls:window.__calls}),100);});
   const watcher=setInterval(()=>{if(window.__lossRequests){clearInterval(watcher);cancel();cancel();}},5);
  }));
  assert.equal(lifecycleCancellation.count,1);assert.equal(lifecycleCancellation.result.cancelled,true);assert.equal(lifecycleCancellation.result.cleanup.recreated,false);assert.equal(lifecycleCancellation.resources.live,0);assert.equal(lifecycleCancellation.calls.length,1);observations.push({scenario:'cancellation during acknowledged-release wait',...lifecycleCancellation});await item.close();
  const disabled=await chromium.launch({channel:'chrome',headless:true,args:['--disable-webgl','--js-flags=--jitless']});
  try{
   item=await page('normal',disabled);
   for(const spec of specs){const data=await run(item,spec.id);assert.equal(data.result.contextStatus,'null');assert.equal(data.result.requiresReload,false);assert.equal(data.calls[data.calls.length-1].args,spec.attributes===null?1:2);}
   const calls=await item.evaluate(()=>window.__calls);assert.equal(calls.length,18);assert.equal(new Set(calls.map(x=>x.canvasId)).size,18);assert.ok(calls.every(x=>x.name!=='2d'));
   observations.push({scenario:'real disabled WebGL, all 18 fresh contexts, omitted attributes preserved',calls});await item.close();
  }finally{await disabled.close();}
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'core-results.json'),JSON.stringify({es5:true,observations,errors},null,2));
  console.log(JSON.stringify({passed:observations.length,es5:true,errors,artifact:path.join(output,'core-results.json')},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
