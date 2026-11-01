'use strict';
/**
 * MicroDesk — programmatic entry point.
 *
 *   const MicroDesk = require('micro-desk');
 *
 *   const app = await MicroDesk.start({
 *     root: __dirname + '/web',
 *     name: 'My App',
 *     width: 1000
 *   });
 *   console.log(app.url);   // http://127.0.0.1:PORT/
 *   await app.stop();
 */

const core = require('./core');
const win = require('./window');
const bridge = require('./bridge');
const mime = require('./mime');
const websocket = require('./websocket');
const pkg = require('../package.json');

/**
 * Start a MicroDesk app: HTTP server + bridge + browser window.
 * Returns a handle with { url, port, core, bridge, browser, stop() }.
 */
async function start(options) {
  const opts = options || {};
  const appId = opts.id || opts.appId || 'microdesk-app';
  const appName = opts.name || 'MicroDesk App';

  const rpc = bridge.createBridge(
    Object.assign({ appId: appId, tickMs: opts.tickMs || 0 }, opts.bridge || {})
  );

  const kernel = core.createCore({
    root: opts.root,
    host: opts.host || '127.0.0.1',
    port: opts.port === undefined ? 0 : opts.port,
    dev: !!opts.dev,
    verbose: !!opts.verbose,
    bridge: rpc,
    assets: opts.assets || null,
    manifest: { name: appName, id: appId, entry: opts.entry || 'index.html' },
    onShutdown: () => {
      // POST /__microdesk/shutdown must actually stop the server in library mode,
      // otherwise a headless app can never be stopped from the outside.
      kernel.close();
      if (typeof opts.onShutdown === 'function') opts.onShutdown();
    }
  });

  await kernel.listen();

  let launched = null;
  if (opts.open !== false) {
    launched = win.launch(kernel.url, {
      appId: appId,
      width: opts.width,
      height: opts.height,
      browser: opts.browser,
      profileDir: opts.profileDir,
      kiosk: opts.kiosk,
      detached: !!opts.detached,
      dryRun: !!opts.dryRun,
      onChildError: opts.onChildError
    });
  }

  return {
    url: kernel.url,
    port: kernel.port,
    mode: launched ? launched.mode : 'headless',
    browser: launched ? launched.browser : null,
    profileDir: launched ? launched.profileDir : null,
    core: kernel,
    bridge: rpc,
    window: launched,
    stop: () => kernel.close()
  };
}

module.exports = {
  start: start,
  createCore: core.createCore,
  createBridge: bridge.createBridge,
  detectBrowsers: win.detectBrowsers,
  pickBrowser: win.pickBrowser,
  launchWindow: win.launch,
  websocket: websocket,
  mime: mime,
  version: pkg.version
};
