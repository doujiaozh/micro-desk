#!/usr/bin/env node
'use strict';
/**
 * MicroDesk CLI
 * ---------------------------------------------------------------------------
 *   node bin/microdesk.js start     # 启动应用（默认：起服务 + 拉起 app 窗口）
 *   node bin/microdesk.js dev       # 开发模式（热重载友好、不自动退出、打印日志）
 *   node bin/microdesk.js doctor    # 诊断：Node 版本 + 浏览器探测结果
 *   node bin/microdesk.js pack      # 打包成单文件（md_pack）
 *   node bin/microdesk.js version
 *
 *   All options can be overridden with MICRODESK_* environment variables.
 */

const path = require('path');
const fs = require('fs');

const pkg = require('../package.json');
const core = require('../lib/core');
const win = require('../lib/window');
const util = require('../lib/util');

const ROOT = path.resolve(__dirname, '..');

// Packed mode: lib/pack.js inlines every module + the web assets and sets this
// global before booting the CLI. Nothing on disk except the bundle itself.
const BUNDLE =
  typeof global !== 'undefined' && global.__MICRODESK_BUNDLE__ ? global.__MICRODESK_BUNDLE__ : null;

/* ------------------------------------------------------------------ */
/* tiny argv parser (no minimist dependency)                          */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args._.push.apply(args._, argv.slice(i + 1));
      break;
    }
    if (token.indexOf('--') === 0) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && next.indexOf('--') !== 0) {
          args[key] = next;
          i++;
        } else {
          args[key] = true;
        }
      }
    } else if (token === '-v') {
      args.version = true;
    } else if (token === '-h') {
      args.help = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return !/^(0|false|no|off)$/i.test(String(value));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ */
/* config                                                             */
/* ------------------------------------------------------------------ */

function loadConfig(cli) {
  const configFile = cli.config
    ? path.resolve(process.cwd(), cli.config)
    : path.join(ROOT, 'microdesk.config.json');

  let fileConfig = {};

  // A packed app carries its config inside the bundle.
  if (BUNDLE && BUNDLE.config) {
    try {
      fileConfig = JSON.parse(JSON.stringify(BUNDLE.config));
    } catch (_) {
      fileConfig = {};
    }
  }

  try {
    if (fs.existsSync(configFile)) {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch (err) {
    console.warn('[microdesk] config parse failed, ignoring: ' + err.message);
  }

  const app = fileConfig.app || {};
  const server = fileConfig.server || {};
  const windowCfg = fileConfig.window || {};

  return {
    configFile: fs.existsSync(configFile) ? configFile : null,
    app: {
      name: cli.name || app.name || pkg.name,
      id: cli.id || app.id || 'microdesk-app',
      root: cli.root ? path.resolve(process.cwd(), cli.root) : path.resolve(ROOT, app.root || 'web'),
      entry: app.entry || 'index.html'
    },
    server: {
      host: cli.host || server.host || '127.0.0.1',
      port: num(cli.port !== undefined ? cli.port : server.port, 0)
    },
    window: {
      width: num(cli.width !== undefined ? cli.width : windowCfg.width, 1180),
      height: num(cli.height !== undefined ? cli.height : windowCfg.height, 760),
      browser: cli.browser || windowCfg.browser || null,
      profileDir: cli['profile-dir'] || windowCfg.profileDir || null,
      kiosk: bool(cli.kiosk !== undefined ? cli.kiosk : windowCfg.kiosk, false),
      extraArgs: windowCfg.extraArgs || []
    },
    dev: bool(cli.dev, false),
    verbose: bool(cli.verbose, false),
    autoExit: bool(cli['auto-exit'], fileConfig.autoExit !== false),
    bridge: fileConfig.bridge || {}
  };
}

/* ------------------------------------------------------------------ */
/* commands                                                           */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(
    [
      '',
      '  MicroDesk v' + pkg.version + '  —  Node.js backend + browser frontend = desktop app',
      '',
      '  Usage:',
      '    node bin/microdesk.js start [options]',
      '',
      '  Options:',
      '    --port <n>            HTTP/WS port (0 = auto pick a free port)',
      '    --host <addr>         bind address (default 127.0.0.1)',
      '    --root <dir>          static root (default ./web)',
      '    --browser <path>      force a browser executable',
      '    --width <n>           window width  (default 1180)',
      '    --height <n>          window height (default 760)',
      '    --kiosk               start fullscreen',
      '    --no-open             start the server only, do not open a window',
      '    --no-auto-exit        keep the server alive after the last window closes',
      '    --dry-run             detect + print the browser command, launch nothing',
      '    --verbose             log every HTTP request',
      '    --config <file>       path to microdesk.config.json',
      '    --out <dir>           pack output directory (default ./dist)',
      '    --copy-node           pack: copy node.exe next to the bundle (portable)',
      '',
      '  Commands:',
      '    start    run the app (server + window)',
      '    dev      same as start --no-auto-exit --verbose',
      '    doctor   print browser detection results',
      '    pack     bundle into a single file (see md_pack)',
      '    version  print version',
      '',
      '  Env:',
      '    MICRODESK_BROWSER     absolute path to chrome.exe / msedge.exe',
      '    MICRODESK_PROFILE_DIR profile root for --user-data-dir',
      ''
    ].join('\n')
  );
}

function cmdDoctor(cli) {
  const cfg = loadConfig(cli);
  const browsers = win.detectBrowsers({ browser: cfg.window.browser });

  console.log('');
  console.log('  MicroDesk doctor');
  console.log('  ' + '-'.repeat(58));
  console.log('  node        ' + process.version + '  (' + process.execPath + ')');
  console.log('  platform    ' + process.platform + ' / ' + process.arch);
  console.log('  os          ' + util.safeCall(() => require('os').release(), 'unknown') + '  ' + util.safeCall(() => require('os').type(), ''));
  console.log('  cpus        ' + util.cpus().length + '   mem ' + Math.round(util.totalmem() / 1048576) + ' MB');
  console.log('  web root    ' + cfg.app.root + (BUNDLE && BUNDLE.assets ? '   (packed: in-memory)' : fs.existsSync(cfg.app.root) ? '' : '   <-- MISSING'));
  console.log('  profile     ' + (cfg.window.profileDir || win.defaultProfileDir(cfg.app.id)));
  console.log('');

  if (!browsers.length) {
    console.log('  browsers    NONE FOUND');
    console.log('              MicroDesk needs Chrome / Edge / Chromium (or set MICRODESK_BROWSER).');
    console.log('              Without one it falls back to the default browser (no app frame).');
    console.log('');
    process.exitCode = 1;
    return;
  }

  console.log('  browsers    ' + browsers.length + ' found, order of preference:');
  browsers.forEach((b, i) => {
    console.log('   ' + String(i + 1).padStart(2) + '. ' + b.label);
    console.log('       exe     ' + b.exe);
    console.log('       source  ' + b.source + (b.kind === 'chromium' ? '   [app-mode capable]' : ''));
  });
  console.log('');
  console.log('  chromium    ' + (browsers.some((b) => b.kind === 'chromium') ? 'YES -> --app= window mode available' : 'NO  -> default-browser fallback'));
  console.log('');
}

function cmdStart(cli) {
  const cfg = loadConfig(cli);
  const noOpen = bool(cli['no-open'], false);
  const dryRun = bool(cli['dry-run'], false);

  const bundledAssets = BUNDLE && BUNDLE.assets ? BUNDLE.assets : null;

  if (!bundledAssets && !fs.existsSync(cfg.app.root)) {
    console.error('[microdesk] web root not found: ' + cfg.app.root);
    process.exitCode = 1;
    return;
  }

  let bridge = null;
  try {
    const Bridge = require('../lib/bridge');
    const config = cfg.bridge || {};
    bridge = Bridge.createBridge(Object.assign({ appId: cfg.app.id }, config));
    if (cfg.dev) bridge.setDevMode(true);
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    console.warn('[microdesk] bridge module not available yet, RPC disabled');
  }

  const server = core.createCore({
    root: cfg.app.root,
    assets: bundledAssets,
    host: cfg.server.host,
    port: cfg.server.port,
    dev: cfg.dev,
    verbose: cfg.verbose || cfg.dev,
    bridge: bridge,
    manifest: { name: cfg.app.name, id: cfg.app.id, entry: cfg.app.entry },
    onShutdown: () => shutdown('control-endpoint')
  });

  let child = null;
  let launched = null;
  let exitTimer = null;
  let everConnected = false;
  let shuttingDown = false;

  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[microdesk] shutting down (' + reason + ')');
    if (exitTimer) clearTimeout(exitTimer);
    // The browser window is a separate process tree: leave it to the user.
    server.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }

  server
    .listen()
    .then(() => {
      const url = server.url;
      console.log('');
      console.log('  MicroDesk  ' + cfg.app.name + '  v' + pkg.version);
      console.log('  ' + '-'.repeat(52));
      console.log('  url      ' + url);
      console.log('  rpc      ws://' + cfg.server.host + ':' + server.port + '/ws');
      console.log('  web root ' + (bundledAssets ? 'in-memory (' + bundledAssets.size + ' assets)' : cfg.app.root));
      console.log('');

      if (noOpen) {
        console.log('[microdesk] --no-open: server only. Press Ctrl+C to stop.');
        return;
      }

      const result = win.launch(url, {
        appId: cfg.app.id,
        width: cfg.window.width,
        height: cfg.window.height,
        kiosk: cfg.window.kiosk,
        browser: cfg.window.browser,
        profileDir: cfg.window.profileDir || win.defaultProfileDir(cfg.app.id),
        extraArgs: cfg.window.extraArgs,
        dryRun: dryRun,
        detached: cfg.dev,
        stdio: cfg.dev ? 'inherit' : 'ignore',
        onChildError: (err) => {
          console.error('[microdesk] failed to launch browser: ' + err.message);
          console.error('[microdesk] open this URL manually: ' + url);
        }
      });

      launched = result;
      child = result.child;

      if (dryRun) {
        console.log('[microdesk] dry-run, would execute:');
        if (result.browser) {
          console.log('  "' + result.browser.exe + '" ' + result.args.join(' '));
        } else {
          console.log('  (no chromium browser) fallback to default browser: ' + url);
        }
        console.log('');
        setTimeout(() => shutdown('dry-run'), 50);
        return;
      }

      if (result.mode === 'app') {
        console.log(
          '[microdesk] app window -> ' + result.browser.label + '  (' + result.browser.exe + ')'
        );
        console.log('[microdesk] profile    -> ' + result.profileDir);
      } else {
        console.warn('[microdesk] no Chromium browser found: opened the system default browser.');
        console.warn('[microdesk] the page works, but there is no frameless window. Install Chrome/Edge.');
      }
      console.log('[microdesk] close the window to quit (or Ctrl+C).');
      console.log('');
    })
    .catch((err) => {
      console.error('[microdesk] cannot listen on ' + cfg.server.host + ':' + cfg.server.port);
      console.error('           ' + err.message);
      process.exitCode = 1;
    });

  // Auto-exit: the browser window is the app's lifetime. We detect "no client
  // connected any more" rather than child exit, because Chromium reuses an
  // existing process for the same --user-data-dir and our spawn may exit early.
  const wss = server.wss;
  wss.on('connection', () => {
    everConnected = true;
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
  });
  if (cfg.autoExit && !dryRun) {
    setInterval(() => {
      if (shuttingDown || !everConnected) return;
      if (wss.connections.size === 0) {
        if (!exitTimer) {
          exitTimer = setTimeout(() => {
            if (wss.connections.size === 0) shutdown('last window closed');
          }, 3000);
        }
      }
    }, 2000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function cmdPack(cli) {
  let pack;
  try {
    pack = require('../lib/pack');
  } catch (err) {
    console.error('[microdesk] pack module unavailable: ' + err.message);
    process.exitCode = 1;
    return;
  }
  const cfg = loadConfig(cli);
  pack
    .build({
      root: cfg.app.root,
      appName: cfg.app.name,
      appId: cfg.app.id,
      outDir: cli.out ? path.resolve(process.cwd(), cli.out) : path.join(ROOT, 'dist'),
      version: pkg.version,
      copyNode: bool(cli['copy-node'], false)
    })
    .then((result) => {
      console.log('');
      console.log('  packed -> ' + result.file);
      console.log('  launcher -> ' + result.launcher);
      console.log('  assets   -> ' + result.assets + ' files, ' + Math.round(result.bytes / 1024) + ' KB');
      console.log('');
    })
    .catch((err) => {
      console.error('[microdesk] pack failed: ' + err.message);
      process.exitCode = 1;
    });
}

/* ------------------------------------------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const cli = parseArgs(argv);
  const command = cli._[0] || 'start';

  if (cli.help || cli.version || command === 'help') {
    if (cli.version || command === 'version') {
      console.log(pkg.version);
      return;
    }
    printHelp();
    return;
  }

  switch (command) {
    case 'start':
    case 'run':
      return cmdStart(cli);
    case 'dev': {
      cli.dev = true;
      cli.verbose = true;
      if (cli['auto-exit'] === undefined) cli['auto-exit'] = false;
      return cmdStart(cli);
    }
    case 'doctor':
      return cmdDoctor(cli);
    case 'pack':
    case 'build':
      return cmdPack(cli);
    case 'version':
      console.log(pkg.version);
      return;
    default:
      console.error('[microdesk] unknown command: ' + command);
      printHelp();
      process.exitCode = 1;
  }
}

main();
