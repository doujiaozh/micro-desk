'use strict';
/**
 * MicroDesk smoke test — no test framework, no dependencies.
 *
 *   node tests/smoke.js
 *
 * Boots the kernel in-process, speaks the real WebSocket protocol over a raw
 * TCP socket (so the hand-rolled ws implementation is genuinely exercised),
 * then asserts the whole RPC path end-to-end.
 */

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MicroDesk = require('../lib');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail) {
  passed++;
  console.log('  \u2713 ' + name + (detail === undefined ? '' : '  (' + detail + ')'));
}
function bad(name, err) {
  failed++;
  failures.push({ name: name, err: err });
  console.log('  \u2717 ' + name + '  -> ' + (err && err.message ? err.message : err));
}
function eq(name, actual, expected) {
  if (actual === expected) return ok(name);
  bad(name, new Error('expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)));
}
function assert(name, cond, detail) {
  if (cond) return ok(name, detail);
  bad(name, new Error(detail || 'assertion failed'));
}

/* ------------------------------------------------------------------ */
/* a minimal RFC 6455 client: handshake + frame parse/send            */
/* ------------------------------------------------------------------ */

function wsConnect(port, wsPath) {
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    let handshakeDone = false;
    const listeners = [];
    const client = {
      messages: [],
      close() {
        try {
          socket.destroy();
        } catch (_) {}
      },
      send(text) {
        socket.write(encodeClientFrame(Buffer.from(text, 'utf8')));
      },
      onMessage(fn) {
        listeners.push(fn);
      }
    };

    socket.on('connect', () => {
      socket.write(
        'GET ' + (wsPath || '/ws') + ' HTTP/1.1\r\n' +
          'Host: 127.0.0.1:' + port + '\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          'Sec-WebSocket-Key: ' + key + '\r\n' +
          'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    socket.on('error', reject);

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshakeDone) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.slice(0, end).toString('utf8');
        if (head.indexOf('101') === -1) return reject(new Error('upgrade failed: ' + head.split('\r\n')[0]));
        buffer = buffer.slice(end + 4);
        handshakeDone = true;
        resolve(client);
      }
      // decode all complete frames
      for (;;) {
        if (buffer.length < 2) break;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let len = buffer[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buffer.length < 4) break;
          len = buffer.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buffer.length < 10) break;
          len = buffer.readUInt32BE(2) * 4294967296 + buffer.readUInt32BE(6);
          off = 10;
        }
        let maskKey = null;
        if (masked) {
          if (buffer.length < off + 4) break;
          maskKey = buffer.slice(off, off + 4);
          off += 4;
        }
        if (buffer.length < off + len) break;
        let payload = buffer.slice(off, off + len);
        if (maskKey) {
          const out = Buffer.allocUnsafe(payload.length);
          for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i & 3];
          payload = out;
        }
        buffer = buffer.slice(off + len);
        if (opcode === 0x1) {
          const text = payload.toString('utf8');
          client.messages.push(text);
          listeners.forEach((fn) => {
            try {
              fn(text);
            } catch (_) {}
          });
        }
      }
    });
  });
}

function encodeClientFrame(payload) {
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  header[0] = 0x81;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/* ------------------------------------------------------------------ */
/* tiny RPC client on top                                            */
/* ------------------------------------------------------------------ */

function rpcClient(conn) {
  let seq = 0;
  const pending = new Map();
  conn.onMessage((text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg.result);
    }
  });
  return {
    call(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        conn.send(JSON.stringify({ id: id, method: method, params: params || [] }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(method + ' timed out'));
          }
        }, 8000);
      });
    }
  };
}

