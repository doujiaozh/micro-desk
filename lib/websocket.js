'use strict';
/**
 * MicroDesk :: websocket
 * ---------------------------------------------------------------------------
 * A dependency-free RFC 6455 WebSocket *server* implementation (the "ws" part
 * of md_core). Written in pure JavaScript so that MicroDesk installs and runs
 * on machines with no build toolchain at all (Windows 7 + Node.js, nothing else).
 *
 * Supported: text/binary frames, fragmentation, ping/pong, close handshake,
 * 16-bit and 64-bit payload lengths, client->server masking (required by RFC).
 * Not supported (intentionally): permessage-deflate. Adds weight for no gain
 * on a loopback socket where frames are already tiny.
 */

const crypto = require('crypto');
const EventEmitter = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa
};

const MAX_PAYLOAD = 64 * 1024 * 1024; // 64 MiB hard cap

function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');
}

/** Build one unmasked server->client frame. */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = data.length;
  let header;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data], header.length + len);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, req, options) {
    super();
    this.socket = socket;
    this.req = req;
    this.options = options || {};
    this.readyState = 'open';
    this.remoteAddress =
      (req && req.socket && req.socket.remoteAddress) ||
      (socket && socket.remoteAddress) ||
      'unknown';
    this.id = crypto.randomBytes(8).toString('hex');
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = null;
    this._lastSeen = Date.now();
    this._closed = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._finalize(1006, String(err && err.message)));
    socket.on('close', () => this._finalize(1006, 'socket closed'));
    socket.on('end', () => this._finalize(1006, 'socket ended'));
    socket.setNoDelay(true);
    socket.setTimeout(0);
  }

  get isAlive() {
    return this.readyState === 'open';
  }

  ping(payload) {
    if (!this.isAlive) return false;
    try {
      this.socket.write(encodeFrame(OPCODE.PING, payload || Buffer.alloc(0)));
      return true;
    } catch (_) {
      return false;
    }
  }

  send(data) {
    if (!this.isAlive) return false;
    try {
      const isBuffer = Buffer.isBuffer(data);
      const payload = isBuffer ? data : String(data);
      this.socket.write(encodeFrame(isBuffer ? OPCODE.BINARY : OPCODE.TEXT, payload));
      return true;
    } catch (err) {
      this._finalize(1011, String(err && err.message));
      return false;
    }
  }

  /** Send a JSON-serialisable value as a text frame. */
  json(value) {
    return this.send(JSON.stringify(value));
  }

  close(code, reason) {
    if (this._closed) return;
    const c = code === undefined ? 1000 : code;
    const r = Buffer.from(String(reason || ''), 'utf8').slice(0, 123);
    const body = Buffer.allocUnsafe(2 + r.length);
    body.writeUInt16BE(c, 0);
    r.copy(body, 2);
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, body));
    } catch (_) {
      /* ignore */
    }
    this._finalize(c, reason);
  }

  terminate() {
    this._finalize(1006, 'terminated');
    try {
      this.socket.destroy();
    } catch (_) {
      /* ignore */
    }
  }

  _finalize(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 'closed';
    if (this._closeTimer) clearTimeout(this._closeTimer);
    try {
      this.socket.end();
    } catch (_) {
      /* ignore */
    }
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    this._lastSeen = Date.now();
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);

    // Parse as many complete frames as the buffer holds.
    for (;;) {
      const buf = this._buffer;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const hi = buf.readUInt32BE(offset);
        const lo = buf.readUInt32BE(offset + 4);
        len = hi * 4294967296 + lo;
        offset += 8;
      }

      if (len > MAX_PAYLOAD) {
        this.close(1009, 'payload too large');
        return;
      }

      let maskKey = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.slice(offset, offset + 4);
        offset += 4;
      }

      if (buf.length < offset + len) return;

      let payload = buf.slice(offset, offset + len);
      this._buffer = buf.slice(offset + len);

      if (masked && maskKey) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i] ^ maskKey[i & 3];
        }
        payload = out;
      } else if (masked) {
        payload = Buffer.alloc(0);
      }

      this._handleFrame(fin, opcode, payload);
      if (this._closed) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case OPCODE.PING:
        try {
          this.socket.write(encodeFrame(OPCODE.PONG, payload));
        } catch (_) {
          /* ignore */
        }
        this.emit('ping', payload);
        return;

      case OPCODE.PONG:
        this.emit('pong', payload);
        return;

      case OPCODE.CLOSE: {
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.slice(2).toString('utf8');
        }
        this.close(code === 1005 ? 1000 : code, '');
        return;
      }

      case OPCODE.CONTINUATION:
        if (this._fragmentOpcode === null) {
          this.close(1002, 'unexpected continuation frame');
          return;
        }
        this._fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this._fragments);
          const op = this._fragmentOpcode;
          this._fragments = [];
          this._fragmentOpcode = null;
          this._emitMessage(op, whole);
        }
        return;

      case OPCODE.TEXT:
      case OPCODE.BINARY:
        if (this._fragmentOpcode !== null) {
          this.close(1002, 'interleaved fragments');
          return;
        }
        if (!fin) {
          this._fragmentOpcode = opcode;
          this._fragments = [payload];
          return;
        }
        this._emitMessage(opcode, payload);
        return;

      default:
        this.close(1002, 'unknown opcode ' + opcode);
    }
  }

  _emitMessage(opcode, payload) {
    if (opcode === OPCODE.TEXT) {
      const text = payload.toString('utf8');
      this.emit('message', text, false);
    } else {
      this.emit('message', payload, true);
    }
  }
}

/**
 * Attach a WebSocket endpoint to an existing http.Server.
 *
 * @param {import('http').Server} server
 * @param {{ path?: string, onConnection?: Function, heartbeatMs?: number }} options
 * @returns {{ connections: Set<WebSocketConnection>, broadcast: Function, close: Function }}
 */
function attach(server, options) {
  const opts = options || {};
  const watchPath = opts.path || '/ws';
  const connections = new Set();

  const wss = new EventEmitter();
  wss.connections = connections;
  wss.path = watchPath;

  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];
    if (pathname !== watchPath) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(key)
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    const conn = new WebSocketConnection(socket, req, opts);
    if (head && head.length) {
      // Data raced the handshake; replay it into the connection parser.
      conn._onData(head);
    }
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    if (typeof opts.onConnection === 'function') opts.onConnection(conn, req);
    wss.emit('connection', conn, req);
  });

  wss.broadcast = function broadcast(data) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    let sent = 0;
    connections.forEach((c) => {
      if (c.isAlive && c.send(text)) sent++;
    });
    return sent;
  };

  // Heartbeat: drop sockets that stopped answering pings (browsers in app-mode
  // get suspended when the lid closes, and dead peers must not leak).
  let timer = null;
  const hb = Number(opts.heartbeatMs || 15000);
  if (hb > 0) {
    timer = setInterval(() => {
      const now = Date.now();
      connections.forEach((c) => {
        if (!c.isAlive) {
          connections.delete(c);
          return;
        }
        if (now - c._lastSeen > hb * 3) {
          c.terminate();
          return;
        }
        c.ping();
      });
    }, hb);
    if (timer.unref) timer.unref();
  }

  wss.close = function close() {
    if (timer) clearInterval(timer);
    connections.forEach((c) => c.close(1001, 'server shutting down'));
    connections.clear();
  };

  return wss;
}

module.exports = { attach, encodeFrame, acceptKey, OPCODE, WebSocketConnection };
