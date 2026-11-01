'use strict';
/* Hello MicroDesk — front-end logic. ES5 only: it must run in old browsers too. */

(function () {
  var out = document.getElementById('out');
  var statusEl = document.getElementById('status');
  var nodeEl = document.getElementById('node');

  function show(label, value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    out.textContent = '› ' + label + '\n' + text;
  }

  function fail(err) {
    out.textContent = '× ' + (err && err.message ? err.message : String(err));
    out.className = 'err';
  }

  var md = MicroDesk.connect({ reconnect: true });

  md.on('open', function () {
    statusEl.textContent = 'connected';
    statusEl.className = 'on';
  });

  md.on('close', function () {
    statusEl.textContent = 'disconnected';
    statusEl.className = 'off';
  });

  // app.tick is pushed by the host every 2s (see server.js: tickMs).
  md.on('app.tick', function (data) {
    nodeEl.textContent = 'uptime ' + Math.round(data.uptimeMs / 1000) + 's · mem ' + data.memFree;
  });

  md.sys.info().then(function (info) {
    nodeEl.textContent = info.node;
  })['catch'](function () { /* host may still be warming up */ });

  document.getElementById('btn-greet').onclick = function () {
    md.host.greeting('MicroDesk').then(function (r) { show('host.greeting()', r); })['catch'](fail);
  };

  document.getElementById('btn-info').onclick = function () {
    md.sys.info().then(function (r) { show('sys.info()', r); })['catch'](fail);
  };

  document.getElementById('btn-file').onclick = function () {
    var file = 'hello-' + Date.now() + '.txt';
    var body = 'written by the page at ' + new Date().toISOString();
    md.fs.writeFile(file, body)
      .then(function () { return md.fs.readFile(file, 'utf8'); })
      .then(function (text) { show('fs.writeFile + readFile → ' + file, text); })
      ['catch'](fail);
  };
})();
