'use strict';
/**
 * MicroDesk :: bridge  (md_bridge)
 * ---------------------------------------------------------------------------
 * The RPC bus between the browser UI and the Node.js host.
 *
 *   browser                                   node
 *   ───────                                   ────
 *   {id:1, method:'fs.readFile', params:[...]}  ──►  dispatch → handler
 *   {id:1, result:'...'}                        ◄──  reply
 *   {id:1, error:{code,message}}                ◄──  reply (rejected promise)
 *   {event:'app.tick', data:{...}}              ◄──  server push
 *
 * Design notes
 *  - Every handler returns a value or a Promise; the client always gets a
 *    Promise. That is the whole "IPC like Electron, minus Electron" trick.
 *  - Errors are normalised into { code, message, data } so the browser never
 *    receives a stack trace or a raw object it cannot serialise.
 *  - Permissions are explicit: methods are gated by `permissions` so a page
 *    loaded from disk can't silently `rm -rf` the machine.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const EventEmitter = require('events');
const util = require('./util');

const VERSION = require('../package.json').version;

/* ------------------------------------------------------------------ */
/* errors                                                             */
/* ------------------------------------------------------------------ */

class RpcError extends Error {
  constructor(code, message, data) {
    super(message || code);
    this.name = 'RpcError';
    this.code = code || 'ERPC';
    this.data = data;
  }
}

