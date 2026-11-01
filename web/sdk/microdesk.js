/*!
 * MicroDesk SDK v0.1.0 — browser side of md_bridge.
 * No build step, no dependencies. Drop this in and you can call Node.js.
 *
 *   const md = MicroDesk.connect();
 *   await md.call('fs.readFile', 'C:/Windows/win.ini', 'utf8');
 *   await md.fs.readdir('.');
 *   md.on('app.tick', (data) => ...);
 *
 * Wire format (one JSON object per WebSocket text frame):
 *   -> { "id": 1, "method": "fs.readFile", "params": ["a.txt", "utf8"] }
 *   <- { "id": 1, "result": "..." }
 *   <- { "id": 1, "error": { "code": "ENOENT", "message": "..." } }
 *   <- { "event": "app.tick", "data": { ... } }        // server push
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    url: null, // derived from location
    path: '/ws',
    timeout: 30000,
    reconnect: true,
    reconnectDelay: 500,
    reconnectMax: 10000
  };

  function nowIso() {
    return new Date().toISOString().replace('T', ' ').slice(0, 23);
  }

  function RpcError(code, message, data) {
    var err = new Error(message || code);
    err.name = 'MicroDeskRpcError';
    err.code = code;
    err.data = data;
    err.isRpcError = true;
    return err;
  }

  function Client(options) {
    var opts = {};
    for (var k in DEFAULTS) opts[k] = DEFAULTS[k];
    for (var k2 in options || {}) opts[k2] = options[k2];

    this.options = opts;
    this.url =
      opts.url ||
      (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + opts.path;
    this.seq = 0;
    this.pending = Object.create(null);
    this.listeners = Object.create(null);
    this.state = 'idle';
    this.lastError = null;
    this._attempt = 0;
    this.socket = null;
    this._connectPromise = null;

    // Stable per-tab identity, handy on the Node side for logging.
    try {
      this.clientId =
        sessionStorage.getItem('microdesk.clientId') ||
        (function () {
          var id = 'c_' + Math.random().toString(36).slice(2, 10);
          sessionStorage.setItem('microdesk.clientId', id);
          return id;
        })();
    } catch (_) {
      this.clientId = 'c_' + Math.random().toString(36).slice(2, 10);
    }

    if (opts.autoConnect !== false) this.connect().catch(function () {});
  }

  Client.prototype._emit = function (name, payload) {
    var list = this.listeners[name];
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error('[microdesk] listener error for "' + name + '"', err);
      }
    }
  };

  Client.prototype.on = function (name, fn) {
    (this.listeners[name] || (this.listeners[name] = [])).push(fn);
    return this;
  };

  Client.prototype.off = function (name, fn) {
    var list = this.listeners[name];
    if (!list) return this;
    this.listeners[name] = fn ? list.filter(function (f) { return f !== fn; }) : [];
    return this;
  };

  Client.prototype.connect = function () {
    var self = this;
    if (this.state === 'open') return Promise.resolve(this);
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = new Promise(function (resolve, reject) {
      var socket;
      try {
        socket = new WebSocket(self.url);
      } catch (err) {
        self._connectPromise = null;
        self.state = 'error';
        return reject(err);
      }
      self.socket = socket;
      self.state = 'connecting';

      var settled = false;

      socket.onopen = function () {
        settled = true;
        self.state = 'open';
        self._attempt = 0;
        self._connectPromise = null;
        self._emit('open', { url: self.url });
        // Announce ourselves; the host may use this to configure capabilities.
        self.callRaw('app.hello', [{ clientId: self.clientId, ua: navigator.userAgent }]).catch(
          function () {}
        );
        resolve(self);
      };

      socket.onmessage = function (event) {
        self._onMessage(event.data);
      };

      socket.onerror = function () {
        self.lastError = 'websocket error';
        if (!settled) {
          settled = true;
          self.state = 'error';
          self._connectPromise = null;
          reject(new Error('MicroDesk bridge: cannot open ' + self.url));
        }
        self._emit('error', { message: self.lastError });
      };

      socket.onclose = function (event) {
        var wasOpen = self.state === 'open';
        self.state = 'closed';
        self._connectPromise = null;
        // Fail every in-flight call: they will never be answered.
        Object.keys(self.pending).forEach(function (id) {
          var req = self.pending[id];
          delete self.pending[id];
          clearTimeout(req.timer);
          req.reject(RpcError('EDISCONNECTED', 'bridge closed before reply'));
        });
        self._emit('close', { code: event && event.code, wasOpen: wasOpen });
        if (self.options.reconnect) self._scheduleReconnect();
      };
    });

    return this._connectPromise;
  };

  Client.prototype._scheduleReconnect = function () {
    var self = this;
    if (this._reconnectTimer) return;
    var delay = Math.min(
      this.options.reconnectDelay * Math.pow(1.6, this._attempt++),
      this.options.reconnectMax
    );
    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      self.connect().catch(function () {});
    }, delay);
  };

  Client.prototype._onMessage = function (raw) {
    var msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      console.warn('[microdesk] non-JSON frame from host', raw);
      return;
    }

    if (msg.event) {
      this._emit(msg.event, msg.data);
      this._emit('*', msg);
      return;
    }

    if (msg.id !== undefined && msg.id !== null) {
      var req = this.pending[msg.id];
      if (!req) return; // late reply after timeout: drop
      delete this.pending[msg.id];
      clearTimeout(req.timer);
      if (msg.error) {
        req.reject(
          RpcError(
            msg.error.code || 'ERPC',
            msg.error.message || 'RPC failed',
            msg.error.data
          )
        );
      } else {
        req.resolve(msg.result);
      }
    }
  };

  Client.prototype.callRaw = function (method, params) {
    var self = this;
    return this.connect().then(function () {
      return new Promise(function (resolve, reject) {
        var id = ++self.seq;
        var timer = setTimeout(function () {
          delete self.pending[id];
          reject(RpcError('ETIMEDOUT', method + ' timed out after ' + self.options.timeout + 'ms'));
        }, self.options.timeout);

        self.pending[id] = { resolve: resolve, reject: reject, timer: timer, method: method };
        self._emit('sent', { id: id, method: method, params: params });

        try {
          self.socket.send(JSON.stringify({ id: id, method: method, params: params || [] }));
        } catch (err) {
          delete self.pending[id];
          clearTimeout(timer);
          reject(RpcError('ESENDFAILED', err.message));
        }
      });
    });
  };

  /**
   * call('fs.readFile', path, encoding)  OR  call('fs.readFile', [path, encoding])
   */
  Client.prototype.call = function (method, params) {
    var list;
    if (arguments.length <= 1) list = [];
    else if (arguments.length === 2 && Array.isArray(params)) list = params;
    else list = Array.prototype.slice.call(arguments, 1);
    return this.callRaw(method, list);
  };

  /**
   * Namespaced sugar: md.fs.readFile(...) === md.call('fs.readFile', ...)
   * Implemented with a Proxy when available, and a plain scan of the manifest
   * otherwise (so old browsers still work — this is a Win7-era framework).
   */
  Client.prototype.ns = function (namespace) {
    var self = this;
    if (typeof Proxy === 'function') {
      return new Proxy(
        {},
        {
          get: function (_target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop === 'then') return undefined; // keep promise-assimilation away
            return function () {
              return self.call(namespace + '.' + prop, Array.prototype.slice.call(arguments));
            };
          }
        }
      );
    }
    var obj = {};
    (self.knownMethods || []).forEach(function (m) {
      if (m.indexOf(namespace + '.') !== 0) return;
      var short = m.slice(namespace.length + 1);
      obj[short] = function () {
        return self.call(m, Array.prototype.slice.call(arguments));
      };
    });
    return obj;
  };

  Client.prototype.close = function () {
    this.options.reconnect = false;
    if (this.socket) {
      try {
        this.socket.close(1000, 'client closed');
      } catch (_) {}
    }
  };

  /* ------------------------------------------------------------------ */
  /* convenience helpers                                                */
  /* ------------------------------------------------------------------ */

  Client.prototype.info = function () {
    return this.callRaw('app.info', []);
  };

  Client.prototype.ping = function () {
    var started = (typeof performance !== 'undefined' && performance.now) || Date.now();
    return this.callRaw('app.ping', []).then(function (r) {
      var end = (typeof performance !== 'undefined' && performance.now) || Date.now();
      return { roundtrip: Math.round(end - started), reply: r };
    });
  };

  function connect(options) {
    return new Client(options);
  }

  var api = {
    connect: connect,
    Client: Client,
    version: '0.1.0',
    now: nowIso
  };

  global.MicroDesk = api;
  // Lazily-created default instance so `microdesk.call(...)` works out of the box.
  Object.defineProperty(api, 'default', {
    get: function () {
      if (!api._default) api._default = connect();
      return api._default;
    }
  });
})(typeof window !== 'undefined' ? window : this);
