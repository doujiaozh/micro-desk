'use strict';
/**
 * Minimal MicroDesk app — the whole "framework as a library" story in 30 lines.
 *
 *   node examples/hello/server.js
 *   node examples/hello/server.js --no-open    (server only)
 */

const path = require('path');
const MicroDesk = require('../../lib');

const noOpen = process.argv.indexOf('--no-open') !== -1;

(async () => {
  const app = await MicroDesk.start({
    root: path.join(__dirname, 'web'),
    name: 'Hello MicroDesk',
    id: 'hello-microdesk',
    width: 760,
    height: 520,
    open: !noOpen,
    tickMs: 2000
  });

  // Your own RPC method — callable from the page as md.host.greeting(...)
  app.bridge.define('host.greeting', (who) => 'Hello, ' + (who || 'world') + '! — from Node ' + process.version);

  console.log('');
  console.log('  Hello MicroDesk is running');
  console.log('  ' + app.url);
  console.log('  (close the window to exit)');
  console.log('');

  // Optional: react to the window closing.
  app.bridge.on('client:close', () => {
    setTimeout(() => app.stop().then(() => process.exit(0)), 1500);
  });
})().catch((err) => {
  console.error('failed to start:', err);
  process.exitCode = 1;
});
