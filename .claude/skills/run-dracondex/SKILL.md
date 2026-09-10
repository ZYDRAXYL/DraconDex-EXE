---
name: run-dracondex
description: Run, launch, drive, screenshot, or smoke-test the DraconDex Electron desktop app (novel world-building manager). Use when asked to run/start the app, take a screenshot, click through the UI, or verify a renderer/main/db change works in the real app.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# Run DraconDex (Electron app)

DraconDex is an Electron desktop app (vanilla JS renderer + `node-sqlite3-wasm`
via IPC). It is driven programmatically with a Playwright `_electron` batch
driver at `.claude/skills/run-dracondex/driver.mjs`. All paths below are
relative to the repo root. Verified on Windows 11, Electron 42, Node via
Git Bash.

There is also a Flutter port in `flutter/` — that is a separate front-end
and is NOT covered by this skill.

## No Electron binary? Use web-driver.mjs

In sandboxes where the Electron zip cannot be downloaded (GitHub releases
blocked → `electron/ensure-electron.js` fails with 403), use
`.claude/skills/run-dracondex/web-driver.mjs` instead. It runs the **real**
renderer, the **real** `electron/preload.js` mapping, and the **real** db layer
(`electron/main.js` IPC handlers, in-process) inside Playwright Chromium
(pre-installed at `/opt/pw-browsers`); only Electron's shell
(app/BrowserWindow/Menu/dialog) is stubbed. Same command vocabulary and the
same scratch data dir / `shots/` layout as `driver.mjs`, plus a persistent
Chromium profile so `localStorage` (theme, language, active nexus) survives
across invocations like the real app. Not covered: frameless-window chrome,
native dialogs (export/import pickers return `canceled`), and true
multi-process IPC.

## Prerequisites

Node.js + npm (already on PATH). No OS packages needed on Windows.

```bash
npm install   # postinstall runs electron/ensure-electron.js to validate the Electron binary
```

`playwright-core` is a devDependency (drives Electron; downloads no browsers).

## Run (agent path) — the driver

Each invocation launches the app fresh against an **isolated scratch data dir**
(`tmp-driver-data/`, gitignored), runs the given commands, and quits. It never
touches the real dev database in `tmp-user-data/`.

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh \
  "ss 01-nexus" \
  "click .module-item:has-text('Director')" \
  "wait 400" \
  "ss 02-director" \
  "click button[onclick='openProjectModal()']" \
  "waitfor #pn" \
  "fill #pn :: Test Novel" \
  "click button[onclick='createProject()']" \
  "wait 600" \
  "ss 03-created"
