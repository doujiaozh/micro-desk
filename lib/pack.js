'use strict';
/**
 * MicroDesk :: pack  (md_pack)
 * ---------------------------------------------------------------------------
 * Turn the whole project into ONE runnable file — pure JavaScript, no native
 * compilation, no `pkg`, nothing to install but Node itself.
 *
 *   node bin/microdesk.js pack
 *
 * Produces in ./dist:
 *   microdesk.bundle.js   every lib/*.js + package.json + web/** inlined
 *   MicroDesk.bat         double-click launcher (finds node.exe, starts app)
 *   MicroDesk.vbs         same, but with no console window (the "native" look)
 *   run.sh                the same on macOS / Linux
 *
 * How the bundle works
 *   A tiny CommonJS shim keeps every module in a table keyed by its project
 *   relative path ("lib/core.js"), and re-implements `require` for relative
 *   specifiers. Node built-ins fall through to the real `require`. The web
 *   assets are embedded as base64 and handed to the kernel as an in-memory
 *   Map, so the packaged app has no `web/` folder to lose.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { builtinModules } = require('module');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENTRY_ID = 'bin/microdesk.js';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.microdesk', 'coverage']);
const SKIP_EXT = new Set(['.log', '.pid', '.map']);

/* ------------------------------------------------------------------ */
/* source scanning                                                    */
/* ------------------------------------------------------------------ */

const REQUIRE_RE = /require\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;

function stripShebangAndBom(source) {
  let src = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (src.startsWith('#!')) {
    const nl = src.indexOf('\n');
    src = nl === -1 ? '' : src.slice(nl + 1);
  }
  return src;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

/** Resolve `spec` as Node would, but only inside the project. */
function resolveModule(fromId, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));
  const candidates = [
    base,
    base + '.js',
    base + '.json',
    base + '/index.js',
    base + '/index.json'
  ];
  for (const id of candidates) {
    if (id.startsWith('..')) continue;
    const abs = path.join(PROJECT_ROOT, id);
    if (isFile(abs)) return id;
  }
  return null;
}

function walk(entryId) {
  const modules = new Map();
  const queue = [entryId];
  const warnings = [];

  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const abs = path.join(PROJECT_ROOT, id);
    let source;
    try {
      source = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      warnings.push('cannot read ' + id + ': ' + err.message);
      continue;
    }

    if (id.endsWith('.json')) {
      modules.set(id, { kind: 'json', source: stripShebangAndBom(source) });
      continue;
    }

    const clean = stripShebangAndBom(source);
    modules.set(id, { kind: 'js', source: clean });

    REQUIRE_RE.lastIndex = 0;
    let m;
    while ((m = REQUIRE_RE.exec(clean))) {
      const spec = m[2];
      if (spec[0] !== '.') continue; // builtin or bare package: leave alone
      const childId = resolveModule(id, spec);
      if (!childId) {
        warnings.push('unresolved require("' + spec + '") in ' + id);
        continue;
      }
      queue.push(childId);
    }
  }

  return { modules, warnings };
}

/* ------------------------------------------------------------------ */
/* web assets                                                         */
/* ------------------------------------------------------------------ */

function collectAssets(webRoot) {
  const assets = {};
  const walked = [];

  function walkDir(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walkDir(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(webRoot, abs).split(path.sep).join('/');
      const buf = fs.readFileSync(abs);
      assets[rel] = buf.toString('base64');
      walked.push({ path: rel, bytes: buf.length });
    }
  }

  walkDir(webRoot);
  return { assets, files: walked };
}

/* ------------------------------------------------------------------ */
/* bundle emission                                                    */
/* ------------------------------------------------------------------ */

function indent(source, spaces) {
  const pad = ' '.repeat(spaces);
  return source
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n');
}

