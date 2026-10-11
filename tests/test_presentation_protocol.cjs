/* Check the actual page/Worker boundary while native presentation is delayed. */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../web/js/diablo.js'), 'utf8');

async function harness(options = {}) {
  const elements = new Map(), windowEvents = {}, reports = [], presentations = [], workers = [];
  let monotonic = 100, prepareDone, destroyed = false, runtimeReads = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      id, tagName: id === 'game-text' ? 'INPUT' : 'BUTTON', hidden: true, value: '', style: {}, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      setAttribute() {}, getAttribute() { return 'false'; }, focus() {},
      querySelector() { return element(id + '-span'); },
      getContext() { return {}; }, getBoundingClientRect() { return {left: 0, top: 0, width: 640, height: 480}; }
    });
    return elements.get(id);
  }
  class FakeWorker {
    constructor() {
      this.sent = []; this.stopped = false; workers.push(this);
      setImmediate(() => this.onmessage({data: {action: 'ready'}}));
    }
    postMessage(message, transfer) {
      this.sent.push(structuredClone(message, transfer ? {transfer} : undefined));
      if (message.action === 'init') setImmediate(() => this.emit({action: 'loaded', nativeMemory: {}}));
    }
    terminate() { this.stopped = true; }
    emit(data) { this.onmessage({data}); }
  }
  class FakeXHR {
    open(method, url) { this.url = url; }
    setRequestHeader() {}
    send() {
      let value;
      if (this.url === '/api/status') value = {engineReady: true, dataReady: true};
      else if (this.url === '/api/saves') value = {files: []};
      else if (this.url === '/engine/build.json') value = {sha256: 'f'.repeat(64)};
      else if (this.url === '/assets/runtime.json') {
        runtimeReads++;
        const changed = options.frontendUpdate && runtimeReads > 1;
        value = {engineSha256: 'f'.repeat(64), frontendSha256: (changed ? 'c' : 'a').repeat(64), revisionSha256: (changed ? 'd' : 'b').repeat(64)};
      }
      else if (this.url === '/game-data/spawn.mpq') {
        this.response = new ArrayBuffer(25830791);new Uint8Array(this.response).set([77,80,81,26]);
      } else throw new Error('Unexpected request ' + this.url);
      if (value) this.response = Uint8Array.from(Buffer.from(JSON.stringify(value))).buffer;
      this.status = 200;setImmediate(() => this.onload());
    }
  }
  const renderer = {
    mode: 'bmp-indexed', capabilities: {bmp: {status: 'passed'}},
    prepare(done) { prepareDone = done; },
    present(batch, done) { presentations.push({batch, done}); },
    destroy() {
      if (destroyed) return;destroyed = true;
      const cancelled = new Error('Presentation cancelled');cancelled.cancelled = true;
      presentations.forEach(item => item.done(cancelled));
    }
  };
  const sandbox = {
    document: {getElementById: element, querySelectorAll() { return []; }, addEventListener() {}, hidden: false},
    location: {search: '?renderer=bmp', reload() {}}, navigator: {userAgent: 'protocol-test'},
    performance: {now: () => monotonic}, Worker: FakeWorker, XMLHttpRequest: FakeXHR,
    Promise, ArrayBuffer, Uint8Array, Uint8ClampedArray, TextDecoder, atob, console,
    setTimeout, clearTimeout, setInterval() { return 1; }, requestAnimationFrame() {},
    addEventListener(name, callback) { windowEvents[name] = callback; },
    createDiabloRenderer(_canvas, options) { assert.equal(options.preferBMP, true);assert.equal(options.preferWebGL, false);return renderer; },
    createDiabloAudio() { return {available: false, stop() {}, handle() {}, visibility() {}, mute() {}}; },
    Portal: {session: () => Promise.resolve('token'), report(payload) { reports.push(payload);return Promise.resolve(); }}
  };
  sandbox.window = sandbox;vm.createContext(sandbox);vm.runInContext(source, sandbox);
  element('start').listeners.click();
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  assert(prepareDone, 'the decoder probe must begin during startup');
  assert.equal(workers[0].sent.length, 0, 'engine initialization must wait for the real renderer probe');
  prepareDone(null, renderer.capabilities);
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  if (!options.frontendUpdate) assert.equal(sandbox.diabloStatus.loaded, true);
  return {page: sandbox, worker: workers[0], reports, presentations, events: windowEvents,
    advance(ms) { monotonic += ms; }};
}

