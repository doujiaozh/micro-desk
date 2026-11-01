'use strict';
/**
 * MicroDesk :: window  (md_window)
 * ---------------------------------------------------------------------------
 * Finds a Chromium-family browser that is already installed on the machine and
 * launches it in *app mode*:
 *
 *     chrome.exe --app=http://127.0.0.1:PORT --user-data-dir=<isolated profile>
 *
 * The result is a frameless window with no tab strip, no address bar and no
 * bookmarks bar — visually indistinguishable from a native desktop app, but
 * costing zero megabytes of bundled rendering engine.
 *
 * Detection order on Windows:
 *   1. $MICRODESK_BROWSER            (explicit override, wins over everything)
 *   2. App Paths registry keys       (HKLM / HKLM\WOW6432Node / HKCU)
 *   3. URL-handler command keys      (ChromeHTML, MSEdgeHTM, ...)
 *   4. Well-known install folders    (%ProgramFiles%, %LOCALAPPDATA%, ...)
 *   5. PATH lookup                   (where.exe / which)
 *
 * Absolutely no native modules: `reg.exe`, `where.exe` and `fs` only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

/* ------------------------------------------------------------------------ */
/* browser catalogue                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Each entry: id, label, kind ('chromium' | 'shell'), exe names, registry
 * candidates and generic path templates.
 */
const CATALOG = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    kind: 'chromium',
    exe: ['chrome.exe'],
    appPaths: ['chrome.exe'],
    handlers: ['ChromeHTML'],
    paths: [
      '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
      '%ProgramW6432%\\Google\\Chrome\\Application\\chrome.exe'
    ]
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    kind: 'chromium',
    exe: ['msedge.exe'],
    appPaths: ['msedge.exe'],
    handlers: ['MSEdgeHTM'],
    paths: [
      '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
      '%ProgramW6432%\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  },
  {
    id: 'chromium',
    label: 'Chromium',
    kind: 'chromium',
    exe: ['chromium.exe'],
    appPaths: ['chromium.exe'],
    handlers: [],
    paths: [
      '%ProgramFiles%\\Chromium\\Application\\chromium.exe',
      '%ProgramFiles(x86)%\\Chromium\\Application\\chromium.exe',
      '%LOCALAPPDATA%\\Chromium\\Application\\chromium.exe'
    ]
  },
  {
    id: 'brave',
    label: 'Brave',
    kind: 'chromium',
    exe: ['brave.exe'],
    appPaths: ['brave.exe'],
    handlers: ['BraveHTML'],
    paths: ['%ProgramFiles%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe']
  },
  {
    id: 'vivaldi',
    label: 'Vivaldi',
    kind: 'chromium',
    exe: ['vivaldi.exe'],
    appPaths: ['vivaldi.exe'],
    handlers: ['vivaldi'],
    paths: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe']
  },
  {
    id: 'opera',
    label: 'Opera',
    kind: 'chromium',
    exe: ['opera.exe', 'launcher.exe'],
    appPaths: ['opera.exe'],
    handlers: [],
    paths: [
      '%LOCALAPPDATA%\\Programs\\Opera\\launcher.exe',
      '%ProgramFiles%\\Opera\\launcher.exe'
    ]
  },
  {
    id: '360chrome',
    label: '360 Chrome (360极速浏览器)',
    kind: 'chromium',
    exe: ['360chrome.exe', '360ChromeX.exe'],
    appPaths: ['360chrome.exe'],
    handlers: ['360ChromeHTML'],
    paths: [
      '%ProgramFiles(x86)%\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
      '%ProgramFiles%\\360\\360Chrome\\Chrome\\Application\\360chrome.exe',
      '%LOCALAPPDATA%\\360ChromeX\\Chrome\\Application\\360ChromeX.exe',
      '%LOCALAPPDATA%\\360Chrome\\Chrome\\Application\\360chrome.exe'
    ]
  },
  {
    id: 'qqbrowser',
    label: 'QQ Browser (QQ浏览器)',
    kind: 'chromium',
    exe: ['QQBrowser.exe'],
    appPaths: ['QQBrowser.exe'],
    handlers: [],
    paths: [
      '%ProgramFiles(x86)%\\Tencent\\QQBrowser\\QQBrowser.exe',
      '%ProgramFiles%\\Tencent\\QQBrowser\\QQBrowser.exe'
    ]
  }
];

/* macOS / Linux candidates (MicroDesk is cross-platform; Win7 is the target) */
const UNIX_PATHS = {
  darwin: [
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['vivaldi', '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi']
  ],
  linux: [
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/google-chrome-stable'],
    ['chromium', '/usr/bin/chromium'],
    ['chromium', '/usr/bin/chromium-browser'],
    ['edge', '/usr/bin/microsoft-edge'],
    ['edge', '/usr/bin/microsoft-edge-stable'],
    ['brave', '/usr/bin/brave-browser']
  ]
};