function normaliseError(err) {
  if (err instanceof RpcError) {
    return { code: err.code, message: err.message, data: err.data };
  }
  const code = (err && (err.code || err.name)) || 'EUNKNOWN';
  return {
    code: String(code),
    message: (err && err.message) || String(err),
    data: err && err.errno !== undefined ? { errno: err.errno, syscall: err.syscall } : undefined
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return Math.round(v * 10) / 10 + ' ' + units[i];
}

function humanUptime(sec) {
  const s = Math.floor(Number(sec) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + h + 'h ' + m + 'm';
  if (h) return h + 'h ' + m + 'm';
  return m + 'm ' + (s % 60) + 's';
}

/**
 * Resolve a user-supplied path. With `root` set, anything outside it is
 * rejected (this is the opt-in sandbox for third-party UI bundles).
 */
function resolvePath(target, root) {
  if (typeof target !== 'string' || !target.length) {
    throw new RpcError('EINVAL', 'path must be a non-empty string');
  }
  const unquoted = target.replace(/^"|"$/g, '');
  const abs = path.isAbsolute(unquoted) ? unquoted : path.resolve(process.cwd(), unquoted);
  if (!root) return abs;
  const rootAbs = path.resolve(root);
  const rel = path.relative(rootAbs, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new RpcError('EACCES', 'path escapes the sandbox root: ' + abs, { root: rootAbs });
  }
  return abs;
}

/* ------------------------------------------------------------------ */
/* method registry                                                    */
/* ------------------------------------------------------------------ */

class Bridge extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.options = opts;
    this.appId = opts.appId || 'microdesk-app';
    this.rendererRoot = opts.rendererRoot || null; // optional fs sandbox
    this.permissions = Object.assign(
      {
        fs: true, // file system access
        exec: true, // run child processes
        open: true, // open paths / urls with the OS shell
        env: true // read environment variables
      },
      opts.permissions || {}
    );

    this.maxReadBytes = opts.maxReadBytes || 16 * 1024 * 1024;
    this.maxWriteBytes = opts.maxWriteBytes || 16 * 1024 * 1024;
    this.execTimeout = opts.execTimeout || 15000;
    this.connections = new Set();
    this.devMode = false;
    this.startedAt = Date.now();
    this.calls = 0;

    this.methods = new Map();
    this._registerCoreMethods();
    if (typeof opts.extend === 'function') opts.extend(this);
    if (opts.methods && typeof opts.methods === 'object') {
      Object.keys(opts.methods).forEach((name) => {
        this.define(name, opts.methods[name]);
      });
    }

    // Optional demo heartbeat: proves that the bridge is bidirectional
    // (server -> browser push), not just request/response.
    const tickMs = Number(opts.tickMs || 0);
    if (tickMs > 0) {
      this._tick = setInterval(() => {
        if (this.connections.size) {
          this.broadcast('app.tick', {
            at: new Date().toISOString(),
            uptimeMs: Date.now() - this.startedAt,
            clients: this.connections.size,
            memFree: humanBytes(util.freemem())
          });
        }
      }, tickMs);
      if (this._tick.unref) this._tick.unref();
    }
  }

  /* ---------------- registry ---------------- */

  define(name, fn, meta) {
    if (typeof fn !== 'function') throw new TypeError('handler for ' + name + ' must be a function');
    this.methods.set(name, { fn, meta: meta || {} });
    return this;
  }

  listMethods() {
    return Array.from(this.methods.keys()).sort();
  }

  setDevMode(on) {
    this.devMode = !!on;
  }

  _perm(key) {
    if (!this.permissions[key]) {
      throw new RpcError('EPERM', 'permission "' + key + '" is disabled in microdesk.config.json');
    }
  }

  /* ---------------- connection lifecycle ---------------- */

  attach(conn) {
    const self = this;
    this.connections.add(conn);
    this.emit('client:open', conn.id);

    conn.on('message', (raw, isBinary) => {
      if (isBinary) {
        conn.json({ event: 'bridge.error', data: { message: 'binary frames are not supported' } });
        return;
      }
      self._onMessage(conn, raw);
    });

    conn.on('close', () => {
      this.connections.delete(conn);
      this.emit('client:close', conn.id);
    });

    // Tell the page we're here, and what it may call.
    conn.json({
      event: 'bridge.ready',
      data: {
        framework: 'MicroDesk',
        version: VERSION,
        appId: this.appId,
        methods: this.listMethods(),
        permissions: this.permissions
      }
    });
  }

  detachAll() {
    this.connections.forEach((c) => c.close(1001, 'bridge shutting down'));
    this.connections.clear();
  }

  broadcast(event, data) {
    const frame = JSON.stringify({ event: event, data: data });
    let n = 0;
    this.connections.forEach((c) => {
      if (c.isAlive && c.send(frame)) n++;
    });
    return n;
  }

  /* ---------------- message dispatch ---------------- */

  _onMessage(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      conn.json({ event: 'bridge.error', data: { message: 'invalid JSON frame' } });
      return;
    }

    // Client -> host event (fire and forget), e.g. UI telemetry.
    if (msg && msg.event && !msg.method) {
      this.emit('event', { event: msg.event, data: msg.data, clientId: conn.id });
      return;
    }

    if (!msg || msg.method === undefined) {
      conn.json({ event: 'bridge.error', data: { message: 'frame needs a "method"' } });
      return;
    }

    const id = msg.id === undefined ? null : msg.id;
    const params = Array.isArray(msg.params) ? msg.params : msg.params === undefined ? [] : [msg.params];

    this.calls++;
    this._invoke(msg.method, params, conn)
      .then((result) => {
        if (id !== null) conn.json({ id: id, result: result === undefined ? null : result });
      })
      .catch((err) => {
        const payload = normaliseError(err);
        if (id !== null) conn.json({ id: id, error: payload });
        if (this.devMode) {
          console.error('[microdesk:bridge]', msg.method, 'failed:', payload.message);
        }
      });
  }

  _invoke(method, params, conn) {
    const entry = this.methods.get(method);
    if (!entry) {
      return Promise.reject(
        new RpcError('ENOMETHOD', 'unknown method "' + method + '"', {
          hint: 'GET /__microdesk/manifest lists every method'
        })
      );
    }
    try {
      const out = entry.fn.apply(this, params.concat([{ conn: conn, method: method }]));
      return Promise.resolve(out);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /* ---------------- built-in methods ---------------- */

  _registerCoreMethods() {
    const self = this;

    /* ---- app ---- */
    this.define('app.ping', () => ({
      pong: true,
      time: new Date().toISOString(),
      uptimeMs: Date.now() - self.startedAt
    }));

    this.define('app.info', function () {
      return {
        name: 'MicroDesk',
        version: VERSION,
        appId: self.appId,
        startedAt: new Date(self.startedAt).toISOString(),
        uptime: humanUptime((Date.now() - self.startedAt) / 1000),
        clients: self.connections.size,
        calls: self.calls,
        methods: self.listMethods().length,
        devMode: self.devMode
      };
    });

    this.define('app.echo', (value) => value);

    this.define('app.hello', (payload, ctx) => {
      self.emit('client:hello', payload);
      return {
        ok: true,
        clientId: payload && payload.clientId,
        serverTime: new Date().toISOString(),
        methods: self.listMethods()
      };
    });

    this.define('app.broadcast', (event, data) => {
      if (!self.devMode) throw new RpcError('EPERM', 'app.broadcast requires dev mode');
      return { delivered: self.broadcast(String(event), data) };
    });

    /* ---- sys ---- */
    this.define('sys.info', () => {
      const cpuList = util.cpus();
      return {
        platform: process.platform,
        arch: process.arch,
        os: util.osDescription() + (process.platform === 'win32' ? ' — Windows NT ' + util.safeCall(() => require('os').release(), '') : ''),
        hostname: util.hostname(),
        node: process.version,
        execPath: process.execPath,
        pid: process.pid,
        cwd: process.cwd(),
        cpus: cpuList.length,
        cpuModel: (cpuList[0] && cpuList[0].model) || 'unknown',
        memTotal: humanBytes(util.totalmem()),
        memFree: humanBytes(util.freemem()),
        uptime: humanUptime(util.uptime()),
        hrtime: Date.now()
      };
    });

    this.define('sys.env', (name) => {
      self._perm('env');
      if (name === undefined) {
        const copy = Object.assign({}, process.env);
        return copy;
      }
      return process.env[String(name)] === undefined ? null : process.env[String(name)];
    });

    /**
     * sys.exec(file, args?, opts?)  ->  { code, stdout, stderr, durationMs }
     * Never uses a shell unless `shell: true` is passed explicitly.
     */
    this.define('sys.exec', function (file, args, opts) {
      self._perm('exec');
      if (typeof file !== 'string' || !file) throw new RpcError('EINVAL', 'sys.exec(file, args?)');
      const argv = Array.isArray(args) ? args.map(String) : args === undefined ? [] : [String(args)];
      const options = Object.assign(
        { cwd: process.cwd(), timeout: self.execTimeout, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: process.env },
        opts && typeof opts === 'object' ? opts : {}
      );
      if (argv.length === 0 && !options.shell) {
        options.shell = false;
      }
      const started = Date.now();
      return new Promise((resolve) => {
        execFile(file, argv, options, (err, stdout, stderr) => {
          resolve({
            file: file,
            args: argv,
            code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
            signal: err && err.signal ? err.signal : null,
            stdout: String(stdout || ''),
            stderr: String(stderr || (err && err.message) || ''),
            durationMs: Date.now() - started
          });
        });
      });
    });

    /** sys.shell(command) — convenience, runs through cmd.exe / sh -c */
    this.define('sys.shell', (command, opts) => {
      self._perm('exec');
      if (typeof command !== 'string' || !command) throw new RpcError('EINVAL', 'sys.shell(command)');
      const isWin = process.platform === 'win32';
      const shell = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
      const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command];
      return this.methods.get('sys.exec').fn(shell, args, opts);
    });

    /** sys.launch(file, args?) — start a detached GUI process */
    this.define('sys.launch', (file, args) => {
      self._perm('exec');
      const argv = Array.isArray(args) ? args.map(String) : [];
      const child = spawn(file, argv, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { pid: child.pid, file: file, args: argv };
    });

    /** sys.openPath(p) — reveal a file/folder/url with the OS default handler */
    this.define('sys.openPath', (target) => {
      self._perm('open');
      const isWin = process.platform === 'win32';
      const p = String(target);
      if (isWin) {
        spawn('cmd', ['/c', 'start', '""', p], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [p], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
      }
      return { opened: p };
    });

    /* ---- fs ---- */
    this.define('fs.list', (dir) => {
      self._perm('fs');
      const abs = resolvePath(dir === undefined ? '.' : dir, self.rendererRoot);
      return fsp.readdir(abs, { withFileTypes: true }).then((entries) =>
        entries.map((e) => {
          const full = path.join(abs, e.name);
          let stat = null;
          try {
            stat = fs.statSync(full);
          } catch (_) {
            /* unreadable entry */
          }
          return {
            name: e.name,
            path: full,
            dir: e.isDirectory(),
            size: stat ? stat.size : 0,
            sizeText: stat ? humanBytes(stat.size) : '?',
            mtime: stat ? stat.mtime.toISOString() : null
          };
        })
      );
    });

    this.define('fs.readdir', function () {
      return self.methods.get('fs.list').fn.apply(self, arguments);
    });

    this.define('fs.stat', (target) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      return fsp.stat(abs).then((s) => ({
        path: abs,
        size: s.size,
        sizeText: humanBytes(s.size),
        dir: s.isDirectory(),
        file: s.isFile(),
        mtime: s.mtime.toISOString(),
        birthtime: s.birthtime ? s.birthtime.toISOString() : null,
        mode: '0' + (s.mode & 0o777).toString(8)
      }));
    });

    this.define('fs.exists', function (target) {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      return new Promise((resolve) => fs.exists ? fs.exists(abs, resolve) : fsp.access(abs).then(() => resolve(true), () => resolve(false)));
    });

    this.define('fs.readFile', (target, encoding) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      const enc = encoding || 'utf8';
      return fsp.stat(abs).then((s) => {
        if (s.size > self.maxReadBytes) {
          throw new RpcError('EFBIG', 'file too large: ' + humanBytes(s.size) + ' > ' + humanBytes(self.maxReadBytes));
        }
        if (enc === 'base64') {
          return fsp.readFile(abs).then((buf) => buf.toString('base64'));
        }
        return fsp.readFile(abs, enc === 'buffer' ? null : enc);
      });
    });

    this.define('fs.writeFile', (target, content, encoding) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      const data = String(content === undefined ? '' : content);
      if (Buffer.byteLength(data, 'utf8') > self.maxWriteBytes) {
        throw new RpcError('EFBIG', 'write exceeds ' + humanBytes(self.maxWriteBytes));
      }
      const enc = encoding === 'base64' ? 'base64' : 'utf8';
      return fsp
        .mkdir(path.dirname(abs), { recursive: true })
        .then(() => fsp.writeFile(abs, data, enc === 'base64' ? null : enc))
        .then(() => ({ path: abs, bytes: Buffer.byteLength(data, enc), encoding: enc }));
    });

    this.define('fs.appendFile', (target, content) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      const data = String(content === undefined ? '' : content);
      return fsp.appendFile(abs, data, 'utf8').then(() => ({ path: abs, bytes: Buffer.byteLength(data) }));
    });

    this.define('fs.mkdir', (target) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      return fsp.mkdir(abs, { recursive: true }).then(() => ({ path: abs, created: true }));
    });

    this.define('fs.unlink', (target) => {
      self._perm('fs');
      const abs = resolvePath(target, self.rendererRoot);
      return fsp.unlink(abs).then(() => ({ path: abs, removed: true }));
    });

    this.define('fs.rename', (from, to) => {
      self._perm('fs');
      const a = resolvePath(from, self.rendererRoot);
      const b = resolvePath(to, self.rendererRoot);
      return fsp.rename(a, b).then(() => ({ from: a, to: b }));
    });

    this.define('fs.copyFile', (from, to) => {
      self._perm('fs');
      const a = resolvePath(from, self.rendererRoot);
      const b = resolvePath(to, self.rendererRoot);
      return fsp.copyFile(a, b).then(() => ({ from: a, to: b, bytes: fs.statSync(b).size }));
    });

    /* ---- events ---- */
    this.define('events.subscribe', (name, ctx) => {
      const conn = ctx && ctx.conn;
      if (!conn) throw new RpcError('EINVAL', 'missing connection');
      conn.subscriptions = conn.subscriptions || new Set();
      conn.subscriptions.add(String(name));
      return { subscribed: String(name) };
    });
  }
}

function createBridge(options) {
  return new Bridge(options);
}

module.exports = { createBridge, Bridge, RpcError, resolvePath, humanBytes, humanUptime, VERSION };
