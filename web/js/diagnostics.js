(function (window, document) {
  'use strict';

  var probes = {};
  var inputs = { counts: {}, gameKeys: {}, pointerTypes: {}, trustedEventFlag: null };
  var revision = 0;
  var reportTimer = null;
  var reportBusy = false;
  var lastReportAt = 0;
  var gamepadTimer = null;
  var gamepadDeadline = 0;
  var inputPaintTimer = null;
  var lastInput = 'No input observed yet.';
  var audioContext = null;
  var audioGeneration = 0;
  var closing = false;
  var labels = { passed: 'Passed', failed: 'Failed', unavailable: 'Unavailable', 'not-tested': 'Not tested' };
  var inputTypes = { mouse: ['mousedown', 'mouseup', 'mousemove'], touch: ['touchstart', 'touchend', 'touchmove', 'touchcancel'], pointer: ['pointerdown', 'pointerup', 'pointermove', 'pointercancel'], keyboard: ['keydown', 'keyup'] };
  var safeGameKeys = { ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Enter: 1, Escape: 1, ' ': 1, Tab: 1, Shift: 1, Control: 1, Alt: 1, Backspace: 1 };
  var legacyKeys = { 8: 'Backspace', 9: 'Tab', 13: 'Enter', 16: 'Shift', 17: 'Control', 18: 'Alt', 27: 'Escape', 32: ' ', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };

  function el(id) { return document.getElementById(id); }
  function message(error) { return String(error && error.message ? error.message : error).slice(0, 240); }
  function update(id, status, detail, extra) {
    var result = { status: status, detail: detail };
    if (extra) result.observations = extra;
    if (JSON.stringify(probes[id]) === JSON.stringify(result)) return;
    probes[id] = result;
    var card = el('probe-' + id);
    if (card) {
      var badge = card.querySelector('.result');
      badge.className = 'result result-' + status;
      badge.textContent = labels[status];
      card.querySelector('.probe-detail').textContent = detail;
    }
    revision += 1;
    queueReport();
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({
      version: 1,
      page: 'diagnostics',
      at: new Date().toISOString(),
      environment: {
        userAgent: String(navigator.userAgent || '').slice(0, 400),
        protocol: window.location.protocol,
        secureContext: typeof window.isSecureContext === 'boolean' ? window.isSecureContext : null,
        viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0, pixelRatio: window.devicePixelRatio || 1 },
        visibility: document.visibilityState || 'unknown'
      },
      probes: probes,
      input: inputs
    }));
  }

  function queueReport() {
    if (reportTimer || closing) return;
    reportTimer = window.setTimeout(function () {
      reportTimer = null;
      saveReport();
    }, Math.max(1000, 5000 - (Date.now() - lastReportAt)));
  }

  function saveReport() {
    if (reportBusy) { queueReport(); return; }
    if (reportTimer) { window.clearTimeout(reportTimer); reportTimer = null; }
    var capturedRevision = revision;
    var data = snapshot();
    reportBusy = true;
    lastReportAt = Date.now();
    el('report-status').className = 'muted';
    el('report-status').textContent = 'Saving results to your Mac…';
    window.Portal.report(data).then(function () {
      reportBusy = false;
      el('report-status').className = 'muted report-success';
      el('report-status').textContent = 'Results saved on your Mac.';
      el('report-updated').textContent = 'Last saved at ' + new Date().toLocaleTimeString();
      if (revision !== capturedRevision) queueReport();
    }, function (error) {
      reportBusy = false;
      el('report-status').className = 'muted report-error';
      el('report-status').textContent = 'Results not saved: ' + message(error);
      if (revision !== capturedRevision) queueReport();
    });
  }

  function canvasProbe() {
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 2; canvas.height = 2;
      var context = canvas.getContext('2d');
      if (!context) { update('canvas2d', 'unavailable', 'This browser did not create a 2D canvas context.'); return; }
      context.fillStyle = 'rgb(30,144,255)';
      context.fillRect(0, 0, 2, 2);
      var pixel = context.getImageData(1, 1, 1, 1).data;
      if (pixel[0] !== 30 || pixel[1] !== 144 || pixel[2] !== 255 || pixel[3] !== 255) throw new Error('The pixel readback did not match the drawn color.');
      update('canvas2d', 'passed', 'Drew a blue pixel and read back the expected RGBA values.', { pixel: [pixel[0], pixel[1], pixel[2], pixel[3]] });
    } catch (error) { update('canvas2d', 'failed', message(error)); }
  }

  function glProbe(version) {
    var gl = null;
    var id = 'webgl' + version;
    var program = null;
    var buffer = null;
    var vertex = null;
    var fragment = null;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 4; canvas.height = 4;
      gl = canvas.getContext(version === 2 ? 'webgl2' : 'webgl', { antialias: false, preserveDrawingBuffer: true });
      if (!gl && version === 1) gl = canvas.getContext('experimental-webgl', { antialias: false, preserveDrawingBuffer: true });
      if (!gl) { update(id, 'unavailable', 'This browser did not create a WebGL ' + version + ' context.'); return; }
      function shader(kind, source) {
        var result = gl.createShader(kind);
        gl.shaderSource(result, source);
        gl.compileShader(result);
        if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) {
          var reason = gl.getShaderInfoLog(result);
          gl.deleteShader(result);
          throw new Error('Shader compilation failed: ' + String(reason).slice(0, 160));
        }
        return result;
      }
      vertex = shader(gl.VERTEX_SHADER, version === 2
        ? '#version 300 es\nin vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}'
        : 'attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}');
      fragment = shader(gl.FRAGMENT_SHADER, version === 2
        ? '#version 300 es\nprecision mediump float; out vec4 color; void main(){color=vec4(1.0,0.5,0.25,1.0);}'
        : 'precision mediump float; void main(){gl_FragColor=vec4(1.0,0.5,0.25,1.0);}');
      program = gl.createProgram();
      gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('The triangle shader did not link.');
      gl.useProgram(program);
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      var location = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 4, 4); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      var pixel = new Uint8Array(4);
      gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (gl.getError() !== gl.NO_ERROR || Math.abs(pixel[0] - 255) > 3 || Math.abs(pixel[1] - 128) > 3 || Math.abs(pixel[2] - 64) > 3 || pixel[3] !== 255) throw new Error('Triangle pixel readback failed or returned the wrong color.');
      update(id, 'passed', 'A real triangle rendered and its pixel color matched.', { pixel: [pixel[0], pixel[1], pixel[2], pixel[3]], version: String(gl.getParameter(gl.VERSION)).slice(0, 100) });
    } catch (error) { update(id, 'failed', message(error)); }
    finally {
      if (gl) {
        if (buffer) gl.deleteBuffer(buffer);
        if (program) gl.deleteProgram(program);
        if (vertex) gl.deleteShader(vertex);
        if (fragment) gl.deleteShader(fragment);
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    }
  }

  function workerProbe() {
    return new Promise(function (resolve) {
      if (typeof window.Worker === 'undefined') { update('worker', 'unavailable', 'The Worker API is not exposed in this browser.'); resolve(); return; }
      var worker = null;
      var timer = null;
      var finished = false;
      var id = 'probe-' + Date.now();
      function finish(status, detail, data) {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        if (worker) worker.terminate();
        update('worker', status, detail, data);
        resolve();
      }
      try {
        worker = new Worker('/js/probe-worker.js');
        worker.onmessage = function (event) {
          if (!event.data || event.data.id !== id || event.data.type !== 'portal-probe-result') return;
          finish('passed', 'A classic worker received a message and returned the matching reply.', { webAssemblyGlobal: event.data.webAssemblyGlobal === true, arrayBuffer: event.data.arrayBuffer === true });
        };
        worker.onerror = function (event) { finish('failed', 'Worker error: ' + String(event.message || 'could not start').slice(0, 160)); };
        timer = window.setTimeout(function () { finish('failed', 'The worker did not reply within 5 seconds.'); }, 5000);
        worker.postMessage({ type: 'portal-probe', id: id });
      } catch (error) { finish('failed', message(error)); }
    });
  }

  function wasmProbe() {
    return new Promise(function (resolve) {
      if (typeof window.WebAssembly === 'undefined') { update('wasm', 'unavailable', 'The WebAssembly global is not exposed. Diablo uses its JavaScript build.'); resolve(); return; }
      if (typeof window.WebAssembly.instantiate !== 'function') { update('wasm', 'unavailable', 'WebAssembly is present, but the instantiate function is unavailable.'); resolve(); return; }
      var finished = false;
      var timer = window.setTimeout(function () { finish('failed', 'Module execution did not finish within 5 seconds.'); }, 5000);
      function finish(status, detail) {
        if (finished) return;
        finished = true; window.clearTimeout(timer); update('wasm', status, detail); resolve();
      }
      try {
        var bytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,10,1,6,97,110,115,119,101,114,0,0,10,6,1,4,0,65,42,11]);
        Promise.resolve(window.WebAssembly.instantiate(bytes)).then(function (result) {
          var instance = result.instance || result;
          if (!instance.exports || typeof instance.exports.answer !== 'function' || instance.exports.answer() !== 42) { finish('failed', 'The module did not return the expected answer.'); return; }
          finish('passed', 'A tiny WebAssembly module instantiated and its function returned 42.');
        }).then(null, function (error) { finish('failed', message(error)); });
      } catch (error) { finish('failed', message(error)); }
    });
  }

  function runChecks() {
    var button = el('run-checks');
    button.disabled = true;
    button.textContent = 'Checking browser…';
    var names = ['canvas2d', 'worker', 'webgl1', 'webgl2', 'wasm'];
    for (var i = 0; i < names.length; i += 1) update(names[i], 'not-tested', 'Running this check…');
    canvasProbe();
    glProbe(1); glProbe(2);
    Promise.all([workerProbe(), wasmProbe()]).then(function () {
      button.disabled = false; button.textContent = 'Run checks again'; queueReport();
    }, function (error) {
      button.disabled = false; button.textContent = 'Run checks again';
      el('report-status').textContent = 'Check interrupted: ' + message(error);
    });
  }

  function memoryProbe() {
    if (typeof ArrayBuffer === 'undefined') { update('memory', 'unavailable', 'ArrayBuffer is not exposed in this browser.'); return; }
    var allocation = null;
    var edge = null;
    try {
      allocation = new ArrayBuffer(128 * 1024 * 1024);
      edge = new Uint8Array(allocation);
      edge[0] = 23; edge[edge.length - 1] = 71;
      if (edge[0] !== 23 || edge[edge.length - 1] !== 71) throw new Error('Buffer edge readback failed.');
      update('memory', 'passed', 'Allocated a 128 MiB ArrayBuffer and checked both ends. References were released; this does not measure physical free RAM or game stability.', { bytes: allocation.byteLength, touchedBytes: 2 });
    } catch (error) { update('memory', 'failed', message(error)); }
    finally { edge = null; allocation = null; }
    el('test-memory').disabled = true;
    el('test-memory').textContent = 'Allocation checked';
  }

  function audioProbe() {
    var Constructor = window.AudioContext || window.webkitAudioContext;
    if (!Constructor) { update('audio', 'unavailable', 'The Web Audio API is not exposed in this browser.'); return; }
    var generation = ++audioGeneration;
    el('test-audio').disabled = true;
    el('confirm-audio').hidden = true;
    var timer = null;
    function finish(status, detail) {
      if (generation !== audioGeneration) return;
      audioGeneration += 1;
      window.clearTimeout(timer);
      el('test-audio').disabled = false;
      if (audioContext && audioContext.close) {
        try { var result = audioContext.close(); if (result && result.then) result.then(function () {}, function () {}); } catch (ignored) {}
      }
      audioContext = null;
      update('audio', status, detail, { heardConfirmed: false });
      el('confirm-audio').hidden = status !== 'passed';
    }
    try {
      audioContext = new Constructor();
      var started = audioContext.resume ? audioContext.resume() : null;
      timer = window.setTimeout(function () { finish('failed', 'Audio did not become ready within 4 seconds.'); }, 4000);
      Promise.resolve(started).then(function () {
        if (generation !== audioGeneration) return;
        if (audioContext.state && audioContext.state !== 'running') { finish('failed', 'The audio context stayed ' + audioContext.state + '. Try a direct tap on the sound button.'); return; }
        var oscillator = audioContext.createOscillator();
        var gain = audioContext.createGain();
        oscillator.frequency.value = 440;
        gain.gain.value = 0.035;
        oscillator.connect(gain); gain.connect(audioContext.destination);
        oscillator.start(); oscillator.stop(audioContext.currentTime + 0.15);
        window.setTimeout(function () { finish('passed', 'The audio context ran and a short tone was scheduled. Confirm below if you heard it.'); }, 250);
      }).then(null, function (error) { finish('failed', message(error)); });
    } catch (error) { finish('failed', message(error)); }
  }

  function stopGamepads() {
    if (gamepadTimer) window.clearInterval(gamepadTimer);
    gamepadTimer = null;
    el('test-gamepad').textContent = 'Listen for controller input';
  }

  function gamepadPoll() {
    if (Date.now() > gamepadDeadline) {
      stopGamepads();
      if (probes.gamepad.status !== 'passed') update('gamepad', 'not-tested', 'Listening ended after 60 seconds without observed controller input. You can try again.');
      return;
    }
    try {
      var pads = navigator.getGamepads();
      var observed = [];
      var changed = false;
      for (var p = 0; p < Math.min(pads.length, 4); p += 1) {
        var pad = pads[p];
        if (!pad) continue;
        var buttons = [];
        var axes = [];
        for (var b = 0; b < Math.min(pad.buttons.length, 24); b += 1) {
          if (pad.buttons[b].pressed || pad.buttons[b].value > 0.25 || pad.buttons[b] > 0.25) buttons.push(b);
        }
        for (var a = 0; a < Math.min(pad.axes.length, 8); a += 1) {
          var axis = Math.round(pad.axes[a] * 10) / 10;
          axes.push(Math.abs(axis) > 0.2 ? axis : 0);
          if (Math.abs(axis) > 0.2) changed = true;
        }
        if (buttons.length) changed = true;
        observed.push({ index: p, mapping: String(pad.mapping || '').slice(0, 32), buttonsPressed: buttons, axes: axes });
      }
      if (changed) {
        update('gamepad', 'passed', 'Observed button or stick input from ' + observed.length + ' connected controller(s).', { pads: observed });
      } else if (probes.gamepad.status !== 'passed') {
        update('gamepad', 'not-tested', observed.length ? 'Controller visible. Move a stick or press a button to prove input.' : 'Listening. No controller has been exposed by this browser yet.', { visibleControllers: observed.length });
      }
    } catch (error) {
      stopGamepads();
      update('gamepad', 'failed', message(error) + ' Browser policy may restrict controller access on this HTTP connection.');
    }
  }

  function startGamepads() {
    if (gamepadTimer) { stopGamepads(); return; }
    if (typeof navigator.getGamepads !== 'function') {
      update('gamepad', 'unavailable', 'The Gamepad API is not exposed in this page. HTTP or captive-browser policy may restrict it; this does not establish whether a controller is connected.');
      return;
    }
    gamepadDeadline = Date.now() + 60000;
    gamepadPoll();
    if (probes.gamepad.status === 'failed') return;
    gamepadTimer = window.setInterval(gamepadPoll, 150);
    el('test-gamepad').textContent = 'Stop listening';
  }

  function paintInputs() {
    inputPaintTimer = null;
    for (var family in inputTypes) {
      if (!Object.prototype.hasOwnProperty.call(inputTypes, family)) continue;
      var count = 0;
      for (var i = 0; i < inputTypes[family].length; i += 1) count += inputs.counts[inputTypes[family][i]] || 0;
      if (count) update(family, 'passed', count + ' event' + (count === 1 ? '' : 's') + ' observed in the test area.');
    }
    el('last-input').textContent = lastInput;
  }

  function inputEvent(event) {
    if (event.isTrusted === false) return;
    inputs.trustedEventFlag = typeof event.isTrusted === 'boolean';
    inputs.counts[event.type] = Math.min(1000000, (inputs.counts[event.type] || 0) + 1);
    if (event.type === 'keydown' || event.type === 'keyup') {
      var key = event.key || legacyKeys[event.keyCode];
      if (key && safeGameKeys[key]) inputs.gameKeys[key === ' ' ? 'Space' : key] = Math.min(1000000, (inputs.gameKeys[key === ' ' ? 'Space' : key] || 0) + 1);
      if (key && (key.indexOf('Arrow') === 0 || key === ' ')) event.preventDefault();
    }
    if (event.pointerType && (event.pointerType === 'mouse' || event.pointerType === 'touch' || event.pointerType === 'pen')) inputs.pointerTypes[event.pointerType] = true;
    if (event.type === 'touchstart' || event.type === 'touchmove') event.preventDefault();
    lastInput = 'Observed: ' + event.type;
    revision += 1;
    if (!inputPaintTimer) inputPaintTimer = window.setTimeout(paintInputs, 120);
    queueReport();
  }

  function init() {
    el('browser-context').textContent = 'Connection: ' + window.location.protocol.replace(':', '').toUpperCase() + ' · Secure context: ' + (typeof window.isSecureContext === 'boolean' ? (window.isSecureContext ? 'yes' : 'no') : 'not reported') + ' · ' + (window.innerWidth || 0) + ' × ' + (window.innerHeight || 0);
    var names = ['memory', 'audio', 'gamepad', 'mouse', 'touch', 'pointer', 'keyboard'];
    for (var i = 0; i < names.length; i += 1) {
      var card = el('probe-' + names[i]);
      probes[names[i]] = { status: 'not-tested', detail: card.querySelector('.probe-detail').textContent };
    }
    el('run-checks').addEventListener('click', runChecks);
    el('save-report').addEventListener('click', saveReport);
    el('test-memory').addEventListener('click', memoryProbe);
    el('test-audio').addEventListener('click', audioProbe);
    el('confirm-audio').addEventListener('click', function () {
      update('audio', 'passed', 'Audio context ran; you confirmed hearing the test tone.', { heardConfirmed: true });
      el('confirm-audio').hidden = true;
    });
    el('test-gamepad').addEventListener('click', startGamepads);
    var pad = el('input-pad');
    for (var family in inputTypes) {
      if (!Object.prototype.hasOwnProperty.call(inputTypes, family)) continue;
      for (var t = 0; t < inputTypes[family].length; t += 1) pad.addEventListener(inputTypes[family][t], inputEvent, false);
    }
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stopGamepads();
    });
    window.addEventListener('pagehide', function () {
      closing = true; stopGamepads();
      if (reportTimer) window.clearTimeout(reportTimer);
      if (audioContext && audioContext.close) {
        try { audioContext.close(); } catch (ignored) {}
      }
    });
    runChecks();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}(window, document));
