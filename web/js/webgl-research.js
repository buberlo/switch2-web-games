(function (window, document) {
  'use strict';
  var config = window.SwitchWebGLResearchConfig || {};
  var core = window.SwitchWebGLProbe;
  var MAX_REPORT = 61440;
  var MAX_LINK = 32768;
  var PAGE = '/assets/webgl-research.html';
  var CAPTIVE = 'http://ctest.p01.ctest.srv.nintendo.net';
  var origin = window.location.protocol + '//' + window.location.host;
  var publicMode = /(?:\?|&)public=1(?:&|$)/.test(window.location.search) || !isLocalHost(window.location.hostname);
  var cases = core ? core.cases() : [];
  var report = null, imported = null, resumePending = false, busy = false, cancel = null, timer = null, stopped = false;
  var pendingSave = null, saving = false, failedSave = null, automaticDelayUntil = 0;
  function el(id) { return document.getElementById(id); }
  function text(id, value) { el(id).textContent = value; }
  function bounded(value, max) { return String(value || '').slice(0, max || 2048); }
  function isLocalHost(host) {
    if (host === 'localhost') return true;
    if (host === 'ctest.p01.ctest.srv.nintendo.net' || /^(?:conntest\.nintendowifi\.net|ctest\.c\.dn\.nintendo\.net)$/.test(host)) return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host), n, i;
    if (!m) return false;
    for (i = 1; i < 5; i += 1) if (+m[i] > 255 || String(+m[i]) !== m[i]) return false;
    n = +m[1];
    return n === 10 || n === 127 || (n === 192 && +m[2] === 168) || (n === 172 && +m[2] >= 16 && +m[2] <= 31);
  }
  function returnURL(value) {
    var match = /^http:\/\/(localhost|\d{1,3}(?:\.\d{1,3}){3})(?::([0-9]{1,5}))?\/assets\/webgl-research\.html$/.exec(value);
    if (!match || !isLocalHost(match[1]) || (match[2] && (+match[2] < 1 || +match[2] > 65535))) return null;
    return value;
  }
  function publicOrigin(value) {
    return typeof value === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(value) ? value : '';
  }
  function utf8Length(value) { return encodeURIComponent(value).replace(/%[A-Fa-f0-9]{2}/g, 'x').length; }
  function safeTree(value, depth) {
    var keys, i;
    if (depth > 9) throw new Error('The report nesting is too deep.');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { if (value.length > 4096) throw new Error('A report string is too long.'); return; }
    if (typeof value === 'number') { if (!isFinite(value) || Math.abs(value) > 1e16) throw new Error('Invalid report number.'); return; }
    if (typeof value !== 'object') throw new Error('Invalid report value.');
    if (Object.prototype.toString.call(value) === '[object Array]') {
      if (value.length > 256) throw new Error('A report list is too long.');
      for (i = 0; i < value.length; i += 1) safeTree(value[i], depth + 1);
      return;
    }
    keys = Object.keys(value);
    if (keys.length > 64) throw new Error('Too many report fields.');
    for (i = 0; i < keys.length; i += 1) {
      if (keys[i] === '__proto__' || keys[i] === 'prototype' || keys[i] === 'constructor' || keys[i].length > 80) throw new Error('Forbidden report field.');
      safeTree(value[keys[i]], depth + 1);
    }
  }
  function validateReport(raw, purpose) {
    if (typeof raw !== 'string' || (raw.length > MAX_REPORT || utf8Length(raw) > MAX_REPORT)) throw new Error('Report exceeds the 60 KiB limit.');
    var value = JSON.parse(raw), allowed = ['kind', 'version', 'probeRevision', 'runId', 'startedAt', 'updatedAt', 'environment', 'metadata', 'cases', 'status', 'error', 'reloads', 'unreachable', 'provenance'], i, j, spec, seen = {};
    safeTree(value, 0);
    if (value.kind !== 'webgl-research' || value.version !== 1 || typeof value.probeRevision !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.probeRevision) || typeof value.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.runId)) throw new Error('Unknown report identity.');
    Object.keys(value).forEach(function (key) { if (allowed.indexOf(key) < 0) throw new Error('Unknown report field: ' + key); });
    if (!value.metadata || typeof value.metadata.firmware !== 'string' || value.metadata.firmware.length > 32 || value.metadata.firmwareConfirmed !== true || ['handheld', 'docked'].indexOf(value.metadata.mode) < 0 || [1, 2, 3].indexOf(value.metadata.opening) < 0) throw new Error('Missing confirmed console metadata.');
    if (!value.environment || typeof value.environment.origin !== 'string' || typeof value.environment.userAgent !== 'string' || value.environment.userAgent.length > 2048) throw new Error('Missing source environment.');
    if (purpose === 'import' && (!publicOrigin(value.environment.origin) || value.environment.publicMode !== true || value.environment.protocol !== 'https:')) throw new Error('Only an HTTPS-origin report can be returned here.');
    if (purpose === 'resume' && (value.environment.origin !== origin || value.probeRevision !== bounded(config.revision, 128))) throw new Error('A resumed report must match this origin and probe revision.');
    if (Object.prototype.toString.call(value.cases) !== '[object Array]' || value.cases.length > 18 || !/^(running|gesture|complete|stopped|reload-required|failed|unreachable)$/.test(value.status) || typeof value.reloads !== 'number' || value.reloads < 0 || value.reloads > 18 || value.reloads % 1) throw new Error('Invalid report progress.');
    if (Object.prototype.toString.call(value.unreachable) !== '[object Array]' || value.unreachable.length > 6) throw new Error('Invalid origin observations.');
    value.unreachable.forEach(function (item) {
      if (!item || ['https', 'lan', 'captive'].indexOf(item.target) < 0 || typeof item.observedAt !== 'string' || item.observedAt.length > 32 || item.reportedByUser !== true || Object.keys(item).length !== 3) throw new Error('Invalid unreachable-origin observation.');
    });
    for (i = 0; i < value.cases.length; i += 1) {
      spec = null;
      for (j = 0; j < cases.length; j += 1) if (cases[j].id === value.cases[i].id) spec = cases[j];
      if (!spec || seen[spec.id] || value.cases[i].schemaVersion !== 1 || value.cases[i].contextName !== spec.contextName || value.cases[i].execution !== spec.execution || ['null', 'threw', 'created'].indexOf(value.cases[i].contextStatus) < 0 || typeof value.cases[i].trustedGesture !== 'boolean' || typeof value.cases[i].requiresReload !== 'boolean' || JSON.stringify(value.cases[i].requestedAttributes) !== JSON.stringify(spec.attributes)) throw new Error('Invalid or duplicate probe case.');
      seen[spec.id] = true;
    }
    return value;
  }
  function environment() {
    var topLevel = false;
    try { topLevel = window.top === window; } catch (ignore) {}
    return { origin: origin, protocol: window.location.protocol, secureContext: typeof window.isSecureContext === 'boolean' ? window.isSecureContext : null, publicMode: publicMode, userAgent: bounded(window.navigator.userAgent, 2048), visibility: document.visibilityState || 'unknown', topLevel: topLevel, api: { webgl1: typeof window.WebGLRenderingContext !== 'undefined', webgl2: typeof window.WebGL2RenderingContext !== 'undefined' } };
  }
  function metadata() {
    var firmware = el('firmware').value.replace(/^\s+|\s+$/g, '');
    if (!/^[0-9A-Za-z ._-]{1,32}$/.test(firmware) || !el('firmware-confirmed').checked) throw new Error('Enter and confirm the system version shown on the console.');
    if (!/^(handheld|docked)$/.test(el('console-mode').value)) throw new Error('Choose handheld or docked mode.');
    return { firmware: firmware, firmwareConfirmed: true, mode: el('console-mode').value, opening: +el('opening').value };
  }
  function createReport() {
    return { kind: 'webgl-research', version: 1, probeRevision: bounded(config.revision || 'unconfigured', 128), runId: 'wgl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), environment: environment(), metadata: metadata(), cases: [], status: 'running', error: null, reloads: 0, unreachable: [] };
  }
  function snapshot() {
    report.updatedAt = new Date().toISOString();
    var raw = JSON.stringify(report);
    if (utf8Length(raw) > MAX_REPORT) throw new Error('The complete report is too large to submit. Keep the readable report below.');
    return JSON.parse(raw);
  }
  function flushSave() {
    if (publicMode || saving || !pendingSave) return;
    var value = pendingSave;
    pendingSave = null; saving = true;
    text('report-status', 'Saving results on the Mac…');
    window.Portal.report(value).then(function () {
      saving = false; failedSave = null;
      text('report-status', 'Results saved on your Mac.');
      el('save-report').disabled = true;
      flushSave();
    }, function (error) {
      saving = false; failedSave = pendingSave || value; pendingSave = null;
      text('report-status', 'Results not saved: ' + bounded(error.message, 300));
      el('save-report').disabled = false;
    });
  }
  function save(value) {
    if (publicMode) { text('report-status', 'Results remain on this HTTPS page. Use the return link to save them on the Mac.'); return; }
    pendingSave = value; flushSave();
  }
  function updateNavigation() {
    var local = returnURL(el('lan-return').value.replace(/^\s+|\s+$/g, ''));
    var secure = publicOrigin(config.publicOrigin);
    el('lan-link').hidden = !local;
    el('captive-link').hidden = publicMode;
    el('https-link').hidden = !secure || publicMode;
    el('return-results').hidden = true;
    if (local) el('lan-link').href = local;
    el('captive-link').href = CAPTIVE + PAGE;
    if (secure) {
      el('https-link').href = secure + PAGE + '?public=1' + (local ? '#return=' + encodeURIComponent(local) : '');
    }
    text('navigation-status', !local ? 'Enter the Mac’s private LAN address to enable returning results.' : (!secure && !publicMode ? 'The public HTTPS probe has not been configured yet.' : 'Origin links use ordinary top-level navigation.'));
    if (publicMode && report && local) {
      var url = local + '#report=' + encodeURIComponent(JSON.stringify(report));
      if (url.length <= MAX_LINK) { el('return-results').href = url; el('return-results').hidden = false; }
      else text('navigation-status', 'The full report is too long for a return link. Copy the complete readable JSON and paste it on the Mac page; no results have been removed.');
    }
  }
  function display() {
    if (!report) return;
    text('results-json', JSON.stringify(report, null, 2));
    el('results-json').value = JSON.stringify(report, null, 2);
    var list = el('case-results');
    while (list.firstChild) list.removeChild(list.firstChild);
    report.cases.forEach(function (result) {
      var item = document.createElement('li');
      var failures = (result.checks || []).filter(function (check) { return check.status !== 'passed' && check.status !== 'pass' && check.status !== 'skipped'; });
      item.textContent = result.id + ': ' + result.contextStatus + (failures.length ? ' — ' + failures.length + ' validation result(s) need review' : '') + (result.requiresReload ? ' — reload required' : '');
      list.appendChild(item);
    });
    updateNavigation();
  }
  function persist() {
    display();
    try { save(snapshot()); } catch (error) { text('report-status', error.message); }
  }
  function nextSpec() {
    var used = {}, i;
    report.cases.forEach(function (item) { used[item.id] = true; });
    for (i = 0; i < cases.length; i += 1) if (!used[cases[i].id]) return cases[i];
    return null;
  }
  function reloadLink() {
    var url = origin + PAGE + '?resumeReload=' + (report.reloads + 1) + (publicMode ? '&public=1' : '') + '#resume=' + encodeURIComponent(JSON.stringify(report));
    var returnTarget = returnURL(el('lan-return').value);
    if (publicMode && returnTarget) url += '&return=' + encodeURIComponent(returnTarget);
    el('resume').hidden = url.length > MAX_LINK;
    if (url.length <= MAX_LINK) el('resume').href = url;
    else text('status', 'Context release was unavailable. The retained report is too large for a resume link; copy the JSON, reload, and use “Review retained progress to resume” on the fresh page.');
  }
  function revealGestureButton() {
    var button = el('trusted-test');
    var rect = button.getBoundingClientRect();
    var height = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top < 24 || rect.bottom > height - 24) {
      button.scrollIntoView(true);
      window.scrollBy(0, -24);
    }
  }
  function advance() {
    if (stopped || busy || !report) return;
    var spec = nextSpec();
    if (!spec) {
      report.status = 'complete'; el('stop').disabled = true; el('trusted-test').disabled = true;
      text('status', 'All 18 checks completed. Review the results below.'); persist(); return;
    }
    if (spec.execution === 'trusted-tap') {
      report.status = 'gesture'; el('trusted-test').disabled = false;
      text('status', report.cases.length + '/18 complete. Tap for ' + spec.contextName + ' / ' + (spec.attributes ? 'minimal attributes' : 'default attributes') + '.');
      persist(); revealGestureButton();
    } else {
      var waitStarted = Date.now();
      function attemptAutomatic() {
        timer = null;
        if (stopped) return;
        var activation = window.navigator.userActivation;
        var active = activation && typeof activation.isActive === 'boolean' ? activation.isActive : Date.now() < automaticDelayUntil;
        if (!active) { run(spec, false); return; }
        if (Date.now() - waitStarted > 15000) {
          stopped = true; report.status = 'failed'; report.error = 'Automatic checks could not begin without active user input.';
          text('status', report.error + ' Reopen the page and leave it untouched after Start.'); el('stop').disabled = true; persist(); return;
        }
        text('status', 'Waiting for the Start tap to expire before automatic checks. Leave the page untouched.');
        timer = window.setTimeout(attemptAutomatic, 100);
      }
      timer = window.setTimeout(attemptAutomatic, 50);
    }
  }
  function run(spec, trusted) {
    if (busy || stopped) return;
    busy = true; report.status = 'running'; el('trusted-test').disabled = true;
    text('status', 'Running ' + spec.id + ' (' + (report.cases.length + 1) + '/18)…');
    cancel = core.runCase(spec, { container: el('probe-surface'), trustedGesture: trusted }, function (error, result) {
      busy = false; cancel = null;
      if (error) {
        stopped = true; report.status = 'failed'; report.error = bounded(error.message, 2048);
        text('status', 'Probe stopped: ' + report.error); el('stop').disabled = true; persist(); return;
      }
      report.cases.push(result);
      if (result.requiresReload) {
        stopped = true; report.status = 'reload-required'; el('stop').disabled = true;
        text('status', 'This context could not be fully released. Reload before the next check to keep only one live context.');
        persist(); reloadLink(); return;
      }
      if (stopped) { report.status = 'stopped'; persist(); return; }
      persist(); advance();
    });
  }
  function start() {
    if (!core || !config.revision) { text('status', 'Probe assets are incomplete. Rebuild the research bundle before measuring.'); return; }
    try {
      if (resumePending) {
        if (JSON.stringify(metadata()) !== JSON.stringify(report.metadata)) throw new Error('Retained results require the same confirmed system version, mode and opening.');
        resumePending = false; report.reloads += 1; report.provenance = { method: 'resumed-url', untrusted: true, submittedFrom: origin };
      } else report = createReport();
    } catch (error) { text('status', error.message); return; }
    stopped = false; automaticDelayUntil = Date.now() + 6000; el('start').disabled = true; el('stop').disabled = false;
    persist(); advance();
  }
  function reviewImport(raw, method) {
    try {
      imported = validateReport(raw, 'import');
      imported.provenance = { method: method, untrusted: true, submittedFrom: origin };
      el('import-section').hidden = false;
      text('import-summary', 'Claimed source: ' + imported.environment.origin + ' | revision ' + imported.probeRevision + ' | ' + imported.cases.length + '/18 cases | ' + imported.metadata.firmware + ' / ' + imported.metadata.mode + '. URL data is untrusted until you verify it.');
      el('results-json').value = JSON.stringify(imported, null, 2);
      el('submit-import').disabled = publicMode;
    } catch (error) { imported = null; el('import-section').hidden = true; text('status', 'Returned report rejected: ' + bounded(error.message, 300)); }
  }
  function reviewResume(raw) {
    if (report || busy) { text('status', 'Open a fresh copy of this page before resuming retained progress.'); return; }
    try {
      report = validateReport(raw, 'resume');
      resumePending = true;
      el('firmware').value = report.metadata.firmware; el('firmware-confirmed').checked = false; el('console-mode').value = report.metadata.mode; el('opening').value = String(report.metadata.opening);
      text('start', 'Continue retained checks');
      text('status', 'Review the ' + report.cases.length + ' retained cases and reconfirm the system version before continuing. The retained report is untrusted input.');
      display();
    } catch (error) { report = null; text('status', 'Resume rejected: ' + bounded(error.message, 300)); }
  }
  el('start').addEventListener('click', start);
  el('trusted-test').addEventListener('click', function (event) {
    if (!event.isTrusted) { text('status', 'Use a real tap or browser cursor click for this gesture check.'); return; }
    var spec = report && nextSpec();
    if (spec && spec.execution === 'trusted-tap') run(spec, true);
  });
  el('stop').addEventListener('click', function () {
    stopped = true; if (timer) window.clearTimeout(timer); timer = null;
    el('trusted-test').disabled = true; el('stop').disabled = true;
    text('status', 'Test stopped. Completed results are retained.');
    if (report) { report.status = 'stopped'; persist(); }
    if (cancel) cancel();
  });
  el('save-report').addEventListener('click', function () { if (failedSave) { pendingSave = failedSave; failedSave = null; flushSave(); } });
  el('lan-return').addEventListener('input', updateNavigation);
  el('lan-return').addEventListener('change', updateNavigation);
  el('review-import').addEventListener('click', function () { reviewImport(el('manual-import').value, 'manual-paste'); });
  el('review-resume').addEventListener('click', function () { reviewResume(el('manual-import').value); });
  el('submit-import').addEventListener('click', function () { if (imported && !publicMode) save(imported); });
  el('record-unreachable').addEventListener('click', function () {
    try { if (!report) report = createReport(); } catch (error) { text('status', error.message); return; }
    if (report.unreachable.length >= 6) { text('status', 'Six unreachable-origin observations are already retained.'); return; }
    report.unreachable.push({ target: el('unreachable-origin').value, observedAt: new Date().toISOString(), reportedByUser: true });
    if (!report.cases.length) report.status = 'unreachable'; persist();
    text('status', 'Origin recorded as unreachable. No WebGL result was inferred.');
  });
  window.addEventListener('pagehide', function () { stopped = true; if (timer) window.clearTimeout(timer); if (cancel) cancel(); });
  el('library-link').hidden = publicMode;
  el('save-report').hidden = publicMode;
  el('review-import').hidden = publicMode;
  text('environment', 'Revision: ' + bounded(config.revision || 'missing', 128) + ' | ' + origin + ' | secure context: ' + (typeof window.isSecureContext !== 'boolean' ? 'unknown' : (window.isSecureContext ? 'yes' : 'no')) + ' | ' + bounded(window.navigator.userAgent, 2048));
  var initialReturn = returnURL(origin + PAGE) || returnURL(String(config.lanOrigin || '') + PAGE);
  if (initialReturn) el('lan-return').value = initialReturn;
  var hash = window.location.hash.slice(1);
  if (hash.length > MAX_LINK) text('status', 'The URL fragment exceeds the limit. Paste the complete report instead.');
  else if (hash.indexOf('return=') === 0) {
    try { var candidate = returnURL(decodeURIComponent(hash.slice(7))); if (candidate) el('lan-return').value = candidate; else text('status', 'Invalid return address ignored. Use a private HTTP LAN page.'); } catch (ignoreReturn) { text('status', 'Unreadable return address ignored.'); }
  } else if (hash.indexOf('report=') === 0 && !publicMode) {
    try { reviewImport(decodeURIComponent(hash.slice(7)), 'url-fragment'); } catch (ignoreImport) { text('status', 'Unreadable returned report ignored.'); }
  } else if (hash.indexOf('resume=') === 0) {
    try {
      var resumeParts = hash.slice(7).split('&return=');
      if (resumeParts.length === 2) { var resumeReturn = returnURL(decodeURIComponent(resumeParts[1])); if (resumeReturn) el('lan-return').value = resumeReturn; }
      reviewResume(decodeURIComponent(resumeParts[0]));
    } catch (error) { report = null; text('status', 'Resume rejected: ' + bounded(error.message, 300)); }
  }
  updateNavigation();
}(window, document));
