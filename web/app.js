/* MicroDesk workbench — front-end logic (plain ES5+ so it runs on old Chromium). */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var logEl = $('log');
  var resultEl = $('rpc-result');
  var methodEl = $('rpc-method');
  var paramsEl = $('rpc-params');
  var dotEl = $('link-dot');
  var linkTextEl = $('link-text');
  var nodeInfoEl = $('node-info');
  var sysEl = $('sys-info');
  var appNameEl = $('app-name');
  var uptimeEl = $('uptime');

  var startedAt = Date.now();

  function log(kind, text) {
    var line = document.createElement('div');
    var stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    line.innerHTML =
      '<span class="t">' + stamp + '</span> ' +
      '<span class="' + kind + '">' + String(text).replace(/</g, '&lt;') + '</span>';
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setLink(online) {
    dotEl.className = 'dot ' + (online ? 'on' : 'off');
    linkTextEl.textContent = online ? 'bridge connected' : 'bridge offline';
  }

  function setResult(text, cls) {
    resultEl.className = 'result mono ' + (cls || '');
    resultEl.textContent = text;
  }

  function fmt(value) {
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  /* ------------------------------------------------------------------ */

  var md = MicroDesk.connect({
    timeout: 20000,
    reconnect: true
  });

  md.on('open', function () {
    setLink(true);
    log('evt', 'bridge open -> ' + md.url);
    refreshManifest();
    refreshSystem();
  });

  md.on('close', function () {
    setLink(false);
    log('err', 'bridge closed (host gone?)');
  });

  md.on('sent', function (req) {
    log('in', '→ ' + req.method + ' #' + req.id);
  });

  md.on('*', function (msg) {
    if (msg.event && msg.event !== 'log') log('evt', 'event: ' + msg.event + ' ' + fmt(msg.data));
  });

  md.on('log', function (data) {
    log('evt', 'host log: ' + fmt(data));
  });

  /* ---------------- manifest / methods ---------------- */

  function refreshManifest() {
    fetch('/__microdesk/manifest')
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        window.__microdeskManifest = data;
        md.knownMethods = data.rpc.methods || [];

        var preferred = [
          'sys.info',
          'app.ping',
          'fs.list',
          'fs.readFile',
          'fs.writeFile',
          'fs.exists',
          'sys.exec',
          'sys.openPath',
          'app.info'
        ];
        var methods = md.knownMethods.slice().sort(function (a, b) {
          var ia = preferred.indexOf(a);
          var ib = preferred.indexOf(b);
          if (ia === -1 && ib === -1) return a < b ? -1 : 1;
          if (ia === -1) return 1;
          if (ib === -1) return -1;
          return ia - ib;
        });

        methodEl.innerHTML = '';
        methods.forEach(function (m) {
          var opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          methodEl.appendChild(opt);
        });

        var name = (data.manifest && data.manifest.name) || 'MicroDesk';
        appNameEl.textContent = name;
        document.title = name + ' — MicroDesk';
        log('evt', 'manifest: ' + methods.length + ' rpc methods, framework ' + data.framework.version);
      })
      .catch(function (err) {
        // The manifest endpoint is optional: without it, type methods by hand.
        log('err', 'manifest fetch failed: ' + err.message);
      });
  }

  /* ---------------- system panel ---------------- */

  function refreshSystem() {
    md.call('sys.info')
      .then(function (info) {
        nodeInfoEl.textContent = 'node ' + info.node;
        var rows = [
          ['平台 platform', info.platform + ' / ' + info.arch],
          ['操作系统 OS', info.os],
          ['CPU', info.cpus + ' cores'],
          ['内存 memory', info.memTotal],
          ['Node', info.node + '  (' + info.execPath + ')'],
          ['进程 PID', info.pid],
          ['工作目录 cwd', info.cwd],
          ['主机 host', info.hostname],
          ['运行时长 uptime', info.uptime]
        ];
        sysEl.innerHTML = rows
          .map(function (r) {
            return '<li><span>' + r[0] + '</span><b title="' + String(r[1]).replace(/"/g, '&quot;') + '">' + r[1] + '</b></li>';
          })
          .join('');
      })
      .catch(function (err) {
        sysEl.innerHTML = '<li><span>错误</span><b>' + err.message + '</b></li>';
      });
  }

  /* ---------------- rpc runner ---------------- */

  function runRpc() {
    var method = methodEl.value;
    var raw = paramsEl.value.trim() || '[]';
    var params;
    try {
      params = JSON.parse(raw);
      if (!Array.isArray(params)) params = [params];
    } catch (err) {
      setResult('参数不是合法 JSON：\n' + err.message, 'err');
      return;
    }

    setResult('// 调用中 ' + method + ' …');
    log('in', 'call ' + method + '(' + params.map(fmt).join(', ') + ')');

    md.call(method, params)
      .then(function (res) {
        setResult(fmt(res), 'ok');
        log('out', '← ' + method + ' ok');
      })
      .catch(function (err) {
        setResult('[error] ' + err.code + ': ' + err.message, 'err');
        log('err', '← ' + method + ' failed: ' + err.message);
      });
  }

  /* ---------------- events ---------------- */

  $('rpc-run').addEventListener('click', runRpc);

  methodEl.addEventListener('change', function () {
    var presets = {
      'sys.info': '[]',
      'app.ping': '[]',
      'app.info': '[]',
      'fs.list': '["."]',
      'fs.readFile': '["package.json", "utf8"]',
      'fs.exists': '["package.json"]',
      'fs.writeFile': '["demo-output.txt", "hello from the browser"]',
      'sys.exec': '["node", ["-v"]]',
      'sys.openPath': '["."]'
    };
    if (presets[methodEl.value]) paramsEl.value = presets[methodEl.value];
  });

  $('ping-btn').addEventListener('click', function () {
    var text = $('ping-input').value;
    md.call('app.echo', text)
      .then(function (res) {
        setResult(fmt(res), 'ok');
      })
      .catch(function (err) {
        setResult('[error] ' + err.message, 'err');
      });
  });

  $('ping-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('ping-btn').click();
  });

  /* ---------------- uptime ticker ---------------- */

  setInterval(function () {
    var s = Math.floor((Date.now() - startedAt) / 1000);
    var mm = String(Math.floor(s / 60)).padStart(2, '0');
    var ss = String(s % 60).padStart(2, '0');
    uptimeEl.textContent = 'session ' + mm + ':' + ss;
  }, 1000);

  log('evt', 'workbench booted, clientId=' + md.clientId);
})();