function buildPrelude(meta, moduleTable) {
  return `#!/usr/bin/env node
/* ---------------------------------------------------------------------------
 * ${meta.name} — packed with MicroDesk v${meta.version}
 * Generated ${meta.builtAt}. Do not edit: re-run "node bin/microdesk.js pack".
 * ------------------------------------------------------------------------- */
'use strict';

var __MD_ASSETS__ = ${JSON.stringify(meta.assets)};
var __MD_CONFIG__ = ${JSON.stringify(meta.config)};
var __MD_META__ = ${JSON.stringify(meta.meta)};

var __MD_MODULES__ = {
${Object.keys(moduleTable)
  .map((id) => {
    const mod = moduleTable[id];
    if (mod.kind === 'json') {
      return '  ' + JSON.stringify(id) + ': function (module) {\n    module.exports = ' + mod.source.trim() + ';\n  }';
    }
    return (
      '  ' +
      JSON.stringify(id) +
      ': function (module, exports, require, __dirname, __filename) {\n' +
      indent(mod.source.replace(/\s+$/, ''), 4) +
      '\n  }'
    );
  })
  .join(',\n')}
};

(function bootMicroDesk() {
  var path = require('path');
  var fs = require('fs');
  var nodeRequire = require;
  var builtins = ${JSON.stringify(builtinModules)};

  var bundleDir = path.dirname(path.resolve(process.argv[1] || __filename));

  // In-memory web assets: the packaged app ships with no web/ folder.
  var assets = new Map();
  Object.keys(__MD_ASSETS__).forEach(function (key) {
    assets.set(key, Buffer.from(__MD_ASSETS__[key], 'base64'));
  });

  global.__MICRODESK_BUNDLE__ = {
    dir: bundleDir,
    assets: assets,
    config: __MD_CONFIG__,
    meta: __MD_META__
  };

  var cache = Object.create(null);

  function virtual(id) {
    return path.join(bundleDir, id);
  }

  function makeRequire(fromId) {
    return function bundleRequire(spec) {
      if (typeof spec !== 'string' || spec.length === 0) {
        throw new TypeError('require() expects a non-empty string');
      }
      if (spec.charAt(0) !== '.') {
        return nodeRequire(spec); // node builtin (path, http, crypto, ...)
      }
      var base = path.posix.join(path.posix.dirname(fromId), spec);
      var candidates = [base, base + '.js', base + '.json', base + '/index.js', base + '/index.json'];
      for (var i = 0; i < candidates.length; i++) {
        var id = path.posix.normalize(candidates[i]);
        if (__MD_MODULES__[id]) return load(id);
      }
      throw new Error('Cannot find module "' + spec + '" from "' + fromId + '" (packed)');
    };
  }

  function load(id) {
    if (cache[id]) return cache[id].exports;
    var factory = __MD_MODULES__[id];
    if (!factory) throw new Error('module not packed: ' + id);
    var mod = (cache[id] = { exports: {} });
    factory.call(
      mod.exports,
      mod,
      mod.exports,
      makeRequire(id),
      path.dirname(virtual(id)),
      virtual(id)
    );
    return mod.exports;
  }

  load(${JSON.stringify(ENTRY_ID)});
})();
`;
}

/* ------------------------------------------------------------------ */
/* launchers                                                          */
/* ------------------------------------------------------------------ */

const BAT_TEMPLATE = `@echo off
rem ---------------------------------------------------------------
rem  @APP_LABEL@  -  MicroDesk launcher (generated, do not edit)
rem  Finds a Node.js runtime, then starts the bundled app.
rem ---------------------------------------------------------------
setlocal enabledelayedexpansion
set "DIR=%~dp0"
set "BUNDLE=%DIR%microdesk.bundle.js"
set "NODE="

if exist "%DIR%node.exe" set "NODE=%DIR%node.exe"
if not defined NODE if exist "%DIR%node\\node.exe" set "NODE=%DIR%node\\node.exe"
if not defined NODE if exist "%DIR%runtime\\node.exe" set "NODE=%DIR%runtime\\node.exe"

if not defined NODE (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE set "NODE=%%I"
  )
)

if not defined NODE if exist "%ProgramFiles%\\nodejs\\node.exe" set "NODE=%ProgramFiles%\\nodejs\\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\\nodejs\\node.exe" set "NODE=%ProgramFiles(x86)%\\nodejs\\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\\Programs\\nodejs\\node.exe" set "NODE=%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"
if not defined NODE if exist "%APPDATA%\\npm\\node.exe" set "NODE=%APPDATA%\\npm\\node.exe"

if not defined NODE (
  echo.
  echo   [@APP_ID@] Node.js was not found on this machine.
  echo   Install Node.js ^(any 12.x or newer^) and run this file again:
  echo     https://nodejs.org/
  echo.
  echo   No native compilation is required - MicroDesk is pure JavaScript.
  echo.
  pause
  exit /b 9009
)

"%NODE%" "%BUNDLE%" start %*

if errorlevel 1 (
  echo.
  echo   The app exited with code %ERRORLEVEL%.
  pause
)
endlocal
`;

const VBS_TEMPLATE = `' @APP_LABEL@ - launch without any console window (MicroDesk)
Option Explicit
Dim shell, fso, dir, bat
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
bat = dir & "\\@BAT_NAME@"
If Not fso.FileExists(bat) Then
  MsgBox "Launcher not found:" & vbCrLf & bat, 16, "@APP_LABEL@"
  WScript.Quit 2
End If
shell.CurrentDirectory = dir
shell.Run """" & bat & """", 0, False
`;

const SH_TEMPLATE = `#!/bin/sh
# @APP_LABEL@ - MicroDesk launcher (generated, do not edit)
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
BUNDLE="$DIR/microdesk.bundle.js"

if [ -x "$DIR/node" ]; then
  NODE="$DIR/node"
elif command -v node >/dev/null 2>&1; then
  NODE=$(command -v node)
elif [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
elif [ -x /usr/bin/node ]; then
  NODE=/usr/bin/node
else
  echo "[@APP_ID@] Node.js not found. Install Node.js 12+ and retry." >&2
  exit 9009
fi

exec "$NODE" "$BUNDLE" start "$@"
`;

