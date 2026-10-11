/* Classic-script renderer. Indexed palettes are opaque RGBA; incoming buffers
 * are copied before draw()/present() returns. WebGL and opt-in native BMP
 * decoding are selected only after actual Canvas pixel readback succeeds. */
(function (scope) {
  'use strict';

  function errorText(error) { return String(error && error.message || error).slice(0, 220); }
  function now() { return scope.performance && scope.performance.now ? scope.performance.now() : Date.now(); }
  function fill(array, value) {
    if (array.fill) { array.fill(value); return; }
    for (var i = 0; i < array.length; i++) array[i] = value;
  }

  function encodeBMP(width,height,indices,palette,topDown,previous) {
    var stride=(width+3)&~3,length=1078+stride*height;
    var bytes=previous&&previous.length===length?previous:new Uint8Array(length);
    var header=new DataView(bytes.buffer,bytes.byteOffset,54);
    header.setUint16(0,0x4d42,true);header.setUint32(2,length,true);header.setUint32(10,1078,true);
    header.setUint32(14,40,true);header.setInt32(18,width,true);header.setInt32(22,topDown?-height:height,true);
    header.setUint16(26,1,true);header.setUint16(28,8,true);header.setUint32(34,stride*height,true);header.setUint32(46,256,true);
    for(var i=0;i<256;i++){var source=i*4,target=54+source;bytes[target]=palette[source+2];bytes[target+1]=palette[source+1];bytes[target+2]=palette[source];bytes[target+3]=0;}
    if(topDown&&stride===width)bytes.set(indices,1078);
    else for(var row=0;row<height;row++){var y=topDown?row:height-row-1;bytes.set(indices.subarray(y*width,(y+1)*width),1078+row*stride);}
    return bytes;
  }

  function createGPU(document, version) {
    var canvas = document.createElement('canvas');canvas.width = 4;canvas.height = 2;
    var attrs = {alpha:true, premultipliedAlpha:false, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:true};
    var gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl', attrs);
    if (!gl && version === 1) gl = canvas.getContext('experimental-webgl', attrs);
    if (!gl) return null;
    var resources = [], textures = [], program, vertex, fragment, buffer;
    var indexFormat = version === 2 ? gl.RED : gl.LUMINANCE;
    var indexInternal = version === 2 ? gl.R8 : gl.LUMINANCE;
    var maskFormat = version === 2 ? gl.RED : gl.ALPHA;
    var maskInternal = version === 2 ? gl.R8 : gl.ALPHA;
    var precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    var highp = precision && precision.precision > 0 ? 'highp' : 'mediump';
    var pixelWidth = 4, pixelHeight = 2;
    function shader(type, source) {
      var compiled = gl.createShader(type);resources.push({kind:'shader',value:compiled});
      gl.shaderSource(compiled, source);gl.compileShader(compiled);
      if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) throw new Error('Palette shader compilation failed: ' + gl.getShaderInfoLog(compiled));
      return compiled;
    }
    function bind(unit) { gl.activeTexture(gl.TEXTURE0 + unit);gl.bindTexture(gl.TEXTURE_2D, textures[unit]); }
    function texture(unit) {
      textures[unit] = gl.createTexture();bind(unit);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    function allocate(width, height) {
      pixelWidth = width;pixelHeight = height;canvas.width = width;canvas.height = height;
      gl.viewport(0, 0, width, height);
      bind(0);gl.texImage2D(gl.TEXTURE_2D,0,indexInternal,width,height,0,indexFormat,gl.UNSIGNED_BYTE,null);
      bind(2);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      bind(3);gl.texImage2D(gl.TEXTURE_2D,0,maskInternal,width,height,0,maskFormat,gl.UNSIGNED_BYTE,null);
    }
    function dispose() {
      for (var i = 0; i < textures.length; i++) if (textures[i]) gl.deleteTexture(textures[i]);
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
      for (var r = 0; r < resources.length; r++) gl.deleteShader(resources[r].value);
      var extension = gl.getExtension('WEBGL_lose_context');if (extension) extension.loseContext();
    }
    try {
      var prefix = version === 2 ? '#version 300 es\n' : '';
      vertex = shader(gl.VERTEX_SHADER, prefix + (version === 2 ? 'in' : 'attribute') + ' vec2 position;' + (version === 2 ? 'out' : 'varying') + ' vec2 uv;void main(){uv=vec2(position.x*.5+.5,.5-position.y*.5);gl_Position=vec4(position,0.,1.);}');
      var sample = version === 2 ? 'texture' : 'texture2D';
      var mask = version === 2 ? '.r' : '.a';
      fragment = shader(gl.FRAGMENT_SHADER,prefix+'precision '+highp+' float;'+(version===2?'in':'varying')+' vec2 uv;uniform sampler2D indices;uniform sampler2D palette;uniform sampler2D rgba;uniform sampler2D indexedMask;'+(version===2?'out vec4 pixel;':'')+'void main(){float i=floor('+sample+'(indices,uv).r*255.+.5);vec4 p='+sample+'(palette,vec2((i+.5)/256.,.5));vec4 raw='+sample+'(rgba,uv);'+(version===2?'pixel':'gl_FragColor')+'=mix(raw,p,step(.5,'+sample+'(indexedMask,uv)'+mask+'));}');
      program = gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Palette shader linking failed: ' + gl.getProgramInfoLog(program));
      gl.useProgram(program);
      buffer = gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
      var location = gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,2,gl.FLOAT,false,0,0);
      gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.disable(gl.DEPTH_TEST);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
      for (var t = 0; t < 4; t++) texture(t);
      gl.uniform1i(gl.getUniformLocation(program,'indices'),0);gl.uniform1i(gl.getUniformLocation(program,'palette'),1);
      gl.uniform1i(gl.getUniformLocation(program,'rgba'),2);gl.uniform1i(gl.getUniformLocation(program,'indexedMask'),3);
      bind(1);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,256,1,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      allocate(4,2);
      return {
        canvas:canvas, gl:gl, version:version, renderer:String(gl.getParameter(gl.RENDERER)).slice(0,100),
        allocate:allocate, dispose:dispose,
        palette:function(bytes){bind(1);gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,256,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);},
        rect:function(rect,bytes,maskBytes,indexed){
          bind(indexed?0:2);gl.texSubImage2D(gl.TEXTURE_2D,0,rect.x,rect.y,rect.w,rect.h,indexed?indexFormat:gl.RGBA,gl.UNSIGNED_BYTE,bytes);
          bind(3);gl.texSubImage2D(gl.TEXTURE_2D,0,rect.x,rect.y,rect.w,rect.h,maskFormat,gl.UNSIGNED_BYTE,maskBytes);
        },
        draw:function(){if(gl.isContextLost())throw new Error('WebGL context was lost.');gl.viewport(0,0,pixelWidth,pixelHeight);gl.drawArrays(gl.TRIANGLES,0,6);},
        check:function(){if(gl.getError()!==gl.NO_ERROR)throw new Error('WebGL palette upload or drawing failed.');}
      };
    } catch (error) { dispose();throw error; }
  }

  function testGPU(gpu, document) {
    var palette = new Uint8Array(1024), indexes = new Uint8Array([0,1,127,255,255,127,1,0]);
    for (var i = 0; i < 256; i++) {palette[i*4]=i;palette[i*4+1]=(i*7)&255;palette[i*4+2]=(i*13)&255;palette[i*4+3]=255;}
    var masks = new Uint8Array(8);fill(masks,255);
    gpu.palette(palette);gpu.rect({x:0,y:0,w:4,h:2},indexes,masks,true);gpu.draw();gpu.check();
    var pixels = new Uint8Array(32);gpu.gl.readPixels(0,0,4,2,gpu.gl.RGBA,gpu.gl.UNSIGNED_BYTE,pixels);gpu.check();
    for (var y = 0; y < 2; y++) for (var x = 0; x < 4; x++) for (var c = 0; c < 4; c++) {
      if (pixels[(y*4+x)*4+c] !== palette[indexes[(1-y)*4+x]*4+c]) throw new Error('The actual palette shader pixel readback did not match.');
    }
    var copyCanvas = document.createElement('canvas');copyCanvas.width=4;copyCanvas.height=2;
    var copy = copyCanvas.getContext('2d');if(!copy)throw new Error('Canvas2D is unavailable for WebGL presentation.');
    copy.drawImage(gpu.canvas,0,0);var copied=copy.getImageData(0,0,4,2).data;
    for (var p=0;p<8;p++) for(var b=0;b<4;b++) if(copied[p*4+b]!==palette[indexes[p]*4+b])throw new Error('WebGL-to-Canvas copy pixel readback did not match.');
    return {status:'passed',paletteReadback:true,canvasCopyReadback:true,renderer:gpu.renderer};
  }

  scope.createDiabloRenderer = function (canvas, options) {
    options=options||{};
    var document=canvas.ownerDocument||scope.document, width=canvas.width, height=canvas.height;
    var context=canvas.getContext('2d');if(!context)throw new Error('Canvas 2D is unavailable in this browser.');
    var image=context.createImageData(width,height),rgba=image.data;
    var rgbaWords=new Uint32Array(rgba.buffer,rgba.byteOffset,rgba.byteLength/4);
    var indices=new Uint8Array(width*height),mask=new Uint8Array(width*height);
    var ones=new Uint8Array(width*height),zeros=new Uint8Array(width*height);fill(ones,255);
    var paletteBytes=new Uint8Array(1024),paletteWords=new Uint32Array(paletteBytes.buffer);
    var littleEndian=new Uint8Array(new Uint32Array([0x01020304]).buffer)[0]===4;
    var paletteKnown=false,gpu=null,destroyed=false;
    var stripRows=8,stripCount=Math.ceil(height/stripRows),signatures=[],candidates=[],allIndexed=[],hasIndexed=[];
    var scratch=new Uint8Array(width*height*4),needsFullExpansion=false,previousText=false;
    var bmpPrepared=false,bmpEnabled=false,bmpTopDown=true,bmpBytes=null,bmpStale=false,pendingJob=null;
    var bmpURL=scope.URL||scope.webkitURL;
    var capabilities={canvas2d:{status:'not-tested'},webgl1:{status:'not-tested'},webgl2:{status:'not-tested'},bmp:{status:'not-tested',reason:'Native BMP decoding was not requested.'},selected:'canvas2d-indexed'};
    var renderer={mode:'canvas2d-indexed',capabilities:capabilities,prepare:prepare,present:present,draw:draw,destroy:destroy};
    try{
      var probeCanvas=document.createElement('canvas');probeCanvas.width=1;probeCanvas.height=1;
      var probe2d=probeCanvas.getContext('2d');probe2d.fillStyle='rgb(17,43,97)';probe2d.fillRect(0,0,1,1);
      var probePixel=probe2d.getImageData(0,0,1,1).data;
      if(probePixel[0]!==17||probePixel[1]!==43||probePixel[2]!==97||probePixel[3]!==255)throw new Error('Canvas pixel readback did not match.');
      capabilities.canvas2d={status:'passed',pixelReadback:true};
    }catch(probeError){capabilities.canvas2d={status:'failed',reason:errorText(probeError)};}
    function publish() {capabilities.selected=renderer.mode;if(typeof options.onCapabilities==='function')options.onCapabilities(capabilities);}
    function dirtyAll() {for(var s=0;s<stripCount;s++){signatures[s]=null;candidates[s]=true;}}
    function loseGPU(reason) {
      if(!gpu)return;
      var previous=gpu;gpu=null;renderer.mode='canvas2d-indexed';
      capabilities['webgl'+previous.version]={status:'failed',reason:reason,previouslyPassed:true};
      needsFullExpansion=true;dirtyAll();publish();try{previous.dispose();}catch(ignored){}
    }
    if(options.preferWebGL!==false){
      for(var version=1;version<=2;version++){
        var candidate=null;
        try{
          candidate=createGPU(document,version);
          if(!candidate){capabilities['webgl'+version]={status:'unavailable',reason:'The browser returned no WebGL '+version+' context.'};continue;}
          capabilities['webgl'+version]=testGPU(candidate,document);
          candidate.allocate(width,height);candidate.check();gpu=candidate;
          renderer.mode='webgl'+version+'-indexed';
          gpu.canvas.addEventListener('webglcontextlost',function(event){event.preventDefault();if(!destroyed)loseGPU('The active WebGL context was lost; Canvas fallback selected.');});
          break;
        }catch(error){capabilities['webgl'+version]={status:'failed',reason:errorText(error)};if(candidate)candidate.dispose();}
      }
    }else{capabilities.webgl1.reason='WebGL was disabled by the caller.';capabilities.webgl2.reason='WebGL was disabled by the caller.';}
    publish();

    function cancelled() {var error=new Error('The Diablo renderer has been destroyed.');error.cancelled=true;return error;}
    function mode(value) {if(renderer.mode!==value){renderer.mode=value;publish();}}
    function cleanDecode(job) {
      if(job.timer!==null){scope.clearTimeout(job.timer);job.timer=null;}
      if(job.image){job.image.onload=job.image.onerror=null;try{job.image.src='';}catch(ignored){}job.image=null;}
      if(job.url){try{bmpURL.revokeObjectURL(job.url);}catch(ignoredURL){}job.url=null;}
    }
    function finish(job,error,value) {
      if(job.finished)return;job.finished=true;cleanDecode(job);
      if(pendingJob===job)pendingJob=null;
      job.done(error||null,value);
    }
    function jobFor(done) {
      if(typeof done!=='function')throw new Error('Renderer completion callback is required.');
      if(destroyed){done(cancelled());return null;}
      if(pendingJob){done(new Error('A renderer presentation or probe is already pending.'));return null;}
      var job={done:done,timer:null,image:null,url:null,finished:false};pendingJob=job;return job;
    }
    function decode(job,bytes,done) {
      var settled=false,setupBegan=now();job.decodeSetupMs=0;
      function complete(error) {
        if(settled||job.finished)return;settled=true;
        var decoded=job.image;
        // drawImage must use the decoded image before its URL and src are cleared.
        if(job.timer!==null){scope.clearTimeout(job.timer);job.timer=null;}
        if(decoded)decoded.onload=decoded.onerror=null;
        try{done(error,decoded);}finally{if(job.image===decoded)cleanDecode(job);}
      }
      try{
        job.image=new scope.Image();job.url=bmpURL.createObjectURL(new scope.Blob([bytes],{type:'image/bmp'}));
        job.image.onload=function(){complete(null);};
        job.image.onerror=function(){complete(new Error('Native BMP image decoding failed.'));};
        job.timer=scope.setTimeout(function(){complete(new Error('Native BMP image decoding timed out after 1000 ms.'));},1000);
        job.image.src=job.url;
        job.decodeSetupMs=now()-setupBegan;
      }catch(error){job.decodeSetupMs=now()-setupBegan;complete(error);}
    }
    function prepare(done) {
      var job=jobFor(done);if(!job)return;
      if(bmpPrepared||options.preferBMP!==true||gpu){
        if(gpu&&options.preferBMP===true)capabilities.bmp.reason='Verified WebGL is preferred.';
        job.timer=scope.setTimeout(function(){finish(job,null,capabilities);},0);return;
      }
      bmpPrepared=true;
      if(typeof scope.Blob!=='function'||typeof scope.Image!=='function'||typeof scope.DataView!=='function'||!bmpURL||typeof bmpURL.createObjectURL!=='function'||typeof bmpURL.revokeObjectURL!=='function'){
        capabilities.bmp={status:'unavailable',reason:'Blob, Image, DataView and object URLs are required for native BMP decoding.'};publish();
        job.timer=scope.setTimeout(function(){finish(job,null,capabilities);},0);return;
      }
      var colors=new Uint8Array(1024),pixels=new Uint8Array(257*2),probe=document.createElement('canvas'),attempts=[];
      probe.width=257;probe.height=2;var probeContext=probe.getContext('2d');
      for(var i=0;i<256;i++){colors[i*4]=i;colors[i*4+1]=(i*7)&255;colors[i*4+2]=(i*13)&255;colors[i*4+3]=i&1?255:0;}
      for(var p=0;p<pixels.length;p++)pixels[p]=p<257?p&255:(513-p)&255;
      function attempt(topDown) {
        var encoded;
        try{encoded=encodeBMP(257,2,pixels,colors,topDown);}catch(error){capabilities.bmp={status:'failed',reason:errorText(error)};publish();finish(job,null,capabilities);return;}
        decode(job,encoded,function(error,decoded){
          if(!error)try{
            probeContext.drawImage(decoded,0,0);var actual=probeContext.getImageData(0,0,257,2).data;
            for(var b=0;b<actual.length;b++)if(actual[b]!==((b&3)===3?255:colors[pixels[b>>2]*4+(b&3)]))throw new Error('Native BMP palette, padding or orientation pixel readback did not match.');
          }catch(readError){error=readError;}
          cleanDecode(job);
          if(error){
            attempts.push({orientation:topDown?'top-down':'bottom-up',reason:errorText(error)});
            if(topDown){attempt(false);return;}
            capabilities.bmp={status:'failed',reason:errorText(error),attempts:attempts};publish();finish(job,null,capabilities);return;
          }
          bmpTopDown=topDown;bmpEnabled=true;
          capabilities.bmp={status:'passed',pixelReadback:true,paletteReadback:true,paddingReadback:true,orientation:topDown?'top-down':'bottom-up',attempts:attempts};
          renderer.mode='bmp-indexed';publish();finish(job,null,capabilities);
        });
      }
      attempt(true);
    }

    function setPalette(bytes) {
      if(!bytes||bytes.length!==1024)throw new Error('Indexed rendering requires a 256-color RGBA palette.');
      var changed=!paletteKnown;
      for(var i=0;i<256;i++){
        var p=i*4,r=bytes[p],g=bytes[p+1],b=bytes[p+2];
        var value=littleEndian?(r|(g<<8)|(b<<16)|(255<<24))>>>0:((r<<24)|(g<<16)|(b<<8)|255)>>>0;
        if(paletteWords[i]!==value){paletteWords[i]=value;changed=true;}
      }
      paletteKnown=true;
      if(changed){needsFullExpansion=true;dirtyAll();if(gpu)gpu.palette(paletteBytes);}
      return changed;
    }
    function validate(rect,indexed) {
      if(!rect||rect.x!==Math.floor(rect.x)||rect.y!==Math.floor(rect.y)||rect.w!==Math.floor(rect.w)||rect.h!==Math.floor(rect.h)||rect.x<0||rect.y<0||rect.w<1||rect.h<1||rect.x+rect.w>width||rect.y+rect.h>height)throw new Error('Invalid renderer rectangle.');
      var stride=rect.stride||rect.w;
      if(stride%1||stride<rect.w||!rect.bytes||rect.bytes.length<((rect.h-1)*stride+rect.w)*(indexed?1:4))throw new Error('Incomplete renderer pixels.');
      return stride;
    }
    function mark(rect,indexed) {
      var first=Math.floor(rect.y/stripRows),last=Math.floor((rect.y+rect.h-1)/stripRows);
      for(var s=first;s<=last;s++){
        candidates[s]=true;
        var covered=rect.x===0&&rect.w===width&&rect.y<=s*stripRows&&rect.y+rect.h>=Math.min(height,(s+1)*stripRows);
        if(indexed){if(!allIndexed[s])signatures[s]=null;hasIndexed[s]=true;if(covered)allIndexed[s]=true;}
        else{allIndexed[s]=false;signatures[s]=null;if(covered)hasIndexed[s]=false;}
      }
    }
    function retain(rect,indexed,stride) {
      var bytes=rect.bytes,channels=indexed?1:4,destination=indexed?indices:rgba;
      var maskSource=indexed?ones:zeros,start=rect.y*width+rect.x;
      if(rect.w===width&&stride===width){
        destination.set(bytes.subarray(0,rect.w*rect.h*channels),start*channels);
        mask.set(maskSource.subarray(0,rect.w*rect.h),start);
      }else for(var row=0;row<rect.h;row++){
        destination.set(bytes.subarray(row*stride*channels,(row*stride+rect.w)*channels),(start+row*width)*channels);
        mask.set(maskSource.subarray(0,rect.w),start+row*width);
      }
      mark(rect,indexed);
      if(gpu){
        var packed=bytes;
        if(stride!==rect.w){for(var y=0;y<rect.h;y++)scratch.set(bytes.subarray(y*stride*channels,(y*stride+rect.w)*channels),y*rect.w*channels);packed=scratch.subarray(0,rect.w*rect.h*channels);}
        else packed=bytes.subarray(0,rect.w*rect.h*channels);
        gpu.rect(rect,packed,maskSource.subarray(0,rect.w*rect.h),indexed);
      }
    }
    function expand(first,last,opaque) {
      var p=first,end=last-7;
      if(opaque){
        for(;p<end;p+=8){rgbaWords[p]=paletteWords[indices[p]];rgbaWords[p+1]=paletteWords[indices[p+1]];rgbaWords[p+2]=paletteWords[indices[p+2]];rgbaWords[p+3]=paletteWords[indices[p+3]];rgbaWords[p+4]=paletteWords[indices[p+4]];rgbaWords[p+5]=paletteWords[indices[p+5]];rgbaWords[p+6]=paletteWords[indices[p+6]];rgbaWords[p+7]=paletteWords[indices[p+7]];}
        for(;p<last;p++)rgbaWords[p]=paletteWords[indices[p]];
      }else for(;p<last;p++)if(mask[p])rgbaWords[p]=paletteWords[indices[p]];
    }
    function drawText(text,clip) {
      if(!text.length)return;
      context.save();
      if(clip){context.beginPath();context.rect(clip[0],clip[1],clip[2]-clip[0],clip[3]-clip[1]);context.clip();}
      context.font='bold 13px Georgia, serif';
      for(var i=0;i<text.length;i++){var t=text[i];context.fillStyle='#'+('000000'+(t.color&0xffffff).toString(16)).slice(-6);context.fillText(t.text,t.x,t.y+22);}
      context.restore();
    }
    function retainBatch(batch) {
      batch=batch||{};var images=batch.images||[],text=batch.text||[],paletteChanged=false,rgbaDirty=null;
      var result={mode:renderer.mode,indexedRects:0,rgbaRects:0,convertedPixels:0,skippedPixels:0,signatureMs:0,conversionMs:0,paletteChanged:false,encodeMs:0,decodeMs:0,presentationMs:0,canvasCpuMs:0};
      if(batch.palette)paletteChanged=setPalette(batch.palette)||paletteChanged;
      for(var i=0;i<images.length;i++){
        var rect=images[i],indexed=rect.format==='indexed';
        var stride=validate(rect,indexed);
        if(indexed){if(rect.palette)paletteChanged=setPalette(rect.palette)||paletteChanged;if(!paletteKnown)throw new Error('No palette has been supplied for indexed pixels.');result.indexedRects++;}
        else{result.rgbaRects++;if(!rgbaDirty)rgbaDirty={top:rect.y,bottom:rect.y+rect.h};else{rgbaDirty.top=Math.min(rgbaDirty.top,rect.y);rgbaDirty.bottom=Math.max(rgbaDirty.bottom,rect.y+rect.h);}}
        try{retain(rect,indexed,stride);}catch(error){if(!gpu)throw error;loseGPU(errorText(error));retain(rect,indexed,stride);}
      }
      result.paletteChanged=paletteChanged;
      return {result:result,text:text,clip:batch.clip,rgbaDirty:rgbaDirty};
    }
    function drawRetained(retained) {
      var result=retained.result,text=retained.text,rgbaDirty=retained.rgbaDirty;
      if(gpu){
        try{
          gpu.draw();
          var operation=context.globalCompositeOperation;context.globalCompositeOperation='copy';context.drawImage(gpu.canvas,0,0);context.globalCompositeOperation=operation;
          drawText(text,retained.clip);previousText=!!text.length;
          result.mode=renderer.mode;return result;
        }catch(error){loseGPU(errorText(error));}
      }
      mode('canvas2d-indexed');
      if(bmpStale){needsFullExpansion=true;dirtyAll();bmpStale=false;}
      var top=rgbaDirty?rgbaDirty.top:height,bottom=rgbaDirty?rgbaDirty.bottom:0;
      for(var s=0;s<stripCount;s++){
        if(!candidates[s])continue;candidates[s]=false;
        if(!hasIndexed[s])continue;
        var start=s*stripRows*width,end=Math.min(indices.length,start+stripRows*width),signature;
        var sigStart=now();
        try{signature=String.fromCharCode.apply(null,indices.subarray(start,end));}catch(ignored){signature=null;}
        result.signatureMs+=now()-sigStart;
        if(!needsFullExpansion&&signature!==null&&signatures[s]===signature){result.skippedPixels+=end-start;continue;}
        var prior=signatures[s];signatures[s]=signature;
        var began=now();
        if(needsFullExpansion||signature===null||prior===null||typeof prior==='undefined'){
          expand(start,end,allIndexed[s]);result.convertedPixels+=end-start;
        }else{
          var length=end-start;
          for(var rowOffset=0;rowOffset<length;rowOffset+=width){
            var rowEnd=Math.min(length,rowOffset+width);
            if(signature.slice(rowOffset,rowEnd)===prior.slice(rowOffset,rowEnd)){result.skippedPixels+=rowEnd-rowOffset;continue;}
            var middle=rowOffset+Math.floor((rowEnd-rowOffset)/2);
            if(signature.charCodeAt(rowOffset)!==prior.charCodeAt(rowOffset)&&signature.charCodeAt(middle)!==prior.charCodeAt(middle)&&signature.charCodeAt(rowEnd-1)!==prior.charCodeAt(rowEnd-1)){
              expand(start+rowOffset,start+rowEnd,allIndexed[s]);result.convertedPixels+=rowEnd-rowOffset;continue;
            }
            for(var offset=rowOffset;offset<rowEnd;offset+=32){
              var limit=Math.min(rowEnd,offset+32);
              if(signature.slice(offset,limit)===prior.slice(offset,limit)){result.skippedPixels+=limit-offset;continue;}
              expand(start+offset,start+limit,allIndexed[s]);result.convertedPixels+=limit-offset;
            }
          }
        }
        result.conversionMs+=now()-began;
        top=Math.min(top,s*stripRows);bottom=Math.max(bottom,Math.min(height,(s+1)*stripRows));
      }
      needsFullExpansion=false;
      if(previousText||text.length){top=0;bottom=height;}
      if(bottom>top)context.putImageData(image,0,0,0,top,width,bottom-top);
      drawText(text,retained.clip);previousText=!!text.length;
      result.mode=renderer.mode;return result;
    }
    function draw(batch) {
      if(destroyed)throw cancelled();
      if(pendingJob)throw new Error('A renderer presentation or probe is already pending.');
      var began=now(),result=drawRetained(retainBatch(batch));
      result.canvasCpuMs=result.presentationMs=now()-began;return result;
    }
    function completelyIndexed() {for(var s=0;s<stripCount;s++)if(!allIndexed[s])return false;return paletteKnown;}
    function present(batch,done) {
      var job=jobFor(done);if(!job)return;
      var began=now(),retained,result,cpuTime=0;
      function fallback(error) {
        if(error){
          bmpEnabled=false;capabilities.bmp={status:'failed',reason:errorText(error),previouslyPassed:true,orientation:bmpTopDown?'top-down':'bottom-up'};
          renderer.mode='canvas2d-indexed';publish();
        }
        var cpuBegan=now();
        try{drawRetained(retained);result.canvasCpuMs=cpuTime+now()-cpuBegan;result.presentationMs=now()-began;finish(job,null,result);}
        catch(drawError){finish(job,drawError);}
      }
      try{
        retained=retainBatch(batch);result=retained.result;
        if(!bmpEnabled||gpu||!completelyIndexed()){
          drawRetained(retained);result.canvasCpuMs=result.presentationMs=now()-began;
          job.timer=scope.setTimeout(function(){finish(job,null,result);},0);return;
        }
        // Text has no transfer buffer, but keep its snapshot stable until decoding finishes.
        var copiedText=[];
        for(var t=0;t<retained.text.length;t++){var item=retained.text[t];copiedText.push({text:item.text,x:item.x,y:item.y,color:item.color});}
        retained.text=copiedText;retained.clip=retained.clip?retained.clip.slice():null;
        bmpStale=true;
        var encodeBegan=now();bmpBytes=encodeBMP(width,height,indices,paletteBytes,bmpTopDown,bmpBytes);result.encodeMs=now()-encodeBegan;
        cpuTime=now()-began;
        var decodeBegan=now();
        decode(job,bmpBytes,function(error,decoded){
          result.encodeMs+=job.decodeSetupMs;cpuTime+=job.decodeSetupMs;
          result.decodeMs=Math.max(0,now()-decodeBegan-job.decodeSetupMs);
          if(error){fallback(error);return;}
          var drawBegan=now(),operation=context.globalCompositeOperation;
          try{
            context.globalCompositeOperation='copy';context.drawImage(decoded,0,0);context.globalCompositeOperation=operation;
            drawText(retained.text,retained.clip);previousText=!!retained.text.length;
            mode('bmp-indexed');result.mode=renderer.mode;result.canvasCpuMs=cpuTime+now()-drawBegan;result.presentationMs=now()-began;
          }catch(drawError){context.globalCompositeOperation=operation;fallback(drawError);return;}
          finish(job,null,result);
        });
      }catch(error){
        if(retained&&bmpEnabled){cpuTime=now()-began;job.timer=scope.setTimeout(function(){fallback(error);},0);}
        else job.timer=scope.setTimeout(function(){finish(job,error);},0);
      }
    }
    function destroy() {
      if(destroyed)return;destroyed=true;
      if(gpu){var old=gpu;gpu=null;old.dispose();}
      indices=mask=rgba=rgbaWords=scratch=ones=zeros=paletteWords=paletteBytes=image=bmpBytes=null;signatures=[];
      if(pendingJob)finish(pendingJob,cancelled());
    }
    return renderer;
  };
}(window));
