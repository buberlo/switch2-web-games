'use strict';
// The explicit compatibility mode is also used by the real-browser test suite.
if (self.location.search.indexOf('compat=1') >= 0) self.WebAssembly = undefined;
var host;
self.onmessage = function (event) {
  var data = event.data;
  try {
    if (data.action === 'init') {
      importScripts('/engine/DiabloSpawn.js', '/js/diablo-host.js');
      host = self.createDiabloHost(function (message, transfer) { self.postMessage(message, transfer); });
      host.init(data);
    } else if (host && data.action === 'event') host.event(data.name, data.args, data.id, data.sentAt);
    else if (host && data.action === 'rendered') host.acknowledge(data.sequence, data.buffer);
    else if (host && data.action === 'pause') host.pause(data.value);
    else if (host && data.action === 'stop') host.stop();
  } catch (error) { self.postMessage({action:'error',message:String(error && error.message || error)}); }
};
self.postMessage({action:'ready', wasmAvailable:typeof self.WebAssembly !== 'undefined'});
