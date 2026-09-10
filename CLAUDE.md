# CLAUDE.md — DraconDex-EXE

Guidance for Claude Code working in this repo. Read `chain/README.md` and the
`multi-repository-architecture` skill first if you have not.

## What this is

The **Electron desktop app**. It was `electron/` inside the DraconDex monorepo
until the 2026-09-10 split; the directory prefix is deliberately unchanged, and
so is everything under it.

The renderer is **vanilla JS** (no framework) that builds all UI as HTML strings;
the data layer is `node-sqlite3-wasm` behind Electron IPC. Default UI language is
**Thai**, with 18 locales.

```
electron/main.js           main process — window creation, ~470 IPC handlers
electron/preload.js        contextBridge — the best table of contents for what the renderer can do
electron/database.js       re-exports every src/db/*.js as one object
electron/index.html        HTML shell; loads css/ and every renderer script IN ORDER
electron/css/              15 files. ORDER IS THE CASCADE
electron/src/db/           data layer (main process), one file per system
electron/src/renderer/     UI layer; core/ hub/ navigator/ hero/ mod/
electron/vendor/           vendored D3 + Konva (offline-first)
electron/test/             node --test regression tests

src/assets/brand/          VENDORED from DraconDex-SDB — do not hand-edit
src/schema/generated/      VENDORED from DraconDex-SDB — do not hand-edit
sdb.lock.json              which SDB release those vendored files came from
```

## Why `electron/` is still a subdirectory

Because flattening it would break three things at once, silently, at runtime:

- `electron/css/*.css` resolves brand images through `url(../../src/assets/brand/…)`
- `electron/src/db/schema/ddl.js` requires `../../../../src/schema/generated/vault-ddl.electron.js`
- `package.json`'s `main` is `electron/main.js`, which is also how
  `run-dracondex`'s driver launches the app (it passes the repo root as argv)

Keeping the prefix and vendoring `src/` beside it makes every relative path
byte-identical to the monorepo. **Do not flatten this.**

## The vendored files are not yours to edit

`src/schema/generated/` and `electron/src/db/supabase-schema.js` are generated in
`ZYDRAXYL/DraconDex-SDB` from `schema/vault.sql` there. Editing them here is
overwritten on the next vendor and, worse, reddens `npm run sdb:check` for a
reason nobody can find.

```bash
npm run sdb:check    # do the vendored files match the pinned SDB release?
npm run sdb:vendor   # re-fetch them, or move the pin with --ref sdb-vX.Y.Z
```

A schema change starts in SDB. `chained-updated` opens the PR that moves the pin
here.

## Dev workflow

```bash
npm install                # postinstall validates/repairs the Electron binary
npm start                  # runs against dev data in tmp-user-data/
npm run build:portable     # electron-builder dir target
npm run build:exe          # single-file portable exe
npm run build:installer    # NSIS installer
```

There is **no linter**. Correctness is verified by running the app and by the two
static checkers:

```bash
node .claude/skills/dracondex-file-arch/check-arch.mjs      # wiring, orphans, cascade
node .claude/skills/dracondex-module-style/check.mjs        # i18n parity, api wiring, theme safety
node --test 'electron/test/*.test.mjs'                      # note the glob
```

## Verify changes by driving the real app

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh "ss 01-before" \
  "click .module-item:has-text('Director')" "wait 400" "ss 02-after"
```

Screenshots land in `tmp-driver-data/shots/` — **read them**. A path that broke
renders blank rather than throwing. Default locale is Thai, so don't rely on
English `text=` selectors.

## Conventions the checkers enforce

- Every `window.api.<ns>.<fn>()` needs a matching `preload.js` entry and a
  matching `main.js` handler.
- Every `t('key')` must exist in **all 18 locale blocks** in `i18n.js`. A missing
  key renders as the literal key string, not an error — easy to miss by eye.
- Never `alert()` / `window.confirm()` — use `openModal`/`closeModal`, `toast()`,
  `uiConfirm()` from `core.js`.

Warnings are metrics against a baseline (42 as of the split). New code should add
zero new warnings; don't chase the pre-existing ones unless asked.

## Releases

Tag `vX.Y.Z`; `build-electron.yml` builds the installer, the portable exe and the
portable zip, publishes the release, and mirrors it to `DraconDex-WEB` — which is
where the in-app update check reads from, because this repo is private and
`api.github.com` answers 404 to everyone without a token.

`flutter-v*` belongs to `DraconDex-APK`. Never publish under that prefix here:
both apps' update checkers filter one shared release list by prefix, and getting
it wrong offers an Android build as a Windows update.

## Where the project's docs live

`docs/` stayed in `ZYDRAXYL/DraconDex-APP` — Architec.md, SYSTEMS.md, FILES.md,
CHANGELOG.md, VAULTS.md, PLUGINS.md, SYNC.md, DRIVE.md, UPDATE.md. They are in
Thai; that is intentional. So does the pre-split history of every file here.
