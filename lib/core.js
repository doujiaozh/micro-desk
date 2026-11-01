'use strict';
/**
 * MicroDesk :: core  (md_core)
 * ---------------------------------------------------------------------------
 * The micro-kernel. One local HTTP server that does exactly three jobs:
 *
 *   1. Serve the front-end bundle (HTML/CSS/JS) from disk or from an in-memory
 *      asset map (used by the single-file pack).
 *   2. Own the WebSocket endpoint that carries the RPC bridge (md_bridge).
 *   3. Expose a tiny JSON control endpoint (/__microdesk/*) for health checks
 *      and for the launcher to wait until the app is really ready.
 *
 * No Express, no Koa, no dependencies. `http` + `fs` + the hand-rolled ws
 * implementation in ./websocket.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ws = require('./websocket');
const mime = require('./mime');
const util = require('./util');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 0; // 0 => let the OS pick a free port (never fight with other apps)
const VERSION = require('../package.json').version;

function log(scope, ...args) {
  console.log('[microdesk:' + scope + ']', ...args);
}

/**
 * Resolve a request path inside root, refusing anything that escapes it.
 * Returns null on traversal attempts.
 */
function safeJoin(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {
    return null;
  }
  // Kill null bytes and Windows alternate data streams.
  if (decoded.indexOf('\0') !== -1) return null;

  const clean = decoded.replace(/\\/g, '/').replace(/\/+/g, '/');
  const normalized = path.posix.normalize(clean);
  if (normalized.indexOf('..') !== -1) return null;

  const abs = path.join(root, normalized);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function etagFor(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
}

class Core {
  constructor(options) {
    const opts = options || {};
    this.options = opts;
    this.host = opts.host || DEFAULT_HOST;
    this.port = opts.port === undefined ? DEFAULT_PORT : opts.port;
    this.root = path.resolve(opts.root || path.join(__dirname, '..', 'web'));
    this.assets = opts.assets || null; // Map<string, Buffer> for packed mode
    this.manifest = Object.assign(
      { name: 'MicroDesk App', version: VERSION, framework: 'microdesk' },
      opts.manifest || {}
    );
    this.bridge = opts.bridge || null;
    this.startedAt = 0;
    this.requestCount = 0;

    this.server = http.createServer((req, res) => this._onRequest(req, res));
    this.server.on('clientError', (err, socket) => {
      if (socket && socket.writable) socket.destroy();
    });

    this.wss = ws.attach(this.server, {
      path: '/ws',
      heartbeatMs: opts.heartbeatMs || 15000,
      onConnection: (conn) => {
        if (this.bridge) this.bridge.attach(conn);
        if (typeof opts.onConnection === 'function') opts.onConnection(conn);
      }
    });
  }

  get url() {
    return 'http://' + this.host + ':' + this.port + '/';
  }

  listen() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.port;
        this.startedAt = Date.now();
        log('core', 'listening on ' + this.url);
        resolve(this);
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, this.host);
    });
  }

  close() {
    return new Promise((resolve) => {
      if (this.bridge) this.bridge.detachAll();
      this.wss.close();
      try {
        this.server.close(() => resolve());
      } catch (_) {
        resolve();
      }
      // Don't let lingering keep-alive sockets block shutdown.
      if (typeof this.server.closeAllConnections === 'function') {
        setTimeout(() => {
          try {
            this.server.closeAllConnections();
          } catch (_) {
            /* ignore */
          }
        }, 200).unref();
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* routing                                                            */
  /* ------------------------------------------------------------------ */

  _onRequest(req, res) {
    this.requestCount++;
    const started = Date.now();
    res.on('finish', () => {
      if (this.options.verbose) {
        log('http', req.method, req.url, res.statusCode, Date.now() - started + 'ms');
      }
    });

    let parsed;
    try {
      parsed = new URL(req.url, this.url);
    } catch (_) {
      return this._send(res, 400, 'Bad Request');
    }
    const pathname = parsed.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      // handled by static layer below
    }

    // --- control plane -------------------------------------------------
    if (pathname.indexOf('/__microdesk/') === 0) {
      return this._onControl(req, res, pathname, parsed);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return this._sendJson(res, 405, { error: 'method_not_allowed', method: req.method });
    }

    return this._serveStatic(req, res, pathname);
  }

  _onControl(req, res, pathname, parsed) {
    const action = pathname.slice('/__microdesk/'.length).replace(/\/$/, '');

    if (action === 'health') {
      return this._sendJson(res, 200, {
        ok: true,
        app: this.manifest.name,
        version: VERSION,
        pid: process.pid,
        uptime: Date.now() - this.startedAt,
        clients: this.wss.connections.size,
        requests: this.requestCount,
        node: process.version,
        platform: process.platform + '/' + process.arch,
        hostname: util.hostname()
      });
    }

    if (action === 'manifest') {
      const methods = this.bridge ? this.bridge.listMethods() : [];
      return this._sendJson(res, 200, {
        manifest: this.manifest,
        framework: { name: 'MicroDesk', version: VERSION },
        rpc: { transport: 'websocket', path: '/ws', methods: methods }
      });
    }

    if (action === 'shutdown' && req.method === 'POST') {
      this._sendJson(res, 200, { ok: true, shuttingDown: true });
      log('core', 'shutdown requested over control endpoint');
      setImmediate(() => {
        if (typeof this.options.onShutdown === 'function') this.options.onShutdown();
      });
      return;
    }

    return this._sendJson(res, 404, { error: 'unknown_control_endpoint', path: pathname });
  }

  /* ------------------------------------------------------------------ */
  /* static files                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The browser SDK is part of the framework, not of the app: serve it even
   * when the app's own web root does not contain a copy of it.
   */
  _frameworkAsset(key) {
    if (key !== 'sdk/microdesk.js') return null;
    if (!this._sdkBody) {
      const sdkFile = path.join(__dirname, '..', 'web', 'sdk', 'microdesk.js');
      try {
        this._sdkBody = fs.readFileSync(sdkFile);
      } catch (_) {
        return null;
      }
    }
    return { body: this._sdkBody, type: 'application/javascript; charset=utf-8' };
  }

  _readAsset(pathname) {
    const key = pathname.replace(/^\/+/, '') || 'index.html';

    // 1) in-memory (packed apps)
    if (this.assets) {
      if (this.assets.has(key)) {
        const entry = this.assets.get(key);
        return {
          body: Buffer.isBuffer(entry) ? entry : Buffer.from(entry.body, 'utf8'),
          type: entry.type || mime.lookup(path.extname(key))
        };
      }
    }

    // 2) framework-level assets (/sdk/microdesk.js)
    const framework = this._frameworkAsset(key);
    if (framework) return framework;

    // 3) on disk
    const abs = safeJoin(this.root, pathname);
    if (!abs) return { forbidden: true };

    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (_) {
      return null;
    }
    if (stat.isDirectory()) {
      const indexFile = path.join(abs, 'index.html');
      try {
        const body = fs.readFileSync(indexFile);
        return { body, type: mime.lookup('.html'), mtime: fs.statSync(indexFile).mtimeMs };
      } catch (_) {
        return null;
      }
    }
    try {
      const body = fs.readFileSync(abs);
      return { body, type: mime.lookup(path.extname(abs)), mtime: stat.mtimeMs };
    } catch (_) {
      return null;
    }
  }

  _serveStatic(req, res, pathname) {
    let asset = this._readAsset(pathname);

    if (asset && asset.forbidden) {
      return this._send(res, 403, 'Forbidden');
    }

    // SPA fallback: unknown *route* (no file extension) falls back to index.html
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(pathname);
    if (!asset && !looksLikeFile && pathname !== '/') {
      asset = this._readAsset('/index.html');
      if (asset) res.setHeader('X-MicroDesk-Fallback', 'spa');
    }
    if (!asset) {
      return this._send(res, 404, 'Not Found: ' + pathname);
    }

    const tag = etagFor(asset.body);
    res.setHeader('ETag', tag);
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Content-Length', String(asset.body.length));
    // Local app assets must never be cached by a *remote* proxy; in dev the
    // browser should revalidate so "edit -> reload" works.
    res.setHeader(
      'Cache-Control',
      this.options.dev ? 'no-cache' : 'private, max-age=0, must-revalidate'
    );
    res.setHeader('X-Powered-By', 'MicroDesk/' + VERSION);

    if (req.headers['if-none-match'] === tag) {
      res.statusCode = 304;
      return res.end();
    }

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      return res.end();
    }

    res.statusCode = 200;
    res.end(asset.body);
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */

  _send(res, status, text) {
    const body = Buffer.from(String(text), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': body.length,
      'X-Powered-By': 'MicroDesk/' + VERSION
    });
    res.end(body);
  }

  _sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Powered-By': 'MicroDesk/' + VERSION
    });
    res.end(body);
  }
}

function createCore(options) {
  return new Core(options);
}

module.exports = { createCore, Core, safeJoin, VERSION, log };