const UNIX_BIN = {
  darwin: [
    ['chrome', 'google-chrome'],
    ['edge', 'microsoft-edge'],
    ['chromium', 'chromium']
  ],
  linux: [
    ['chrome', 'google-chrome'],
    ['chrome', 'google-chrome-stable'],
    ['chromium', 'chromium'],
    ['chromium', 'chromium-browser'],
    ['edge', 'microsoft-edge'],
    ['brave', 'brave-browser']
  ]
};

/* ------------------------------------------------------------------------ */
/* low-level probing helpers                                                 */
/* ------------------------------------------------------------------------ */

function expandEnv(p) {
  return p.replace(/%([^%]+)%/g, (whole, name) => {
    const value = process.env[name];
    return value === undefined ? whole : value;
  });
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function looksLikeBrowserPath(p) {
  return /\.(exe|app|sh|bin)$/i.test(p) || isFile(p);
}

function registryDefaultValue(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const line = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^REG_(SZ|EXPAND_SZ|MULTI_SZ)/i.test(l));
    if (!line) return null;
    const value = line.replace(/^REG_(SZ|EXPAND_SZ|MULTI_SZ)\s+/i, '').trim();
    return value || null;
  } catch (_) {
    return null;
  }
}

function registryCommandExecutable(key) {
  const cmd = registryDefaultValue(key);
  if (!cmd) return null;
  const quoted = cmd.match(/^"([^"]+)"/);
  if (quoted) return quoted[1];
  const first = cmd.split(/\s+/)[0];
  return first || null;
}

