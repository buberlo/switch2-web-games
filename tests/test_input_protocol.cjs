/* Exercise the real host/worker input boundary with a deterministic slow engine. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/diablo-host.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(__dirname, '../web/js/diablo-worker.js'), 'utf8');

async function harness() {
  const messages = [], calls = [];
  let wall = 10000, monotonic = 0, interval, inputHook = () => {};
  const sandbox = {
    Date: {now: () => wall}, performance: {now: () => monotonic},
    ArrayBuffer, Uint8Array, console,
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() { interval = null; }
  };
  sandbox.self = sandbox;
  function call(name, args) {
    calls.push({name, args});
    inputHook(name, args);
  }
  const engine = {
    HEAPU8: new Uint8Array(1024),
    _DApi_Init() {}, _DApi_Render() {},
    _DApi_Key(...args) { call('DApi_Key', args); },
    _DApi_Mouse(...args) { call('DApi_Mouse', args); },
    _DApi_Char(...args) { call('DApi_Char', args); },
    _DApi_SyncTextPtr() { return 16; },
    _DApi_SyncText(flags) {
      let end = 16;
      while (engine.HEAPU8[end]) end++;
      call('text', [Buffer.from(engine.HEAPU8.subarray(16, end)).toString('ascii'), flags]);
    }
  };
  sandbox.DiabloSpawn = () => Promise.resolve(engine);
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const host = sandbox.createDiabloHost(message => messages.push(structuredClone(message)));
  await host.init({archive: new ArrayBuffer(4), saves: [], audioEnabled: false});
  return {
    host, messages, calls, api: sandbox.DApi,
    now: () => wall,
    advance(ms) { wall += ms; monotonic += ms; },
    onInput(hook) { inputHook = hook; },
    tick() { assert(interval, 'engine timer must be active'); interval(); },
    complete(id) { return messages.filter(message => message.action === 'input-complete' && message.id === id); }
  };
}

async function slowInputQuarantinesQueuedActions() {
  const h = await harness();
  const sentBeforeLoad = h.now();
  h.onInput((name, args) => {
    if (name === 'DApi_Key' && args[0] === 0 && args[2] === 13) h.advance(1500);
  });
  h.host.event('DApi_Key', [0, 0, 13], 1, sentBeforeLoad);
  assert.equal(h.complete(1).length, 1, 'slow Enter must complete exactly once');
  assert.equal(h.complete(1)[0].milliseconds, 1500);
  const timing = h.messages.find(message => message.action === 'input-timing');
  assert.deepEqual([timing.name, timing.id, timing.milliseconds], ['DApi_Key', 1, 1500]);
  h.onInput(() => {});

  const queuedActions = [
    ['DApi_Key', [0, 0, 13]], // repeated confirmation
    ['DApi_Key', [0, 0, 27]], // Escape can close the engine at the main menu
    ['DApi_Key', [0, 0, 38]],
    ['DApi_Key', [0, 0, 40]],
    ['DApi_Mouse', [1, 1, 0, 320, 380]], // an old press could select Quit
    ['DApi_Mouse', [0, 0, 0, 320, 380]],
    ['DApi_Char', [105]],
    ['text', ['Stale hero name', 0]]
  ];
  queuedActions.forEach(([name, args], index) => {
    const id = index + 2;
    h.host.event(name, args, id, sentBeforeLoad + 500);
    assert.deepEqual(h.complete(id), [{action: 'input-complete', id, milliseconds: 0, discarded: true}],
      'discarded actions still release the page request barrier');
  });
  assert.equal(h.calls.length, 1, 'queued press, movement, text and character actions must not enter the new game');

  h.host.event('DApi_Key', [1, 0, 13], 20, sentBeforeLoad);
  h.host.event('DApi_Mouse', [2, 1, 0, 320, 380], 21, sentBeforeLoad);
  assert.deepEqual(h.calls.slice(-2), [
    {name: 'DApi_Key', args: [1, 0, 13]},
    {name: 'DApi_Mouse', args: [2, 1, 0, 320, 380]}
  ], 'old releases must clear held keys and mouse buttons');
  assert.equal(h.complete(20)[0].discarded, undefined);
  assert.equal(h.complete(21)[0].discarded, undefined);

  for (const code of [13, 27, 38, 40]) {
    h.host.event('DApi_Key', [0, 0, code], 100 + code, h.now());
    assert.equal(h.calls.at(-1).args[2], code, 'fresh critical keys must remain usable');
    assert.equal(h.complete(100 + code)[0].discarded, undefined);
  }
  h.advance(600);
  h.tick();
  const metrics = h.messages.find(message => message.action === 'metrics');
  assert.equal(metrics.maxInputMs, 1500, 'input stalls must appear in input metrics');
  assert.equal(metrics.maxTickMs, 0, 'input work must remain distinguishable from render work');
  h.host.stop();
}

async function slowBoundary() {
  for (const duration of [999, 1000]) {
    const h = await harness(), sentAt = h.now();
    h.onInput(() => h.advance(duration));
    h.host.event('DApi_Key', [0, 0, 13], 1, sentAt);
    h.onInput(() => {});
    h.host.event('DApi_Key', [0, 0, 27], 2, sentAt);
    assert.equal(h.calls.length, duration === 999 ? 2 : 1, 'only the configured slow-call boundary starts quarantine');
    assert.equal(h.complete(2)[0].discarded, duration === 999 ? undefined : true);
    h.host.stop();
  }
}

async function explicitLoadingPhases() {
  for (const endPhase of ['game-ready', 'loading-end']) {
    const h = await harness(), before = h.now();
    h.api.phase('loading-start', {value: 0});
    h.host.event('DApi_Key', [0, 0, 27], 1, h.now());
    h.host.event('DApi_Mouse', [1, 1, 0, 320, 380], 2, h.now());
    assert.equal(h.calls.length, 0, 'fresh presses are blocked while loading is active');
    assert.equal(h.complete(1)[0].discarded, true);
    assert.equal(h.complete(2)[0].discarded, true);
    h.host.event('DApi_Key', [1, 0, 27], 3, before);
    h.host.event('DApi_Mouse', [2, 1, 0, 320, 380], 4, before);
    assert.equal(h.calls.length, 2, 'releases also pass while loading is active');
    h.advance(40);
    h.api.phase('loading-progress', {value: 267});
    h.api.phase(endPhase, {value: 0});
    h.host.event('DApi_Key', [0, 0, 27], 5, before);
    assert.equal(h.complete(5)[0].discarded, true, 'even a short explicit level load invalidates earlier input');
    assert.equal(h.calls.length, 2);
    h.host.event('DApi_Key', [0, 0, 13], 6, h.now());
    h.host.event('text', ['Current hero', 0], 7, h.now());
    assert.deepEqual(h.calls.slice(-2), [
      {name: 'DApi_Key', args: [0, 0, 13]},
      {name: 'text', args: ['Current hero', 0]}
    ], 'input at or after the completed phase boundary must work');
    assert.equal(h.complete(6)[0].discarded, undefined);
    assert.equal(h.complete(7)[0].discarded, undefined);
    assert.deepEqual(h.messages.filter(message => message.action === 'phase').map(message => [message.name, message.details]), [
      ['loading-start', {value: 0}], ['loading-progress', {value: 267}], [endPhase, {value: 0}]
    ], 'the page receives the original loading and progress information');
    h.host.stop();
  }
}

async function loadingInsideInput() {
  const h = await harness(), start = h.now();
  h.onInput(() => {
    h.api.phase('loading-start', {value: 0});
    h.advance(250);
    h.api.phase('game-ready', {value: 0});
  });
  h.host.event('DApi_Key', [0, 0, 13], 1, start);
  h.onInput(() => {});
  const actions = h.messages.map(message => message.action);
  assert(actions.indexOf('phase') < actions.indexOf('input-complete'), 'phase updates precede completion of the triggering input');
  assert.equal(h.complete(1)[0].milliseconds, 250);
  h.host.event('DApi_Key', [0, 0, 27], 2, start + 100);
  assert.equal(h.complete(2)[0].discarded, true, 'the phase barrier protects loads shorter than the slow-call threshold');
  assert.equal(h.calls.length, 1);
  h.host.stop();
}

function workerPreservesInputEnvelope() {
  const forwarded = [];
  const sandbox = {
    location: {search: ''}, postMessage() {}, importScripts() {},
    createDiabloHost() { return {init() {}, event(...args) { forwarded.push(args); }}; }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(workerSource, sandbox);
  sandbox.onmessage({data: {action: 'init'}});
  const args = [0, 0, 13];
  sandbox.onmessage({data: {action: 'event', name: 'DApi_Key', args, id: 17, sentAt: 123456}});
  assert.deepEqual(forwarded, [['DApi_Key', args, 17, 123456]], 'the worker must preserve request ID and send time for quarantine');
}

async function inputQueueLatency() {
  const h = await harness(), sentAt = h.now();
  h.advance(75);h.onInput(() => h.advance(4));
  h.host.event('DApi_Mouse', [1, 1, 0, 320, 280], 1, sentAt);
  h.advance(2000);h.tick();
  const metrics = h.messages.find(message => message.action === 'metrics');
  assert.equal(metrics.inputMs, 4);
  assert.equal(metrics.inputQueueMs, 75);
  assert.equal(metrics.maxInputQueueMs, 75);
  assert.equal(metrics.inputLatencyMs, 79);
  assert.equal(metrics.maxInputLatencyMs, 79);
  h.host.stop();
}

(async () => {
  await slowInputQuarantinesQueuedActions();
  await slowBoundary();
  await explicitLoadingPhases();
  await loadingInsideInput();
  await inputQueueLatency();
  workerPreservesInputEnvelope();
  console.log('Input protocol passed: stale actions, held-input releases, completions, phase barriers, duration metrics, and worker timestamps.');
})().catch(error => { console.error(error); process.exitCode = 1; });