function frame(sequence) {
  const bytes = new Uint8Array(4);bytes.set([0,1,2,3]);
  return {action: 'render', sequence, sentAt: Date.now(), batch: {
    images: [{x: 0, y: 0, w: 2, h: 2, stride: 2, bytes, format: 'indexed'}], text: []
  }};
}
function acknowledgements(h) { return h.worker.sent.filter(message => message.action === 'rendered'); }
const statistics = {convertedPixels: 0, skippedPixels: 4, signatureMs: 0, conversionMs: 0,
  encodeMs: 2, decodeMs: 12, presentationMs: 15, canvasCpuMs: 3};

(async () => {
  const h = await harness(), first = frame(1);
  h.worker.emit(first);
  assert.equal(h.page.diabloStatus.frames, 0);
  assert.equal(h.page.diabloStatus.presentationPending, true);
  assert.equal(acknowledgements(h).length, 0, 'a decoding frame must retain its transfer buffer');
  assert.equal(first.batch.images[0].bytes.buffer.byteLength, 4);
  h.advance(15);h.presentations[0].done(null, statistics);
  assert.equal(h.page.diabloStatus.frames, 1);
  assert.equal(h.page.diabloStatus.presentationPending, false);
  assert.equal(first.batch.images[0].bytes.buffer.byteLength, 0, 'successful ACK transfers the buffer back');
  assert.deepEqual(acknowledgements(h).map(message => message.sequence), [1]);
  assert.equal(h.reports.filter(report => report.event === 'first-frame').length, 1);
  h.presentations[0].done(null, statistics);
  assert.equal(h.page.diabloStatus.frames, 1, 'duplicate completion cannot count or acknowledge another frame');
  assert.equal(acknowledgements(h).length, 1);

  h.advance(100);h.worker.emit({action: 'metrics', fps: 20, heapBytes: 128, tickMs: 8, maxTickMs: 9});
  const metrics = h.reports.find(report => report.event === 'metrics');
  assert.equal(metrics.encodingMs, 2);assert.equal(metrics.decodingMs, 12);
  assert.equal(metrics.presentationMs, 15);assert.equal(metrics.canvasCpuMs, 3);
  assert.equal(metrics.frontendSha256, 'a'.repeat(64));assert.equal(metrics.revisionSha256, 'b'.repeat(64));

  h.worker.emit(frame(2));
  h.events.pagehide();
  h.presentations[1].done(null, statistics);
  assert.equal(h.worker.stopped, true);
  assert.equal(h.page.diabloStatus.frames, 1, 'a late decoder callback after teardown must not paint/count');
  assert.equal(acknowledgements(h).length, 1);
  assert.equal(h.page.diabloStatus.presentationPending, false);

  const failure = await harness();failure.worker.emit(frame(1));
  failure.presentations[0].done(new Error('Decode failed and fallback failed'));
  assert.equal(failure.page.diabloStatus.error, 'Decode failed and fallback failed');
  assert.equal(failure.worker.stopped, true);assert.equal(failure.page.diabloStatus.frames, 0);
  assert.equal(acknowledgements(failure).length, 0);
  const stale = await harness({frontendUpdate: true});
  assert.match(stale.page.diabloStatus.error, /changed after this page opened/);
  assert.equal(stale.worker.stopped, true);
  assert.equal(stale.worker.sent.filter(message => message.action === 'init').length, 0, 'stale frontend cannot initialize an engine under a newer identity');
  console.log('Presentation protocol passed: probe barrier, delayed/detached buffers, exactly-once ACK, timing identity, stale frontend, cancellation and failure.');
})().catch(error => { console.error(error);process.exitCode = 1; });