function whereExe(name) {
  try {
    const flag = IS_WIN ? ['where', [name]] : ['which', [name]];
    const out = execFileSync(flag[0], flag[1], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const first = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first && isFile(first) ? first : null;
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------------ */
/* detection                                                                 */
/* ------------------------------------------------------------------------ */

function detectOnWindows() {
  const results = [];

  for (const entry of CATALOG) {
    const found = [];

    // --- 2. App Paths registry -----------------------------------------
    for (const exeName of entry.appPaths) {
      const keys = [
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeName,
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeName,
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exeName
      ];
      for (const key of keys) {
        const value = registryDefaultValue(key);
        if (value) {
          const expanded = expandEnv(value.replace(/^"|"$/g, ''));
          if (looksLikeBrowserPath(expanded)) found.push({ source: 'registry:' + key, exe: expanded });
        }
      }
    }

    // --- 3. URL handler command ----------------------------------------
    for (const handler of entry.handlers) {
      const key = 'HKCR\\' + handler + '\\shell\\open\\command';
      const exe = registryCommandExecutable(key);
      if (exe && looksLikeBrowserPath(exe)) found.push({ source: 'handler:' + handler, exe });
    }

    // --- 4. Well-known folders -----------------------------------------
    for (const tpl of entry.paths) {
      const expanded = expandEnv(tpl);
      if (isFile(expanded)) found.push({ source: 'path', exe: expanded });
    }

    // --- 5. PATH --------------------------------------------------------
    for (const exeName of entry.exe) {
      const hit = whereExe(exeName);
      if (hit) found.push({ source: 'path-env', exe: hit });
    }

    if (found.length) {
      // De-duplicate by normalised path, keep the first (most authoritative).
      const seen = new Set();
      const unique = found.filter((f) => {
        const key = path.resolve(f.exe).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      results.push({
        id: entry.id,
        label: entry.label,
        kind: entry.kind,
        exe: unique[0].exe,
        source: unique[0].source,
        all: unique
      });
    }
  }

  return results;
}

function detectOnUnix() {
  const results = [];
  const table = UNIX_PATHS[process.platform] || [];
  for (const [id, exePath] of table) {
    if (isFile(exePath)) {
      const entry = CATALOG.find((c) => c.id === id) || { id, label: id, kind: 'chromium' };
      results.push({
        id: entry.id,
        label: entry.label,
        kind: 'chromium',
        exe: exePath,
        source: 'path',
        all: [{ source: 'path', exe: exePath }]
      });
    }
  }
  for (const [id, bin] of UNIX_BIN[process.platform] || []) {
    const hit = whereExe(bin);
    if (hit && !results.some((r) => r.id === id)) {
      const entry = CATALOG.find((c) => c.id === id) || { id, label: id, kind: 'chromium' };
      results.push({
        id: entry.id,
        label: entry.label,
        kind: 'chromium',
        exe: hit,
        source: 'path-env',
        all: [{ source: 'path-env', exe: hit }]
      });
    }
  }
  return results;
}

/**
 * Detect every Chromium-family browser installed on this machine.
 * @returns {Array<{id:string,label:string,kind:string,exe:string,source:string}>}
 */
function detectBrowsers(options) {
  const opts = options || {};
  const found = [];

  const override = opts.browser || process.env.MICRODESK_BROWSER;
  if (override) {
    const exe = override.replace(/^"|"$/g, '');
    if (isFile(exe) || looksLikeBrowserPath(exe)) {
      found.push({
        id: 'custom',
        label: 'Custom browser ($MICRODESK_BROWSER)',
        kind: 'chromium',
        exe,
        source: 'env',
        all: [{ source: 'env', exe }]
      });
    } else {
      found.push({
        id: 'custom',
        label: 'Custom browser (unverified path)',
        kind: 'chromium',
        exe,
        source: 'env',
        all: [{ source: 'env', exe }]
      });
    }
  }

  const rest = IS_WIN ? detectOnWindows() : detectOnUnix();
  for (const r of rest) {
    if (!found.some((f) => path.resolve(f.exe).toLowerCase() === path.resolve(r.exe).toLowerCase())) {
      found.push(r);
    }
  }

  // Chromium-family first, then anything else.
  return found.sort((a, b) => {
    if (a.kind === b.kind) return 0;
    return a.kind === 'chromium' ? -1 : 1;
  });
}

/** Convenience: the browser MicroDesk will actually use. */
function pickBrowser(options) {
  const list = detectBrowsers(options);
  const chromium = list.find((b) => b.kind === 'chromium');
  return chromium || list[0] || null;
}

/* ------------------------------------------------------------------------ */
/* profile / user-data-dir                                                   */
/* ------------------------------------------------------------------------ */

function defaultProfileDir(appId) {
  const base =
    process.env.MICRODESK_PROFILE_DIR ||
    path.join(
      IS_WIN ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local') :
        IS_MAC ? path.join(os.homedir(), 'Library', 'Application Support') :
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
      'MicroDesk',
      'profiles',
      String(appId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
    );
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  return base;
}

/* ------------------------------------------------------------------------ */
/* launching                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * Build the argv for a Chromium app-mode window.
 */
function buildChromiumArgs(url, options) {
  const opts = options || {};
  const args = [
    '--app=' + url,
    '--user-data-dir=' + opts.profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--disable-background-mode'
  ];

  if (opts.width && opts.height) {
    args.push('--window-size=' + opts.width + ',' + opts.height);
  }
  if (opts.position) {
    args.push('--window-position=' + opts.position);
  }
  if (opts.kiosk) {
    args.push('--start-fullscreen');
  }
  if (opts.incognito) {
    args.push('--incognito');
  }
  // Keep app windows from being throttled while backgrounded so the WebSocket
  // bridge stays responsive even when the user is in another window.
  args.push('--disable-background-timer-throttling');
  args.push('--disable-renderer-backgrounding');

  if (Array.isArray(opts.extraArgs)) args.push.apply(args, opts.extraArgs);
  return args;
}

/**
 * Launch the app window.
 *
 * @param {string} url  http://127.0.0.1:PORT/
 * @param {object} options
 * @returns {{mode:'app'|'default-browser', browser:object|null, child:import('child_process').ChildProcess|null, args:string[]}}
 */
function launch(url, options) {
  const opts = options || {};

  if (opts.dryRun) {
    const browser = pickBrowser(opts);
    const profileDir = opts.profileDir || defaultProfileDir(opts.appId);
    const args = browser ? buildChromiumArgs(url, Object.assign({}, opts, { profileDir })) : [];
    return { mode: browser ? 'app' : 'default-browser', browser, child: null, args, dryRun: true };
  }

  const browser = pickBrowser(opts);

  if (browser) {
    const profileDir = opts.profileDir || defaultProfileDir(opts.appId);
    const args = buildChromiumArgs(url, Object.assign({}, opts, { profileDir }));
    const child = spawn(browser.exe, args, {
      detached: !!opts.detached,
      stdio: opts.stdio || 'ignore',
      windowsHide: false
    });
    if (opts.detached && typeof child.unref === 'function') child.unref();
    child.on('error', (err) => {
      if (typeof opts.onChildError === 'function') opts.onChildError(err);
    });
    return { mode: 'app', browser, child, args, profileDir };
  }

  // --- fallback: no Chromium browser. Open in the system default browser. ---
  const fallback = openWithSystemBrowser(url);
  return { mode: 'default-browser', browser: null, child: fallback || null, args: [url] };
}

function openWithSystemBrowser(url) {
  try {
    if (IS_WIN) {
      // `start` is a cmd builtin; empty "" is the window title argument.
      return spawn('cmd', ['/c', 'start', '""', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
    }
    if (IS_MAC) {
      return spawn('open', [url], { detached: true, stdio: 'ignore' });
    }
    return spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  } catch (_) {
    return null;
  }
}

module.exports = {
  detectBrowsers,
  pickBrowser,
  launch,
  buildChromiumArgs,
  defaultProfileDir,
  openWithSystemBrowser,
  CATALOG,
  IS_WIN,
  IS_MAC
};
