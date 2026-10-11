/* Isolated Chrome integration test. Run with Node; PLAYWRIGHT_MODULE is optional. */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8093';
const artifacts = path.join(root, 'data', 'qa', 'benchmark-browser');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-benchmark-browser-'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let server, browser, page, deadlineTimer;
let serverOutput = '';
const requests = [], reports = [], errors = [], navigations = [], initializations = [], characterNames = [], mouseCommands = [];

function profileHashes() {
  const directory = path.join(temporaryRoot, 'data', 'saves');
  return Object.fromEntries(fs.readdirSync(directory).sort().map(name => [name, sha256(fs.readFileSync(path.join(directory, name)))]));
}

function assertMeasurement(measurement, minimumMilliseconds, label) {
  assert(measurement, label + ' measurement is missing');
  assert(Number.isFinite(measurement.presentedFps) && measurement.presentedFps > 0, label + ' must measure presented frames');
  assert(Number.isFinite(measurement.elapsedMs) && measurement.elapsedMs >= minimumMilliseconds, label + ' sampling window was too short');
  assert(Number.isInteger(measurement.frames) && measurement.frames > 1, label + ' must contain multiple presented frames');
  const samples = Array.isArray(measurement.samples) ? measurement.samples.length : measurement.samples;
  assert(Number.isInteger(samples) && samples > 0, label + ' must collect timing samples');
  assert.equal(measurement.timingBlocksSkipped, 1, label + ' timings must skip the first fresh metrics block that may contain the preceding phase');
  assert(Math.abs(measurement.presentedFps - measurement.frames * 1000 / measurement.elapsedMs) < 0.1, label + ' FPS must agree with its frame count and elapsed time');
}

async function waitForBenchmarkStage(stage, timeout = 35000) {
  await page.waitForFunction(expected => {
    const benchmark = window.diabloBenchmark;
    return window.diabloStatus.error || benchmark && (benchmark.stage === expected || benchmark.stage === 'error');
  }, stage, {timeout});
  const current = await page.evaluate(() => ({benchmark: window.diabloBenchmark, game: window.diabloStatus}));
  assert.equal(current.game.error, null, 'game error: ' + current.game.error);
  assert.notEqual(current.benchmark.stage, 'error', 'benchmark error: ' + JSON.stringify(current.benchmark));
  assert.equal(current.benchmark.stage, stage);
  return current;
}

async function completeRun(label, expectedRuntime) {
  await waitForBenchmarkStage('menu');
  assert.equal(await page.locator('#benchmark-banner').isVisible(), true, 'benchmark mode must have visible feedback');
  const town = await waitForBenchmarkStage('town');
  assert.equal(town.game.phase, 'game-ready', 'the town window must begin after real engine readiness');
  assert.equal(town.game.inputBlocked, false, 'name confirmation must have completed before town sampling');
  assert.equal(town.game.engineSha256, expectedRuntime.engineSha256);
  assert.equal(town.game.frontendSha256, expectedRuntime.frontendSha256);
  assert.equal(town.game.revisionSha256, expectedRuntime.revisionSha256);
  assert.equal(town.game.audioEnabled, false, 'benchmark audio must stay disabled');
  assertMeasurement(town.benchmark.results.menu, 5900, label + ' menu');
  await page.screenshot({path: path.join(artifacts, label + '-town.png')});
  const moving = await waitForBenchmarkStage('movingTown', 25000);
  assert.equal(moving.game.phase, 'game-ready');
  const completed = await waitForBenchmarkStage('complete', 25000);
  assert.equal(completed.game.phase, 'game-ready');
  assert.equal(completed.game.inputBlocked, false);
  assertMeasurement(completed.benchmark.results.menu, 5900, label + ' menu');
  assertMeasurement(completed.benchmark.results.town, 19900, label + ' town');
  assertMeasurement(completed.benchmark.results.movingTown, 19900, label + ' walking');
  assert.deepEqual(completed.benchmark.results.movingTown.movement.coordinates, [[384,208],[256,208],[256,272],[384,272]], 'every run must issue the same bounded walking route');
  const movement = completed.benchmark.results.movingTown.movement;
  assert.equal(movement.clicks, 10, 'every renderer must receive exactly ten walking commands');
  assert.equal(movement.plannedClicks, 10);
  assert.deepEqual(movement.deliveries.map(delivery => delivery.targetMs), [0,2000,4000,6000,8000,10000,12000,14000,16000,18000], 'walking must use absolute phase-start deadlines');
  assert(Number.isFinite(movement.meanTimerLatenessMs) && movement.maxTimerLatenessMs < 2000, 'walking must report frontend timer latency without delayed command bursts');
  assert(completed.benchmark.results.movingTown.inputs > 0, 'walking must cross the real game input boundary');
  assert(completed.game.benchmarkWrites > 0, 'the test must exercise suppression of actual engine save operations');
  await page.screenshot({path: path.join(artifacts, label + '-complete.png')});
  return completed;
}

