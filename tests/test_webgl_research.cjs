'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const acorn = require('acorn');
const webRoot = path.resolve(__dirname, '../web');
acorn.parse(fs.readFileSync(path.join(webRoot, 'js/webgl-research.js'), 'utf8'), { ecmaVersion: 5 });
const secureOrigin = 'https://webgl-probe.example';
const revision = 'test-probe-revision';
const reports = [], requests = [], errors = [];
let failures = 0;
const mockCore = `(function(){
var list=[],minimal={alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,failIfMajorPerformanceCaveat:false};
['visible-auto','detached-auto','trusted-tap'].forEach(function(execution){['webgl','experimental-webgl','webgl2'].forEach(function(name){[null,minimal].forEach(function(attributes){list.push({id:execution+'-'+name+'-'+(attributes?'minimal':'default'),execution:execution,contextName:name,attributes:attributes});});});});
window.mockCalls=[];
window.SwitchWebGLProbe={cases:function(){return list;},runCase:function(spec,options,done){
  window.mockCalls.push({spec:spec, trusted:options.trustedGesture, active:navigator.userActivation&&navigator.userActivation.isActive});
  var result={schemaVersion:1,id:spec.id,contextName:spec.contextName,execution:spec.execution,requestedAttributes:spec.attributes,trustedGesture:options.trustedGesture,contextStatus:'null',creationMs:1,api:{webgl1:'function',webgl2:'function'},creationErrors:[],exception:null,actualAttributes:null,info:null,checks:[],animation:null,cleanup:{resourcesDeleted:0,contextLossRequested:false,contextLostAcknowledged:false,recreated:false,recreatedReleased:false},requiresReload:false,cancelled:false};
  if(window.mockScenario==='reload'&&window.location.hash.indexOf('resume=')<0) result.requiresReload=true;
  if(window.mockScenario==='throw'){result.contextStatus='threw';result.exception={name:'Error',message:'Creation exception'};}
  if(window.mockScenario==='event') result.creationErrors=['Graphics backend unavailable'];
  if(window.mockScenario==='large') result.creationErrors=[new Array(1501).join('x')];
  var finished=false;function finish(){if(finished)return;finished=true;done(null,result);}
  var timer=setTimeout(finish,window.mockScenario==='slow'?400:1);
  return function(){clearTimeout(timer);result.cancelled=true;setTimeout(finish,0);};
}};
}());`;
function content(route) {
  if (route === '/assets/webgl-research-config.js') return { type: 'application/javascript', body: 'window.SwitchWebGLResearchConfig=' + JSON.stringify({ revision, publicOrigin: secureOrigin }) + ';' };
  if (route === '/js/webgl-probe.js') return { type: 'application/javascript', body: mockCore };
  const file = path.resolve(webRoot, route.slice(1));
  if (!file.startsWith(webRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { type: { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' }[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) };
}
const server = http.createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  requests.push(route);
  function json(status, body) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
  if (route === '/api/session') return json(200, { token: 'research-test-token' });
  if (route === '/api/diagnostics') {
    assert.equal(request.headers['x-portal-token'], 'research-test-token');
    let body = '';
    request.on('data', chunk => body += chunk);
    request.on('end', () => {
      if (failures) { failures -= 1; json(503, { error: 'Planned reporting outage' }); }
      else { reports.push(JSON.parse(body)); json(200, { ok: true }); }
    });
    return;
  }
  const item = content(route);
  if (!item) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': item.type }); response.end(item.body);
});
async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.WEBGL_UI_PORT || 8097), '127.0.0.1', resolve); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--enable-unsafe-swiftshader'] });
  const contexts = [];
  async function pageFor(scenario, secure) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } }); contexts.push(context);
    await context.addInitScript(value => {
      window.mockScenario = value;
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage forbidden'); } });
      Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage forbidden'); } });
      window.indexedDB = undefined;
    }, scenario);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    if (secure) await context.route(secureOrigin + '/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      assert.ok(!pathname.startsWith('/api/'), 'Public page must never request any API');
      const item = content(pathname);
      await route.fulfill({ status: item ? 200 : 404, contentType: item ? item.type : 'text/plain', body: item ? item.body : 'missing' });
    });
    return page;
  }
  async function setup(page) {
    await page.locator('#firmware-confirmed').check();
    await page.locator('#console-mode').selectOption('handheld');
  }
  async function run(page) {
    await setup(page); await page.locator('#start').click();
    await page.waitForFunction(() => !document.getElementById('trusted-test').disabled);
    assert.equal(await page.evaluate(() => window.mockCalls.length), 12);
    assert.ok((await page.evaluate(() => window.mockCalls.slice(0, 12))).every(item => item.active === false), 'automatic calls wait until activation expires');
    await page.evaluate(() => document.getElementById('trusted-test').click());
    assert.equal(await page.evaluate(() => window.mockCalls.length), 12, 'synthetic gesture ignored');
    for (let i = 0; i < 6; i++) {
      await page.waitForFunction(() => !document.getElementById('trusted-test').disabled);
      await page.locator('#trusted-test').click();
    }
    await page.waitForFunction(() => document.getElementById('status').textContent.indexOf('All 18') === 0);
    const result = JSON.parse(await page.locator('#results-json').inputValue());
    assert.equal(result.cases.length, 18); assert.equal(result.status, 'complete');
    assert.ok(result.cases.slice(0, 12).every(item => item.trustedGesture === false));
    assert.ok(result.cases.slice(12).every(item => item.trustedGesture === true));
    assert.ok((await page.evaluate(() => window.mockCalls.slice(12))).every(item => item.active));
    return result;
  }
  try {
    const page = await pageFor('normal');
    await page.goto(origin + '/assets/webgl-research.html');
    await page.locator('#start').click();
    assert.match(await page.locator('#status').textContent(), /confirm the system version/);
    assert.equal(await page.evaluate(() => window.mockCalls.length), 0);
    const result = await run(page);
    await page.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.equal(result.metadata.firmware, '23.0.1'); assert.equal(result.probeRevision, revision);
    assert.ok(reports.some(item => item.cases.length === 18));
    assert.ok(reports.some(item => item.cases.length > 0 && item.cases.length < 18), 'partial progress persisted');
    assert.match(await page.locator('#https-link').getAttribute('href'), /#return=http/);
    assert.equal(requests.some(item => /Diablo|spawn\.mpq|\.wasm/.test(item)), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    const failure = await pageFor('event');
    await failure.goto(origin + '/assets/webgl-research.html');
    const eventResult = await run(failure);
    assert.equal(eventResult.cases[0].creationErrors[0], 'Graphics backend unavailable');
    failures = 1;
    await failure.locator('#record-unreachable').click();
    await failure.waitForFunction(() => document.getElementById('report-status').textContent.indexOf('Results not saved:') === 0);
    await failure.locator('#save-report').click();
    await failure.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.equal(reports[reports.length - 1].unreachable[0].target, 'https');
    assert.equal(reports[reports.length - 1].cases.length, 18);

    const throwing = await pageFor('throw'); await throwing.goto(origin + '/assets/webgl-research.html');
    await setup(throwing); await throwing.locator('#start').click();
    await throwing.waitForFunction(() => window.mockCalls.length >= 2);
    await throwing.locator('#stop').click();
    assert.equal(JSON.parse(await throwing.locator('#results-json').inputValue()).cases[0].contextStatus, 'threw');

    const slow = await pageFor('slow'); await slow.goto(origin + '/assets/webgl-research.html');
    await setup(slow); await slow.locator('#start').click();
    await slow.waitForFunction(() => window.mockCalls.length === 1);
    await slow.locator('#stop').click();
    await slow.waitForFunction(() => JSON.parse(document.getElementById('results-json').value).cases.length === 1);
    const stopped = JSON.parse(await slow.locator('#results-json').inputValue());
    assert.equal(stopped.status, 'stopped'); assert.equal(stopped.cases[0].cancelled, true);
    assert.equal(await slow.evaluate(() => window.mockCalls.length), 1);

    const reload = await pageFor('reload'); await reload.goto(origin + '/assets/webgl-research.html');
    await setup(reload); await reload.locator('#start').click();
    await reload.waitForFunction(() => !document.getElementById('resume').hidden);
    assert.equal(await reload.evaluate(() => window.mockCalls.length), 1);
    await reload.locator('#resume').click();
    assert.equal(await reload.evaluate(() => window.mockCalls.length), 0, 'resume awaits user review');
    await reload.locator('#firmware-confirmed').check();
    await reload.locator('#start').click();
    await reload.waitForFunction(() => !document.getElementById('trusted-test').disabled);
    assert.equal(await reload.evaluate(() => window.mockCalls.length), 11, 'resume skips retained first case');
    const resumed = JSON.parse(await reload.locator('#results-json').inputValue());
    assert.equal(resumed.reloads, 1); assert.equal(resumed.cases.length, 12);
    await reload.locator('#stop').click();

    const manualResume = await pageFor('normal');
    await manualResume.goto(origin + '/assets/webgl-research.html');
    const beforeResume = reports.length;
    await manualResume.locator('#manual-import').fill(JSON.stringify(resumed));
    await manualResume.locator('#review-resume').click();
    assert.equal(reports.length, beforeResume, 'manual retained progress requires confirmation');
    assert.equal(await manualResume.evaluate(() => window.mockCalls.length), 0);
    await manualResume.locator('#firmware-confirmed').check();
    await manualResume.locator('#start').click();
    assert.equal(JSON.parse(await manualResume.locator('#results-json').inputValue()).cases.length, 12);
    assert.equal(await manualResume.evaluate(() => window.mockCalls.length), 0, 'retained auto cases are not repeated');
    await manualResume.locator('#stop').click();

    const unknownSecure = await pageFor('normal');
    await unknownSecure.addInitScript(() => { Object.defineProperty(window, 'isSecureContext', { value: undefined, configurable: true }); });
    await unknownSecure.goto(origin + '/assets/webgl-research.html');
    await setup(unknownSecure); await unknownSecure.locator('#record-unreachable').click();
    assert.equal(JSON.parse(await unknownSecure.locator('#results-json').inputValue()).environment.secureContext, null);
    assert.match(await unknownSecure.locator('#environment').textContent(), /secure context: unknown/);

    const secure = await pageFor('normal', true);
    await secure.goto(secureOrigin + '/assets/webgl-research.html?public=1#return=' + encodeURIComponent(origin + '/assets/webgl-research.html'));
    const secureResult = await run(secure);
    assert.equal(secureResult.environment.publicMode, true);
    assert.equal(secureResult.environment.secureContext, true);
    assert.equal(await secure.locator('#save-report').isVisible(), false);
    const returnLink = await secure.locator('#return-results').getAttribute('href');
    assert.ok(returnLink.startsWith(origin)); assert.ok(returnLink.length <= 32768);
    const before = reports.length;
    const importPage = await pageFor('normal'); await importPage.goto(returnLink);
    await importPage.locator('#import-section').waitFor({ state: 'visible' });
    assert.equal(reports.length, before, 'returned report is never submitted automatically');
    await importPage.locator('#submit-import').click();
    await importPage.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.equal(reports[reports.length - 1].provenance.untrusted, true);
    assert.equal(reports[reports.length - 1].environment.origin, secureOrigin);

    const invalid = JSON.parse(JSON.stringify(secureResult)); invalid.environment.origin = origin;
    await importPage.goto(origin + '/assets/webgl-research.html#report=' + encodeURIComponent(JSON.stringify(invalid)));
    await importPage.reload();
    assert.match(await importPage.locator('#status').textContent(), /Only an HTTPS-origin report/);
    assert.equal(await importPage.locator('#import-section').isVisible(), false);
    invalid.environment.origin = secureOrigin; invalid.cases.push(invalid.cases[0]);
    await importPage.goto(origin + '/assets/webgl-research.html#report=' + encodeURIComponent(JSON.stringify(invalid)));
    await importPage.reload();
    assert.match(await importPage.locator('#status').textContent(), /rejected/);
    await importPage.locator('#manual-import').fill('{"kind":"webgl-research","__proto__":{"polluted":true}}');
    await importPage.locator('#review-import').click();
    assert.match(await importPage.locator('#status').textContent(), /Forbidden report field/);

    const unsafeReturn = await pageFor('normal', true);
    await unsafeReturn.goto(secureOrigin + '/assets/webgl-research.html?public=1#return=' + encodeURIComponent('http://example.com/assets/webgl-research.html'));
    assert.equal(await unsafeReturn.locator('#lan-return').inputValue(), '');
    assert.equal(await unsafeReturn.locator('#return-results').isVisible(), false);
    for (const misleadingHost of ['010.0.0.1', '0172.16.0.1']) {
      await unsafeReturn.locator('#lan-return').fill('http://' + misleadingHost + '/assets/webgl-research.html');
      assert.equal(await unsafeReturn.locator('#lan-link').isVisible(), false, 'noncanonical IPv4 must not become an external return origin');
      assert.equal(await unsafeReturn.locator('#return-results').isVisible(), false);
    }

    const large = await pageFor('large', true);
    await large.goto(secureOrigin + '/assets/webgl-research.html?public=1#return=' + encodeURIComponent(origin + '/assets/webgl-research.html'));
    const largeResult = await run(large);
    assert.equal(await large.locator('#return-results').isVisible(), false, 'oversize return is never truncated');
    assert.match(await large.locator('#navigation-status').textContent(), /too long for a return link/);
    assert.ok(Buffer.byteLength(JSON.stringify(largeResult)) < 61440);
    await importPage.locator('#manual-import').fill(JSON.stringify(largeResult));
    await importPage.locator('#review-import').click();
    await importPage.locator('#import-section').waitFor({ state: 'visible' });
    await importPage.locator('#submit-import').click();
    await importPage.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    assert.equal(reports[reports.length - 1].cases.length, 18);

    const real = await pageFor('normal');
    await real.route('**/js/webgl-probe.js', route => route.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(webRoot, 'js/webgl-probe.js'), 'utf8') }));
    await real.goto(origin + '/assets/webgl-research.html');
    await setup(real); await real.locator('#start').click();
    await real.waitForFunction(() => !document.getElementById('trusted-test').disabled, null, { timeout: 60000 });
    for (let i = 0; i < 6; i++) {
      await real.waitForFunction(() => !document.getElementById('trusted-test').disabled);
      assert.equal(await real.evaluate(() => {
        const rect = document.getElementById('trusted-test').getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }), true, 'gesture control is visible without browser automation scrolling it');
      await real.locator('#trusted-test').click();
    }
    await real.waitForFunction(() => document.getElementById('status').textContent.indexOf('All 18') === 0);
    await real.waitForFunction(() => document.getElementById('report-status').textContent === 'Results saved on your Mac.');
    const realResult = JSON.parse(await real.locator('#results-json').inputValue());
    assert.ok(realResult.cases.every(item => item.contextStatus === 'created'));
    assert.equal(realResult.cases.length, 18);
    assert.ok(Buffer.byteLength(JSON.stringify(realResult)) < 61440);
    console.log('Full positive 18-case report: ' + Buffer.byteLength(JSON.stringify(realResult)) + ' bytes.');
    assert.deepEqual(errors, []);
    console.log('PASS: 18-case sequencing, trusted taps, required metadata, partial authenticated reports, retry, cancellation, context-release reload, public API isolation, bounded reviewed return/import, private return allowlist, ES5 syntax, responsive layout.');
  } finally {
    for (const context of contexts) await context.close();
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
