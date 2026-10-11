/* Run with Node and PLAYWRIGHT_MODULE pointing at the installed playwright package. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {spawn,spawnSync} = require('child_process');
const assert = require('assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const gpuEnabled=process.env.SMOKE_GPU==='1';
const bmpEnabled=process.env.SMOKE_BMP==='1';
assert(!(gpuEnabled&&bmpEnabled),'choose one renderer per smoke run');
const rendererQuery=bmpEnabled?'&renderer=bmp':'';
const artifactDir = path.join(root,'data','qa',bmpEnabled?'bmp-smoke':gpuEnabled?'gpu-smoke':'.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'switch-arcade-browser-'));
fs.mkdirSync(artifactDir,{recursive:true});
fs.cpSync(path.join(root,'web'),path.join(temp,'web'),{recursive:true});
fs.mkdirSync(path.join(temp,'data','assets'),{recursive:true});
fs.copyFileSync(path.join(root,'data','assets','spawn.mpq'),path.join(temp,'data','assets','spawn.mpq'));
const identity=spawnSync(process.env.PYTHON||'python3',[path.join(root,'scripts','build_runtime.py'),'--root',temp],{encoding:'utf8'});
assert.equal(identity.status,0,identity.stderr);
const build=JSON.parse(fs.readFileSync(path.join(temp,'web','engine','build.json'),'utf8'));
const runtime=JSON.parse(fs.readFileSync(path.join(temp,'web','assets','runtime.json'),'utf8'));
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(temp,'web','engine','DiabloSpawn.js'))).digest('hex'),build.sha256,'manifest must identify the actual tested engine');
const server = spawn(process.env.PYTHON || 'python3',[path.join(root,'server','portal.py'),'--root',temp,'--host','127.0.0.1','--port','8091'],{stdio:['ignore','pipe','pipe']});
let browser;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  let healthy=false;
  for(let i=0;i<50;i++){try{const r=await fetch('http://127.0.0.1:8091/healthz');if(r.ok){const h=await r.json();if(h.pid===server.pid){healthy=true;break;}}}catch{}await delay(100);}
  assert(healthy,'test server did not become ready');
  browser=await chromium.launch({channel:'chrome',headless:true,args:gpuEnabled?['--enable-unsafe-swiftshader']:[]});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('**/js/diablo-renderer.js',route=>route.fulfill({contentType:'application/javascript',body:fs.readFileSync(path.join(temp,'web/js/diablo-renderer.js'),'utf8')+`