// This fixture accelerates browser time and supplies a small fake game. It tests
// controller sequencing/navigation only; the real-engine runs below test saves,
// Worker input and measured frame counters separately.
async function comparisonControllerChecks(runtime) {
  const comparisonReports = [], fixtureNavigations = [], fixtureErrors = [];
  const context = await browser.newContext();
  await context.exposeBinding('__recordComparison', (_source, value) => comparisonReports.push(value));
  const fixture = `<!doctype html><main><button id="start">Start</button><canvas id="screen" width="640" height="480" tabindex="0" style="width:320px;height:240px"></canvas><form id="text-entry" hidden><input id="game-text"></form></main>
<script>
(function(){
  var realTimeout=window.setTimeout.bind(window),realInterval=window.setInterval.bind(window),realNow=performance.now.bind(performance);
  performance.now=function(){return realNow()*100;};
  var injectedLate=false;
  window.setTimeout=function(callback,delay){
    if(!injectedLate&&location.search.indexOf('mockLate=1')>=0&&window.diabloBenchmark&&window.diabloBenchmark.stage==='movingTown'&&delay>1500){injectedLate=true;delay+=3000;}
    return realTimeout(callback,Math.max(1,delay/100));
  };
  window.setInterval=function(callback,delay){return realInterval(callback,Math.max(1,delay/100));};
  Object.defineProperty(window,'localStorage',{get:function(){throw new Error('comparison must not use browser storage');}});
  Object.defineProperty(window,'sessionStorage',{get:function(){throw new Error('comparison must not use browser storage');}});
  var parameters=new URLSearchParams(location.search),selection=parameters.get('renderer')||'canvas';
  var identity=${JSON.stringify(runtime)};
  var unavailable=parameters.get('mockBmp')==='unavailable'&&selection==='bmp';
  var game=window.diabloStatus={benchmark:true,benchmarkWrites:1,loaded:false,frames:0,inputs:0,error:null,inputBlocked:false,pendingInputId:null,phase:'menu',mode:'fixture',
    renderer:selection==='bmp'?'bmp-indexed':'canvas2d-indexed',engineSha256:identity.engineSha256,frontendSha256:identity.frontendSha256,revisionSha256:identity.revisionSha256,
    capabilities:{bmp:{status:unavailable?'unavailable':'passed',reason:unavailable?'Fixture decoder rejected palette readback':undefined}},
    performance:{frames:0,inputs:0,tickMs:3,encodingMs:0.2,decodingMs:0.5,presentationMs:0.1,inputMs:0.4,inputQueueMs:1.3,inputLatencyMs:1.7}};
  window.Portal={report:function(value){return window.__recordComparison(value);}};
  document.getElementById('start').onclick=function(){game.loaded=true;game.frames=1;};
  var enters=0;document.addEventListener('keydown',function(event){if(event.keyCode===13&&++enters===2)document.getElementById('text-entry').hidden=false;});
  document.getElementById('text-entry').addEventListener('submit',function(event){event.preventDefault();this.hidden=true;game.phase='game-ready';});
  ['mousemove','mousedown','mouseup'].forEach(function(name){document.addEventListener(name,function(){game.inputs++;});});
  realInterval(function(){if(game.loaded){game.frames+=20;game.performance.frames=game.frames;game.performance.inputs=game.inputs;}},2);
})();
</script><script src="/js/diablo-benchmark.js"></script>`;
  await context.route(origin + '/play/diablo?**', route => route.fulfill({contentType:'text/html',body:fixture}));
  const fixturePage = await context.newPage();
  fixturePage.on('pageerror', error => fixtureErrors.push(error.message));
  fixturePage.on('framenavigated', frame => {if (frame === fixturePage.mainFrame()) fixtureNavigations.push(frame.url());});
  await fixturePage.goto(origin + '/play/diablo?benchmark=1&compare=renderers&compat=1&keep=hello%20world');
  await fixturePage.waitForFunction(() => window.diabloBenchmark && window.diabloBenchmark.stage === 'complete' && window.diabloBenchmark.pair === 3 && window.diabloBenchmark.selection === 'bmp', null, {timeout:20000});
  await delay(100);
  const complete = comparisonReports.filter(report => report.stage === 'complete');
  assert.equal(complete.length, 6, 'three paired comparisons must complete six fresh game runs');
  assert.deepEqual(complete.map(report => [report.pair,report.rendererSelection]), [[1,'canvas'],[1,'bmp'],[2,'canvas'],[2,'bmp'],[3,'canvas'],[3,'bmp']]);
  assert.equal(new Set(complete.map(report => report.comparisonId)).size, 1, 'all pairs must retain one URL comparison identifier');
  assert(complete.every(report => report.revisionSha256 === runtime.revisionSha256 && report.frontendSha256 === runtime.frontendSha256 && report.engineSha256 === runtime.engineSha256));
  assert.equal(comparisonReports.filter(report => report.stage === 'comparison-complete').length, 1);
  for (const navigation of fixtureNavigations) {
    const url = new URL(navigation);
    assert.equal(url.searchParams.get('compat'), '1');
    assert.equal(url.searchParams.get('keep'), 'hello world', 'renderer navigation must preserve unrelated query configuration');
    assert.equal(url.origin, origin, 'comparison must navigate only within the same origin');
  }
  const samples = comparisonReports.filter(report => report.stage === 'movingTown').flatMap(report => report.measurement.samples);
  assert(samples.some(sample => sample.encodingMs === 0.2 && sample.decodingMs === 0.5 && sample.presentationMs === 0.1 && sample.inputMs === 0.4 && sample.inputQueueMs === 1.3 && sample.inputLatencyMs === 1.7), 'reports must carry separate encoding/decoding/presentation and full input latency timings');
  const beforeBlocked = comparisonReports.length;
  await fixturePage.goto(origin + '/play/diablo?benchmark=1&compare=renderers&renderer=bmp&comparePair=1&compareId=blocked-fixture&mockBmp=unavailable');
  await fixturePage.waitForFunction(() => window.diabloBenchmark && window.diabloBenchmark.stage === 'blocked', null, {timeout:5000});
  await delay(50);
  const blocked = comparisonReports.slice(beforeBlocked);
  assert.equal(blocked.filter(report => report.stage === 'blocked').length, 1, 'failed native probe must produce a measured blocker');
  assert.match(blocked.find(report => report.stage === 'blocked').message, /palette readback/);
  assert.equal(blocked.filter(report => report.stage === 'complete' || report.stage === 'comparison-next').length, 0, 'failed BMP must end the comparison instead of claiming a completed pair');
  const beforeLate = comparisonReports.length;
  await fixturePage.goto(origin + '/play/diablo?benchmark=1&compare=renderers&renderer=canvas&comparePair=1&compareId=late-fixture&mockLate=1');
  await fixturePage.waitForFunction(() => window.diabloBenchmark && window.diabloBenchmark.stage === 'error', null, {timeout:5000});
  await delay(50);
  const late = comparisonReports.slice(beforeLate);
  assert.equal(late.filter(report => report.stage === 'error').length, 1, 'a missed walking deadline must invalidate the run once');
  assert.match(late.find(report => report.stage === 'error').message, /late.*burst/);
  assert.equal(late.filter(report => report.stage === 'complete' || report.stage === 'comparison-next').length, 0, 'late walking cannot be reported as a completed comparison');
  assert.equal(await fixturePage.evaluate(() => window.diabloStatus.inputs), 3, 'a missed deadline must stop after the first click without dispatching a catch-up burst');
  assert.deepEqual(fixtureErrors, []);
  await context.close();
  return {runs:complete.length,pairs:3,navigations:fixtureNavigations,capabilityBlocker:blocked.find(report => report.stage==='blocked'),walkingDeadlineFailure:late.find(report => report.stage==='error'),limitation:'Accelerated fake-game fixture verifies comparison control flow only; it provides no performance or gameplay evidence.'};
}

