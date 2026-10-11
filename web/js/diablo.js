(function () {
  'use strict';
  var $ = function(id){return document.getElementById(id);};
  var canvas=$('screen'), context=canvas.getContext('2d'), token, transport, audio, renderer;
  var started=false, ready=false, useSpell=false, workerMode=false, firstFrame=true, metricReports=0, lastMetricReport=0;
  var pixelImage, directImage=typeof ImageData!=='undefined', drawTotal=0, drawMax=0, drawCount=0, lastPresented=0, lastPresentationTime=0, deliveryLag=0;
  var convertedPixels=0,skippedPixels=0,signatureTotal=0,conversionTotal=0;
  var encodingTotal=0,decodingTotal=0,presentationTotal=0,canvasCpuTotal=0,presentationPending=false,presentationGeneration=0;
  var pointer={x:320,y:240}, pressed={}, keys={}, lastPointer=0, pending=Object.create(null), saving=false, saveFailed=false;
  var compat=location.search.indexOf('compat=1')>=0, mainOnly=location.search.indexOf('main=1')>=0;
  var benchmark=/(?:^|[?&])benchmark=1(?:&|$)/.test(location.search);
  var rendererMatch=/(?:^|[?&])renderer=(bmp|canvas)(?:&|$)/.exec(location.search),rendererChoice=rendererMatch?rendererMatch[1]:'auto';
  var state=window.diabloStatus={loaded:false,frames:0,inputs:0,error:null,mode:null,save:null,metrics:[]};
  state.benchmark=benchmark;state.benchmarkWrites=0;
  state.rendererChoice=rendererChoice;state.presentationPending=false;
  // Capture the published identity while this page's scripts are loading,
  // rather than attributing a welcome page left open to a later revision.
  var pageRuntime=request('GET','/assets/runtime.json').then(json).catch(function(e){return {error:e.message};});
  var inputBlocked=false, barrierSequence=0, recentInputs=[], lastHeartbeat=0, lastPhaseAt=0;
  if(compat)window.WebAssembly=undefined;
  function request(method,url,body,headers,onProgress){
    return new Promise(function(resolve,reject){
      var xhr=new XMLHttpRequest();xhr.open(method,url,true);xhr.responseType='arraybuffer';xhr.timeout=120000;
      Object.keys(headers||{}).forEach(function(k){xhr.setRequestHeader(k,headers[k]);});
      if(onProgress)xhr.onprogress=onProgress;
      xhr.onload=function(){if(xhr.status>=200&&xhr.status<300)resolve(xhr.response);else reject(new Error('Request failed ('+xhr.status+'): '+url));};
      xhr.onerror=function(){reject(new Error('Connection to the Mac was lost.'));};
      xhr.ontimeout=function(){reject(new Error('The Mac did not respond in time.'));};
      xhr.send(body===undefined?null:body);
    });
  }
  function json(buffer){
    if(typeof TextDecoder!=='undefined')return JSON.parse(new TextDecoder('utf-8').decode(buffer));
    // The Python API emits ASCII JSON with Unicode escape sequences.
    var bytes=new Uint8Array(buffer),text='';for(var i=0;i<bytes.length;i+=8192)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
    return JSON.parse(text);
  }
  function report(event,extra){
    var snapshot={kind:'game',event:event,game:'diablo-shareware',mode:state.mode,engineSha256:state.engineSha256,
      frontendSha256:state.frontendSha256,revisionSha256:state.revisionSha256,rendererChoice:rendererChoice,
      renderProtocol:'bounded-indexed-v2',renderer:renderer&&renderer.mode||'Canvas 2D',phase:state.phase||null,
      ua:navigator.userAgent,ts:new Date().toISOString()};
    Object.keys(extra||{}).forEach(function(k){snapshot[k]=extra[k];});
    if(window.Portal)Portal.report(snapshot).catch(function(){});
  }
  function loading(text,value){$('load-status').textContent=text;if(value!==undefined){$('progress').hidden=false;$('progress').value=value;}}
  function error(message){
    state.error=String(message);releaseInputs();ready=false;state.loaded=false;
    stopRendering();
    if(transport)transport.stop();if(audio)audio.stop();
    $('error-message').textContent=state.error;$('failure').hidden=false;$('welcome').hidden=true;
    blockInputs(false);$('runtime-status').textContent='Stopped';report('error',{message:state.error,recentInputs:recentInputs});
  }
  function stopRendering(){
    presentationGeneration++;presentationPending=false;state.presentationPending=false;
    if(renderer&&renderer.destroy)renderer.destroy();
  }
  function blockInputs(value){
    if(value&&!inputBlocked)lastPhaseAt=Date.now();
    inputBlocked=value;state.inputBlocked=value;
    Array.prototype.forEach.call(document.querySelectorAll('.controls button,#menu'),function(button){button.disabled=value;});
    var overlay=$('loading-overlay');if(overlay)overlay.hidden=!value;
    if(value)$('runtime-status').textContent='Loading Tristram…';
    else if(ready&&state.loaded)$('runtime-status').textContent='Running · '+state.mode;
  }
  function event(name,args,id,internal){
    var release=name==='DApi_Key'&&args[0]===1||name==='DApi_Mouse'&&args[0]===2;
    if(ready&&transport&&(!inputBlocked||release||internal)){
      var now=Date.now();transport.event(name,args,id,now);state.inputs++;
      if(name!=='DApi_Mouse'||args[0]!==0){
        recentInputs.push({name:name,args:name==='text'?[String(args[0]).length,args[1]]:args.slice(),at:now});
        if(recentInputs.length>24)recentInputs.shift();
      }
    }
  }
  function key(code,down,mods){event('DApi_Key',[down?0:1,mods||0,code]);if(down)keys[code]=true;else delete keys[code];}
  function hotkey(code,down,mods){key(code,down,mods);if(down&&((code>=48&&code<=57)||(code>=65&&code<=90)))event('DApi_Char',[code>=65?code+32:code]);}
  function tapKey(code){hotkey(code,true);hotkey(code,false);}
  function mouse(action,button,mods){event('DApi_Mouse',[action,button,mods||0,Math.round(pointer.x),Math.round(pointer.y)]);}
  function releaseInputs(){
    Object.keys(pressed).forEach(function(button){mouse(2,Number(button),0);});pressed={};
    Object.keys(keys).forEach(function(code){key(Number(code),false);});keys={};
  }
  function coordinates(clientX,clientY){var r=canvas.getBoundingClientRect();pointer.x=Math.max(0,Math.min(639,(clientX-r.left)*640/r.width));pointer.y=Math.max(0,Math.min(479,(clientY-r.top)*480/r.height));}
  function modifiers(e,touch){return (e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0)|(touch?8:0);}
  function press(button,mods){pressed[button]=true;mouse(0,0,mods);mouse(1,button,mods);}
  function release(button,mods){if(pressed[button]){mouse(2,button,mods);delete pressed[button];}}
  function updateSaveStatus(){
    var count=Object.keys(pending).length;
    $('save-status').textContent=saveFailed?'Save failed — retry while the Mac is connected':(count||saving?'Saving to Mac…':'Saved on Mac');
    $('retry-save').hidden=!saveFailed;
  }
  function flush(){
    if(saving||!token)return;
    var names=Object.keys(pending);if(!names.length){updateSaveStatus();return;}
    var name=names[0], job=pending[name];saving=true;saveFailed=false;updateSaveStatus();
    request(job.operation==='delete'?'DELETE':'PUT','/api/saves/'+encodeURIComponent(name),job.data||null,{'X-Portal-Token':token,'Content-Type':'application/octet-stream'}).then(function(){
      if(pending[name]===job)delete pending[name];saving=false;updateSaveStatus();flush();
    }).catch(function(e){saving=false;saveFailed=true;updateSaveStatus();report('save-failed',{message:e.message});});
  }
  function draw(batch){
    if(!context)throw new Error('Canvas 2D is unavailable in this browser.');
    if(renderer)return renderer.draw(batch);
    var began=performance.now();
    batch.images.forEach(function(rect){
      var image;
      if(directImage){try{image=new ImageData(new Uint8ClampedArray(rect.bytes.buffer,rect.bytes.byteOffset,rect.bytes.byteLength),rect.w,rect.h);}catch(e){directImage=false;}}
      if(image)context.putImageData(image,rect.x,rect.y);
      else {
        if(!pixelImage)pixelImage=context.createImageData(640,480);
        var offset=(rect.y*640+rect.x)*4;
        if(rect.w===640)pixelImage.data.set(rect.bytes,offset);
        else for(var row=0;row<rect.h;row++)pixelImage.data.set(rect.bytes.subarray(row*rect.w*4,(row+1)*rect.w*4),offset+row*640*4);
        context.putImageData(pixelImage,0,0,rect.x,rect.y,rect.w,rect.h);
      }
    });
    if(batch.text.length){
      context.save();if(batch.clip){var c=batch.clip;context.beginPath();context.rect(c[0],c[1],c[2]-c[0],c[3]-c[1]);context.clip();}
      context.font='bold 13px Georgia, serif';batch.text.forEach(function(t){context.fillStyle='#'+('000000'+(t.color&0xffffff).toString(16)).slice(-6);context.fillText(t.text,t.x,t.y+22);});context.restore();
    }
    var duration=performance.now()-began;
    return {convertedPixels:0,skippedPixels:0,signatureMs:0,conversionMs:0,canvasCpuMs:duration,presentationMs:duration};
  }
  function present(data){
    if(presentationPending)throw new Error('A second frame arrived before presentation completed.');
    presentationPending=true;state.presentationPending=true;
    var began=performance.now(),generation=presentationGeneration,settled=false,activeTransport=transport;
    function done(failure,statistics){
      if(settled)return;settled=true;
      if(generation!==presentationGeneration)return;
      presentationPending=false;state.presentationPending=false;
      if(failure){if(!failure.cancelled)error(failure.message||String(failure));return;}
      statistics=statistics||{};
      var duration=performance.now()-began;
      convertedPixels+=statistics.convertedPixels||0;skippedPixels+=statistics.skippedPixels||0;
      signatureTotal+=statistics.signatureMs||0;conversionTotal+=statistics.conversionMs||0;
      encodingTotal+=statistics.encodeMs||0;decodingTotal+=statistics.decodeMs||0;
      presentationTotal+=typeof statistics.presentationMs==='number'?statistics.presentationMs:duration;
      canvasCpuTotal+=typeof statistics.canvasCpuMs==='number'?statistics.canvasCpuMs:duration;
      drawTotal+=duration;drawMax=Math.max(drawMax,duration);drawCount++;state.frames++;
      if(renderer)state.renderer=renderer.mode;
      if(firstFrame){firstFrame=false;lastPresentationTime=performance.now();report('first-frame');}
      try{
        if(activeTransport===transport&&transport&&transport.acknowledge){
          transport.acknowledge(data.sequence,data.batch.images.length?data.batch.images[0].bytes.buffer:null);
        }
      }catch(e){error(e.message);}
    }
    try{if(renderer&&renderer.present)renderer.present(data.batch,done);else done(null,draw(data.batch));}
    catch(e){done(e);}
  }
  function receive(data){
    try{
      switch(data.action){
      case 'loaded':ready=true;state.loaded=true;state.nativeMemory=data.nativeMemory;$('welcome').hidden=true;$('game').hidden=false;$('runtime-status').textContent='Running · '+state.mode;if(benchmark)$('save-status').textContent='Temporary character · saves disabled';canvas.focus();report('loaded',{audio:state.audioEnabled,benchmark:benchmark,nativeMemory:data.nativeMemory});break;
      case 'render':
        lastHeartbeat=Date.now();
        deliveryLag=Math.max(0,Date.now()-(data.sentAt||Date.now()));present(data);
        break;
      case 'progress':loading(data.message);break;
      case 'phase':
        state.phase=data.name;state.phaseDetails=data.details;lastPhaseAt=lastHeartbeat=Date.now();
        if(data.name==='loading-start')blockInputs(true);
        if((data.name==='game-ready'||data.name==='loading-end')&&!state.pendingInputId)blockInputs(false);
        report('phase',{name:data.name,details:data.details,recentInputs:data.name==='exit-request'?recentInputs:undefined});
        break;
      case 'input-timing':state.lastInputTiming=data;report('input-timing',{name:data.name,milliseconds:data.milliseconds});break;
      case 'input-complete':
        if(data.id===state.pendingInputId){state.pendingInputId=null;blockInputs(false);report('name-confirmed',{milliseconds:Date.now()-state.pendingInputStarted,lastEventMs:data.milliseconds,discarded:!!data.discarded});}
        break;
      case 'audio':audio.handle(data.method,data.args);break;
      case 'error':error(data.message);break;
      case 'fs':if(!/^(config\.ini|spawn[0-9]\.sv)$/.test(data.name))throw new Error('Unexpected save filename');if(benchmark){state.benchmarkWrites++;break;}pending[data.name]=data;flush();break;
      case 'current_save':state.save=data.name;break;
      case 'cursor':pointer.x=data.x;pointer.y=data.y;break;
      case 'keyboard':
        if(data.open){$('text-entry').hidden=false;$('game-text').maxLength=Math.min(255,Math.abs(data.length)||15);$('game-text').inputMode=data.length<0?'numeric':'text';$('game-text').focus();}
        else {$('text-entry').hidden=true;$('game-text').value='';}
        break;
      case 'metrics':
        state.metrics.push(data.fps);if(state.metrics.length>300)state.metrics.shift();
        var measuredAt=performance.now(),presentFps=lastPresentationTime?(state.frames-lastPresented)*1000/(measuredAt-lastPresentationTime):0;
        var timing={fps:presentFps,engineFps:data.fps,frames:state.frames,inputs:state.inputs,heapBytes:data.heapBytes,
          tickMs:data.tickMs,maxTickMs:data.maxTickMs,bridgeMs:data.bridgeMs,canvasMs:drawCount?drawTotal/drawCount:0,
          maxCanvasMs:drawMax,deliveryLagMs:deliveryLag,coalescedFrames:data.coalescedFrames,sentFrames:data.sentFrames,
          format:data.format,inputMs:data.inputMs,maxInputMs:data.maxInputMs,
          inputQueueMs:data.inputQueueMs,maxInputQueueMs:data.maxInputQueueMs,
          inputLatencyMs:data.inputLatencyMs,maxInputLatencyMs:data.maxInputLatencyMs,sections:data.sections,
          renderer:renderer&&renderer.mode,convertedPixels:convertedPixels,skippedPixels:skippedPixels,
          signatureMs:drawCount?signatureTotal/drawCount:0,conversionMs:drawCount?conversionTotal/drawCount:0,
          encodingMs:drawCount?encodingTotal/drawCount:0,decodingMs:drawCount?decodingTotal/drawCount:0,
          presentationMs:drawCount?presentationTotal/drawCount:0,canvasCpuMs:drawCount?canvasCpuTotal/drawCount:0,
          presentationPending:presentationPending};
        state.performance=timing;lastPresented=state.frames;lastPresentationTime=measuredAt;drawTotal=drawMax=drawCount=0;
        convertedPixels=skippedPixels=signatureTotal=conversionTotal=0;
        encodingTotal=decodingTotal=presentationTotal=canvasCpuTotal=0;
        if(!inputBlocked)$('runtime-status').textContent=presentFps.toFixed(1)+' FPS / 20 · '+state.mode;
        metricReports++;if(metricReports<=3||Date.now()-lastMetricReport>=15000){lastMetricReport=Date.now();report('metrics',timing);}break;
      case 'exit':ready=false;state.loaded=false;stopRendering();blockInputs(false);transport.stop();audio.stop();$('runtime-status').textContent='Game closed · return to Library';report('exit',{recentInputs:recentInputs});break;
      }
    }catch(e){error(e.message);}
  }
  function loadScript(src){return new Promise(function(resolve,reject){var script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=function(){reject(new Error('Cannot load '+src));};document.head.appendChild(script);});}
  function chooseTransport(){
    function main(){
      state.mode='JavaScript · main thread';
      return loadScript('/engine/DiabloSpawn.js').then(function(){return loadScript('/js/diablo-host.js');}).then(function(){
        var host=window.createDiabloHost(receive);return {init:host.init,event:host.event,pause:host.pause,stop:host.stop,acknowledge:host.acknowledge};
      });
    }
    if(mainOnly||typeof Worker==='undefined')return main();
    return new Promise(function(resolve,reject){
      var worker;try{worker=new Worker('/js/diablo-worker.js'+(compat?'?compat=1':''));}catch(e){reject(e);return;}
      var timeout=setTimeout(function(){worker.terminate();reject(new Error('Worker startup timed out'));},4000);
      worker.onerror=function(e){clearTimeout(timeout);worker.terminate();reject(new Error(e.message||'Worker unavailable'));};
      worker.onmessage=function(e){if(e.data.action!=='ready')return;clearTimeout(timeout);workerMode=true;state.mode='JavaScript · worker';
        worker.onmessage=function(e){receive(e.data);};worker.onerror=function(e){error(e.message||'The game worker stopped.');};
        resolve({init:function(data){data.action='init';var transfer=[data.archive];data.saves.forEach(function(file){transfer.push(file.bytes);});worker.postMessage(data,transfer);},event:function(name,args,id,sentAt){worker.postMessage({action:'event',name:name,args:args,id:id,sentAt:sentAt});},pause:function(value){worker.postMessage({action:'pause',value:value});},stop:function(){worker.terminate();},acknowledge:function(id,buffer){worker.postMessage({action:'rendered',sequence:id,buffer:buffer},buffer?[buffer]:[]);}});
      };
    }).catch(function(){return main();});
  }
  function start(){
    if(started)return;started=true;$('start').disabled=true;audio=window.createDiabloAudio();
    if(benchmark){$('sound').disabled=true;$('sound').textContent='Sound off';$('sound').setAttribute('aria-pressed','false');}
    if(!context){error('Canvas 2D is unavailable in this browser.');return;}
    try{
      if(window.createDiabloRenderer){renderer=window.createDiabloRenderer(canvas,{preferWebGL:rendererChoice==='auto',preferBMP:rendererChoice==='bmp',onCapabilities:function(value){state.capabilities=value;state.renderer=value.selected;if(state.engineSha256)report('capabilities',{capabilities:value});}});state.renderer=renderer.mode;state.capabilities=renderer.capabilities;}
    }catch(e){error(e.message);return;}
    loading('Connecting to your Mac…',0);
    Portal.session().then(function(value){token=value;return request('GET','/api/status');}).then(function(buffer){
      var status=json(buffer);if(!status.engineReady||!status.dataReady)throw new Error('The Mac setup is incomplete. Build the engine and prepare shareware data, then reload.');
      return Promise.all([chooseTransport().then(function(value){transport=value;if(state.error)transport.stop();return value;}),request('GET','/game-data/spawn.mpq',null,{},function(e){loading('Loading shareware from your Mac…',e.lengthComputable?Math.round(e.loaded/e.total*85):10);}),benchmark?Promise.resolve(null):request('GET','/api/saves',null,{'X-Portal-Token':token}),request('GET','/engine/build.json'),new Promise(function(resolve,reject){if(renderer&&renderer.prepare)renderer.prepare(function(failure){if(failure)reject(failure);else resolve();});else resolve();}),request('GET','/assets/runtime.json'),pageRuntime]);
    }).then(function(values){
      transport=values[0];var archive=values[1];state.engineSha256=json(values[3]).sha256;
      var runtime=values[6],currentRuntime=json(values[5]);
      if(runtime.error)throw new Error(runtime.error);
      if(runtime.revisionSha256!==currentRuntime.revisionSha256)throw new Error('The game code changed after this page opened. Reload the game to use a matching frontend revision.');
      if(runtime.engineSha256!==state.engineSha256)throw new Error('The engine changed while loading. Reload the game to use a matching runtime revision.');
      state.frontendSha256=runtime.frontendSha256;state.revisionSha256=runtime.revisionSha256;
      if(!/^[a-f0-9]{64}$/.test(state.frontendSha256||'')||!/^[a-f0-9]{64}$/.test(state.revisionSha256||''))throw new Error('The Mac runtime manifest is incomplete. Rebuild it and reload.');
      if(renderer)report('capabilities',{capabilities:renderer.capabilities});
      if(archive.byteLength!==25830791)throw new Error('The shareware archive has an unexpected size.');
      var signature=new Uint8Array(archive,0,4);if(signature[0]!==77||signature[1]!==80||signature[2]!==81||signature[3]!==26)throw new Error('The shareware archive is not valid MPQ data.');
      var saves=benchmark?[]:json(values[2]).files.map(function(file){var decoded=atob(file.data),bytes=new Uint8Array(decoded.length);for(var i=0;i<decoded.length;i++)bytes[i]=decoded.charCodeAt(i);return {name:file.name,bytes:bytes.buffer};});
      state.audioEnabled=!benchmark&&audio.available;
      loading('Starting Diablo…',95);transport.init({archive:archive,saves:saves,audioEnabled:state.audioEnabled,indexed:!!renderer});
    }).catch(function(e){error(e.message);});
  }
  $('start').addEventListener('click',start);
  $('reload').addEventListener('click',function(){if(!saving&&!Object.keys(pending).length)location.reload();else {$('error-message').textContent='Saves are still pending. Retry saving before reloading.';flush();}});
  $('retry-save').addEventListener('click',function(){request('GET','/api/session').then(function(buffer){token=json(buffer).token;flush();}).catch(function(){saveFailed=true;updateSaveStatus();});});
  $('menu').addEventListener('click',function(){releaseInputs();tapKey(27);});
  $('sound').addEventListener('click',function(){var mute=this.getAttribute('aria-pressed')==='true';this.setAttribute('aria-pressed',String(!mute));this.textContent=mute?'Sound off':'Sound on';if(audio)audio.mute(mute);});
  $('spell').addEventListener('click',function(){useSpell=!useSpell;this.setAttribute('aria-pressed',String(useSpell));this.textContent=useSpell?'Spell: on':'Spell: off';});
  Array.prototype.forEach.call(document.querySelectorAll('[data-key]'),function(button){button.addEventListener('click',function(){tapKey(Number(button.getAttribute('data-key')));});});
  canvas.addEventListener('contextmenu',function(e){e.preventDefault();});
  canvas.addEventListener('mousedown',function(e){if(!ready||inputBlocked)return;e.preventDefault();lastPointer=Date.now();coordinates(e.clientX,e.clientY);press(useSpell||e.button===2?2:1,modifiers(e));if(audio)audio.resume();});
  window.addEventListener('mousemove',function(e){if(!ready||inputBlocked||e.target!==canvas&&!Object.keys(pressed).length)return;coordinates(e.clientX,e.clientY);mouse(0,0,modifiers(e));});
  window.addEventListener('mouseup',function(e){if(!ready)return;coordinates(e.clientX,e.clientY);Object.keys(pressed).forEach(function(b){release(Number(b),modifiers(e));});});
  canvas.addEventListener('click',function(e){if(!ready||inputBlocked||Date.now()-lastPointer<700)return;coordinates(e.clientX,e.clientY);press(useSpell?2:1,0);release(useSpell?2:1,0);});
  canvas.addEventListener('touchstart',function(e){if(!ready||inputBlocked)return;e.preventDefault();lastPointer=Date.now();var t=e.changedTouches[0];coordinates(t.clientX,t.clientY);press(useSpell?2:1,8);if(audio)audio.resume();},{passive:false});
  canvas.addEventListener('touchmove',function(e){if(!ready||inputBlocked)return;e.preventDefault();lastPointer=Date.now();var t=e.changedTouches[0];coordinates(t.clientX,t.clientY);mouse(0,0,8);},{passive:false});
  canvas.addEventListener('touchend',function(e){e.preventDefault();lastPointer=Date.now();Object.keys(pressed).forEach(function(b){release(Number(b),8);});},{passive:false});
  canvas.addEventListener('touchcancel',releaseInputs);
  window.addEventListener('keydown',function(e){if(!ready||e.target.tagName==='INPUT')return;var code=e.keyCode||e.which;if(code===116||e.metaKey)return;e.preventDefault();if(inputBlocked)return;key(code,true,modifiers(e));if(e.key&&e.key.length===1)event('DApi_Char',[e.key.charCodeAt(0)]);});
  window.addEventListener('keyup',function(e){if(!ready||e.target.tagName==='INPUT')return;e.preventDefault();key(e.keyCode||e.which,false,modifiers(e));});
  window.addEventListener('blur',releaseInputs);
  document.addEventListener('visibilitychange',function(){releaseInputs();if(transport)transport.pause(document.hidden);if(audio)audio.visibility(document.hidden);flush();});
  $('text-entry').addEventListener('submit',function(e){
    e.preventDefault();if(inputBlocked)return;var text=$('game-text').value.replace(/[^\x20-\x7e]/g,'');
    releaseInputs();event('text',[text,0]);$('text-entry').hidden=true;
    state.pendingInputId=++barrierSequence;state.pendingInputStarted=Date.now();blockInputs(true);
    event('DApi_Key',[0,0,13],null,true);event('DApi_Key',[1,0,13],state.pendingInputId,true);canvas.focus();
  });
  $('game-text').addEventListener('input',function(){event('text',[this.value.replace(/[^\x20-\x7e]/g,''),0]);});
  $('text-cancel').addEventListener('click',function(){event('text',[$('game-text').value,1]);$('text-entry').hidden=true;tapKey(27);canvas.focus();});
  $('leave').addEventListener('click',function(e){if(saving||Object.keys(pending).length){e.preventDefault();flush();$('save-status').textContent='Wait for saves to finish, then return to Library.';return;}releaseInputs();stopRendering();if(transport)transport.stop();if(audio)audio.stop();});
  window.addEventListener('pagehide',function(){releaseInputs();stopRendering();if(transport)transport.stop();if(audio)audio.stop();});
  window.addEventListener('beforeunload',function(e){if(saving||Object.keys(pending).length){e.preventDefault();e.returnValue='Saves are pending.';}});
  var oldButtons=[],lastPadTime=0;
  function pollPad(time){
    requestAnimationFrame(pollPad);if(!ready||inputBlocked||document.hidden)return;
    try{
      var pads=navigator.getGamepads&&navigator.getGamepads(),pad=pads&&Array.prototype.find.call(pads,function(p){return !!p;});
      if(!pad){if(oldButtons.length){releaseInputs();oldButtons=[];}$('pad-cursor').hidden=true;return;}
      var dt=Math.min(.05,(time-lastPadTime)/1000||.016);lastPadTime=time;
      function axis(value){return Math.abs(value||0)>.18?value:0;}
      pointer.x=Math.max(0,Math.min(639,pointer.x+axis(pad.axes[0])*dt*350));pointer.y=Math.max(0,Math.min(479,pointer.y+axis(pad.axes[1])*dt*350));
      if(axis(pad.axes[0])||axis(pad.axes[1]))mouse(0,0,0);
      $('pad-cursor').hidden=false;$('pad-cursor').style.left=(pointer.x/640*100)+'%';$('pad-cursor').style.top=(pointer.y/480*100)+'%';
      pad.buttons.forEach(function(button,index){var down=button.pressed;if(down===!!oldButtons[index])return;
        if(index===0||index===7){if(down)press(index===7?2:1,0);else release(index===7?2:1,0);}
        else {var codes={1:27,2:73,3:67,4:49,5:50,9:27,12:38,13:40,14:37,15:39};if(codes[index])hotkey(codes[index],down);}
        oldButtons[index]=down;
      });
    }catch(e){/* Browser may expose the method but deny access on this origin. */}
  }
  requestAnimationFrame(pollPad);
  var lastLoadingReport=0;
  setInterval(function(){
    if(!inputBlocked||!state.loaded)return;
    var now=Date.now(),seconds=Math.max(0,Math.round((now-lastPhaseAt)/1000));
    var overlay=$('loading-overlay');if(overlay)overlay.querySelector('span').textContent='Preparing your character and game data… '+seconds+' s';
    if(seconds>=15&&now-lastLoadingReport>=15000){lastLoadingReport=now;report('loading-wait',{milliseconds:now-lastPhaseAt,sinceLastFrameMs:lastHeartbeat?now-lastHeartbeat:null});}
  },1000);
})();
