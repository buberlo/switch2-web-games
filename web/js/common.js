(function (window) {
  'use strict';

  var sessionPromise = null;

  function xhr(path, options, token) {
    return new Promise(function (resolve, reject) {
      var request = new XMLHttpRequest();
      var method = options.method || 'GET';
      request.open(method, path, true);
      request.timeout = options.timeout || 12000;
      request.setRequestHeader('Accept', 'application/json');
      if (token) request.setRequestHeader('X-Portal-Token', token);
      if (options.body !== undefined) request.setRequestHeader('Content-Type', 'application/json');
      request.onload = function () {
        var data = {};
        try {
          data = request.responseText ? JSON.parse(request.responseText) : {};
        } catch (error) {
          reject(new Error('The Mac returned an unreadable response.'));
          return;
        }
        if (request.status < 200 || request.status >= 300) {
          var failure = new Error(data.error || ('Request failed (' + request.status + ').'));
          failure.status = request.status;
          reject(failure);
          return;
        }
        resolve(data);
      };
      request.onerror = function () { reject(new Error('Cannot reach the Mac. Check its server and Wi-Fi connection.')); };
      request.ontimeout = function () { reject(new Error('The Mac did not respond in time. Try again.')); };
      request.onabort = function () { reject(new Error('The request was interrupted.')); };
      request.send(options.body === undefined ? null : JSON.stringify(options.body));
    });
  }

  function session() {
    if (!sessionPromise) {
      sessionPromise = xhr('/api/session', {}, null).then(function (data) {
        if (typeof data.token !== 'string' || !data.token) throw new Error('The Mac did not provide a session token.');
        return data.token;
      }).then(null, function (error) {
        sessionPromise = null;
        throw error;
      });
    }
    return sessionPromise;
  }

  function request(path, options) {
    options = options || {};
    if (typeof path !== 'string' || path.indexOf('/api/') !== 0) {
      return Promise.reject(new Error('Portal requests must use a local API path.'));
    }
    var method = (options.method || 'GET').toUpperCase();
    options.method = method;
    if (method === 'GET' || method === 'HEAD') return xhr(path, options, null);
    function send(retry) {
      return session().then(function (token) {
        return xhr(path, options, token);
      }).then(null, function (error) {
        if (retry && (error.status === 401 || error.status === 403)) {
          sessionPromise = null;
          return send(false);
        }
        throw error;
      });
    }
    return send(true);
  }

  window.Portal = {
    session: session,
    request: request,
    report: function (snapshot) {
      return request('/api/diagnostics', { method: 'POST', body: snapshot });
    }
  };

  function updateLanding() {
    var status = document.getElementById('installation-status');
    if (!status) return;
    request('/api/status').then(function (data) {
      var ready = data.engineReady === true && data.dataReady === true;
      status.className = 'status-pill ' + (ready ? 'status-ready' : 'status-pending');
      status.textContent = ready ? 'Installed on your Mac' : 'Setup in progress';
      var detail = document.getElementById('installation-detail');
      if (detail) detail.textContent = ready
        ? 'The engine and shareware data are ready to load.'
        : 'The game opens once its engine and shareware data are prepared on the Mac.';
    }).then(null, function (error) {
      status.className = 'status-pill status-failed';
      status.textContent = 'Mac connection unavailable';
      document.getElementById('installation-detail').textContent = error.message;
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateLanding);
  else updateLanding();
}(window));
