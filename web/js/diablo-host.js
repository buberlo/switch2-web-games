/* Host adapter for the d07RiV/Devilution DApi interface. See third_party notices. */
(function (scope) {
  'use strict';
  scope.createDiabloHost = function (emit) {
    var engine, files = Object.create(null), batch, timer, paused = false, stopped = false;
    var frames = 0, lastStats = 0, elapsed = 0, lastTick = 0, audioEnabled = true;
    var framebuffer, output, pixelSize = 4, format = 'rgba';
    var palette = new Uint8Array(1024), paletteWords = new Uint32Array(palette.buffer), sections = Object.create(null);
    var dirty = null, latest = null, inFlight = false, sequence = 0, waitingSequence = 0;
    var ticks = 0, tickTotal = 0, tickMax = 0, bridgeTotal = 0, sentFrames = 0, coalesced = 0;
    var inputTotal = 0, inputMax = 0, inputCalls = 0;
    var inputQueueTotal = 0, inputQueueMax = 0, inputLatencyTotal = 0, inputLatencyMax = 0;
    var loading = false, discardBefore = 0;
    function memoryCapabilities() {
      var result = {}, probe = new Uint8Array([1,2,3,4,5,6]);
      try {
        if (typeof probe.copyWithin !== 'function') throw new Error('Typed-array copyWithin unavailable');
        probe.copyWithin(2,0,4);
        if (probe[0]!==1||probe[1]!==2||probe[2]!==1||probe[3]!==2||probe[4]!==3||probe[5]!==4) throw new Error('Overlapping copy readback failed');
        result.copyWithin = {status:'passed',overlapReadback:true,implementation:Function.prototype.toString.call(probe.copyWithin).indexOf('[native code]')>=0?'browser-native':'javascript'};
      } catch (error) {result.copyWithin = {status:'unavailable',reason:String(error.message || error)};}
      try {
        if (typeof probe.fill !== 'function') throw new Error('Typed-array fill unavailable');
        probe.fill(9,1,4);
        if (probe[1]!==9||probe[2]!==9||probe[3]!==9||probe[4]!==3) throw new Error('Fill readback failed');
        result.fill = {status:'passed',pixelReadback:true,implementation:Function.prototype.toString.call(probe.fill).indexOf('[native code]')>=0?'browser-native':'javascript'};
      } catch (error) {result.fill = {status:'unavailable',reason:String(error.message || error)};}
      return result;
    }
    function selectFormat(value) {
      if (framebuffer && value === format) return;
      var changed = !!framebuffer;
      format = value;pixelSize = value === 'indexed' ? 1 : 4;
      framebuffer = new Uint8Array(640 * 480 * pixelSize);
      if (changed) dirty = {left:0, top:0, right:640, bottom:480};
    }
    function markDirty(x, y, w, h) {
      if (!dirty) dirty = {left:x, top:y, right:x+w, bottom:y+h};
      else {dirty.left=Math.min(dirty.left,x);dirty.top=Math.min(dirty.top,y);dirty.right=Math.max(dirty.right,x+w);dirty.bottom=Math.max(dirty.bottom,y+h);}
    }
    function send(action, data, transfer) {
      data = data || {}; data.action = action; emit(data, transfer || []);
    }
    function fail(error) { clearInterval(timer); stopped = true; send('error', {message: String(error && error.message || error)}); }
    function present() {
      if (inFlight || !latest || stopped) return;
      var began = performance.now();
      var images = [], transfer = [], rect = dirty;
      if (rect) {
        var width = rect.right - rect.left, height = rect.bottom - rect.top;
        var required = 640 * 480 * pixelSize + (format === 'indexed' ? 1024 : 0);
        if (!output || output.byteLength < required) output = new ArrayBuffer(required);
        var bytes = new Uint8Array(output, 0, width * height * pixelSize), start = (rect.top * 640 + rect.left) * pixelSize;
        if (width === 640) bytes.set(framebuffer.subarray(start, start + bytes.length));
        else for (var row = 0; row < height; row++) {
          var offset = start + row * 640 * pixelSize;
          bytes.set(framebuffer.subarray(offset, offset + width * pixelSize), row * width * pixelSize);
        }
        var image = {x:rect.left, y:rect.top, w:width, h:height, bytes:bytes, format:format, stride:width};
        if (format === 'indexed') {image.palette = new Uint8Array(output, 640 * 480, 1024);image.palette.set(palette);}
        images.push(image);transfer.push(output);
      }
      var pending = latest;latest = null;dirty = null;inFlight = true;waitingSequence = ++sequence;sentFrames++;
      send('render', {batch:{images:images, text:pending.text, clip:pending.clip, palette:images.length && images[0].palette || null}, sequence:waitingSequence, sentAt:Date.now()}, transfer);
      bridgeTotal += performance.now() - began;
    }
    function tick() {
      if (stopped || paused) return;
      try {
        var now = performance.now();
        elapsed += Math.min(250, now - lastTick); lastTick = now;
        engine._DApi_Render(Math.floor(elapsed) >>> 0);
        var end = performance.now(), duration = end - now;ticks++;tickTotal += duration;tickMax = Math.max(tickMax, duration);
        if (end - lastStats >= 2000) {
          send('metrics', {fps: frames * 1000 / (end - lastStats), heapBytes: engine.HEAPU8.length,
            tickMs:tickTotal / ticks, maxTickMs:tickMax, bridgeMs:bridgeTotal / ticks,
            sentFrames:sentFrames, coalescedFrames:coalesced, pendingRender:inFlight, format:format,
            inputMs:inputCalls ? inputTotal / inputCalls : 0, maxInputMs:inputMax,
            inputQueueMs:inputCalls ? inputQueueTotal / inputCalls : 0, maxInputQueueMs:inputQueueMax,
            inputLatencyMs:inputCalls ? inputLatencyTotal / inputCalls : 0, maxInputLatencyMs:inputLatencyMax, sections:sections});
          frames = ticks = tickTotal = tickMax = bridgeTotal = sentFrames = coalesced = 0; lastStats = end;
          inputTotal = inputMax = inputCalls = 0;sections = Object.create(null);
          inputQueueTotal = inputQueueMax = inputLatencyTotal = inputLatencyMax = 0;
        }
      } catch (e) { fail(e); }
    }
    scope.DApi = {
      exit_error: function (message) { throw new Error(message); },
      exit_game: function () { stopped = true; clearInterval(timer); send('exit'); },
      current_save_id: function (id) { send('current_save', {name: id >= 0 ? 'spawn' + id + '.sv' : null}); },
      get_file_size: function (name) { var file = files[name.toLowerCase()]; return file ? file.length : 0; },
      get_file_contents: function (name, target, offset) { var file = files[name.toLowerCase()]; if (file) target.set(file.subarray(offset, offset + target.length)); },
      put_file_contents: function (name, data) {
        name = name.toLowerCase(); files[name] = data;
        var copy = data.slice(); send('fs', {operation: 'put', name: name, data: copy}, [copy.buffer]);
      },
      remove_file: function (name) { name = name.toLowerCase(); delete files[name]; send('fs', {operation: 'delete', name: name}); },
      set_cursor: function (x, y) { send('cursor', {x: x, y: y}); },
      open_keyboard: function (x0, y0, x1, y1, length) { send('keyboard', {open: true, length: length}); },
      close_keyboard: function () { send('keyboard', {open: false}); },
      use_websocket: function () {}, websocket_closed: function () { return true; }, websocket_send: function () {},
      draw_begin: function () { batch = {text: [], clip: null}; },
      draw_blit: function (x, y, w, h, bytes) {
        if (!batch) return;
        selectFormat('rgba');
        var started = performance.now(), destination = (y * 640 + x) * 4;
        if (w === 640) framebuffer.set(bytes, destination);
        else for (var row = 0; row < h; row++) framebuffer.set(bytes.subarray(row * w * 4, (row + 1) * w * 4), destination + row * 640 * 4);
        markDirty(x,y,w,h);
        bridgeTotal += performance.now() - started;
      },
      draw_indexed: function (x, y, w, h, bytes, stride, sourcePalette) {
        if (!batch) return;
        selectFormat('indexed');
        var started = performance.now(), destination = y * 640 + x, changed = false;
        if (w === 640 && stride === 640) framebuffer.set(bytes.subarray(0,w*h),destination);
        else for (var row = 0; row < h; row++) framebuffer.set(bytes.subarray(row*stride,row*stride+w),destination+row*640);
        for (var i = 0; i < 256; i++) {
          var p = i*4, color = (sourcePalette[p] | sourcePalette[p+1]<<8 | sourcePalette[p+2]<<16 | 0xff000000) >>> 0;
          if (paletteWords[i] !== color) {paletteWords[i] = color;changed = true;}
        }
        if (changed) markDirty(0,0,640,480);else markDirty(x,y,w,h);
        bridgeTotal += performance.now() - started;
      },
      profiler: function (name, milliseconds) {
        var entry = sections[name] || (sections[name] = {ms:0,calls:0,maxMs:0});
        entry.ms += milliseconds;entry.calls++;entry.maxMs = Math.max(entry.maxMs,milliseconds);
      },
      phase: function (name, details) {
        if (name === 'loading-start') loading = true;
        if (name === 'game-ready' || name === 'loading-end') {loading = false;discardBefore = Date.now();}
        send('phase',{name:name,details:details || null});
      },
      sound_enabled: function () { return audioEnabled; },
      draw_clip_text: function (x0, y0, x1, y1) { if (batch) batch.clip = [x0,y0,x1,y1]; },
      draw_text: function (x, y, text, color) { if (batch) batch.text.push({x:x,y:y,text:text,color:color}); },
      draw_belt: function () {},
      draw_end: function () {
        if (!batch) return;
        frames++;if (latest) coalesced++;latest = batch;batch = null;
        present();
      }
    };
    scope.alert = function (message) { fail(message); };
    ['create_sound_raw','create_sound','duplicate_sound','play_sound','set_volume','stop_sound','delete_sound'].forEach(function (name) {
      scope.DApi[name] = function () {
        if (!audioEnabled) return;
        var args = Array.prototype.slice.call(arguments), transfer = [];
        if ((name === 'create_sound' || name === 'create_sound_raw') && args[1]) transfer.push(args[1].buffer);
        send('audio', {method:name, args:args}, transfer);
      };
    });
    return {
      init: function (data) {
        audioEnabled = data.audioEnabled !== false;
        // Old pages remain compatible during a live engine update.
        if (!data.indexed) scope.DApi.draw_indexed = undefined;
        files['spawn.mpq'] = new Uint8Array(data.archive);
        (data.saves || []).forEach(function (file) { files[file.name] = new Uint8Array(file.bytes); });
        send('progress', {message:'Preparing the Diablo engine…'});
        return scope.DiabloSpawn({print:function(){},printErr:function(line){send('log',{message:String(line)});},onAbort:fail}).then(function (module) {
          if (stopped) return;
          engine = module; elapsed = Date.now() >>> 0; engine._DApi_Init(elapsed, 0, 1, 0, 0);
          lastTick = lastStats = performance.now(); timer = setInterval(tick, 50);
          send('loaded',{nativeMemory:memoryCapabilities()});
        }).catch(fail);
      },
      event: function (name, args, id, sentAt) {
        if (!engine || stopped) return;
        try {
          var release = name === 'DApi_Key' && args[0] === 1 || name === 'DApi_Mouse' && args[0] === 2;
          if (!release && (loading || sentAt && sentAt < discardBefore)) {
            if (id) send('input-complete',{id:id,milliseconds:0,discarded:true});
            return;
          }
          var started = performance.now(),queueMs=typeof sentAt==='number'?Math.max(0,Date.now()-sentAt):0;
          if (name === 'text') {
            var text = String(args[0]).slice(0,255), ptr = engine._DApi_SyncTextPtr(), i;
            for (i=0;i<text.length;i++) engine.HEAPU8[ptr+i] = text.charCodeAt(i) & 255;
            engine.HEAPU8[ptr+i] = 0; engine._DApi_SyncText(args[1] || 0);
          } else if (['DApi_Mouse','DApi_Key','DApi_Char'].indexOf(name) >= 0) engine['_' + name].apply(null,args);
          var duration = performance.now() - started;inputTotal += duration;inputMax = Math.max(inputMax,duration);inputCalls++;
          inputQueueTotal+=queueMs;inputQueueMax=Math.max(inputQueueMax,queueMs);
          inputLatencyTotal+=queueMs+duration;inputLatencyMax=Math.max(inputLatencyMax,queueMs+duration);
          if (duration >= 1000) discardBefore = Date.now();
          if (duration >= 100) send('input-timing',{name:name,milliseconds:duration,id:id || null});
          if (id) send('input-complete',{id:id,milliseconds:duration});
        } catch (e) { fail(e); }
      },
      pause: function (value) { paused = value; lastTick = performance.now(); },
      acknowledge: function (id, buffer) {
        if (!inFlight || id !== waitingSequence) return;
        if (buffer) output = buffer;
        inFlight = false;present();
      },
      stop: function () { stopped = true; clearInterval(timer); }
    };
  };
})(self);
