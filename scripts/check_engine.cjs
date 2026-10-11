#!/usr/bin/env node
'use strict';

// Exercise the real JavaScript-only engine and real shareware archive in a
// browser-shaped VM. This checks initialization and deterministic game
// pixel output, not physical Switch playability. Run with Node 20 or newer.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const options = {
  engine: path.join(root, 'web/engine/DiabloSpawn.js'),
  asset: path.join(root, 'data/assets/spawn.mpq'),
  output: null,
  withIntro: false,
  offscreen: false,
  indexed: false,
  noAudio: false,
  profile: false,
  withoutMemoryBuiltins: false,
  frameDigests: false,
  reloadSave: null,
  saveDir: null,
  scene: 'menu'
};
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i];
  if (flag === '--help') {
    console.log('Usage: node scripts/check_engine.cjs [--engine PATH] [--asset PATH] [--output JSON_PATH] [--with-intro] [--offscreen] [--indexed] [--no-audio] [--profile] [--without-memory-builtins] [--frame-digests] [--scene menu|town|town-reload|dungeon-reload] [--reload-save PATH] [--save-dir PATH]');
    process.exit(0);
  }
  if (flag === '--with-intro') { options.withIntro = true; continue; }
  if (flag === '--offscreen') { options.offscreen = true; continue; }
  if (flag === '--indexed') { options.indexed = true; continue; }
  if (flag === '--no-audio') { options.noAudio = true; continue; }
  if (flag === '--profile') { options.profile = true; continue; }
  if (flag === '--without-memory-builtins') { options.withoutMemoryBuiltins = true; continue; }
  if (flag === '--frame-digests') { options.frameDigests = true; continue; }
  if (flag === '--reload-save' || flag === '--save-dir') {
    assert(process.argv[i + 1], 'Missing path for ' + flag);
    options[flag === '--reload-save' ? 'reloadSave' : 'saveDir'] = path.resolve(process.argv[++i]);
    continue;
  }
  if (flag === '--scene') {
    options.scene = process.argv[++i];
    assert(['menu', 'town', 'town-reload', 'dungeon-reload'].includes(options.scene), 'Expected menu, town, town-reload, or dungeon-reload scene');
    continue;
  }
  if (!['--engine', '--asset', '--output'].includes(flag) || !process.argv[i + 1]) {
    throw new Error('Unknown option or missing value: ' + flag);
  }
  options[flag.slice(2)] = path.resolve(process.argv[++i]);
}

const engineSource = fs.readFileSync(options.engine, 'utf8');
assert(!options.reloadSave || ['town-reload', 'dungeon-reload'].includes(options.scene), '--reload-save requires a reload scene');
assert(options.scene !== 'dungeon-reload' || options.reloadSave, 'dungeon-reload requires --reload-save with a local cathedral save');
const archive = fs.readFileSync(options.asset);
assert.strictEqual(archive.length, 25830791, 'Expected the pinned shareware archive');
assert.strictEqual(archive.subarray(0, 4).toString('hex'), '4d50511a', 'Expected MPQ magic');
assert.strictEqual(crypto.createHash('sha256').update(archive).digest('hex'),
  '21d125650291d6099a4a49e325374add8fbc3ac17f97d64fac83bbdd3364f28f', 'Shareware checksum mismatch');

function summarizeTiming(times) {
  const sorted = times.slice().sort((a, b) => a - b);
  const round = value => Math.round(value * 10) / 10;
  return {
    first: round(times[0]),
    mean: round(times.reduce((sum, value) => sum + value, 0) / times.length),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    p95: round(sorted[Math.floor(sorted.length * .95)]),
    max: round(sorted[sorted.length - 1])
  };
}

