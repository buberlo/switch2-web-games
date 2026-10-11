/* Isolated Chrome integration test. Run with Node; PLAYWRIGHT_MODULE is optional. */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8093';
const artifacts = path.join(root, 'data', 'qa', 'benchmark-browser');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-benchmark-browser-'));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let server, browser, page, deadlineTimer;
let serverOutput = '';
const requests = [], reports = [], errors = [], navigations = [], initializations = [], characterNames = [];

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

async function completeRun(label, expectedManifestHash) {
  await waitForBenchmarkStage('menu');
  assert.equal(await page.locator('#benchmark-banner').isVisible(), true, 'benchmark mode must have visible feedback');
  const town = await waitForBenchmarkStage('town');
  assert.equal(town.game.phase, 'game-ready', 'the town window must begin after real engine readiness');
  assert.equal(town.game.inputBlocked, false, 'name confirmation must have completed before town sampling');
  assert.equal(town.game.engineSha256, expectedManifestHash);
  assert.equal(town.game.audioEnabled, false, 'benchmark audio must stay disabled');
  assertMeasurement(town.benchmark.results.menu, 5900, label + ' menu');
  await page.screenshot({path: path.join(artifacts, label + '-town.png')});
  const completed = await waitForBenchmarkStage('complete', 25000);
  assert.equal(completed.game.phase, 'game-ready');
  assert.equal(completed.game.inputBlocked, false);
  assertMeasurement(completed.benchmark.results.menu, 5900, label + ' menu');
  assertMeasurement(completed.benchmark.results.town, 19900, label + ' town');
  assert(completed.game.benchmarkWrites > 0, 'the test must exercise suppression of actual engine save operations');
  await page.screenshot({path: path.join(artifacts, label + '-complete.png')});
  return completed;
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

  await page.goto(origin + '/play/diablo?compat=1');
  await delay(11000);
  const inactive = await page.evaluate(() => ({benchmark: typeof window.diabloBenchmark, loaded: window.diabloStatus.loaded, frames: window.diabloStatus.frames}));
  assert.deepEqual(inactive, {benchmark: 'undefined', loaded: false, frames: 0}, 'the normal page must require an explicit Play action');
  assert.equal(initializations.length, 0);
  assert.equal(requests.filter(request => request.path === '/engine/build.json').length, 0, 'the default page must not poll the engine manifest');
  assert.equal(requests.filter(request => request.path === '/game-data/spawn.mpq').length, 0, 'the default page must not start loading game data');

  await page.goto(origin + '/play/diablo?compat=1&benchmark=1');
  const firstRun = await completeRun('initial', build.sha256);
  assert(characterNames.includes('SwitchBench'), 'the real character prompt must receive the benchmark name');
  assert.deepEqual(profileHashes(), beforeProfiles, 'the benchmark must preserve every profile byte and filename');
  const beforeReload = navigations.length;
  const manifestRequestsBeforeChange = requests.filter(request => request.path === '/engine/build.json').length;
  // This changes metadata only. The second run still executes the same compiled engine bytes.
  const changedManifestHash = sha256('benchmark manifest reload fixture: ' + actualEngineHash);
  const metadataFixture = {...build, sha256: changedManifestHash};
  const reloaded = page.waitForEvent('framenavigated', {predicate: frame => frame === page.mainFrame(), timeout: 20000});
  fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(metadataFixture, null, 2));
  fs.renameSync(manifestPath + '.tmp', manifestPath);
  await reloaded;
  assert.equal(navigations.length, beforeReload + 1, 'one changed manifest must cause one automatic reload');
  assert.equal(new URL(page.url()).searchParams.get('benchmark'), '1', 'automatic reload must retain benchmark mode');
  const secondRun = await completeRun('metadata-rerun', changedManifestHash);
  await delay(11000);
  assert.equal(navigations.length, beforeReload + 1, 'unchanged metadata after the reload must not create a reload loop');
  assert(requests.filter(request => request.path === '/engine/build.json').length >= manifestRequestsBeforeChange + 3, 'the changed manifest and subsequent stable polls must be exercised');
  assert.equal(sha256(fs.readFileSync(enginePath)), actualEngineHash, 'the metadata fixture must not change compiled engine bytes');
  assert.deepEqual(profileHashes(), beforeProfiles, 'the rerun must also preserve every profile byte and filename');
  assert.deepEqual(requests.filter(request => request.path === '/api/saves' || request.path.startsWith('/api/saves/')), [], 'benchmark mode must never read, upload, or delete persistent saves');
  assert.equal(initializations.length, 2, 'exactly one worker must start for each benchmark run');
  for (const initialization of initializations) assert.deepEqual(initialization, {saveNames: [], audioEnabled: false});
  assert(characterNames.length >= 2 && characterNames.every(name => name === 'SwitchBench'), 'both runs must create only the temporary benchmark character');
  assert.deepEqual(errors, []);

  const persisted = fs.readFileSync(path.join(temporaryRoot, 'data', 'diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).payload);
  const benchmarkReports = persisted.filter(report => report.kind === 'game' && report.event === 'benchmark');
  for (const stage of ['menu', 'town', 'complete']) {
    assert.equal(benchmarkReports.filter(report => report.stage === stage).length, 2, stage + ' must be persisted exactly once per run');
  }
  const result = {
    browserVersion: browser.version(), initialEngineSha256: actualEngineHash,
    metadataReloadTest: {changedManifestHash, engineBytesChanged: false, automaticReloads: navigations.length - beforeReload},
    inactive, beforeProfiles, afterProfiles: profileHashes(), initializations, characterNames,
    firstRun, secondRun, benchmarkReports, errors,
    saveRequests: requests.filter(request => request.path.startsWith('/api/saves')),
    manifestRequests: requests.filter(request => request.path === '/engine/build.json').length,
    limitations: 'Desktop Chrome integration test with WebAssembly and WebGL disabled. Manifest-only rerun uses identical engine bytes; this is not physical Switch performance evidence.'
  };
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ok: true, artifacts, automaticReloads: result.metadataReloadTest.automaticReloads, saveRequests: result.saveRequests.length, menuFps: firstRun.benchmark.results.menu.presentedFps, townFps: firstRun.benchmark.results.town.presentedFps, limitation: result.limitations}, null, 2));
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
  new Promise((_resolve, reject) => {deadlineTimer = setTimeout(() => reject(new Error('Benchmark browser test exceeded its 120 second deadline')), 120000);})
]).catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) {
    try {console.error(JSON.stringify(await page.evaluate(() => ({benchmark: window.diabloBenchmark, game: window.diabloStatus})), null, 2));} catch {}
  }
  process.exitCode = 1;
}).finally(cleanup);
