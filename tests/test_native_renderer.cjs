/* Native BMP decoding, borrowed buffers, bounded presentation and fallback. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/js/diablo-renderer.js'),'utf8');
const output=path.join(root,'data/qa/native-renderer');fs.mkdirSync(output,{recursive:true});

(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--js-flags=--jitless','--disable-webgl']});
  let result;
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('http://native-renderer.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><canvas></canvas>'}));
    await page.goto('http://native-renderer.test/');await page.evaluate(()=>{window.WebAssembly=undefined;});await page.addScriptTag({content:source});
    result=await page.evaluate(async()=>{
      const NativeImage=window.Image,nativeCreate=URL.createObjectURL.bind(URL),nativeRevoke=URL.revokeObjectURL.bind(URL);
      const sourceDescriptor=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src');
      const blobs=new Map(),observations=[];let behavior='normal',maximumURLs=0,createdURLs=0,revokedURLs=0;
      URL.createObjectURL=blob=>{const url=nativeCreate(blob);blobs.set(url,blob);createdURLs++;maximumURLs=Math.max(maximumURLs,blobs.size);return url;};
      URL.revokeObjectURL=url=>{if(blobs.delete(url))revokedURLs++;nativeRevoke(url);};
      window.Image=function(){
        const image=new NativeImage();
        Object.defineProperty(image,'src',{get(){return sourceDescriptor.get.call(image);},set(value){
          if(!value){sourceDescriptor.set.call(image,value);return;}
          const action=behavior,success=image.onload,failure=image.onerror;
          if(action==='stall')return;
          if(action==='fail'){setTimeout(()=>failure&&failure.call(image),0);return;}
          if(action==='delayed')image.onload=function(){setTimeout(()=>success&&success.call(image),80);};
          if(action==='bottom-up-only'){
            blobs.get(value).arrayBuffer().then(buffer=>{
              if(new DataView(buffer).getInt32(22,true)<0){if(failure)failure.call(image);}
              else sourceDescriptor.set.call(image,value);
            });return;
          }
          sourceDescriptor.set.call(image,value);
        }});return image;
      };
      const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
      const prepare=renderer=>new Promise((resolve,reject)=>renderer.prepare((error,value)=>error?reject(error):resolve(value)));
      const present=(renderer,batch)=>new Promise((resolve,reject)=>renderer.present(batch,(error,value)=>error?reject(error):resolve(value)));
      function canvas(width=641,height=49){const element=document.createElement('canvas');element.width=width;element.height=height;return element;}
      function equalPixels(actualCanvas,expectedCanvas,label){
        const actual=actualCanvas.getContext('2d').getImageData(0,0,actualCanvas.width,actualCanvas.height).data;
        const expected=expectedCanvas.getContext('2d').getImageData(0,0,expectedCanvas.width,expectedCanvas.height).data;
        for(let p=0;p<expected.length;p++)if(actual[p]!==expected[p])throw new Error(label+' pixel mismatch at '+p+': '+actual[p]+' != '+expected[p]);
      }
      function noLeaks(label){if(blobs.size)throw new Error(label+' leaked '+blobs.size+' object URLs');}
      const width=641,height=49,palette=new Uint8Array(1024),pixels=new Uint8Array(width*height);
      for(let i=0;i<256;i++)palette.set([i,(i*7)&255,(i*13)&255,i&1?255:0],i*4);
      for(let p=0;p<pixels.length;p++)pixels[p]=(p*19+(p>>6)*7)&255;
      const full=()=>({images:[{format:'indexed',x:0,y:0,w:width,h:height,bytes:pixels,palette}],text:[]});
      const nativeCanvas=canvas(),referenceCanvas=canvas();
      const renderer=createDiabloRenderer(nativeCanvas,{preferBMP:true,preferWebGL:false});
      const reference=createDiabloRenderer(referenceCanvas,{preferWebGL:false});
      const capabilities=await prepare(renderer);
      if(capabilities.bmp.status!=='passed'||capabilities.bmp.orientation!=='top-down')throw new Error('Top-down native BMP probe did not pass: '+JSON.stringify(capabilities));
      noLeaks('probe');
      async function check(label,batch,wantedMode='bmp-indexed'){
        const stats=await present(renderer,batch);reference.draw(batch);equalPixels(nativeCanvas,referenceCanvas,label);noLeaks(label);
        if(stats.mode!==wantedMode)throw new Error(label+' selected '+stats.mode);
        for(const field of ['encodeMs','decodeMs','presentationMs','canvasCpuMs'])if(!Number.isFinite(stats[field])||stats[field]<0)throw new Error('Invalid timing '+field);
        observations.push({label,stats});return stats;
      }
      await check('all colors, odd width, padding and row orientation',full());
      await check('unchanged frame',full());
      await check('strided indexed dirty rectangle',{images:[{format:'indexed',x:7,y:13,w:3,h:2,stride:5,bytes:new Uint8Array([6,7,8,99,99,9,10,11,99,99]),palette}],text:[]});
      const alternate=palette.slice();alternate.set([244,31,171,0],6*4);
      await check('palette-only update',{images:[],palette:alternate,text:[]});
      await check('text with clipping',{images:[],text:[{text:'AB',x:3,y:0,color:0xffffff}],clip:[5,5,28,20]});
      await check('text removal restores base',{images:[],text:[]});
      const rgba=new Uint8Array(7*9*4);for(let i=0;i<rgba.length;i+=4)rgba.set([13,212,37,255],i);
      await check('mixed RGBA forces exact retained Canvas expansion',{images:[{format:'rgba',x:20,y:5,w:7,h:9,bytes:rgba}],text:[]},'canvas2d-indexed');
      await check('palette-only update preserves mixed RGBA',{images:[],palette,text:[]},'canvas2d-indexed');
      await check('full indexed surface resumes native decoding',full());
      const borrowed=new Uint8Array([6,7,8,9]),borrowedPalette=alternate.slice();
      const batch={images:[{format:'indexed',x:1,y:1,w:2,h:2,bytes:borrowed,palette:borrowedPalette}],text:[]};
      reference.draw(batch);const borrowedResult=present(renderer,batch);
      structuredClone({borrowed,borrowedPalette},{transfer:[borrowed.buffer,borrowedPalette.buffer]});
      await borrowedResult;equalPixels(nativeCanvas,referenceCanvas,'detached borrowed buffers');noLeaks('detached buffers');
      observations.push({label:'borrowed pixels and palette survive immediate detachment'});
      const snapshot={images:[],text:[{text:'AB',x:3,y:0,color:0xffffff}],clip:[5,5,28,20]};
      reference.draw(snapshot);const snapshotResult=present(renderer,snapshot);snapshot.text[0].text='WRONG';snapshot.clip[0]=30;
      await snapshotResult;equalPixels(nativeCanvas,referenceCanvas,'asynchronous text snapshot');
      observations.push({label:'text and clip snapshot survive caller mutation'});
      let rejected=false;try{await present(renderer,{images:[{format:'indexed',x:NaN,y:0,w:1,h:1,bytes:new Uint8Array(1),palette}]});}catch(error){rejected=/rectangle/.test(error.message);}
      if(!rejected)throw new Error('Invalid native rectangle accepted');
      behavior='delayed';let completions=0;
      const pending=new Promise((resolve,reject)=>renderer.present(full(),(error,value)=>{completions++;error?reject(error):resolve(value);}));
      let concurrentCalls=0;renderer.present(full(),error=>{concurrentCalls++;if(!error||!/pending/.test(error.message))throw new Error('Concurrent presentation was accepted');});
      let syncRejected=false;try{renderer.draw(full());}catch(error){syncRejected=/pending/.test(error.message);}
      if(!syncRejected||concurrentCalls!==1||blobs.size!==1)throw new Error('Pending native work was not bounded');
      const delayed=await pending;if(completions!==1||delayed.decodeMs<70)throw new Error('Native callback ran before delayed presentation');
      noLeaks('delayed frame');observations.push({label:'one in-flight image and exactly-once completion',stats:delayed});
      behavior='fail';await check('decode error falls back to same frame',full(),'canvas2d-indexed');
      if(renderer.capabilities.bmp.status!=='failed'||!renderer.capabilities.bmp.reason)throw new Error('Decode failure did not report capability reason');
      behavior='normal';await check('failed native decoder remains disabled',full(),'canvas2d-indexed');renderer.destroy();reference.destroy();

      behavior='bottom-up-only';const bottomCanvas=canvas(),bottom=createDiabloRenderer(bottomCanvas,{preferBMP:true,preferWebGL:false});
      const bottomCapabilities=await prepare(bottom);
      if(bottomCapabilities.bmp.status!=='passed'||bottomCapabilities.bmp.orientation!=='bottom-up'||bottomCapabilities.bmp.attempts.length!==1)throw new Error('Bottom-up fallback probe failed');
      await present(bottom,full());const bottomReference=canvas(),bottomCPU=createDiabloRenderer(bottomReference,{preferWebGL:false});bottomCPU.draw(full());equalPixels(bottomCanvas,bottomReference,'bottom-up decoding');
      bottom.destroy();bottomCPU.destroy();noLeaks('bottom-up');observations.push({label:'top-down decode rejected; bottom-up pixels verified'});

      behavior='normal';const largeCanvas=canvas(640,480),largeReference=canvas(640,480);
      const large=createDiabloRenderer(largeCanvas,{preferBMP:true,preferWebGL:false}),largeCPU=createDiabloRenderer(largeReference,{preferWebGL:false});await prepare(large);
      const largePixels=new Uint8Array(640*480);for(let p=0;p<largePixels.length;p++)largePixels[p]=(p*13+(p>>9))&255;
      const largeBatch={images:[{format:'indexed',x:0,y:0,w:640,h:480,bytes:largePixels,palette}],text:[]};
      for(let frame=0;frame<5;frame++){largePixels[frame*640]=237;await present(large,largeBatch);largeCPU.draw(largeBatch);equalPixels(largeCanvas,largeReference,'640x480 aligned BMP frame '+frame);noLeaks('640x480 frame');}
      large.destroy();largeCPU.destroy();observations.push({label:'640x480 native contiguous-copy path matches five full reference frames'});

      behavior='normal';const timeoutCanvas=canvas(),timeout=createDiabloRenderer(timeoutCanvas,{preferBMP:true,preferWebGL:false});await prepare(timeout);behavior='stall';
      const timeoutStats=await present(timeout,full());
      if(timeoutStats.mode!=='canvas2d-indexed'||timeoutStats.decodeMs<900||!/timed out/.test(timeout.capabilities.bmp.reason))throw new Error('Decoder timeout did not recover');
      equalPixels(timeoutCanvas,bottomReference,'timeout fallback pixels');timeout.destroy();noLeaks('timeout');observations.push({label:'one-second timeout falls back to same frame',stats:timeoutStats});

      behavior='normal';const doomed=createDiabloRenderer(canvas(),{preferBMP:true,preferWebGL:false});await prepare(doomed);behavior='delayed';let cancellations=0;
      doomed.present(full(),error=>{cancellations++;if(!error||!error.cancelled)throw new Error('Destroyed renderer did not cancel');});doomed.destroy();await wait(120);
      if(cancellations!==1)throw new Error('Late decode completed after cancellation');noLeaks('destroy during frame');observations.push({label:'destroy cancels pending image and suppresses late callback'});
      behavior='stall';const probing=createDiabloRenderer(canvas(),{preferBMP:true,preferWebGL:false});let probeCancellations=0;
      probing.prepare(error=>{probeCancellations++;if(!error||!error.cancelled)throw new Error('Probe cancellation was not identified');});probing.destroy();
      if(probeCancellations!==1)throw new Error('Probe did not cancel exactly once');noLeaks('destroy during probe');

      behavior='normal';const NativeBlob=window.Blob;window.Blob=undefined;
      const unavailable=createDiabloRenderer(canvas(),{preferBMP:true,preferWebGL:false});const unavailableCapabilities=await prepare(unavailable);window.Blob=NativeBlob;
      if(unavailableCapabilities.bmp.status!=='unavailable')throw new Error('Missing Blob was not reported unavailable');unavailable.destroy();
      behavior='fail';const failed=createDiabloRenderer(canvas(),{preferBMP:true,preferWebGL:false});const failedCapabilities=await prepare(failed);
      if(failedCapabilities.bmp.status!=='failed'||failedCapabilities.bmp.attempts.length!==2)throw new Error('Both failed orientations were not reported');failed.destroy();noLeaks('failed probes');
      observations.push({label:'unavailable APIs and both failed probe orientations reported'});
      behavior='normal';const getImageData=CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData=function(...args){const result=getImageData.apply(this,args);if(this.canvas.width===257)result.data.fill(0);return result;};
      const wrongPixels=createDiabloRenderer(canvas(),{preferBMP:true,preferWebGL:false});const wrongCapabilities=await prepare(wrongPixels);
      CanvasRenderingContext2D.prototype.getImageData=getImageData;
      if(wrongCapabilities.bmp.status!=='failed'||!/pixel readback/.test(wrongCapabilities.bmp.reason))throw new Error('Broken native pixel readback passed capability probe');
      wrongPixels.destroy();noLeaks('wrong pixels');observations.push({label:'decode success with incorrect actual pixels rejects native capability'});
      if(maximumURLs!==1||createdURLs!==revokedURLs)throw new Error('Native resources were unbounded or leaked');
      window.Image=NativeImage;URL.createObjectURL=nativeCreate;URL.revokeObjectURL=nativeRevoke;
      return {scope:'Native BMP correctness and bounded lifetime in jitless desktop Chrome; physical Switch performance remains unverified.',capabilities,observations,maximumURLs,createdURLs,revokedURLs};
    });
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
  fs.writeFileSync(path.join(output,'native-renderer-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