;(function(){var factory=window.createDiabloRenderer;window.__testRendererFrames=[];window.createDiabloRenderer=function(canvas,options){var renderer=factory(canvas,options),present=renderer.present,draw=renderer.draw;function record(result,began){window.__testRendererFrames.push({phase:window.diabloStatus.phase||'menu',milliseconds:performance.now()-began,paletteChanged:result.paletteChanged,convertedPixels:result.convertedPixels,skippedPixels:result.skippedPixels,mode:result.mode,encodeMs:result.encodeMs,decodeMs:result.decodeMs});if(window.__testRendererFrames.length>1000)window.__testRendererFrames.shift();}if(present){renderer.present=function(batch,done){var began=performance.now();return present(batch,function(error,result){if(!error)record(result,began);done(error,result);});};}else{renderer.draw=function(batch){var began=performance.now(),result=draw(batch);record(result,began);return result;};}return renderer;};}());`}));
  await context.addInitScript(({gpuEnabled})=>{
    window.WebAssembly=undefined;window.SharedArrayBuffer=undefined;window.TextDecoder=undefined;
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){if(!gpuEnabled&&String(type).includes('webgl'))return null;return original.call(this,type,...args);};
    // Observe actual game input at the Worker boundary, without a production hook.
    window.__testMouseMessages=[];window.__testInputMessages=[];
    const postMessage=Worker.prototype.postMessage;
    const held=[];
    window.__testReleaseNameConfirmation=()=>{window.__testHoldNameConfirmation=false;while(held.length){const item=held.shift();postMessage.call(item.worker,item.message,...item.args);}};
    Worker.prototype.postMessage=function(message,...args){
      if(message&&message.action==='event')window.__testInputMessages.push({name:message.name,args:message.args.slice(),id:message.id});
      if(message&&message.action==='event'&&message.name==='DApi_Mouse'){
        window.__testMouseMessages.push(message.args.slice());
        if(window.__testMouseMessages.length>64)window.__testMouseMessages.shift();
      }
      // Hold the real confirmation Enter at the transport boundary so the test
      // can exercise the loading input barrier deterministically on a fast Mac.
      if(window.__testHoldNameConfirmation&&message&&message.action==='event'&&message.name==='DApi_Key'&&message.args[2]===13){held.push({worker:this,message,args});return;}
      return postMessage.call(this,message,...args);
    };
  },{gpuEnabled});
  const page=await context.newPage(), errors=[], requests=[], manifestResponses=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(request.url()));
  page.on('response',response=>{if(response.url().endsWith('/engine/build.json'))manifestResponses.push(response.status());});
  await page.goto('http://127.0.0.1:8091/play/diablo?compat=1'+rendererQuery);
  await page.getByRole('button',{name:'Play Diablo',exact:true}).click();
  await page.waitForFunction(()=>window.diabloStatus.loaded||window.diabloStatus.error,{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  await page.waitForFunction(()=>window.diabloStatus.frames>35);
  await page.screenshot({path:path.join(artifactDir,'diablo-initial.png')});
  await page.keyboard.press('Enter');await delay(500);
  await page.screenshot({path:path.join(artifactDir,'diablo-menu.png')});
  await page.keyboard.press('Enter');
  await page.locator('#game-text').waitFor({state:'visible'});
  await page.locator('#game-text').fill('BrowserProof');
  await page.evaluate(()=>{window.__testHoldNameConfirmation=true;window.__testInputMessages=[];});
  await page.locator('#text-entry').getByRole('button',{name:'Confirm',exact:true}).click();
  assert.equal(await page.locator('#text-entry').isVisible(),false,'confirmation must close the name overlay');
  assert.equal(await page.locator('#loading-overlay').isVisible(),true,'world preparation must have visible feedback');
  assert.equal(await page.getByRole('button',{name:'Inventory',exact:true}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.diabloStatus.inputBlocked),true);
  const beforeBlockedInput=await page.evaluate(()=>window.__testInputMessages.length);
  await page.keyboard.press('Escape');
  await page.locator('#screen').dispatchEvent('mousedown',{button:0,clientX:100,clientY:100});
  const blockedInputMessages=await page.evaluate(start=>window.__testInputMessages.slice(start),beforeBlockedInput);
  assert(!blockedInputMessages.some(message=>message.name==='DApi_Mouse'||message.name==='DApi_Key'&&message.args[0]===0),'new pointer/key presses must not reach the loading engine');
  const blockedState=await page.evaluate(()=>window.diabloStatus);
  await page.screenshot({path:path.join(artifactDir,'diablo-character-loading.png')});
  await page.evaluate(()=>window.__testReleaseNameConfirmation());
  await page.waitForFunction(()=>window.diabloStatus.error||window.diabloStatus.inputBlocked===false&&window.diabloStatus.pendingInputId===null&&['game-ready','loading-end'].includes(window.diabloStatus.phase),{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  assert.equal(await page.locator('#loading-overlay').isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Inventory',exact:true}).isDisabled(),false);
  await delay(1200);
  await page.screenshot({path:path.join(artifactDir,'diablo-town.png')});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  const townPixels=await page.locator('#screen').evaluate(c=>c.toDataURL());
  await page.getByRole('button',{name:'Inventory',exact:true}).click();await delay(200);
  await page.screenshot({path:path.join(artifactDir,'diablo-inventory.png')});
  assert.notEqual(await page.locator('#screen').evaluate(c=>c.toDataURL()),townPixels);
  await page.getByRole('button',{name:'Inventory',exact:true}).click();
  const box=await page.locator('#screen').boundingBox();
  assert(Math.abs(box.width-640)>50,'coordinate check must exercise a scaled game canvas');
  await page.evaluate(()=>{window.__testMouseMessages=[];});
  await page.mouse.click(box.x+400/640*box.width,box.y+280/480*box.height);await delay(1200);
  const pointerMessages=await page.evaluate(()=>window.__testMouseMessages);
  assert(pointerMessages.some(args=>args[0]===1&&args[1]===1&&args[3]===400&&args[4]===280),'scaled click must reach the engine as left-down at (400,280)');
  assert(pointerMessages.some(args=>args[0]===2&&args[1]===1&&args[3]===400&&args[4]===280),'scaled click must release at the same engine coordinates');
  await page.getByRole('button',{name:'Game menu',exact:true}).click();await delay(250);
  await page.screenshot({path:path.join(artifactDir,'diablo-save-menu.png')});
  await page.keyboard.press('Enter');await delay(750);
  await page.waitForFunction(()=>document.getElementById('save-status').textContent==='Saved on Mac');
  assert(fs.statSync(path.join(temp,'data','saves','spawn0.sv')).size>1000);
  // In-game Load uses a different engine path from opening a saved hero.
  // Observe its real phase reports and ensure it returns control to the page.
  await page.evaluate(()=>{
    window.__testLoadPhases=[];
    const report=Portal.report;
    Portal.report=function(snapshot){
      if(snapshot.event==='phase')window.__testLoadPhases.push({name:snapshot.name,details:snapshot.details});
      return report.call(this,snapshot);
    };
  });
  await page.getByRole('button',{name:'Game menu',exact:true}).click();
  for(let i=0;i<3;i++)await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.diabloStatus.error||window.__testLoadPhases.some(value=>value.name==='loading-start')&&window.__testLoadPhases.some(value=>value.name==='game-ready')&&!window.diabloStatus.inputBlocked,{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  assert.equal(await page.locator('#loading-overlay').isVisible(),false);
  assert.equal(await page.getByRole('button',{name:'Inventory',exact:true}).isDisabled(),false);
  await delay(500);
  await page.screenshot({path:path.join(artifactDir,'diablo-in-game-loaded.png')});
  const inGameLoad=await page.evaluate(()=>({state:window.diabloStatus,phases:window.__testLoadPhases}));
  assert.equal(inGameLoad.phases[0].name,'loading-start');
  assert.equal(inGameLoad.phases[inGameLoad.phases.length-1].name,'game-ready');
  assert.equal(inGameLoad.state.phase,'game-ready');
  const result=await page.evaluate(()=>({state:window.diabloStatus,webAssembly:typeof WebAssembly,pixelSample:Array.from(document.getElementById('screen').getContext('2d').getImageData(200,100,1,1).data)}));
  result.inGameLoad=inGameLoad;
  result.browserVersion=browser.version();
  result.gpuEnabled=gpuEnabled;
  result.bmpEnabled=bmpEnabled;
  result.rendererFrames=await page.evaluate(()=>window.__testRendererFrames);
  result.characterLoading={blockedState,blockedInputMessages,completedState:await page.evaluate(()=>window.diabloStatus)};
  await page.goto('http://127.0.0.1:8091/play/diablo?compat=1&main=1'+rendererQuery);
  await page.getByRole('button',{name:'Play Diablo',exact:true}).click();
  await page.waitForFunction(()=>window.diabloStatus.loaded||window.diabloStatus.error,{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  await page.waitForFunction(()=>window.diabloStatus.frames>35);
  await page.keyboard.press('Enter');await delay(400);
  await page.keyboard.press('Enter');await delay(400);
  await page.keyboard.press('Enter');await delay(3500);
  await page.screenshot({path:path.join(artifactDir,'diablo-restored-main.png')});
  result.restoredMain=await page.evaluate(()=>window.diabloStatus);
  assert.equal(result.restoredMain.save,'spawn0.sv');
  assert.equal(result.restoredMain.mode,'JavaScript · main thread');
  assert.equal(result.restoredMain.error,null);
  assert.equal(result.restoredMain.inputBlocked,false);
  assert(['game-ready','loading-end'].includes(result.restoredMain.phase));
  result.scaledPointer={canvasWidth:box.width,canvasHeight:box.height,engineCoordinates:[400,280],messages:pointerMessages};
  // A lost asset transfer must stop visibly; the offered reload must recover.
  const archiveRoute='**/game-data/spawn.mpq';
  let abortedArchives=0;
  await page.route(archiveRoute,route=>{abortedArchives++;return route.abort('failed');});
  await page.goto('http://127.0.0.1:8091/play/diablo?compat=1'+rendererQuery);
  await page.getByRole('button',{name:'Play Diablo',exact:true}).click();
  await page.locator('#failure').waitFor({state:'visible'});
  await page.waitForFunction(()=>window.diabloStatus.error!==null);
  assert.equal(abortedArchives,1,'the failure must come from the intercepted archive request');
  assert.match(await page.locator('#error-message').textContent(),/Connection to the Mac was lost/);
  assert.equal(await page.locator('#start').isDisabled(),true);
  assert.equal(await page.locator('#game').isVisible(),false);
  assert.equal(await page.locator('#runtime-status').textContent(),'Stopped');
  const failedState=await page.evaluate(()=>window.diabloStatus);
  assert.equal(failedState.loaded,false);
  assert.equal(failedState.frames,0);
  await delay(500);
  assert.equal(await page.evaluate(()=>window.diabloStatus.frames),failedState.frames,'a failed load must not continue rendering');
  await page.screenshot({path:path.join(artifactDir,'diablo-loading-failure.png')});
  await page.unroute(archiveRoute);
  await page.getByRole('button',{name:'Reload game',exact:true}).click();
  await page.getByRole('button',{name:'Play Diablo',exact:true}).waitFor({state:'visible'});
  await page.getByRole('button',{name:'Play Diablo',exact:true}).click();
  await page.waitForFunction(()=>window.diabloStatus.loaded||window.diabloStatus.error,{},{timeout:60000});
  assert.equal(await page.evaluate(()=>window.diabloStatus.error),null);
  await page.waitForFunction(()=>window.diabloStatus.frames>35);
  assert.equal(await page.locator('#failure').isVisible(),false);
  assert.equal(await page.locator('#game').isVisible(),true);
  await page.screenshot({path:path.join(artifactDir,'diablo-loading-recovered.png')});
  result.failureRecovery={abortedArchives,failedState,recoveredState:await page.evaluate(()=>window.diabloStatus)};
  for(const state of [result.state,result.restoredMain,result.failureRecovery.recoveredState]){
    assert.equal(state.engineSha256,build.sha256);
    assert.equal(state.frontendSha256,runtime.frontendSha256);
    assert.equal(state.revisionSha256,runtime.revisionSha256);
    assert.equal(state.capabilities.canvas2d.status,'passed');
    if(bmpEnabled){assert.equal(state.renderer,'bmp-indexed');assert.equal(state.capabilities.bmp.status,'passed');}
    else if(gpuEnabled){assert.match(state.renderer,/^webgl[12]-indexed$/);assert.equal(state.capabilities[state.renderer.split('-')[0]].paletteReadback,true);}
    else{assert.equal(state.renderer,'canvas2d-indexed');assert.equal(state.capabilities.webgl1.status,'unavailable');assert.equal(state.capabilities.webgl2.status,'unavailable');}
  }
  const reports=fs.readFileSync(path.join(temp,'data','diagnostics.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).payload).filter(payload=>payload.kind==='game');
  const gameReports=reports.filter(payload=>['loaded','first-frame','metrics'].includes(payload.event));
  assert(gameReports.length>0,'game build must be recorded in persisted diagnostics');
  for(const report of gameReports){assert.equal(report.engineSha256,build.sha256);assert.equal(report.frontendSha256,runtime.frontendSha256);assert.equal(report.revisionSha256,runtime.revisionSha256);assert.equal(report.renderProtocol,'bounded-indexed-v2');}
  const reportedModes=[...new Set(gameReports.filter(report=>report.event==='loaded').map(report=>report.mode))];
  assert(reportedModes.includes('JavaScript · worker'));assert(reportedModes.includes('JavaScript · main thread'));
  assert(manifestResponses.length>=3,'each successful startup must fetch build metadata');
  assert(manifestResponses.every(status=>status===200),'build metadata fetch must succeed');
  result.reportedBuild={engineSha256:build.sha256,renderProtocol:'bounded-indexed-v2',manifestResponses,successfulGameReports:gameReports.length,reportedModes};
  result.rendererReports=reports.filter(report=>report.event==='capabilities');
  result.phaseReports=reports.filter(report=>report.event==='phase');
  result.inputTimingReports=reports.filter(report=>report.event==='input-timing'||report.event==='name-confirmed');
  assert(result.rendererReports.length>=3,'verified renderer capabilities must be saved for each successful startup');
  assert(result.phaseReports.some(report=>report.name==='game-ready'),'gameplay readiness must be reported');
  assert(result.inputTimingReports.some(report=>report.event==='name-confirmed'&&!report.discarded),'confirmation barrier must acknowledge completed work');
  result.errors=errors;result.wasmRequests=requests.filter(x=>/\.wasm(?:\?|$)/.test(x));
  assert.equal(result.wasmRequests.length,0);assert.deepEqual(errors,[]);assert.equal(result.webAssembly,'undefined');
  fs.writeFileSync(path.join(artifactDir,'browser-smoke.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();server.kill();if(server.exitCode===null)await Promise.race([new Promise(resolve=>server.once('exit',resolve)),delay(2000)]);fs.rmSync(temp,{recursive:true,force:true});});
