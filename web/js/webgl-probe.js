/* Standalone ES5 WebGL research. Context creation is synchronous for trusted taps.
 * A successful context is explicitly lost before another one can be created. */
(function (scope) {
  'use strict';
  var busy = false, reloadRequired = false;
  var minimal = {alpha:false, antialias:false, depth:false, stencil:false, preserveDrawingBuffer:false, failIfMajorPerformanceCaveat:false};
  function now() { return scope.performance && scope.performance.now ? scope.performance.now() : Date.now(); }
  function text(value, limit) { return String(value == null ? '' : value).slice(0, limit || 220); }
  function exception(error) { return {name:text(error && error.name || 'Error', 60), message:text(error && error.message || error)}; }
  function copyAttributes(value) {
    if (!value) return null;
    var keys = ['alpha','antialias','depth','stencil','preserveDrawingBuffer','failIfMajorPerformanceCaveat','premultipliedAlpha','powerPreference','desynchronized'], result = {};
    for (var i = 0; i < keys.length; i++) if (typeof value[keys[i]] === 'boolean' || typeof value[keys[i]] === 'string') result[keys[i]] = typeof value[keys[i]] === 'string' ? text(value[keys[i]],40) : value[keys[i]];
    return result;
  }
  function canvasPosition(canvas, reveal) {
    var document = scope.document, attached = !!(document.documentElement && document.documentElement.contains(canvas));
    var roots = [document.documentElement, document.body], previous = [], rect, scrollError = null;
    if (reveal && attached) {
      // Boolean scrollIntoView works on legacy browsers and stays in the trusted
      // event stack. Temporarily disable smooth scrolling before reading geometry.
      for (var i = 0; i < roots.length; i++) if (roots[i]) { previous[i] = roots[i].style.scrollBehavior; roots[i].style.scrollBehavior = 'auto'; }
      try {
        if (canvas.scrollIntoView) canvas.scrollIntoView(true);
        else { rect = canvas.getBoundingClientRect(); scope.scrollTo((scope.pageXOffset || 0) + rect.left, (scope.pageYOffset || 0) + rect.top); }
      } catch (error) { scrollError = exception(error); }
      for (var r = 0; r < roots.length; r++) if (roots[r]) roots[r].style.scrollBehavior = previous[r] || '';
    }
    rect = canvas.getBoundingClientRect();
    function boundedNumber(value) { return isFinite(value) ? Math.round(Math.max(-1000000, Math.min(1000000,value)) * 100) / 100 : 0; }
    var width = scope.innerWidth || document.documentElement.clientWidth || 0, height = scope.innerHeight || document.documentElement.clientHeight || 0;
    var left = rect.left, top = rect.top, w = rect.right - rect.left, h = rect.bottom - rect.top;
    var value = {attached:attached, inViewport:attached && w > 0 && h > 0 && rect.right > 0 && rect.bottom > 0 && left < width && top < height,
      fullyInViewport:attached && w > 0 && h > 0 && left >= 0 && top >= 0 && rect.right <= width && rect.bottom <= height,
      rect:{left:boundedNumber(left),top:boundedNumber(top),width:boundedNumber(w),height:boundedNumber(h)},viewport:{width:boundedNumber(width),height:boundedNumber(height)}};
    if (scrollError) value.scrollError = scrollError;
    return value;
  }
  function cases() {
    var list = [], executions = ['visible-auto','detached-auto','trusted-tap'], names = ['webgl','experimental-webgl','webgl2'];
    for (var e = 0; e < executions.length; e++) for (var n = 0; n < names.length; n++) for (var a = 0; a < 2; a++) {
      list.push({id:executions[e] + '-' + names[n] + '-' + (a ? 'minimal' : 'default'), execution:executions[e], contextName:names[n], attributes:a ? copyAttributes(minimal) : null});
    }
    return list;
  }
  function runCase(spec, options, done) {
    options = options || {};
    if (typeof done !== 'function') throw new Error('Completion callback is required.');
    if (busy || reloadRequired) {
      scope.setTimeout(function () { done(new Error(reloadRequired ? 'Reload this page before creating another WebGL context.' : 'A WebGL case is already running.')); }, 0);
      return function () {};
    }
    var valid = false, definitions = cases();
    for (var d = 0; d < definitions.length; d++) if (spec && definitions[d].id === spec.id && definitions[d].contextName === spec.contextName && definitions[d].execution === spec.execution && JSON.stringify(definitions[d].attributes) === JSON.stringify(spec.attributes)) valid = true;
    if (!valid) { scope.setTimeout(function () { done(new Error('Unknown WebGL probe case.')); }, 0); return function () {}; }
    busy = true;
    var document = scope.document, canvas = document.createElement('canvas'), gl = null, finished = false, ending = false;
    var timeout = null, pending = null, raf = null, lossTimer = null, activeCanvas = canvas, lossHandler = null;
    var resources = [], currentStage = 'creation';
    var result = {schemaVersion:1, id:spec.id, contextName:spec.contextName, execution:spec.execution, requestedAttributes:copyAttributes(spec.attributes),
      trustedGesture:options.trustedGesture === true || options.trusted === true, visibility:document.visibilityState || 'unknown', userActivation:{available:false,isActive:null,hasBeenActive:null}, contextStatus:'not-attempted', creationMs:0,
      api:{webgl1:typeof scope.WebGLRenderingContext, webgl2:typeof scope.WebGL2RenderingContext}, creationErrors:[], exception:null,
      actualAttributes:null, info:null, canvasAtCreation:null, checks:[], animation:null, cancelled:false, requiresReload:false,
      cleanup:{resourcesDeleted:0, contextLossRequested:false, contextLostAcknowledged:false, recreated:false, recreatedReleased:false}};
    try {
      var activation = scope.navigator && scope.navigator.userActivation;
      if (activation && typeof activation.isActive === 'boolean' && typeof activation.hasBeenActive === 'boolean') result.userActivation={available:true,isActive:activation.isActive,hasBeenActive:activation.hasBeenActive};
    } catch (ignoredActivation) {}
    canvas.width = 16; canvas.height = 16;
    canvas.setAttribute('aria-label', 'WebGL research canvas');
    canvas.style.display='block'; canvas.style.width='auto'; canvas.style.maxWidth='100%'; canvas.style.height='auto';
    function creationError(event) { if (result.creationErrors.length < 4) result.creationErrors.push(text(event.statusMessage)); }
    canvas.addEventListener('webglcontextcreationerror', creationError, false);
    function removeCanvas(value) { if (value && value.parentNode) value.parentNode.removeChild(value); }
    function clearTimers() {
      if (timeout !== null) { scope.clearTimeout(timeout); timeout = null; }
      if (pending !== null) { scope.clearTimeout(pending); pending = null; }
      if (raf !== null) { if (scope.cancelAnimationFrame) scope.cancelAnimationFrame(raf); else scope.clearTimeout(raf); raf = null; }
    }
    function finish() {
      if (finished) return; finished = true; clearTimers();
      if (lossTimer !== null) scope.clearTimeout(lossTimer);
      if (lossHandler && activeCanvas) activeCanvas.removeEventListener('webglcontextlost', lossHandler, false);
      canvas.removeEventListener('webglcontextcreationerror', creationError, false);
      removeCanvas(canvas); if (activeCanvas !== canvas) removeCanvas(activeCanvas);
      reloadRequired = reloadRequired || result.requiresReload; busy = false;
      scope.setTimeout(function () { done(null, result); }, 0);
    }
    function check(name, status, details) { if (result.checks.length < 12) result.checks.push({name:name, status:status, details:details || null}); }
    function deleteResources() {
      for (var i = resources.length - 1; i >= 0; i--) try { gl['delete' + resources[i].kind](resources[i].object); result.cleanup.resourcesDeleted++; } catch (ignored) {}
      resources = [];
    }
    function release(context, target, callback) {
      activeCanvas = target;
      var settled = false, extension;
      function complete(ack) {
        if (settled) return; settled = true;
        if (lossTimer !== null) { scope.clearTimeout(lossTimer); lossTimer = null; }
        if (lossHandler) target.removeEventListener('webglcontextlost', lossHandler, false);
        lossHandler = null; callback(ack);
      }
      try { if (context.isContextLost()) { complete(true); return; } extension = context.getExtension('WEBGL_lose_context'); } catch (ignored) {}
      if (!extension || typeof extension.loseContext !== 'function') { result.requiresReload = true; complete(false); return; }
      lossHandler = function (event) { event.preventDefault(); complete(true); };
      target.addEventListener('webglcontextlost', lossHandler, false);
      lossTimer = scope.setTimeout(function () { result.requiresReload = true; complete(false); }, 650);
      try { result.cleanup.contextLossRequested = true; extension.loseContext(); }
      catch (error) { check('context-release', 'failed', exception(error)); result.requiresReload = true; complete(false); }
    }
    function recreate() {
      var fresh = document.createElement('canvas'), second = null;
      fresh.width = 16; fresh.height = 16; fresh.style.cssText=canvas.style.cssText; activeCanvas = fresh;
      try {
        removeCanvas(canvas);
        if (spec.execution !== 'detached-auto' && options.container) options.container.appendChild(fresh);
        var position=canvasPosition(fresh,spec.execution !== 'detached-auto');
        second = spec.attributes === null ? fresh.getContext(spec.contextName) : fresh.getContext(spec.contextName, spec.attributes);
        if (!second) { check('context-recreation', 'failed', {reason:'A fresh context returned null after acknowledged context loss.'}); finish(); return; }
        result.cleanup.recreated = true;
        second.clearColor(0,1,0,1); second.clear(second.COLOR_BUFFER_BIT);
        var pixel = new Uint8Array(4); second.readPixels(0,0,1,1,second.RGBA,second.UNSIGNED_BYTE,pixel);
        if (pixel[0] !== 0 || pixel[1] !== 255 || pixel[2] !== 0 || pixel[3] !== 255 || second.getError() !== second.NO_ERROR) throw new Error('Recreated context pixel readback failed.');
        check('context-recreation', 'passed',{attached:position.attached,inViewport:position.inViewport,trustedGesture:false});
      } catch (error) { check('context-recreation', 'failed', exception(error)); }
      if (second) release(second, fresh, function (ack) { result.cleanup.recreatedReleased = ack; finish(); }); else finish();
    }
    function end(validateLifecycle) {
      if (ending || finished) return; ending = true; clearTimers(); deleteResources();
      if (!gl) { finish(); return; }
      release(gl, canvas, function (ack) {
        result.cleanup.contextLostAcknowledged = ack;
        if (validateLifecycle && ack && !result.cancelled) recreate();
        else { if (validateLifecycle) check('context-recreation', 'not-tested', {reason:'Explicit context release was unavailable or unacknowledged; reload required.'}); finish(); }
      });
    }
    function fail(error) { check(currentStage, 'failed', exception(error)); end(false); }
    function owned(kind, object) { if (!object) throw new Error('Could not create WebGL ' + kind + '.'); resources.push({kind:kind, object:object}); return object; }
    function shader(kind, source) {
      var item = owned('Shader', gl.createShader(kind)); gl.shaderSource(item, source); gl.compileShader(item);
      if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) throw new Error('Shader compilation failed: ' + text(gl.getShaderInfoLog(item), 160)); return item;
    }
    function program(vertex, fragment) {
      var item = owned('Program', gl.createProgram()); gl.attachShader(item, shader(gl.VERTEX_SHADER, vertex)); gl.attachShader(item, shader(gl.FRAGMENT_SHADER, fragment)); gl.linkProgram(item);
      if (!gl.getProgramParameter(item, gl.LINK_STATUS)) throw new Error('Shader linking failed: ' + text(gl.getProgramInfoLog(item), 160)); gl.useProgram(item); return item;
    }
    function geometry(item, vertices) {
      var buffer = owned('Buffer', gl.createBuffer()); gl.bindBuffer(gl.ARRAY_BUFFER,buffer); gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(vertices),gl.STATIC_DRAW);
      var position = gl.getAttribLocation(item,'position'); if (position < 0) throw new Error('Shader position attribute is unavailable.');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    }
    function noError() { var error = gl.getError(); if (error !== gl.NO_ERROR) throw new Error('WebGL error ' + error + '.'); }
    function pixelAt(x,y,expected) {
      var pixel = new Uint8Array(4); gl.readPixels(x,y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel); noError();
      for (var c = 0; c < 4; c++) if (Math.abs(pixel[c] - expected[c]) > 1) throw new Error('Pixel readback mismatch at component ' + c + ': ' + pixel[c] + ' instead of ' + expected[c] + '.');
    }
    function validate() {
      try {
        currentStage = 'clear-readback'; gl.disable(gl.DITHER); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
        gl.clearColor(17/255,43/255,97/255,1); gl.clear(gl.COLOR_BUFFER_BIT); pixelAt(0,0,[17,43,97,255]); check(currentStage,'passed');
        var v2 = spec.contextName === 'webgl2', prefix = v2 ? '#version 300 es\n' : '', input = v2 ? 'in' : 'attribute';
        currentStage = 'triangle';
        var triangle = program(prefix + input + ' vec2 position;void main(){gl_Position=vec4(position,0.,1.);}', prefix + 'precision mediump float;' + (v2 ? 'out vec4 pixel;' : '') + 'void main(){' + (v2 ? 'pixel' : 'gl_FragColor') + '=vec4(1.,0.,0.,1.);}');
        geometry(triangle,[-1,-1,1,-1,0,1]); gl.viewport(0,0,16,16); gl.drawArrays(gl.TRIANGLES,0,3); pixelAt(8,6,[255,0,0,255]); check(currentStage,'passed');
        currentStage = 'diablo-palette';
        var sample = v2 ? 'texture' : 'texture2D', precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);
        var paletteProgram = program(prefix + input + ' vec2 position;' + (v2 ? 'out' : 'varying') + ' vec2 uv;void main(){uv=vec2(position.x*.5+.5,.5-position.y*.5);gl_Position=vec4(position,0.,1.);}',
          prefix + 'precision ' + (precision && precision.precision > 0 ? 'highp' : 'mediump') + ' float;' + (v2 ? 'in' : 'varying') + ' vec2 uv;uniform sampler2D indices;uniform sampler2D palette;uniform sampler2D rgba;uniform sampler2D indexedMask;uniform float paletteShift;' + (v2 ? 'out vec4 pixel;' : '') +
          'void main(){float i=floor(' + sample + '(indices,uv).r*255.+.5);i=mod(i+paletteShift,256.);vec4 p=' + sample + '(palette,vec2((i+.5)/256.,.5));vec4 raw=' + sample + '(rgba,uv);' + (v2 ? 'pixel' : 'gl_FragColor') + '=mix(raw,p,step(.5,' + sample + '(indexedMask,uv)' + (v2 ? '.r' : '.a') + '));}');
        geometry(paletteProgram,[-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]);
        var indices = new Uint8Array(512), palette = new Uint8Array(1024), raw = new Uint8Array(2048), masks = new Uint8Array(512), expected = new Uint8Array(2048);
        for (var i = 0; i < 256; i++) { palette[i*4]=i; palette[i*4+1]=(i*7)&255; palette[i*4+2]=(i*13)&255; palette[i*4+3]=255; }
        for (var p = 0; p < 512; p++) {
          indices[p] = p < 256 ? p : 511-p; masks[p] = p < 256 || p%2 === 0 ? 255 : 0;
          raw[p*4]=23; raw[p*4+1]=149; raw[p*4+2]=201; raw[p*4+3]=255;
          for (var c = 0; c < 4; c++) expected[p*4+c]=masks[p] ? palette[indices[p]*4+c] : raw[p*4+c];
        }
        gl.pixelStorei(gl.UNPACK_ALIGNMENT,1); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
        function texture(unit, name, internal, format, width, height, bytes) {
          var item = owned('Texture',gl.createTexture()); gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,item);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D,0,internal,width,height,0,format,gl.UNSIGNED_BYTE,bytes); gl.uniform1i(gl.getUniformLocation(paletteProgram,name),unit);
        }
        texture(0,'indices',v2?gl.R8:gl.LUMINANCE,v2?gl.RED:gl.LUMINANCE,256,2,indices);
        texture(1,'palette',gl.RGBA,gl.RGBA,256,1,palette); texture(2,'rgba',gl.RGBA,gl.RGBA,256,2,raw);
        texture(3,'indexedMask',v2?gl.R8:gl.ALPHA,v2?gl.RED:gl.ALPHA,256,2,masks);
        canvas.width=256; canvas.height=2; gl.viewport(0,0,256,2); gl.drawArrays(gl.TRIANGLES,0,6);
        var actual = new Uint8Array(2048); gl.readPixels(0,0,256,2,gl.RGBA,gl.UNSIGNED_BYTE,actual); noError();
        for (var y = 0; y < 2; y++) for (var x = 0; x < 256; x++) for (var b = 0; b < 4; b++) if (actual[(y*256+x)*4+b] !== expected[((1-y)*256+x)*4+b]) throw new Error('Palette or mixed RGBA readback mismatch at ' + x + ',' + y + ',' + b + '.');
        check(currentStage,'passed',{paletteEntries:256,mixedRGBA:true,rowOrientation:true});
        var paletteShift = gl.getUniformLocation(paletteProgram,'paletteShift');
        currentStage = 'animation'; canvas.width=640; canvas.height=480; gl.viewport(0,0,640,480);
        if (spec.execution === 'detached-auto' && options.container) options.container.appendChild(canvas);
        var animationPosition=canvasPosition(canvas,true);
        var start = now(), previous = start, frames = 0, totalInterval = 0, maxInterval = 0, hidden = document.visibilityState === 'hidden';
        function frame() {
          if (ending || finished) return;
          try {
            var time = now(), interval = time - previous; previous = time;
            if (document.visibilityState === 'hidden') hidden = true;
            gl.uniform1f(paletteShift,frames&255); gl.drawArrays(gl.TRIANGLES,0,6); noError(); frames++; totalInterval += interval; maxInterval = Math.max(maxInterval,interval);
            if (time-start >= 2000) {
              result.animation={frames:frames,elapsedMs:time-start,fps:frames*1000/(time-start),meanFrameMs:totalInterval/frames,maxFrameMs:maxInterval,width:640,height:480,hiddenDuringRun:hidden,attached:!!canvas.parentNode,canvasAtStart:animationPosition,timingMeaning:'Submitted draws per animation callback; display presentation and hardware acceleration are unconfirmed.'};
              check('animation','passed',{submittedFrames:frames}); end(true); return;
            }
            raf = scope.requestAnimationFrame ? scope.requestAnimationFrame(frame) : scope.setTimeout(frame,16);
          } catch (error) { fail(error); }
        }
        raf = scope.requestAnimationFrame ? scope.requestAnimationFrame(frame) : scope.setTimeout(frame,16);
      } catch (error) { fail(error); }
    }
    try {
      if (spec.execution !== 'detached-auto') {
        if (!options.container || typeof options.container.appendChild !== 'function') throw new Error('Visible probe cases require a container.');
        options.container.appendChild(canvas);
      }
      result.canvasAtCreation=canvasPosition(canvas,spec.execution !== 'detached-auto');
      var began = now();
      try { gl = spec.attributes === null ? canvas.getContext(spec.contextName) : canvas.getContext(spec.contextName,spec.attributes); result.contextStatus=gl?'created':'null'; }
      catch (error) { result.contextStatus='threw'; result.exception=exception(error); }
      result.creationMs=now()-began;
      if (!gl) { pending=scope.setTimeout(function () { end(false); },80); }
      else {
        try {
          result.actualAttributes=copyAttributes(gl.getContextAttributes());
          var extensions=gl.getSupportedExtensions()||[], names=[]; for(var ex=0;ex<extensions.length&&ex<64;ex++) names.push(text(extensions[ex],100));
          result.info={version:text(gl.getParameter(gl.VERSION)),shadingLanguageVersion:text(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),renderer:text(gl.getParameter(gl.RENDERER)),vendor:text(gl.getParameter(gl.VENDOR)),extensions:names};
        } catch (metadataError) { check('context-info','failed',exception(metadataError)); }
        timeout=scope.setTimeout(function () { fail(new Error('WebGL validation exceeded its five-second deadline.')); },5000);
        pending=scope.setTimeout(validate,0);
      }
    } catch (setupError) { result.exception=exception(setupError); pending=scope.setTimeout(function () { end(false); },0); }
    return function () { if (!finished) { result.cancelled=true; if (!ending) end(false); } };
  }
  scope.SwitchWebGLProbe={cases:cases,runCase:runCase};
}(window));