```

Screenshots land in `tmp-driver-data/shots/<name>.png` — **Read them and look**.
On any failed command the driver saves `_failure.png`, prints the error, and
exits 1.

Commands (each one argv entry, quoted):

| Command | Effect |
|---|---|
| `ss <name>` | screenshot → `tmp-driver-data/shots/<name>.png` |
| `click <selector>` | click first match (Playwright selectors, `:has-text()` ok) |
| `dragto <src> :: <dst> [:: frac]` | genuine mouse-driven HTML5 drag-and-drop (multi-step mouse move, not a synthetic dispatch) |
| `rclick <selector>` | genuine mouse-driven right-click (fires real `contextmenu`, not synthetic dispatch) |
| `fill <sel> :: <text>` | set input value (note the ` :: ` separator) |
| `upload <sel> :: <filepath>` | real file-input upload via `setInputFiles` (fires a genuine `change` event, exercises `FileReader` handlers end-to-end) |
| `type <text>` / `press <key>` | keyboard input |
| `nextwindow` | follow a window handoff — point later commands at the newly opened window (see "The app opens on the Welcome window" below) |
| `waitfor <selector>` / `wait <ms>` | wait for element / sleep |
| `text <sel>` / `count <sel>` | print innerText / match count |
| `eval <js>` | run in renderer, print JSON (promises awaited) |
| `evalmain <js>` | run in main process; `app`, `BrowserWindow`, `ipcMain` in scope |

Flags: `--fresh` wipes the scratch data dir first; `--data-dir <path>` uses a
different scratch dir.

### Direct DB/IPC checks without clicking

The preload exposes the full IPC surface as `window.api` (`db`, `folder`,
`project`, `category`, `template`, `object`, `timeline`, `relation`, …), and
`eval` awaits promises — so you can assert on state directly:

```bash
node .claude/skills/run-dracondex/driver.mjs "eval window.api.project.getAll(null)"
node .claude/skills/run-dracondex/driver.mjs "evalmain app.getPath('userData')"
```

## Run (human path)

```bash
npm start          # opens the window; uses real dev data in tmp-user-data/; Ctrl-C won't kill Electron — close the window
```

To launch it interactively **without** touching real dev data:

```bash
DRACONDEX_DATA_DIR="$PWD/tmp-driver-data" npm start
```

## Build (portable exe)

```bash
npm run build:portable   # electron-builder dir target → app folder DraconDexPortable/DraconDex-<ver>/ (run DraconDex.exe inside; ~200MB)
npm run build:installer  # NSIS installer → DraconDexPortable/DraconDex-Setup-<ver>.exe (installed builds keep data in appData, not next to exe)
npm run build:exe        # old single-file portable exe (unpacks to %TEMP% on each launch)
```

## Finding selectors

`electron/index.html` is mostly empty shells — the renderer builds all UI at runtime.
Grep `electron/src/renderer/*.js` for `onclick=` to find handlers;
attribute selectors like `button[onclick='openProjectModal()']` are the most
robust click targets. Modal input ids are short (`#pn` project name, `#fn`
folder name, `#cn` category, `#on` object — see `electron/src/renderer/modals.js`).
All UI handler functions are globals, so `eval openProjectModal()` also works.

## The app opens on the Welcome window

Since v4.6.0 `electron/main.js` opens a **Welcome window** (`electron/index.html?welcome=1`,
`body.welcome-mode`) on launch, not the app shell — and boot no longer reopens
the last vault. So the driver's first window is the Welcome screen: a vault
list in the left panel and a hero with recent vaults on the right. Picking one
opens a *second* window (`?nexus=<id>`) and closes the Welcome one, so anything
past that point needs `nextwindow`:

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh \
  "click .welcome-actions .btn-p" "wait 400" \
  "fill #nx-name :: Test Vault" "click .mfoot .btn-p" "wait 1500" \
  "nextwindow" "ss 01-vault-open"
```

`nextwindow` also follows the windows opened by the vault-head switcher
(3 most recent vaults) and its "เปลี่ยน Nexus…" row / the ⇄ button, which both
reopen the Welcome window.

`web-driver.mjs` has no main process to open windows, so it loads `electron/index.html`
bare — the no-vault picker fallback. Use `--query welcome=1` (or
`--query nexus=<id>`) there to reach the mode you want.

## Gotchas

- **Default locale is Thai.** Don't use English `text=` selectors for buttons;
  use `onclick`-attribute selectors or ids. Module tiles (`.module-item`) do
  contain English names (Director, Navigator, Hero, Writer, Sage).
- **Frameless window** (`frame: false`): no OS chrome. Window controls are DOM
  buttons `#win-min` / `#win-max` / `#win-close`.
- **Data isolation is via `DRACONDEX_DATA_DIR`** (dev-mode override added in
  `electron/main.js`). Without it, dev runs use `tmp-user-data/` — the developer's real
  working DB. The driver always sets it; don't point `--data-dir` at
  `tmp-user-data`.
- **Single-instance lock is per data dir** (keyed on `userData`, set from
  `DRACONDEX_DATA_DIR`). The driver coexists with an open dev app, but two
  simultaneous driver runs on the *same* scratch dir make the second instance
  quit silently — the driver then times out at `firstWindow`/`.module-item`
  wait (~15 s). Run driver invocations sequentially.
- **App-ready signal**: driver waits for `.module-item` / `#left-panel-inner
  .ph` / `#hub-body`, which only exist after the renderer boots — on the
  Welcome window that's the vault list header. If you change the boot view,
  update that wait in `driver.mjs` (it is used by `nextwindow` too).
- After `createProject()` the project opens as a title-bar tab and a toast
  (`สร้างโปรเจกต์แล้ว`) appears bottom-right; sidebar `.li` items belong to the
  *previous* Director view, so assert via `eval window.api.project.getAll(null)`
  instead of counting DOM rows.

## Troubleshooting

- `Timeout ... waiting for locator` on a click → selector doesn't exist in the
  current view. Look at `tmp-driver-data/shots/_failure.png` (saved
  automatically) and re-derive the selector from `electron/src/renderer/*.js`.
- `Electron binary is missing or incomplete` → `node electron/ensure-electron.js`
  (or delete `node_modules/electron` and `npm install`).
- Driver hangs ~15 s then fails at startup → another instance already holds the
  lock for that data dir (see single-instance gotcha), or the renderer crashed
  before nexus rendered — run `evalmain BrowserWindow.getAllWindows().length`
  in a fresh invocation to check.
