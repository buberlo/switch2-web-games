/* Opt-in device measurement. Normal game pages do not run this controller. */
(function () {
  'use strict';
  if (!/(?:^|[?&])benchmark=1(?:&|$)/.test(location.search)) return;

  var game = window.diabloStatus;
  var state = window.diabloBenchmark = {stage:'starting', results:{}, error:null, reloadsPending:false};
  var cancelled = false, reloading = false, checkingBuild = false, pendingHash = null;
  var banner = document.createElement('section'), title = document.createElement('strong');
  var status = document.createElement('p'), results = document.createElement('p'), normal = document.createElement('a');
  banner.id = 'benchmark-banner';banner.setAttribute('aria-label','Switch speed test');
  banner.style.cssText = 'margin:12px auto;padding:14px 18px;max-width:960px;background:#181f2d;color:#f3f5fa;border:1px solid #bfa36a;border-radius:8px;font:15px/1.45 system-ui,sans-serif;';
  title.textContent = 'Switch speed test — temporary character';
  status.id = 'benchmark-status';status.setAttribute('role','status');
  results.id = 'benchmark-results';normal.href = '/play/diablo';normal.textContent = 'Play normally';normal.style.color = '#edcf90';
  banner.appendChild(title);banner.appendChild(status);banner.appendChild(results);banner.appendChild(normal);
  document.body.insertBefore(banner, document.querySelector('main') || document.body.firstChild);

  function now() { return performance.now(); }
  function round(value) { return Math.round(value * 100) / 100; }
  function stage(value, message) { state.stage = value;status.textContent = message; }
  function safeCapabilities() {
    try {
      var text = JSON.stringify(game.capabilities || {});
      return text.length <= 4096 ? JSON.parse(text) : {omitted:'Capability report exceeded its size limit.'};
    } catch (_) { return {}; }
  }
  function timingSnapshot() {
    var source = game.performance || {}, value = {};
    ['fps','engineFps','frames','inputs','heapBytes','tickMs','maxTickMs','bridgeMs','canvasMs','maxCanvasMs',
      'inputMs','maxInputMs','sentFrames','coalescedFrames','deliveryLagMs','convertedPixels','skippedPixels',
      'signatureMs','conversionMs'].forEach(function (key) {
      if (typeof source[key] === 'number' && isFinite(source[key])) value[key] = round(source[key]);
    });
    return value;
  }
  function report(name, extra) {
    var payload = {kind:'game', event:'benchmark', game:'diablo-shareware', stage:name,
      engineSha256:game && game.engineSha256 || null, mode:game && game.mode || null,
      renderer:game && game.renderer || null, phase:game && game.phase || null,
      ua:String(navigator.userAgent).slice(0,512), ts:new Date().toISOString(),
      capabilities:game ? safeCapabilities() : {}, benchmark:true, temporaryCharacter:true};
    Object.keys(extra || {}).forEach(function (key) { payload[key] = extra[key]; });
    // Keep the report well below the diagnostics API limit, including UTF-8 text.
    if (JSON.stringify(payload).length > 16000 && payload.measurement) delete payload.measurement.samples;
    if (window.Portal && typeof Portal.report === 'function') return Portal.report(payload).catch(function () {});
    return Promise.resolve();
  }
  function fail(error) {
    if (cancelled || reloading) return;
    cancelled = true;state.error = String(error && error.message || error).slice(0,500);
    stage('error', 'Speed test stopped: ' + state.error);
    report('error', {message:state.error});
  }
  function checkGame() {
    if (cancelled || reloading) throw new Error('Measurement stopped.');
    if (game.error) throw new Error(game.error);
    if (document.hidden) throw new Error('Keep the game page visible for a valid measurement. Reopen the speed test to retry.');
  }
  function waitFor(predicate, milliseconds, message) {
    var began = now();
    return new Promise(function (resolve,reject) {
      function poll() {
        try {
          checkGame();
          if (predicate()) { resolve();return; }
          if (now() - began >= milliseconds) throw new Error(message);
          setTimeout(poll,100);
        } catch (error) { reject(error); }
      }
      poll();
    });
  }
  function delay(milliseconds) { var began = now();return waitFor(function(){return now()-began>=milliseconds;},milliseconds+2000,'The game did not respond.'); }
  function updateResults() {
    var menu = state.results.menu, town = state.results.town;
    results.textContent = (menu ? 'Menu: '+menu.presentedFps.toFixed(1)+' FPS' : 'Menu: waiting') +
      (town ? ' · Town: '+town.presentedFps.toFixed(1)+' FPS' : ' · Town: waiting') +
      ' · '+(game.renderer || game.mode || 'starting');
  }
  function measure(name, milliseconds) {
    var began = now(), firstFrame = game.frames, lastSampleFrame = -1, samples = [];
    return new Promise(function (resolve,reject) {
      function sample() {
        try {
          checkGame();
          if (!game.loaded) throw new Error('The engine closed during the '+name+' measurement.');
          if (game.inputBlocked || game.pendingInputId) throw new Error('Unexpected loading interrupted the '+name+' measurement.');
          var timing = timingSnapshot();
          if (timing.frames !== undefined && timing.frames !== lastSampleFrame && samples.length < 24) {
            lastSampleFrame = timing.frames;samples.push(timing);
          }
          var elapsed = now() - began;
          status.textContent = 'Measuring '+name+'… '+Math.min(Math.floor(elapsed/1000),milliseconds/1000)+' / '+milliseconds/1000+' seconds. Please leave the controls still.';
          if (elapsed >= milliseconds) {
            var frameCount = game.frames - firstFrame;
            if (!frameCount) throw new Error('No new frames reached the screen during the '+name+' measurement.');
            var measurement = {presentedFps:round(frameCount*1000/elapsed),elapsedMs:round(elapsed),frames:frameCount,
              samples:samples,source:'presented frame counter divided by elapsed browser time',qualification:false};
            state.results[name] = measurement;updateResults();
            report(name,{measurement:measurement});resolve(measurement);return;
          }
          setTimeout(sample,1000);
        } catch (error) { reject(error); }
      }
      sample();
    });
  }
  function enter() {
    checkGame();
    if (!game.loaded || game.inputBlocked || game.pendingInputId) throw new Error('The game is not ready for the next menu step.');
    var canvas = document.getElementById('screen');canvas.focus();
    ['keydown','keyup'].forEach(function (type) {
      var event = document.createEvent('Event');event.initEvent(type,true,true);
      event.key = 'Enter';event.keyCode = 13;event.which = 13;
      canvas.dispatchEvent(event);
    });
  }
  function submitName() {
    var input = document.getElementById('game-text'), form = document.getElementById('text-entry');
    if (form.hidden || game.inputBlocked) throw new Error('The character-name prompt was not ready.');
    input.value = 'SwitchBench';
    var changed = document.createEvent('Event');changed.initEvent('input',true,true);input.dispatchEvent(changed);
    stage('loading','Preparing the temporary character. Your normal saves are not used.');
    var submit = document.createEvent('Event');submit.initEvent('submit',true,true);form.dispatchEvent(submit);
  }
  function canReload() {
    return game && game.engineSha256 && !game.inputBlocked && !game.pendingInputId &&
      game.phase !== 'loading-start' && game.phase !== 'loading-progress' && state.stage !== 'starting' && state.stage !== 'loading';
  }
  function maybeReload() {
    if (!pendingHash || reloading || !canReload()) return;
    reloading = true;state.reloadsPending = true;
    stage('updating','A new engine is ready. Restarting the temporary speed test…');
    var didReload = false;
    var reload = function () { if (!didReload) { didReload=true;location.reload(); } };
    report('build-change',{nextEngineSha256:pendingHash}).then(reload);
    // Logging must never prevent a new build from being tested.
    setTimeout(reload,1500);
  }
  function watchBuild() {
    if (reloading) return;
    maybeReload();
    if (checkingBuild || reloading) return;
    checkingBuild = true;
    var xhr = new XMLHttpRequest();xhr.open('GET','/engine/build.json?benchmark-check='+Date.now(),true);xhr.timeout=5000;
    function finish() { checkingBuild=false;maybeReload(); }
    xhr.onload = function () {
      try {
        var next = xhr.status===200 && JSON.parse(xhr.responseText).sha256;
        if (typeof next==='string' && /^[a-f0-9]{64}$/i.test(next) && game.engineSha256 && next!==game.engineSha256) pendingHash=next;
      } catch (_) {}
      finish();
    };
    xhr.onerror=xhr.ontimeout=xhr.onabort=finish;xhr.send();
  }

  if (!game || game.benchmark !== true) {
    fail(new Error('The page has not enabled temporary-save protection. Reload after the Mac setup is updated.'));
    return;
  }
  updateResults();stage('starting','Starting an isolated speed test. Normal saves stay untouched.');
  setInterval(watchBuild,10000);
  setInterval(maybeReload,1000);
  setTimeout(function () {
    try { document.getElementById('start').click(); }
    catch (error) { fail(error);return; }
    waitFor(function () { return game.loaded && game.frames>0 && game.performance; },90000,'The engine did not become ready within 90 seconds.')
      .then(function () { stage('menu','Measuring the main menu…');return measure('menu',6000); })
      .then(function () { stage('character','Opening the temporary warrior…');enter();return delay(1000); })
      .then(function () { enter();return waitFor(function(){return !document.getElementById('text-entry').hidden;},15000,'The character-name prompt did not appear. No further keys were sent.'); })
      .then(function () { submitName();return waitFor(function(){return game.phase==='game-ready'&&!game.inputBlocked&&!game.pendingInputId;},90000,'The character did not finish loading within 90 seconds.'); })
      .then(function () { stage('town','Measuring Tristram…');return measure('town',20000); })
      .then(function () {
        stage('complete','Speed test complete. The temporary character stays in town. These measurements describe this browser run.');
        updateResults();report('complete',{menu:state.results.menu.presentedFps,town:state.results.town.presentedFps});
      }).catch(fail);
  },0);
})();
