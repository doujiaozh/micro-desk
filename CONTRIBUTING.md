# Contributing to MicroDesk

Thanks for helping. MicroDesk has one hard rule that everything else follows from:

> **No native code. Ever.**

No `node-gyp`, no WebView2, no Rust, no prebuilt binaries. If a feature needs any of those, it belongs in another project. This is what keeps MicroDesk installable on a Windows 7 box with 8 GB of RAM and a plain Node.js.

## Ground rules

1. **Zero runtime dependencies.** `package.json` must keep `"dependencies": {}`. HTTP, WebSocket, MIME, RPC and packing are already hand-written in `lib/`.
2. **Node 12 compatible.** No optional chaining (`?.`), no nullish coalescing (`??`), no `fs.rm`, no top-level `await` outside an async IIFE. `Object.assign` and `Promise` are fine.
3. **Windows 7 is a first-class target.** Don't assume `curl`, PowerShell 7, long paths, or modern TLS.
4. **Bilingual docs.** User-facing docs (README, CLI help) are Chinese + English. Code comments may be English only.
5. **No build step.** What you write is what runs: `node bin/microdesk.js start`.

## Getting started

```bash
git clone https://github.com/<you>/micro-desk.git
cd micro-desk
node bin/microdesk.js doctor     # check browser detection on your machine
node tests/smoke.js              # 32 assertions, no framework
node bin/microdesk.js start      # real window
```

`node tests/smoke.js` must stay green on Node 12/16/18/20 under Windows and Linux. It covers the HTTP surface, a hand-rolled WebSocket client, every RPC error path, and window argument construction — so a failing assertion usually points at the exact line that broke.

## Project layout

| Path | What lives there |
|---|---|
| `lib/core.js` | HTTP kernel, routing, static serving, SPA fallback |
| `lib/websocket.js` | RFC 6455 server (frames, fragmentation, masking, ping/pong) |
| `lib/bridge.js` | RPC method table, permission gates, `define()` for custom methods |
| `lib/window.js` | Browser detection + `spawn` with `--app=` / `--user-data-dir=` |
| `lib/pack.js` | Module walker, asset inliner, launcher templates |
| `lib/util.js` | `safeCall` wrappers — old Windows / restricted sandboxes make `os` calls throw |
| `bin/microdesk.js` | CLI: `start` / `dev` / `doctor` / `pack` |
| `web/` | The default app (Workbench) and the browser SDK |
| `examples/hello/` | Smallest possible app, used as living documentation |
| `tests/smoke.js` | The single test file |

## Adding an RPC method

```js
// lib/bridge.js, inside _registerBuiltins()
this.define('db.query', async function (sql, params, ctx) {
  this._perm('db', ctx);              // optional permission gate
  return myDb.query(sql, params || []);
}, { description: 'run a SQL query' });
```

Rules:

- Return a value or a Promise. Throw to reject — errors are normalised to `{ code, message, data }`.
- `code` should be a stable string (`ENOENT`, `EACCES`, `EFBIG`, `ENOMETHOD`) so UI code can branch on it.
- Anything that touches the filesystem must go through `resolvePath()` so the optional sandbox root is respected.
- Anything that runs a command must default to `execFile` (no shell). Shell access is a separate, explicit method.
- Add a `description` — it shows up in `/__microdesk/manifest` and in the Workbench dropdown.
- Add an assertion to `tests/smoke.js`. A method without a test does not exist.

## Adding a browser

Append to `CATALOG` in `lib/window.js`:

```js
{
  id: 'mybrowser', label: '我的浏览器',
  exe: 'mybrowser.exe',
  registry: 'mybrowser.exe',          // App Paths key name, if any
  handler: 'MyBrowserHTML',           // URL protocol handler, if any
  chromium: true,                     // only Chromium supports --app=
  paths: ['%ProgramFiles%\\MyBrowser\\Application\\mybrowser.exe']
}
```

Then run `node bin/microdesk.js doctor` and check the detection order and `source` column.

## Commits

Conventional commits, one logical change per commit:

```
feat(bridge): add fs.copyFile
fix(window): respect MICRODESK_BROWSER on win32
docs: clarify auto-exit behaviour
```

Before opening a PR:

```bash
node tests/smoke.js
node bin/microdesk.js doctor        # must still detect a browser (or say NONE, don't crash)
node bin/microdesk.js pack --out dist-check && node dist-check/microdesk.bundle.js start --dry-run
```

## License

MIT. By contributing you agree to license your work under the same terms.