function writeLaunchers(outDir, appName, appId) {
  const batName = 'MicroDesk.bat';
  const bat = BAT_TEMPLATE.replace(/@APP_LABEL@/g, appName)
    .replace(/@APP_ID@/g, appId)
    .replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(outDir, batName), bat, 'utf8');

  const vbs = VBS_TEMPLATE.replace(/@APP_LABEL@/g, appName)
    .replace(/@APP_ID@/g, appId)
    .replace(/@BAT_NAME@/g, batName)
    .replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(path.join(outDir, 'MicroDesk.vbs'), vbs, 'utf8');

  const sh = SH_TEMPLATE.replace(/@APP_LABEL@/g, appName).replace(/@APP_ID@/g, appId);
  const shPath = path.join(outDir, 'run.sh');
  fs.writeFileSync(shPath, sh, 'utf8');
  try {
    fs.chmodSync(shPath, 0o755);
  } catch (_) {}

  return { bat: path.join(outDir, batName), vbs: path.join(outDir, 'MicroDesk.vbs'), sh: shPath };
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

function readConfig() {
  const file = path.join(PROJECT_ROOT, 'microdesk.config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * @param {object} options
 * @param {string} [options.root]     web root (default <project>/web)
 * @param {string} [options.appName]
 * @param {string} [options.appId]
 * @param {string} [options.outDir]   default <project>/dist
 * @param {string} [options.version]
 * @param {boolean} [options.copyNode] copy this node.exe next to the bundle
 */
async function build(options) {
  const opts = options || {};
  const webRoot = path.resolve(opts.root || path.join(PROJECT_ROOT, 'web'));
  const outDir = path.resolve(opts.outDir || path.join(PROJECT_ROOT, 'dist'));
  const pkg = require('../package.json');
  const config = readConfig();

  const appName = opts.appName || (config.app && config.app.name) || pkg.name;
  const appId = opts.appId || (config.app && config.app.id) || 'microdesk-app';
  const version = opts.version || pkg.version;

  if (!fs.existsSync(webRoot)) {
    throw new Error('web root not found: ' + webRoot);
  }

  // 1) module graph
  const entry = path.join(PROJECT_ROOT, ENTRY_ID);
  if (!isFile(entry)) throw new Error('bundle entry missing: ' + entry);
  const { modules, warnings } = walk(ENTRY_ID);

  // 2) web assets
  const { assets, files } = collectAssets(webRoot);

  // 3) bundle
  const meta = {
    name: appName,
    version: version,
    builtAt: new Date().toISOString(),
    assets: assets,
    config: { app: Object.assign({}, config.app, { name: appName, id: appId }), server: config.server || {}, window: config.window || {}, bridge: config.bridge || {} },
    meta: { appId: appId, entry: ENTRY_ID, modules: modules.size, assetCount: files.length }
  };
  const bundleSource = buildPrelude(meta, Object.fromEntries(modules));

  fs.mkdirSync(outDir, { recursive: true });
  const bundleFile = path.join(outDir, 'microdesk.bundle.js');
  fs.writeFileSync(bundleFile, bundleSource, 'utf8');

  // 4) launchers
  const launchers = writeLaunchers(outDir, appName, appId);

  // 5) optional portable runtime
  let runtime = null;
  const wantsRuntime = opts.copyNode || process.env.MICRODESK_COPY_NODE === '1';
  if (wantsRuntime) {
    try {
      const nodeExe = process.execPath;
      const dest = path.join(outDir, path.basename(nodeExe));
      fs.copyFileSync(nodeExe, dest);
      runtime = dest;
    } catch (err) {
      warnings.push('could not copy node runtime: ' + err.message);
    }
  }

  // 6) manifest
  const hash = crypto.createHash('sha256').update(bundleSource).digest('hex');
  const manifest = {
    app: { name: appName, id: appId, version: version },
    builtAt: meta.builtAt,
    bundle: {
      file: path.basename(bundleFile),
      bytes: Buffer.byteLength(bundleSource, 'utf8'),
      sha256: hash,
      modules: modules.size,
      assets: files.length
    },
    launchers: {
      windows: path.basename(launchers.bat),
      windowsSilent: path.basename(launchers.vbs),
      unix: path.basename(launchers.sh)
    },
    runtime: runtime ? path.basename(runtime) : null,
    warnings: warnings
  };
  fs.writeFileSync(path.join(outDir, 'pack-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    file: bundleFile,
    launcher: launchers.bat,
    launchers: launchers,
    assets: files.length,
    bytes: manifest.bundle.bytes,
    modules: modules.size,
    outDir: outDir,
    hash: hash,
    warnings: warnings,
    manifest: manifest
  };
}

module.exports = { build, collectAssets, walk, PROJECT_ROOT };