async function run() {
  fs.mkdirSync(artifacts, {recursive: true});
  fs.cpSync(path.join(root, 'web'), path.join(temporaryRoot, 'web'), {recursive: true});
  fs.mkdirSync(path.join(temporaryRoot, 'data', 'assets'), {recursive: true});
  fs.copyFileSync(path.join(root, 'data', 'assets', 'spawn.mpq'), path.join(temporaryRoot, 'data', 'assets', 'spawn.mpq'));
  fs.mkdirSync(path.join(temporaryRoot, 'data', 'saves'), {recursive: true});
  fs.writeFileSync(path.join(temporaryRoot, 'data', 'saves', 'config.ini'), '[Diablo]\nBenchmarkSentinel=keep-this-profile\n');
  // Deliberately not a valid hero. A benchmark must neither read it nor pass it to the engine.
  fs.writeFileSync(path.join(temporaryRoot, 'data', 'saves', 'spawn9.sv'), 'benchmark-profile-sentinel-do-not-load-or-modify\n');
  const beforeProfiles = profileHashes();
  const manifestPath = path.join(temporaryRoot, 'web', 'engine', 'build.json');
  const build = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const enginePath = path.join(temporaryRoot, 'web', 'engine', 'DiabloSpawn.js');
  const actualEngineHash = sha256(fs.readFileSync(enginePath));
  assert.equal(build.sha256, actualEngineHash, 'initial manifest must identify the engine under test');
  const runtimePath = path.join(temporaryRoot, 'web', 'assets', 'runtime.json');
  function updateRuntime() {
    execFileSync(process.env.PYTHON || 'python3', [path.join(root, 'scripts', 'build_runtime.py'), '--root', temporaryRoot]);
    return JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  }
  const initialRuntime = updateRuntime();

  server = spawn(process.env.PYTHON || 'python3', [path.join(root, 'server', 'portal.py'), '--root', temporaryRoot, '--host', '127.0.0.1', '--port', '8093'], {stdio: ['ignore', 'pipe', 'pipe']});
  server.stdout.on('data', chunk => {serverOutput = (serverOutput + chunk).slice(-8000);});
  server.stderr.on('data', chunk => {serverOutput = (serverOutput + chunk).slice(-8000);});
  let healthy = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(origin + '/healthz', {signal: AbortSignal.timeout(1000)});
      if (response.ok && (await response.json()).pid === server.pid) {healthy = true; break;}
    } catch {}
    await delay(100);
  }
  assert(healthy, 'the isolated server did not start: ' + serverOutput);

  browser = await chromium.launch({channel: 'chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  await context.exposeBinding('__recordBenchmarkInit', (_source, data) => initializations.push(data));
  await context.exposeBinding('__recordBenchmarkName', (_source, name) => characterNames.push(name));
  await context.exposeBinding('__recordBenchmarkMouse', (_source, args) => mouseCommands.push(args));
  await context.addInitScript(() => {
    window.WebAssembly = undefined;
    window.SharedArrayBuffer = undefined;
    window.TextDecoder = undefined;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return String(type).includes('webgl') ? null : getContext.call(this, type, ...args);
    };
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message && message.action === 'init') {
        window.__recordBenchmarkInit({saveNames: message.saves.map(file => file.name), audioEnabled: message.audioEnabled});
      }
      if (message && message.action === 'event' && message.name === 'text') window.__recordBenchmarkName(message.args[0]);
      if (message && message.action === 'event' && message.name === 'DApi_Mouse') window.__recordBenchmarkMouse(message.args);
      return postMessage.call(this, message, ...args);
    };
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => {if (frame === page.mainFrame()) navigations.push(frame.url());});
  page.on('request', request => {
    const url = new URL(request.url());
    requests.push({path: url.pathname, method: request.method(), at: Date.now()});
    if (url.pathname === '/api/diagnostics') {
      try {reports.push(JSON.parse(request.postData()));} catch {}
    }
  });

  if (process.argv.includes('--controller-only')) {
    const comparisonController = await comparisonControllerChecks(initialRuntime);
    fs.writeFileSync(path.join(artifacts, 'controller-result.json'), JSON.stringify(comparisonController, null, 2));
    console.log(JSON.stringify({ok:true,comparisonController}, null, 2));
    return;
  }

  await page.goto(origin + '/play/diablo?compat=1');
  await delay(11000);
  const inactive = await page.evaluate(() => ({benchmark: typeof window.diabloBenchmark, loaded: window.diabloStatus.loaded, frames: window.diabloStatus.frames}));
  assert.deepEqual(inactive, {benchmark: 'undefined', loaded: false, frames: 0}, 'the normal page must require an explicit Play action');
  assert.equal(initializations.length, 0);
  assert.equal(requests.filter(request => request.path === '/engine/build.json').length, 0, 'the default page must not poll the engine manifest');
  assert.equal(requests.filter(request => request.path === '/game-data/spawn.mpq').length, 0, 'the default page must not start loading game data');

  await page.goto(origin + '/play/diablo?compat=1&benchmark=1');
  const firstRun = await completeRun('initial', initialRuntime);
  assert(characterNames.includes('SwitchBench'), 'the real character prompt must receive the benchmark name');
  assert.deepEqual(profileHashes(), beforeProfiles, 'the benchmark must preserve every profile byte and filename');
  const beforeReload = navigations.length;
  const manifestRequestsBeforeChange = requests.filter(request => request.path === '/assets/runtime.json').length;
  // A frontend-only update must trigger a rerun even though engine bytes are unchanged.
  const frontendFixture = path.join(temporaryRoot, 'web', 'js', 'diablo-benchmark.js');
  const reloaded = page.waitForEvent('framenavigated', {predicate: frame => frame === page.mainFrame(), timeout: 20000});
  fs.appendFileSync(frontendFixture, '\n// Frontend-only runtime watch integration fixture.\n');
  const changedRuntime = updateRuntime();
  assert.equal(changedRuntime.engineSha256, initialRuntime.engineSha256);
  assert.notEqual(changedRuntime.frontendSha256, initialRuntime.frontendSha256);
  assert.notEqual(changedRuntime.revisionSha256, initialRuntime.revisionSha256);
  await reloaded;
  assert.equal(navigations.length, beforeReload + 1, 'one changed frontend identity must cause one automatic reload');
  assert.equal(new URL(page.url()).searchParams.get('benchmark'), '1', 'automatic reload must retain benchmark mode');
  const secondRun = await completeRun('frontend-rerun', changedRuntime);
  await delay(11000);
  assert.equal(navigations.length, beforeReload + 1, 'unchanged metadata after the reload must not create a reload loop');
  assert(requests.filter(request => request.path === '/assets/runtime.json').length >= manifestRequestsBeforeChange + 3, 'the changed runtime and subsequent stable polls must be exercised');
  assert.equal(sha256(fs.readFileSync(enginePath)), actualEngineHash, 'the frontend fixture must not change compiled engine bytes');
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), build, 'the frontend fixture must not change engine metadata');
  assert.deepEqual(profileHashes(), beforeProfiles, 'the rerun must also preserve every profile byte and filename');
  assert.deepEqual(requests.filter(request => request.path === '/api/saves' || request.path.startsWith('/api/saves/')), [], 'benchmark mode must never read, upload, or delete persistent saves');
  assert.equal(initializations.length, 2, 'exactly one worker must start for each benchmark run');
  for (const initialization of initializations) assert.deepEqual(initialization, {saveNames: [], audioEnabled: false});
  assert(characterNames.length >= 2 && characterNames.every(name => name === 'SwitchBench'), 'both runs must create only the temporary benchmark character');
  assert(mouseCommands.some(args => args[0] === 1 && args[3] === 384 && args[4] === 208), 'real walking clicks must use game coordinates after CSS scaling');
  assert(mouseCommands.some(args => args[0] === 2), 'every walking click must release input');
  assert.deepEqual(errors, []);

  const persisted = fs.readFileSync(path.join(temporaryRoot, 'data', 'diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
  const benchmarkReports = persisted.filter(report => report.kind === 'game' && report.event === 'benchmark');
  for (const stage of ['menu', 'town', 'movingTown', 'complete']) {
    assert.equal(benchmarkReports.filter(report => report.stage === stage).length, 2, stage + ' must be persisted exactly once per run');
  }
  const comparisonController = await comparisonControllerChecks(changedRuntime);
  const result = {
    browserVersion: browser.version(), initialEngineSha256: actualEngineHash,
    frontendReloadTest: {initialRuntime, changedRuntime, engineBytesChanged: false, automaticReloads: navigations.length - beforeReload},
    inactive, beforeProfiles, afterProfiles: profileHashes(), initializations, characterNames, mouseCommands,
    firstRun, secondRun, comparisonController, benchmarkReports, errors,
    saveRequests: requests.filter(request => request.path.startsWith('/api/saves')),
    runtimeManifestRequests: requests.filter(request => request.path === '/assets/runtime.json').length,
    limitations: 'Desktop Chrome integration test with WebAssembly and WebGL disabled. Frontend-only rerun uses identical engine bytes; this is not physical Switch performance evidence.'
  };
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ok: true, artifacts, automaticReloads: result.frontendReloadTest.automaticReloads, saveRequests: result.saveRequests.length, menuFps: firstRun.benchmark.results.menu.presentedFps, townFps: firstRun.benchmark.results.town.presentedFps, walkingFps: firstRun.benchmark.results.movingTown.presentedFps, limitation: result.limitations}, null, 2));
}

async function cleanup() {
  clearTimeout(deadlineTimer);
  if (browser) await browser.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL');
      await new Promise(resolve => server.once('exit', resolve));
    }
  }
  fs.rmSync(temporaryRoot, {recursive: true, force: true});
}

Promise.race([
  run(),
  new Promise((_resolve, reject) => {deadlineTimer = setTimeout(() => reject(new Error('Benchmark browser test exceeded its 220 second deadline')), 220000);})
]).catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) {
    try {console.error(JSON.stringify(await page.evaluate(() => ({benchmark: window.diabloBenchmark, game: window.diabloStatus})), null, 2));} catch {}
  }
  process.exitCode = 1;
}).finally(cleanup);