/* ------------------------------------------------------------------ */
/* http helper                                                       */
/* ------------------------------------------------------------------ */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body }));
      })
      .on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* main                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n  MicroDesk smoke test\n  ' + '-'.repeat(56));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'microdesk-test-'));

  const app = await MicroDesk.start({
    root: path.join(__dirname, '..', 'web'),
    name: 'Smoke Test',
    id: 'smoke-test',
    open: false,
    port: 0,
    bridge: { tickMs: 300 }
  });

  console.log('  server: ' + app.url + '\n');

  /* ---- HTTP plane ---- */
  try {
    const health = await httpGet(app.url + '__microdesk/health');
    assert('GET /__microdesk/health -> 200', health.status === 200);
    const parsed = JSON.parse(health.body);
    eq('health.ok', parsed.ok, true);
    eq('health.app', parsed.app, 'Smoke Test');

    const manifest = JSON.parse((await httpGet(app.url + '__microdesk/manifest')).body);
    assert('manifest lists rpc methods', Array.isArray(manifest.rpc.methods) && manifest.rpc.methods.length > 8, manifest.rpc.methods.length + ' methods');
    assert('manifest advertises websocket transport', manifest.rpc.transport === 'websocket');

    const index = await httpGet(app.url);
    assert('GET / serves index.html', index.status === 200 && /MicroDesk/.test(index.body));
    assert('content-type is html', /text\/html/.test(index.headers['content-type']));
    assert('ETag header present', !!index.headers.etag);

    const css = await httpGet(app.url + 'app.css');
    assert('GET /app.css serves css', css.status === 200 && /--accent/.test(css.body));

    const sdk = await httpGet(app.url + 'sdk/microdesk.js');
    assert('GET /sdk/microdesk.js serves sdk', sdk.status === 200 && /MicroDesk/.test(sdk.body));

    const missing = await httpGet(app.url + 'nope-does-not-exist.js');
    eq('missing asset -> 404', missing.status, 404);

    const traversal = await httpGet(app.url + '__microdesk/health/../../../package.json');
    assert('path traversal is not served', traversal.status === 404 || traversal.status === 403 || !/micro-desk/.test(traversal.body));
  } catch (err) {
    bad('http plane', err);
  }

  /* ---- WebSocket plane ---- */
  let conn;
  try {
    conn = await wsConnect(app.port, '/ws');
    ok('websocket handshake (101 Switching Protocols)');

    const rpc = rpcClient(conn);

    // bridge.ready is pushed by the server on connect
    await new Promise((r) => setTimeout(r, 150));
    const ready = conn.messages.map((m) => JSON.parse(m)).find((m) => m.event === 'bridge.ready');
    assert('server pushes bridge.ready', !!ready && ready.data.version, ready && ready.data.version);

    const pong = await rpc.call('app.ping', []);
    eq('app.ping -> pong', pong.pong, true);

    const echo = await rpc.call('app.echo', ['hi microdesk']);
    eq('app.echo roundtrip', echo, 'hi microdesk');

    const info = await rpc.call('sys.info', []);
    eq('sys.info.platform', info.platform, process.platform);
    assert('sys.info.node', typeof info.node === 'string' && info.node[0] === 'v', info.node);

    const list = await rpc.call('fs.list', [__dirname]);
    assert('fs.list returns entries', Array.isArray(list) && list.some((e) => e.name === 'smoke.js'));

    const target = path.join(tmpDir, 'rpc-roundtrip.txt');
    const payload = 'written by the browser side, through the RPC bridge \u2764';
    const w = await rpc.call('fs.writeFile', [target, payload]);
    assert('fs.writeFile', w.bytes > 0, w.bytes + ' bytes');
    const back = await rpc.call('fs.readFile', [target, 'utf8']);
    eq('fs.readFile roundtrip', back, payload);

    const exists = await rpc.call('fs.exists', [target]);
    eq('fs.exists', exists, true);

    const stat = await rpc.call('fs.stat', [target]);
    assert('fs.stat.file', stat.file === true && stat.size > 0);

    const unlinked = await rpc.call('fs.unlink', [target]);
    eq('fs.unlink', unlinked.removed, true);

    const exec = await rpc.call('sys.exec', ['node', ['-e', 'console.log("from-node-"+process.platform)']]);
    eq('sys.exec exit code', exec.code, 0);
    assert('sys.exec stdout', /from-node-/.test(exec.stdout), exec.stdout.trim());

    // error path
    let errCaught = null;
    try {
      await rpc.call('does.not.exist', []);
    } catch (err) {
      errCaught = err;
    }
    assert('unknown method rejects with ENOMETHOD', errCaught && errCaught.code === 'ENOMETHOD');

    // server push
    const gotTick = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      const probe = (text) => {
        try {
          const m = JSON.parse(text);
          if (m.event === 'app.tick') {
            clearTimeout(timer);
            resolve(true);
          }
        } catch (_) {}
      };
      conn.onMessage(probe);
    });
    assert('server pushes app.tick events', gotTick === true);
  } catch (err) {
    bad('websocket plane', err);
  } finally {
    if (conn) conn.close();
  }

  /* ---- window detection ---- */
  try {
    const browsers = MicroDesk.detectBrowsers();
    assert('browser detection runs', Array.isArray(browsers));
    if (browsers.length) {
      ok('browser found: ' + browsers[0].label, browsers[0].exe);
      const preview = MicroDesk.launchWindow(app.url, { appId: 'smoke', dryRun: true });
      assert('app-mode args contain --app=', preview.args.some((a) => a.indexOf('--app=') === 0));
      assert('app-mode args contain --user-data-dir=', preview.args.some((a) => a.indexOf('--user-data-dir=') === 0));
    } else {
      console.log('  ! no chromium browser installed — skipping launch argument checks');
    }
  } catch (err) {
    bad('window plane', err);
  }

  await app.stop();

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}

  console.log('\n  ' + '-'.repeat(56));
  console.log('  ' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) {
    failures.forEach((f) => console.log('   - ' + f.name + ': ' + f.err.message));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\n  smoke test crashed: ' + err.stack);
  process.exitCode = 1;
});
