'use strict';
// Optional network check of a deployment already authorized by its owner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const bundle = path.join(root, 'data/webgl-public');
const destination = new URL(process.argv[2] || 'https://switch2-webgl-probe.pages.dev');
assert.equal(destination.protocol, 'https:', 'The public control must use valid HTTPS');
assert.equal(destination.pathname, '/');
assert.equal(destination.search + destination.hash + destination.username + destination.password, '');
const origin = destination.origin;
const digest = body => crypto.createHash('sha256').update(body).digest('hex');

(async () => {
  const expected = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json')));
  const observations = [];
  for (const relative of [...expected.sources.map(item => item.path), 'assets/webgl-research-config.js', 'manifest.json', 'index.html']) {
    const response = await fetch(origin + '/' + relative, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, relative);
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, fs.readFileSync(path.join(bundle, relative)), relative + ' differs from the reviewed bundle');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    observations.push({ path: relative, sha256: digest(body), status: response.status });
  }
  for (const relative of ['api/session', 'api/diagnostics', 'engine/DiabloSpawn.js', 'assets/spawn.mpq', 'data/diagnostics.jsonl']) {
    const response = await fetch(origin + '/' + relative, { signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 404, relative + ' must be absent');
    observations.push({ path: relative, status: response.status });
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-webgl', '--js-flags=--jitless'] });
  const requests = [], errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.goto(origin + '/assets/webgl-research.html?public=1#return=' + encodeURIComponent('http://127.0.0.1:8090/assets/webgl-research.html'));
    await page.locator('#firmware').fill('desktop-control');
    await page.locator('#firmware-confirmed').check();
    await page.locator('#console-mode').selectOption('handheld');
    const evidence = path.join(root, 'data/qa/webgl-research');
    fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'public-probe.png') });
    await page.locator('#start').click();
    // In-page polling avoids renewing transient activation through DevTools.
    await page.waitForFunction(() => !document.getElementById('trusted-test').disabled);
    for (let index = 0; index < 6; index += 1) {
      await page.waitForFunction(() => !document.getElementById('trusted-test').disabled);
      await page.locator('#trusted-test').click();
    }
    await page.waitForFunction(() => document.getElementById('status').textContent.indexOf('All 18') === 0);
    const report = JSON.parse(await page.locator('#results-json').inputValue());
    assert.equal(report.probeRevision, expected.revision);
    assert.equal(report.environment.secureContext, true);
    assert.equal(report.cases.length, 18);
    assert.ok(report.cases.every(item => item.contextStatus === 'null'));
    assert.ok((await page.locator('#return-results').getAttribute('href')).startsWith('http://127.0.0.1:8090/assets/webgl-research.html#report='));
    for (const address of ['010.0.0.1', '0172.16.0.1']) {
      await page.goto(origin + '/assets/webgl-research.html?public=1&control=' + address + '#return=' + encodeURIComponent('http://' + address + '/assets/webgl-research.html'));
      assert.equal(await page.locator('#lan-return').inputValue(), '', 'Noncanonical IPv4 return must be rejected');
      assert.equal(await page.locator('#return-results').isVisible(), false);
    }
    assert.ok(requests.every(value => new URL(value).origin === origin && !new URL(value).pathname.startsWith('/api/')));
    assert.deepEqual(errors, []);
    const result = { checkedAt: new Date().toISOString(), origin, probeRevision: expected.revision,
      note: 'Desktop control with deliberately disabled WebGL; no physical console measurement.',
      assets: observations, browserRequests: requests, report };
    fs.writeFileSync(path.join(evidence, 'deployment-check.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('PASS: public HTTPS asset hashes, no-store headers, missing private routes, 18 disabled-WebGL cases, no API/LAN requests, bounded return link. Revision ' + expected.revision);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