async function scenario(mode) {
  const files = { 'spawn.mpq': new Uint8Array(archive) };
  const pixelsDigest = crypto.createHash('sha256');
  const result = {mode, scene: options.scene, offscreen: options.offscreen,
    indexed: options.indexed, audio: !options.noAudio,
    frames: 0, blits: 0, indexedBlits: 0, pixelBytes: 0, nonzeroPixelSamples: 0,
    audioCallbacks: 0, writes: 0, exits: 0, phases: [], profiles: {}};
  if (options.frameDigests) result.frameDigests = [];
  let frameDigest = null;
  let lastTerrainCache = null;
  const terrainCacheResets = [];
  const terrainCachePeak = {entries: 0, spanBytes: 0};
  let consumerMs = 0;
  function consumeRGBA(x, y, width, height, data) {
    assert(width > 0 && height > 0, 'Empty render rectangle');
    assert.strictEqual(data.length, width * height * 4, 'RGBA rectangle length mismatch');
    result.blits++; result.pixelBytes += data.length;
    pixelsDigest.update(data);
    if (frameDigest) {
      frameDigest.update(JSON.stringify([x, y, width, height]));
      frameDigest.update(data);
    }
    for (let i = 0; i < data.length; i += 256) {
      if (data[i] || data[i + 1] || data[i + 2]) result.nonzeroPixelSamples++;
    }
  }
  const DApi = {
    get_file_size(name) { return files[name.toLowerCase()]?.length || 0; },
    get_file_contents(name, target, offset) {
      const file = files[name.toLowerCase()];
      assert(file, 'Read of missing engine file: ' + name);
      target.set(file.subarray(offset, offset + target.length));
    },
    put_file_contents(name, data) { files[name.toLowerCase()] = data.slice(); result.writes++; },
    remove_file(name) { delete files[name.toLowerCase()]; },
    exit_error(message) { throw Error(message); },
    exit_game() { result.exits++; }, current_save_id() {}, set_cursor() {}, open_keyboard() {}, close_keyboard() {},
    phase(name, details) { result.phases.push({name, details}); },
    use_websocket() {}, websocket_closed() { return true; }, websocket_send() {},
    draw_begin() { if (options.frameDigests) frameDigest = crypto.createHash('sha256'); },
    draw_end() {
      result.frames++;
      if (frameDigest) { result.frameDigests.push(frameDigest.digest('hex')); frameDigest = null; }
    },
    draw_clip_text() {}, draw_text() {}, draw_belt() {},
    draw_blit(x, y, width, height, data) {
      const begin = performance.now();
      consumeRGBA(x, y, width, height, data);
      consumerMs += performance.now() - begin;
    }
  };
  if (options.noAudio) DApi.sound_enabled = () => false;
  if (options.profile) DApi.profiler = (name, ms) => {
    const profile = result.profiles[name] || (result.profiles[name] = {ms: 0, calls: 0});
    profile.ms += ms; profile.calls++;
  };
  if (options.indexed) DApi.draw_indexed = (x, y, width, height, indices, stride, palette) => {
    const begin = performance.now();
    assert(stride >= width && indices.length === (height - 1) * stride + width);
    assert.strictEqual(palette.length, 1024);
    const colors = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      colors[i] = palette[i * 4] | palette[i * 4 + 1] << 8 | palette[i * 4 + 2] << 16 | 0xff000000;
    }
    const rgba = new Uint8Array(width * height * 4), pixels = new Uint32Array(rgba.buffer);
    let out = 0;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) pixels[out++] = colors[indices[row * stride + col]];
    }
    consumeRGBA(x, y, width, height, rgba);
    result.indexedBlits++;
    consumerMs += performance.now() - begin;
  };
  for (const name of ['create_sound_raw', 'create_sound', 'duplicate_sound', 'play_sound', 'set_volume', 'stop_sound', 'delete_sound']) {
    DApi[name] = () => { result.audioCallbacks++; };
  }
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    WebAssembly: undefined, BigInt: undefined, SharedArrayBuffer: undefined,
    Worker: undefined, OffscreenCanvas: undefined, indexedDB: undefined,
    DApi, location: {href: 'http://local/engine/DiabloSpawn.js'},
    alert(message) { throw Error('Unexpected engine alert: ' + message); }
  };
  sandbox.self = sandbox;
  if (mode === 'worker') {
    sandbox.importScripts = () => { throw Error('Unexpected engine dependency download'); };
  } else {
    sandbox.window = sandbox;
    sandbox.document = {currentScript: {src: 'http://local/engine/DiabloSpawn.js'}};
  }
  vm.createContext(sandbox);
  // Single-player dungeon setup also seeds from C time(NULL). Pin that
  // browser clock so baseline/optimized runs can compare every RGBA byte.
  vm.runInContext('Date.now = function () { return 1700000000000; };', sandbox);
  if (options.withoutMemoryBuiltins) {
    vm.runInContext('Uint8Array.prototype.copyWithin = undefined; Uint8Array.prototype.fill = undefined;', sandbox);
  }
  vm.runInContext(engineSource, sandbox, {filename: options.engine, timeout: 20000});
  const started = performance.now();
  const engine = await sandbox.DiabloSpawn({print() {}, printErr: console.error});
  result.heapBytes = engine.HEAPU8.length;
  assert(result.heapBytes <= 268435456, 'Engine heap exceeded the configured cap');
  for (const name of ['Init', 'Render', 'Mouse', 'Key', 'Char', 'SyncTextPtr', 'SyncText']) {
    assert.strictEqual(typeof engine['_DApi_' + name], 'function', 'Missing engine export: ' + name);
  }
  result.engineExports = Object.keys(engine).filter(name => name.startsWith('_DApi_')).sort();
  assert.deepStrictEqual(result.engineExports,
    ['AllocPacket', 'Char', 'Init', 'Key', 'Mouse', 'Render', 'SyncText', 'SyncTextPtr'].map(name => '_DApi_' + name).sort(),
    'Production engine contains unexpected DApi exports');
  const initStarted = performance.now();
  engine._DApi_Init(0, options.offscreen ? 1 : 0, 1, 0, 0);
  result.initMs = Math.round(performance.now() - initStarted);
  const renderTimes = [];
  const engineTimes = [];
  const inputTimes = [];
  const dungeon = options.scene === 'dungeon-reload';
  const reload = dungeon || options.scene === 'town-reload';
  const tickCount = dungeon ? 640 : reload ? 240 : 120;
  for (let tick = 1; tick <= tickCount; tick++) {
    const inputStarted = performance.now();
    // Only the optional upstream startup needs Escape; it exits the default
    // direct menu, so never send this for the project's normal build.
    if (options.withIntro && (tick === 20 || tick === 60)) {
      engine._DApi_Key(0, 0, 27); engine._DApi_Key(1, 0, 27);
    }
    if (options.scene !== 'menu') {
      if (tick === 10 || tick === 20 || tick === 30) {
        if (tick === 30) {
          const name = Buffer.from('EngineProof\0');
          engine.HEAPU8.set(name, engine._DApi_SyncTextPtr());
          engine._DApi_SyncText(0);
        }
        engine._DApi_Key(0, 0, 13); engine._DApi_Key(1, 0, 13);
      }
      if (tick === 70 || tick === 90) engine._DApi_Char(105); // inventory
      if (tick === 100) {
        engine._DApi_Mouse(1, 1, 0, 400, 280);
        engine._DApi_Mouse(2, 1, 0, 400, 280);
      }
    }
    if (reload) {
      const press = code => { engine._DApi_Key(0, 0, code); engine._DApi_Key(1, 0, code); };
      if (tick === 130 || tick === 150) engine._DApi_Char(122); // zoom both ways
      if (tick === 160 || tick === 180) press(27); // in-game menu
      if (tick === 162) press(13); // save
      if (tick === 175 && options.reloadSave) files['spawn0.sv'] = new Uint8Array(fs.readFileSync(options.reloadSave));
      if (tick === 182) { press(40); press(40); press(40); } // Load Game
      if (tick === 184) press(13);
      if (!dungeon && (tick === 210 || tick === 220)) engine._DApi_Char(99); // character panel
      if (!dungeon && tick === 230) { engine._DApi_Mouse(1, 1, 0, 240, 260); engine._DApi_Mouse(2, 1, 0, 240, 260); }
      if (dungeon) {
        // Only normal public inputs are used: load a local synthetic/owned
        // cathedral save, then exercise both zooms, panels, walking and reload.
        // Calls 185-214 warm the scene; 215-334 measure stationary rendering.
        if (tick === 335 || tick === 355) engine._DApi_Char(122);
        if (tick === 375 || tick === 395) engine._DApi_Char(105);
        if (tick === 415 || tick === 435) engine._DApi_Char(99);
        if (tick === 455 || tick === 515) {
          const point = tick === 455 ? [360, 240] : [260, 200];
          engine._DApi_Mouse(0, 0, 0, ...point);
          engine._DApi_Mouse(1, 1, 0, ...point); engine._DApi_Mouse(2, 1, 0, ...point);
        }
        if (tick === 575 || tick === 590) press(27);
        if (tick === 577) press(13); // save cathedral progress
        if (tick === 592) { press(40); press(40); press(40); }
        if (tick === 594) press(13); // ordinary Load Game again
        if (tick === 184 || tick === 594) {
          const phase = result.phases[result.phases.length - 1];
          assert(phase?.name === 'game-ready' && phase.details?.value === 1,
            'Dungeon replay did not finish loading cathedral level 1');
        }
      }
    }
    if (tick === 80) engine._DApi_Mouse(0, 0, 0, 320, 240);
    inputTimes.push(performance.now() - inputStarted);
    const renderStarted = performance.now();
    const consumerBefore = consumerMs;
    engine._DApi_Render(tick * 50);
    const renderMs = performance.now() - renderStarted;
    if (engine.switchTerrainCache && engine.switchTerrainCache !== lastTerrainCache) {
      lastTerrainCache = engine.switchTerrainCache; terrainCacheResets.push(tick);
    }
    if (engine.switchTerrainCache) {
      const cache = engine.switchTerrainCache;
      assert(cache.count <= 2048 && cache.bytes <= 2097152, 'Terrain cache exceeded its bounds during replay');
      terrainCachePeak.entries = Math.max(terrainCachePeak.entries, cache.count);
      terrainCachePeak.spanBytes = Math.max(terrainCachePeak.spanBytes, cache.bytes);
    }
    renderTimes.push(renderMs);
    engineTimes.push(renderMs - (consumerMs - consumerBefore));
  }
  result.renderTimingMs = summarizeTiming(renderTimes);
  if (engine.switchTerrainCache) {
    const entries = Object.values(engine.switchTerrainCache.entries);
    const spanBytes = entries.reduce((sum, spans) => sum + spans.byteLength, 0);
    assert(entries.length <= 2048 && spanBytes <= 2097152, 'Terrain cache exceeded its bounds');
    result.terrainCache = {entries: entries.length, spanBytes, peak: terrainCachePeak, resets: terrainCacheResets,
      tileTypes: [...new Set(Object.keys(engine.switchTerrainCache.entries).map(key => Number(key.split(':')[1])))].sort()};
    if (reload) {
      assert(terrainCacheResets.includes(184), 'Load Game did not invalidate terrain cache');
      if (dungeon) assert(terrainCacheResets.includes(594), 'Second dungeon reload did not invalidate terrain cache');
      assert.strictEqual(result.phases[result.phases.length - 1]?.name, 'game-ready', 'Load Game did not finish its loading phase');
    }
  }
  result.warmRenderTimingMs = summarizeTiming(renderTimes.slice(30));
  result.warmEngineTimingMs = summarizeTiming(engineTimes.slice(30));
  if (dungeon) {
    result.dungeonWarmEngineTimingMs = summarizeTiming(engineTimes.slice(214, 334));
    result.dungeonTimingMethod = '120 stationary cathedral render calls (215-334), after 30 warmup calls following normal Load Game; test conversion/hash excluded, browser painting/transfer excluded.';
    result.reloadedSaveSha256 = crypto.createHash('sha256').update(fs.readFileSync(options.reloadSave)).digest('hex');
  }
  result.maxInputMs = Math.round(Math.max(...inputTimes));
  if (options.scene !== 'menu') result.heroAcceptMs = Math.round(inputTimes[29]);
  result.timingMethod = 'renderTimingMs: synchronous _DApi_Render including test pixel conversion/hash; warmEngineTimingMs subtracts that consumer, calls31-' + tickCount + '. Init and input/level-loading callbacks are separate; no browser paint, audio playback, or transfer cost.';
  result.elapsedMs = Math.round(performance.now() - started);
  result.pixelsSha256 = pixelsDigest.digest('hex');
  result.saves = {};
  for (const name of Object.keys(files).filter(name => /^spawn\d+\.sv$/.test(name)).sort()) {
    result.saves[name] = {bytes: files[name].length,
      sha256: crypto.createHash('sha256').update(files[name]).digest('hex')};
    if (options.saveDir) {
      fs.mkdirSync(options.saveDir, {recursive: true});
      fs.writeFileSync(path.join(options.saveDir, mode + '-' + name), files[name]);
    }
  }
  assert(result.frames >= 20 && result.blits >= 20, 'Engine produced too few rendered frames');
  assert(result.nonzeroPixelSamples > 0, 'Engine produced no visible pixels');
  if (options.scene !== 'menu') assert(result.writes > 0, 'Hero creation did not save a character');
  assert.strictEqual(result.exits, 0, 'Engine unexpectedly requested exit');
  if (options.indexed && !options.offscreen) assert(result.indexedBlits > 0, 'Indexed output was not used');
  return result;
}

(async () => {
  const results = [];
  // Run sequentially to keep peak memory bounded.
  for (const mode of ['worker', 'main']) results.push(await scenario(mode));
  const report = {
    engineSha256: crypto.createHash('sha256').update(engineSource).digest('hex'),
    forbiddenCapabilities: ['WebAssembly', 'BigInt', 'SharedArrayBuffer', 'Worker', 'OffscreenCanvas', 'indexedDB'],
    results
  };
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), {recursive: true});
    fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {console.error(error); process.exitCode = 1;});
