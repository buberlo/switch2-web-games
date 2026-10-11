/* Pixel correctness plus bounded local Canvas benchmarks; no LAN server touched. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'web/js/diablo-renderer.js'),'utf8');
const output=path.join(root,'data/qa/renderer');fs.mkdirSync(output,{recursive:true});
async function pageFor(browser,init){
  const page=await browser.newPage();
  if(init)await page.addInitScript(init);
  await page.route('http://renderer.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="background:#17120f;color:white;font-family:Arial"><h1>Indexed renderer equivalence</h1></body></html>'}));
  await page.goto('http://renderer.test/');await page.addScriptTag({content:source});return page;
}
async function pixelTests(page){
  return page.evaluate(async()=>{
    const width=641,height=49,observations=[],reports=[];
    function canvas(label){const title=document.createElement('h2');title.textContent=label;document.body.appendChild(title);const result=document.createElement('canvas');result.width=width;result.height=height;result.style.width='512px';result.style.imageRendering='pixelated';document.body.appendChild(result);return result;}
    const gpuCanvas=canvas('Verified WebGL palette lookup'),cpuCanvas=canvas('Canvas fallback'),reference=canvas('Independent reference');
    // Capture the private WebGL canvas through native context creation for loss testing.
    let privateCanvas;
    const nativeGetContext=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){const result=nativeGetContext.call(this,type,...args);if((type==='webgl'||type==='webgl2')&&result)privateCanvas=this;return result;};
    const gpu=createDiabloRenderer(gpuCanvas,{onCapabilities:value=>reports.push(JSON.parse(JSON.stringify(value)))});
    HTMLCanvasElement.prototype.getContext=nativeGetContext;
    const cpu=createDiabloRenderer(cpuCanvas,{preferWebGL:false});
    if(gpu.mode.indexOf('webgl')!==0)throw new Error('The desktop palette shader did not verify: '+JSON.stringify(gpu.capabilities));
    const expected=new Uint8ClampedArray(width*height*4),stored=new Uint8Array(width*height),mask=new Uint8Array(width*height),colors=new Uint8Array(1024);
    function referenceDraw(batch){
      if(batch.palette){colors.set(batch.palette);for(let i=3;i<1024;i+=4)colors[i]=255;}
      for(const rect of batch.images||[]){
        const indexed=rect.format==='indexed',stride=rect.stride||rect.w;
        if(rect.palette){colors.set(rect.palette);for(let i=3;i<1024;i+=4)colors[i]=255;}
        for(let y=0;y<rect.h;y++)for(let x=0;x<rect.w;x++){
          const dst=(rect.y+y)*width+rect.x+x,src=y*stride+x;
          if(indexed){stored[dst]=rect.bytes[src];mask[dst]=1;}
          else{mask[dst]=0;for(let c=0;c<4;c++)expected[dst*4+c]=rect.bytes[src*4+c];}
        }
      }
      for(let p=0;p<stored.length;p++)if(mask[p])for(let c=0;c<4;c++)expected[p*4+c]=colors[stored[p]*4+c];
      const context=reference.getContext('2d');context.putImageData(new ImageData(expected,width,height),0,0);
      if((batch.text||[]).length){context.save();if(batch.clip){const c=batch.clip;context.beginPath();context.rect(c[0],c[1],c[2]-c[0],c[3]-c[1]);context.clip();}context.font='bold 13px Georgia, serif';for(const item of batch.text){context.fillStyle='#'+('000000'+(item.color&0xffffff).toString(16)).slice(-6);context.fillText(item.text,item.x,item.y+22);}context.restore();}
    }
    function check(label,batch){
      const stats=cpu.draw(batch);gpu.draw(batch);referenceDraw(batch);
      const wanted=reference.getContext('2d').getImageData(0,0,width,height).data;
      let maxTextChannelDelta=0;
      for(const candidate of [cpuCanvas,gpuCanvas]){
        const actual=candidate.getContext('2d').getImageData(0,0,width,height).data;
        for(let p=0;p<wanted.length;p++)if(actual[p]!==wanted[p]){
          const x=(p>>2)%width,y=Math.floor((p>>2)/width),delta=Math.abs(actual[p]-wanted[p]);
          // Native GPU-backed vs CPU-backed Canvas text antialiasing can round
          // by one channel unit. Indexed/RGBA pixels remain byte-exact.
          const textEdge=label==='text and clipping'&&candidate===gpuCanvas&&batch.clip&&x>=batch.clip[0]&&x<batch.clip[2]&&y>=batch.clip[1]&&y<batch.clip[3]&&p%4!==3;
          if(!textEdge||delta>1)throw new Error(label+' pixel mismatch at byte '+p+': '+actual[p]+' vs '+wanted[p]+(candidate===gpuCanvas?' GPU':' CPU'));
          maxTextChannelDelta=Math.max(maxTextChannelDelta,delta);
        }
      }
      observations.push({label,stats,maxTextChannelDelta});return stats;
    }
    const palette=new Uint8Array(1024);for(let i=0;i<256;i++){palette[i*4]=i;palette[i*4+1]=(i*7)&255;palette[i*4+2]=(i*13)&255;palette[i*4+3]=i&1?255:0;}
    const pixels=new Uint8Array(width*height);for(let p=0;p<pixels.length;p++)pixels[p]=(p*19+(p>>6)*7)&255;
    const frame={images:[{format:'indexed',x:0,y:0,w:width,h:height,bytes:pixels,palette}],text:[]};
    check('all 256 colors and opaque palette flags',frame);
    const unchanged=check('unchanged indexed frame skips conversion',frame);
    if(unchanged.convertedPixels!==0||unchanged.skippedPixels!==width*height)throw new Error('Unchanged frame was unnecessarily expanded.');
    const sparse=new Uint8Array([6,7,8,99,99,9,10,11,99,99]);
    check('strided odd-width indexed patch',{images:[{format:'indexed',x:7,y:13,w:3,h:2,stride:5,bytes:sparse,palette}],text:[]});
    const rgba=new Uint8Array(7*9*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=13;rgba[i+1]=212;rgba[i+2]=37;rgba[i+3]=255;}
    check('RGBA and indexed pixels coexist',{images:[{format:'rgba',x:20,y:5,w:7,h:9,bytes:rgba}],text:[]});
    const restoreIndices=new Uint8Array(7*9);for(let y=0;y<9;y++)for(let x=0;x<7;x++)restoreIndices[y*7+x]=pixels[(y+5)*width+x+20];
    check('indexed patch replaces RGBA with unchanged stored indices',{images:[{format:'indexed',x:20,y:5,w:7,h:9,bytes:restoreIndices,palette}],text:[]});
    check('RGBA patch restored for palette-only test',{images:[{format:'rgba',x:20,y:5,w:7,h:9,bytes:rgba}],text:[]});
    const palette2=palette.slice();palette2[6*4]=244;palette2[6*4+1]=31;palette2[6*4+2]=171;
    check('palette-only change preserves RGBA patches',{images:[],palette:palette2,text:[]});
    const borrowedIndices=new Uint8Array([7,8,9,10]),borrowedPalette=palette2.slice();
    check('borrowed transfer buffers copied before return',{images:[{format:'indexed',x:1,y:1,w:2,h:2,bytes:borrowedIndices,palette:borrowedPalette}],text:[]});
    structuredClone({indices:borrowedIndices,palette:borrowedPalette},{transfer:[borrowedIndices.buffer,borrowedPalette.buffer]});
    check('retained pixels survive detached source buffers',{images:[],palette:palette,text:[]});
    check('text and clipping',{images:[],text:[{text:'AB',x:3,y:0,color:0xffffff}],clip:[5,5,28,20]});
    check('removing text restores cached base',{images:[],text:[]});
    let invalid=false;try{cpu.draw({images:[{format:'indexed',x:NaN,y:0,w:1,h:1,bytes:new Uint8Array(1),palette}]});}catch(error){invalid=true;}if(!invalid)throw new Error('Malformed rectangle accepted.');
    const gl=privateCanvas.getContext('webgl')||privateCanvas.getContext('webgl2');
    const lost=new Promise(resolve=>privateCanvas.addEventListener('webglcontextlost',()=>setTimeout(resolve,0),{once:true}));
    gl.getExtension('WEBGL_lose_context').loseContext();await lost;
    if(gpu.mode!=='canvas2d-indexed')throw new Error('Context loss did not select Canvas.');
    check('context-loss fallback preserves exact retained pixels',{images:[],text:[]});
    check('context-loss fallback continues with indexed frames',frame);
    return {observations,reports,finalMode:gpu.mode};
  });
}
async function benchmark(page){
  return page.evaluate(()=>{
    const width=640,height=480,count=width*height,frames=24;
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const renderer=createDiabloRenderer(canvas,{preferWebGL:false});
    const plain=document.createElement('canvas');plain.width=width;plain.height=height;
    const context=plain.getContext('2d'),image=context.createImageData(width,height),words=new Uint32Array(image.data.buffer);
    const colors=new Uint8Array(1024),paletteWords=new Uint32Array(colors.buffer);
    for(let i=0;i<256;i++){colors[i*4]=i;colors[i*4+1]=(i*7)&255;colors[i*4+2]=(i*13)&255;colors[i*4+3]=255;}
    const indices=new Uint8Array(count);for(let p=0;p<count;p++)indices[p]=(p*17)&255;
    const frame={images:[{format:'indexed',x:0,y:0,w:width,h:height,bytes:indices,palette:colors}],text:[]};
    function naive(){for(let p=0;p<count;p++)words[p]=paletteWords[indices[p]];context.putImageData(image,0,0);}
    function measure(scene){
      renderer.draw(frame);naive();const cached=[],uncached=[];let converted=0,skipped=0;
      for(let i=0;i<frames;i++){
        if(scene==='sparse'){const row=(i%24)*8;for(let y=0;y<8;y++)indices.fill((i+31)&255,(row+y)*width+200,(row+y)*width+232);}
        if(scene==='all-changed')indices.fill((i+47)&255);
        let start=performance.now();const stats=renderer.draw(frame);cached.push(performance.now()-start);converted+=stats.convertedPixels;skipped+=stats.skippedPixels;
        start=performance.now();naive();uncached.push(performance.now()-start);
      }
      const actual=canvas.getContext('2d').getImageData(0,0,width,height).data;
      for(let p=0;p<actual.length;p++)if(actual[p]!==image.data[p])throw new Error('Benchmark pixel mismatch '+scene+' at '+p);
      function summary(values){const sorted=values.slice().sort((a,b)=>a-b);return {meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)]};}
      return {scene,frames,cached:summary(cached),naiveUint32:summary(uncached),convertedPixels:converted,skippedPixels:skipped};
    }
    return ['unchanged','sparse','all-changed'].map(measure);
  });
}
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-swiftshader']});
  let correctness,normal,restricted,webgl2,failedProbe;
  try{
    const page=await pageFor(browser),errors=[];page.on('pageerror',error=>errors.push(error.message));
    correctness=await pixelTests(page);await page.screenshot({path:path.join(output,'pixel-equivalence.png'),fullPage:true});
    normal=await benchmark(page);assert.deepEqual(errors,[]);
    const blocked=await pageFor(browser,()=>{const native=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(String(type).indexOf('webgl')!==-1)return null;return native.call(this,type,...args);};});
    restricted=await blocked.evaluate(()=>{const c=document.createElement('canvas');c.width=640;c.height=480;const r=createDiabloRenderer(c);return {mode:r.mode,capabilities:r.capabilities};});
    assert.equal(restricted.mode,'canvas2d-indexed');assert.equal(restricted.capabilities.webgl1.status,'unavailable');assert.equal(restricted.capabilities.webgl2.status,'unavailable');
    const onlyWebGL2=await pageFor(browser,()=>{const native=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){if(type==='webgl'||type==='experimental-webgl')return null;return native.call(this,type,...args);};});
    webgl2=await onlyWebGL2.evaluate(()=>{const c=document.createElement('canvas');c.width=17;c.height=13;const r=createDiabloRenderer(c),palette=new Uint8Array(1024),indices=new Uint8Array(17*13);palette.set([31,97,173,255],7*4);indices.fill(7);r.draw({images:[{format:'indexed',x:0,y:0,w:17,h:13,bytes:indices,palette}],text:[]});const pixels=c.getContext('2d').getImageData(0,0,17,13).data;for(let i=0;i<pixels.length;i++)if(pixels[i]!==[31,97,173,255][i%4])throw new Error('WebGL2 NPOT pixel mismatch');return {mode:r.mode,capabilities:r.capabilities};});
    assert.equal(webgl2.mode,'webgl2-indexed');assert.equal(webgl2.capabilities.webgl2.status,'passed');
    const badReadback=await pageFor(browser,()=>{for(const constructor of [window.WebGLRenderingContext,window.WebGL2RenderingContext])if(constructor){const native=constructor.prototype.readPixels;constructor.prototype.readPixels=function(...args){native.apply(this,args);args[6].fill(0);};}});
    failedProbe=await badReadback.evaluate(()=>{const c=document.createElement('canvas');c.width=17;c.height=13;const r=createDiabloRenderer(c);return {mode:r.mode,capabilities:r.capabilities};});
    assert.equal(failedProbe.mode,'canvas2d-indexed');assert.equal(failedProbe.capabilities.webgl1.status,'failed');assert.equal(failedProbe.capabilities.webgl2.status,'failed');
  }finally{await browser.close();}
  const interpreter=await chromium.launch({channel:'chrome',headless:true,args:['--js-flags=--jitless']});
  let jitless;
  try{const page=await pageFor(interpreter);jitless=await benchmark(page);}finally{await interpreter.close();}
  const result={scope:'Desktop Canvas microbenchmark; jitless Chrome is not a Switch performance guarantee.',correctness,restricted,webgl2,failedProbe,normal,jitless};
  fs.writeFileSync(path.join(output,'renderer-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({pixelCases:correctness.observations.length,capabilityReports:correctness.reports,restricted,webgl2,failedProbe,normal,jitless},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
