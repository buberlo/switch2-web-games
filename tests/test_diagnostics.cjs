/* Run with a local Playwright install; PLAYWRIGHT_MODULE can override its path. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const webRoot = path.resolve(__dirname, '../web');
const reports = [];
const requests = [];
const token = 'diagnostics-test-token';
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  requests.push(route);
  const json = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (route === '/api/session') return json(200, { token });
  if (route === '/api/status') return json(200, { engineReady: true, dataReady: true });
  if (route === '/api/diagnostics' && request.method === 'POST') {
    assert.equal(request.headers['x-portal-token'], token);
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { reports.push(JSON.parse(body)); json(200, { saved: true }); });
    return;
  }
  const relative = route === '/portal' ? 'index.html' : route === '/diagnostics' ? 'diagnostics.html' : route.slice(1);
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});

async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--enable-unsafe-swiftshader']
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/portal');
    await page.getByText('Installed on your Mac', { exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Play Diablo/ }).count(), 2);
    const screenshotDir = process.env.PORTAL_SCREENSHOT_DIR;
    if (screenshotDir) { fs.mkdirSync(screenshotDir, { recursive: true }); await page.screenshot({ path: path.join(screenshotDir, 'portal-desktop.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await page.getByText('Installed on your Mac', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'portal-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(origin + '/diagnostics');
    await page.waitForFunction(() => !document.getElementById('run-checks').disabled);
    for (const id of ['canvas2d', 'worker', 'wasm', 'webgl1', 'webgl2']) {
      assert.equal(await page.locator('#probe-' + id + ' .result').textContent(), 'Passed', id);
    }
    await page.locator('#input-pad').click();
    await page.keyboard.type('DoNotRecordThis!');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('#probe-keyboard .result').textContent === 'Passed');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.ok(reports.length > 0);
    const inputReport = reports[reports.length - 1];
    assert.ok(inputReport.input.counts.keydown >= 16);
    assert.ok(inputReport.input.gameKeys.ArrowUp > 0);
    assert.equal(JSON.stringify(reports).includes('DoNotRecordThis'), false);
    assert.equal(Object.keys(inputReport.input.gameKeys).some(key => /^[a-z]$/i.test(key)), false);
    assert.equal(inputReport.environment.protocol, 'http:');
    await page.locator('#test-audio').click();
    await page.waitForFunction(() => document.querySelector('#probe-audio .result').textContent === 'Passed');
    assert.equal(await page.locator('#confirm-audio').isVisible(), true);
    await page.locator('#test-memory').click();
    assert.equal(await page.locator('#probe-memory .result').textContent(), 'Passed');
    await page.evaluate(() => { Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: undefined }); });
    await page.locator('#test-gamepad').click();
    assert.equal(await page.locator('#probe-gamepad .result').textContent(), 'Unavailable');
    assert.match(await page.locator('#probe-gamepad .probe-detail').textContent(), /does not establish/);
    await page.route('**/api/diagnostics', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Test outage"}' }));
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.getElementById('report-status').textContent.indexOf('Results not saved:') === 0);
    await page.unroute('**/api/diagnostics');
    await page.locator('#save-report').click();
    await page.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, 'diagnostics.png'), fullPage: true });
    await context.close();

    const restricted = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await restricted.addInitScript(() => {
      window.WebAssembly = undefined;
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, options) {
        if (/webgl/.test(type)) return null;
        return getContext.call(this, type, options);
      };
      Object.defineProperty(window, 'localStorage', { get: function () { throw new Error('Storage intentionally disabled'); } });
      window.indexedDB = undefined;
    });
    await restricted.route('**/js/probe-worker.js', route => route.fulfill({ contentType: 'application/javascript', body: 'self.WebAssembly = undefined;\n' + fs.readFileSync(path.join(webRoot, 'js/probe-worker.js'), 'utf8') }));
    const restrictedPage = await restricted.newPage();
    restrictedPage.on('pageerror', error => errors.push(error.message));
    await restrictedPage.goto(origin + '/diagnostics');
    await restrictedPage.waitForFunction(() => !document.getElementById('run-checks').disabled);
    for (const id of ['wasm', 'webgl1', 'webgl2']) assert.equal(await restrictedPage.locator('#probe-' + id + ' .result').textContent(), 'Unavailable');
    for (const id of ['canvas2d', 'worker']) assert.equal(await restrictedPage.locator('#probe-' + id + ' .result').textContent(), 'Passed');
    await restrictedPage.locator('#save-report').click();
    await restrictedPage.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.equal(reports[reports.length - 1].probes.worker.observations.webAssemblyGlobal, false);
    assert.equal(requests.some(route => /\.wasm($|\?)/.test(route)), false);
    assert.deepEqual(errors, []);
    await restricted.close();
    console.log('PASS: responsive portal, real browser probes, input privacy, audio scheduling, optional memory, failure recovery, restricted APIs, no wasm requests.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
