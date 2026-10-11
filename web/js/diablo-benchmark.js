/* Opt-in device measurement. Normal game pages do not run this controller. */
(function () {
  'use strict';
  if (!/(?:^|[?&])benchmark=1(?:&|$)/.test(location.search)) return;

  function query() {
    var fields = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (part) {
      if (!part) return;
      var split = part.indexOf('='), key = split < 0 ? part : part.slice(0,split), value = split < 0 ? '' : part.slice(split+1);
      try { fields[decodeURIComponent(key.replace(/\+/g,' '))] = decodeURIComponent(value.replace(/\+/g,' ')); } catch (_) {}
    });
    return fields;
  }
  var configuration = query(), comparison = configuration.compare === 'renderers';
  var pair = Number(configuration.comparePair || 1), selection = configuration.renderer === 'bmp' ? 'bmp' : 'canvas';
  if (!isFinite(pair) || Math.floor(pair) !== pair || pair < 1 || pair > 3) pair = 1;
  var comparisonId = String(configuration.compareId || Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)).slice(0,80);
  var game = window.diabloStatus;
  var state = window.diabloBenchmark = {stage:'starting', results:{}, error:null, reloadsPending:false,
    comparison:comparison, pair:comparison ? pair : null, selection:configuration.renderer || 'automatic', comparisonId:comparison ? comparisonId : null};
  var cancelled = false, reloading = false, checkingBuild = false, pendingRevision = null, navigating = false;
  var movementTimer = null;
  // Fixed screen-space walking commands use the same route for each new temporary warrior.
  var movement = {intervalMs:2000, coordinates:[[384,208],[256,208],[256,272],[384,272]], plannedClicks:10,
    clicks:0, began:0, latenessTotal:0, latenessMaximum:0, deliveries:[]};
  var banner = document.createElement('section'), title = document.createElement('strong');
  var status = document.createElement('p'), results = document.createElement('p'), normal = document.createElement('a');
  banner.id = 'benchmark-banner';banner.setAttribute('aria-label','Switch speed test');
  banner.style.cssText = 'margin:12px auto;padding:14px 18px;max-width:960px;background:#181f2d;color:#f3f5fa;border:1px solid #bfa36a;border-radius:8px;font:15px/1.45 system-ui,sans-serif;';
  title.textContent = comparison ? 'Switch renderer comparison — pair '+pair+' / 3 · '+selection.toUpperCase() : 'Switch speed test — temporary character';
  status.id = 'benchmark-status';status.setAttribute('role','status');
  results.id = 'benchmark-results';normal.href = '/play/diablo';normal.textContent = 'Play normally';normal.style.color = '#edcf90';
  banner.appendChild(title);banner.appendChild(status);banner.appendChild(results);banner.appendChild(normal);
  document.body.insertBefore(banner, document.querySelector('main') || document.body.firstChild);

  function now() { return performance.now(); }
  function round(value) { return Math.round(value * 100) / 100; }
  function stage(value, message) { state.stage = value;status.textContent = message; }
  function stopMovement() { if (movementTimer !== null) clearTimeout(movementTimer);movementTimer=null; }
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
      'signatureMs','conversionMs','encodingMs','decodingMs','presentationMs','canvasCpuMs',
      'inputQueueMs','maxInputQueueMs','inputLatencyMs','maxInputLatencyMs'].forEach(function (key) {
      if (typeof source[key] === 'number' && isFinite(source[key])) value[key] = round(source[key]);
    });
    return value;
  }
  function report(name, extra) {
    var payload = {kind:'game', event:'benchmark', game:'diablo-shareware', stage:name,
      engineSha256:game && game.engineSha256 || null, frontendSha256:game && game.frontendSha256 || null,
      revisionSha256:game && game.revisionSha256 || null, mode:game && game.mode || null,
      renderer:game && game.renderer || null, rendererSelection:configuration.renderer || 'automatic', phase:game && game.phase || null,
      compare:comparison ? 'renderers' : null, comparisonId:comparison ? comparisonId : null, pair:comparison ? pair : null,
      ua:String(navigator.userAgent).slice(0,512), ts:new Date().toISOString(),
      capabilities:game ? safeCapabilities() : {}, benchmark:true, temporaryCharacter:true};
    Object.keys(extra || {}).forEach(function (key) { payload[key] = extra[key]; });
    if (JSON.stringify(payload).length > 16000 && payload.measurement) delete payload.measurement.samples;
    if (window.Portal && typeof Portal.report === 'function') return Portal.report(payload).catch(function () {});
    return Promise.resolve();
  }
  function fail(error) {
    if (cancelled || reloading || navigating) return;
    cancelled = true;stopMovement();state.error = String(error && error.message || error).slice(0,500);
    stage('error', 'Speed test stopped: ' + state.error);
    report('error', {message:state.error});
  }
  function blocked(reason) {
    cancelled = true;stopMovement();state.error = String(reason).slice(0,500);
    stage('blocked','Renderer comparison stopped: '+state.error+' The Canvas renderer remains the default.');
    report('blocked',{message:state.error,qualification:false});
  }
  function checkGame() {
    if (cancelled || reloading || navigating) throw new Error('Measurement stopped.');
    if (game.error) throw new Error(game.error);
    if (document.hidden) throw new Error('Keep the game page visible for a valid measurement. Reopen the speed test to retry.');
    if (comparison && selection === 'bmp' && game.capabilities && game.capabilities.bmp &&
        (game.capabilities.bmp.status === 'unavailable' || game.capabilities.bmp.status === 'failed')) {
      var reason = game.capabilities.bmp.reason || 'The browser did not pass indexed BMP pixel decoding.';
      blocked(reason);throw new Error(reason);
    }
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
    var menu = state.results.menu, town = state.results.town, moving = state.results.movingTown;
    results.textContent = (menu ? 'Menu: '+menu.presentedFps.toFixed(1)+' FPS' : 'Menu: waiting') +
      (town ? ' · Town: '+town.presentedFps.toFixed(1)+' FPS' : ' · Town: waiting') +
      (moving ? ' · Walking: '+moving.presentedFps.toFixed(1)+' FPS' : ' · Walking: waiting') +
      ' · '+(game.renderer || game.mode || 'starting');
  }
  function measure(name, milliseconds) {
    var began = now(), firstFrame = game.frames, firstInput = game.inputs, samples = [];
    var lastSampleFrame = game.performance && typeof game.performance.frames === 'number' ? game.performance.frames : -1;
    var timingBlocksSkipped = 0;
    if (name==='movingTown') {movement.began=began;walk();}
    return new Promise(function (resolve,reject) {
      function sample() {
        try {
          checkGame();
          if (!game.loaded) throw new Error('The engine closed during the '+name+' measurement.');
          if (game.inputBlocked || game.pendingInputId) throw new Error('Unexpected loading interrupted the '+name+' measurement.');
          var timing = timingSnapshot();
          if (timing.frames !== undefined && timing.frames !== lastSampleFrame && samples.length < 24) {
            lastSampleFrame = timing.frames;
            // The first newly delivered metrics block may still include the
            // preceding phase/loading. Keep FPS over the full phase, but collect
            // timings only after that partial block has passed.
            if (timingBlocksSkipped===0) timingBlocksSkipped++;
            else samples.push(timing);
          }
          var elapsed = now() - began;
          status.textContent = 'Measuring '+(name==='movingTown'?'walking in town':name)+'… '+Math.min(Math.floor(elapsed/1000),milliseconds/1000)+' / '+milliseconds/1000+' seconds. Please leave the controls still.';
          if (elapsed >= milliseconds) {
            var frameCount = game.frames - firstFrame;
            if (!frameCount) throw new Error('No new frames reached the screen during the '+name+' measurement.');
            var measurement = {presentedFps:round(frameCount*1000/elapsed),elapsedMs:round(elapsed),frames:frameCount,
              inputs:game.inputs-firstInput,samples:samples,timingBlocksSkipped:timingBlocksSkipped,
              timingSamplePolicy:'Ignore the initial snapshot and first new metrics block to exclude preceding-phase/loading timings.',
              source:'presented frame counter divided by elapsed browser time',qualification:false};
            if (name==='movingTown') {
              stopMovement();
              if (movement.clicks!==movement.plannedClicks) throw new Error('The prescribed walking sequence did not finish within the 20-second window. This run cannot be compared.');
              measurement.movement={intervalMs:movement.intervalMs,coordinates:movement.coordinates,
                plannedClicks:movement.plannedClicks,clicks:movement.clicks,
                meanTimerLatenessMs:round(movement.latenessTotal/movement.clicks),maxTimerLatenessMs:round(movement.latenessMaximum),
                deliveries:movement.deliveries};
            }
            state.results[name] = measurement;updateResults();
            report(name,{measurement:measurement});resolve(measurement);return;
          }
          setTimeout(sample,1000);
        } catch (error) { stopMovement();reject(error); }
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
  function walk() {
    checkGame();
    if (!game.loaded || game.inputBlocked || game.pendingInputId) throw new Error('The game is not ready for the walking measurement.');
    var expected = movement.clicks*movement.intervalMs, elapsed = now()-movement.began, lateness=Math.max(0,elapsed-expected);
    if (lateness>=movement.intervalMs) throw new Error('The walking command arrived '+Math.round(lateness)+' ms late. The fixed sequence cannot be delivered without a burst; this run cannot be compared.');
    var point = movement.coordinates[movement.clicks % movement.coordinates.length], canvas = document.getElementById('screen');
    var bounds = canvas.getBoundingClientRect(), x = bounds.left+point[0]*bounds.width/640, y = bounds.top+point[1]*bounds.height/480;
    ['mousemove','mousedown','mouseup'].forEach(function (type) {
      var event = document.createEvent('MouseEvents');
      event.initMouseEvent(type,true,true,window,1,0,0,x,y,false,false,false,false,0,null);
      canvas.dispatchEvent(event);
    });
    movement.latenessTotal+=lateness;movement.latenessMaximum=Math.max(movement.latenessMaximum,lateness);
    movement.deliveries.push({targetMs:expected,dispatchMs:round(elapsed),latenessMs:round(lateness),x:point[0],y:point[1]});
    movement.clicks++;
    movementTimer = movement.clicks<movement.plannedClicks ? setTimeout(function () { try { walk(); } catch (error) { fail(error); } },
      Math.max(0,movement.began+movement.clicks*movement.intervalMs-now())) : null;
  }
  function submitName() {
    var input = document.getElementById('game-text'), form = document.getElementById('text-entry');
    if (form.hidden || game.inputBlocked) throw new Error('The character-name prompt was not ready.');
    input.value = 'SwitchBench';
    var changed = document.createEvent('Event');changed.initEvent('input',true,true);input.dispatchEvent(changed);
    stage('loading','Preparing the temporary character. Your normal saves are not used.');
    var submit = document.createEvent('Event');submit.initEvent('submit',true,true);form.dispatchEvent(submit);
  }
  function replace(fields) {
    var next = query();
    Object.keys(fields).forEach(function (key) { if (fields[key]===null) delete next[key];else next[key]=String(fields[key]); });
    var search = Object.keys(next).sort().map(function (key) { return encodeURIComponent(key)+'='+encodeURIComponent(next[key]); }).join('&');
    location.replace(location.pathname+'?'+search+location.hash);
  }
  function canReload() {
    return game && game.revisionSha256 && !game.inputBlocked && !game.pendingInputId &&
      game.phase !== 'loading-start' && game.phase !== 'loading-progress' && state.stage !== 'starting' && state.stage !== 'loading';
  }
  function maybeReload() {
    if (!pendingRevision || reloading || navigating || !canReload()) return;
    reloading = true;stopMovement();state.reloadsPending = true;
    stage('updating','Updated game code is ready. Restarting the temporary speed test…');
    var didReload = false;
    var reload = function () {
      if (didReload) return;didReload=true;
      if (comparison) replace({renderer:'canvas',comparePair:1,compareId:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10),compareRevision:pendingRevision});
      else location.reload();
    };
    report('build-change',{nextRevisionSha256:pendingRevision}).then(reload);setTimeout(reload,1500);
  }
  function watchBuild() {
    if (reloading || navigating) return;
    maybeReload();if (checkingBuild || reloading) return;
    checkingBuild = true;
    var xhr = new XMLHttpRequest();xhr.open('GET','/assets/runtime.json?benchmark-check='+Date.now(),true);xhr.timeout=5000;
    function finish() { checkingBuild=false;maybeReload(); }
    xhr.onload = function () {
      try {
        var next = xhr.status===200 && JSON.parse(xhr.responseText).revisionSha256;
        if (typeof next==='string' && /^[a-f0-9]{64}$/i.test(next) && game.revisionSha256 && next!==game.revisionSha256) pendingRevision=next;
      } catch (_) {}
      finish();
    };
    xhr.onerror=xhr.ontimeout=xhr.onabort=finish;xhr.send();
  }
  function nextComparison() {
    if (!comparison) return;
    if (selection==='bmp' && pair===3) {
      stage('complete','All three Canvas/BMP pairs are complete. Results were sent to the Mac for review. The default renderer has not changed.');
      report('comparison-complete',{pairs:3,qualification:false});return;
    }
    navigating = true;stopMovement();
    var nextSelection = selection==='canvas'?'bmp':'canvas', nextPair=selection==='canvas'?pair:pair+1;
    stage('next','Preparing pair '+nextPair+' / 3 · '+nextSelection.toUpperCase()+'…');
    var moved=false, navigate=function(){if(moved)return;moved=true;replace({renderer:nextSelection,comparePair:nextPair,compareId:comparisonId,compareRevision:game.revisionSha256});};
    report('comparison-next',{nextPair:nextPair,nextRenderer:nextSelection}).then(navigate);setTimeout(navigate,1500);
  }

  if (!game || game.benchmark !== true) {
    fail(new Error('The page has not enabled temporary-save protection. Reload after the Mac setup is updated.'));return;
  }
  if (comparison && (configuration.renderer!==selection || Number(configuration.comparePair)!==pair || !configuration.compareId)) {
    navigating=true;replace({renderer:selection,comparePair:pair,compareId:comparisonId});return;
  }
  updateResults();stage('starting','Starting an isolated speed test. Normal saves stay untouched.');
  setInterval(watchBuild,10000);setInterval(maybeReload,1000);
  setTimeout(function () {
    try { document.getElementById('start').click(); }
    catch (error) { fail(error);return; }
    waitFor(function () { return game.loaded && game.frames>0 && game.performance; },90000,'The engine did not become ready within 90 seconds.')
      .then(function () {
        if (comparison && configuration.compareRevision && configuration.compareRevision!==game.revisionSha256) {
          pendingRevision=game.revisionSha256;stage('menu','Restarting comparison after a code update.');maybeReload();throw new Error('Comparison revision changed.');
        }
        if (comparison && selection==='bmp' && (!game.capabilities || !game.capabilities.bmp || game.capabilities.bmp.status!=='passed')) {
          blocked('The browser did not complete the indexed BMP capability probe.');throw new Error(state.error);
        }
        report('start',{movementSequence:movement.coordinates,movementIntervalMs:movement.intervalMs});
        stage('menu','Measuring the main menu…');return measure('menu',6000);
      })
      .then(function () { stage('character','Opening the temporary warrior…');enter();return delay(1000); })
      .then(function () { enter();return waitFor(function(){return !document.getElementById('text-entry').hidden;},15000,'The character-name prompt did not appear. No further keys were sent.'); })
      .then(function () { submitName();return waitFor(function(){return game.phase==='game-ready'&&!game.inputBlocked&&!game.pendingInputId;},90000,'The character did not finish loading within 90 seconds.'); })
      .then(function () { stage('town','Measuring Tristram…');return measure('town',20000); })
      .then(function () { stage('movingTown','Measuring the same walking sequence…');return measure('movingTown',20000); })
      .then(function () {
        stage('complete','Speed test complete. The temporary character stays in town. These measurements describe this browser run.');
        updateResults();return report('complete',{menu:state.results.menu.presentedFps,town:state.results.town.presentedFps,movingTown:state.results.movingTown.presentedFps});
      }).then(nextComparison).catch(fail);
  },0);
})();
