/* Classic worker, deliberately without module or WebAssembly requirements. */
self.onmessage = function (event) {
  if (!event.data || event.data.type !== 'portal-probe') return;
  self.postMessage({
    type: 'portal-probe-result',
    id: event.data.id,
    webAssemblyGlobal: typeof WebAssembly !== 'undefined',
    arrayBuffer: typeof ArrayBuffer !== 'undefined'
  });
};
