'use strict';
/**
 * MicroDesk :: util
 * Small amount of defensive glue. Sandboxed hosts (containers, hardened CI,
 * some anti-virus shims on Windows 7) can make libuv calls fail with ENOSYS or
 * EPERM — a desktop framework must never crash the app over a diagnostics call.
 */

const os = require('os');

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch (_) {
    return typeof fallback === 'function' ? safeCall(fallback, null) : fallback;
  }
}

function hostname() {
  return safeCall(() => os.hostname(), 'localhost');
}

function uptime() {
  return safeCall(() => os.uptime(), 0);
}

function freemem() {
  return safeCall(() => os.freemem(), 0);
}

function totalmem() {
  return safeCall(() => os.totalmem(), 0);
}

function cpus() {
  return safeCall(() => os.cpus(), []) || [];
}

function osDescription() {
  const type = safeCall(() => os.type(), 'unknown');
  const release = safeCall(() => os.release(), '');
  const arch = safeCall(() => os.arch(), '');
  return (type + ' ' + release).trim() + (arch ? ' (' + arch + ')' : '');
}

module.exports = { safeCall, hostname, uptime, freemem, totalmem, cpus, osDescription };
