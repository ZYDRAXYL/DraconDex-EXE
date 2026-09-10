<p align="center">
  <img src="src/assets/brand/DraconDex_Color.png" alt="DraconDex logo" width="160">
</p>

<h1 align="center">DraconDex</h1>

<p align="center">
  A desktop app for organizing world-building data for novels — characters,
  places, timelines, relationships, and free-form notes.
</p>

<p align="center">
  <em>แอปจัดการข้อมูลโลกในนิยาย — ตัวละคร, สถานที่, ไทม์ไลน์, ความสัมพันธ์,
  และโน้ตอิสระ (ภาษาไทยเป็นภาษาหลักของแอป)</em>
</p>

---

## What is DraconDex

DraconDex is an **Electron** desktop app (`"Novel data management app"` per
`package.json`) for novelists and world-builders. It stores characters,
places, timelines, relationships, game/story design data, and free-form
Obsidian-style markdown notes with `[[wikilinks]]`, all in local SQLite
files — no account, no cloud, no internet required.

The default UI language is **Thai**, with **18 locales** supported
(`en`, `ja`, `ko`, `th`, `zh`, `vi`, `id`, `es`, `pt`, `fr`, `de`, `ru`,
`it`, `nl`, `pl`, `uk`, `tr`, and `qd` — a fictional "dragonish" placeholder
locale).

### Three front-ends, one schema — and this repo is one of them

**This repository holds the Windows desktop app only.** DraconDex was one
monorepo until 2026-09-10; it is now seven repositories with one job each.

| Runs on | Repository | Status |
|---|---|---|
| Windows desktop | **this repo** — Electron + vanilla JS | The lead front-end; everything lands here first |
| Android / iOS | [DraconDex-APK](https://github.com/ZYDRAXYL/DraconDex-APK) — Flutter + Riverpod | Behind the desktop app |
| Browser / PWA | [DraconDex-PWA](https://github.com/ZYDRAXYL/DraconDex-PWA) — builds both of the above for the web | Works, including local storage |

All of them open the same SQLite vault format, generated for each side from a
single `vault.sql` in [DraconDex-SDB](https://github.com/ZYDRAXYL/DraconDex-SDB).
This repo vendors its share of that output under `src/schema/generated/` and
pins the version in `sdb.lock.json`.

| | |
|---|---|
| [DraconDex-APP](https://github.com/ZYDRAXYL/DraconDex-APP) | the hub — documentation, the chain contract, shared Claude tooling |
| [DraconDex-PKG](https://github.com/ZYDRAXYL/DraconDex-PKG) | downloadable theme / language / view packages |
| [DraconDex-WEB](https://github.com/ZYDRAXYL/DraconDex-WEB) | the website, and the public release mirror the app's update check reads |

> หมายเหตุ: เวอร์ชัน Flutter (มือถือ/เว็บ) ยังพัฒนาตามหลังเวอร์ชัน Electron
> อยู่ — ฟีเจอร์บางส่วน (เช่น v3 module tree, plugin, wikilink) ยังไม่มี
> ในฝั่งนั้น ดูที่ DraconDex-APK

## Features

- **One file per world.** Since v4.9.0 the store is `app.ddx` (app-level
  settings, plugins, the vault registry) plus one `<name>-<id>.ddx` per
  Nexus under `vaults/`. A vault file is self-contained: put one world on a
  flash drive, or hand it to someone else, without shipping the rest of your
  data — or your saved Google credentials — along with it. See
  [docs/VAULTS.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/VAULTS.md).
- **A module tree you build yourself.** A Nexus holds a tree of module
  nodes ("Nexus nest"), each node picking one of 15 kinds (collector,
  manager, inspector, classifier, locator, chronicler, wanderer, narrator,
  author, scribe, drafter, viewer, connector, sketcher, designer). The old
  fixed modules Director / Navigator / Hero / Writer were **removed in
  v4.10.0** — old data isn't stranded, though: a boot-time prompt (and
  *Settings → App-data → Database*) still converts a pre-v3 vault into the
  module tree.
  What survives of the other legacy modules now lives inside the v3 system:
  Scribe is the note editor, Sage's force graph draws relations, and Artisan
  is the wizard that builds modules from templates.
- **Obsidian-style `[[wikilinks]]`** with backlinks across all note content.
- **Maps, timelines, dialogue graphs, sketching and diagramming canvases**
  built on vendored D3 and Konva (offline-first — no CDN dependency
  required at runtime).
- **Three workspace styles** over the same module tree — Drake (nav rail +
  tree panel + split panes), Wyvern (a stripped-down toolbar with
  breadcrumb drill-down), and Dragon (an ERP-style console with KPI tiles,
  search, and card/table views).
- **Theming and 18 languages** — four built-in themes (daylight, moonlight,
  midnight, rainbow) plus custom themes you can edit, import and export as
  palettes.
- **Sandboxed plugins**, installed by pasting a single `.git` link. Each
  plugin gets its own database tables and runs in a separate, tightly
  restricted window. See [docs/PLUGINS.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/PLUGINS.md) and the
  [plugin template](https://github.com/ZYDRAXYL/DraconDex-PGI-Template).
- **Portable by design** — the portable build keeps your data next to the
  executable, so a whole project folder travels on a flash drive.
- **Backups you own.** Everything works fully offline: export/import the
  whole database, a single Nexus, or one module subtree as a file. The
  cloud path is **Google Drive backup** over OAuth with the `drive.appdata`
  scope — a hidden per-app folder, so DraconDex can never see the rest of
  your Drive. You supply your own Google OAuth client; there is no DraconDex
  server in the loop. See [docs/DRIVE.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/DRIVE.md).
  <br>A second cloud feature, Supabase **Cloud Sync**, is off by default but
  no longer hard-disabled: the in-app *"set up your own Supabase project"*
  page takes a project URL + publishable key, checks what's there and
  installs the schema for you, and finishing that setup unlocks the feature.
  See [docs/SYNC.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/SYNC.md) §0.
- **Update notice, not an auto-updater.** The desktop app checks the public
  release mirror and tells you a newer version exists; installing is your
  call. The Android build can download and hand the APK to the system
  installer. See [docs/UPDATE.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/UPDATE.md).

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron (`contextIsolation: true`, `nodeIntegration: false`) |
| Renderer (UI) | Vanilla JS — no framework, HTML built as strings |
| Data layer | `node-sqlite3-wasm`, accessed from the renderer via Electron IPC |
| Mobile / web port | Flutter + Riverpod, in [DraconDex-APK](https://github.com/ZYDRAXYL/DraconDex-APK) |
| Shared contract | `src/schema/vault.sql` → generated DDL for both sides |

## Getting started (desktop / dev)

Requirements: Node.js and npm.

```bash
npm install     # postinstall runs electron/ensure-electron.js to validate the Electron binary
npm start       # launches the app against local dev data in tmp-user-data/
```

`npm start` runs `electron/start.js` and opens the app against an isolated dev
database in `tmp-user-data/` (override with the `DRACONDEX_DATA_DIR`
environment variable). Note that pressing Ctrl-C in the terminal won't
close the Electron window — close the window itself to stop the app.

If you change a vault table, edit [`src/schema/vault.sql`](src/schema/vault.sql)
in [DraconDex-SDB](https://github.com/ZYDRAXYL/DraconDex-SDB) and regenerate
there, then move this repo's pin — CI fails if the vendored copy drifts:

```bash
npm run sdb:check    # do the vendored artifacts match the pinned SDB release?
npm run sdb:vendor   # re-fetch them, or --ref sdb-vX.Y.Z to move the pin
```

## Building

```bash
npm run build:portable    # electron-builder dir target (portable app folder)
npm run build:exe         # legacy single-file portable .exe
npm run build:installer   # NSIS installer (DraconDexPortable/DraconDex-Setup-<version>.exe)
```

- `build:portable` produces a portable app folder (roughly 200–220 MB) at
  `DraconDexPortable/DraconDex-<version>/`. Copy that whole folder to a
  flash drive and run `DraconDex.exe` on any Windows PC — no install
  needed, and your data (kept in `novel-manager-data` next to the exe)
  travels with the folder.
- `build:installer` builds a Windows installer with a normal
  install/uninstall flow (choose install folder, desktop + Start Menu
  shortcuts). Installed data is kept in
  `%APPDATA%/DraconDex/novel-manager-data/`, so it survives
  uninstall/update.
- `build:exe` builds the older single-file portable `.exe` instead of the
  `build:portable` folder target.

### Releases

All three build types are produced on Windows by the **"Build Electron
(Windows)"** GitHub Actions workflow
(`.github/workflows/build-electron.yml`) and published as GitHub release
assets:

| Asset | From |
|---|---|
| `DraconDex-Setup-<version>.exe` | `build:installer` |
| `DraconDex-Portable-<version>.exe` | `build:exe` |
| `DraconDex-<version>-win-x64.zip` | `build:portable` (zipped app folder) |
| `checksums-sha256.txt` | SHA-256 of the three assets above |

To cut a release, bump `version` in `package.json`, then push a matching
tag:

```bash
git tag v4.13.4
git push origin v4.13.4
```

The workflow builds, runs the regression tests, and creates the release
with auto-generated notes. A manual run (Actions tab → **Build Electron
(Windows)** → *Run workflow*) does the same and defaults to a **draft**
release; it takes an optional tag (defaults to `v<package.json version>`)
and a pre-release toggle. Pull requests that touch app or build files only
build and upload the same assets as a workflow artifact — nothing is
published.

Android releases use the same pattern in `build-apk.yml`, under their own
`flutter-v*` tag prefix (the Electron `package.json` version and the Flutter
`pubspec.yaml` version are independent numbers), and only publish APKs that
pass a signing check.

#### Public release mirror

**This repository is private, so download links point at a mirror.** Every
release published here is re-published to
[**ZYDRAXYL/DraconDex-WEB**](https://github.com/ZYDRAXYL/DraconDex-WEB/releases) —
the [project website](https://zydraxyl.github.io/DraconDex-WEB/)'s own repo — by a
`mirror` job in both build workflows (plus `mirror-releases.yml` for
backfilling or re-mirroring a single tag). It needs a `WEB_REPO_TOKEN` secret
with `contents: write` on that repo.

Everything public reads that one mirror:

- **Both apps' in-app update checks** — `electron/src/db/update.js` and
  DraconDex-APK's `flutter/lib/data/services/update_service.dart`.
- **The website's download pages.** After mirroring,
  `.github/scripts/update-web-releases-json.sh` snapshots that repo's release
  list into `assets/data/releases.json` inside it (via the Contents API, no
  checkout needed), so the pages read a same-origin static file instead of
  calling `api.github.com` from every visitor's browser — removing the
  anonymous 60 req/hour per-IP rate limit as a failure mode when traffic
  spikes.

The mirror exists because a private repo's GitHub API answers `404` to everyone
without a token, which used to make update checks and the download page fail
silently. See [docs/UPDATE.md](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/UPDATE.md) §2.17.

A second mirror, [`ZYDRAXYL/DraconDex-REL`](https://github.com/ZYDRAXYL/DraconDex-REL/releases),
predates this and is still filled by the same `mirror` job when a
`RELEASE_REPO_TOKEN` secret is present. Nothing reads it any more — the update
checks moved to `DraconDex-WEB` so a release lands in one place and one token
has to be kept alive rather than two. Leaving that secret unset simply skips
the step.

### GitHub Packages (npm)

The app source is also published as the npm package
**`@zydraxyl/dracondex`** to GitHub Packages by the **"Publish package (GitHub
Packages)"** workflow (`.github/workflows/publish-package.yml`). Publishing a
GitHub release runs it automatically, so a release carries both the Windows
installers above and the package; a manual run can publish the current
`package.json` version on its own, or just pack the tarball to inspect it
(*dry run*).

The tarball is the app itself — everything under `electron/` except its
tests, plus the shared brand assets in `src/assets/brand/` and the generated
schema in `src/schema/generated/` (~3 MB). It is **not** a library: there is
nothing to `import`, and it is meant for consuming the sources
programmatically (vendoring, plugin tooling, running from source). Most
people want the installer from
[Releases](https://github.com/ZYDRAXYL/DraconDex-WEB/releases) instead.

GitHub Packages requires npm authentication in every case, and the package
inherits this repo's visibility — so installing needs a personal access
token with `read:packages` and access to this repository:

```bash
# ~/.npmrc
@zydraxyl:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_TOKEN
```

```bash
npm install @zydraxyl/dracondex
```

Electron is a *dev* dependency, so it is not pulled in by that install —
`npm start` from the package needs `npm install` in a full checkout.

## Mobile and web builds

They live in their own repositories now:

- **Android / iOS** — [ZYDRAXYL/DraconDex-APK](https://github.com/ZYDRAXYL/DraconDex-APK).
  One Flutter source tree; `flutter build apk --release --split-per-abi`, or the
  "Build Flutter APK" workflow there.
- **Browser / PWA** — [ZYDRAXYL/DraconDex-PWA](https://github.com/ZYDRAXYL/DraconDex-PWA),
  which puts both front-ends behind one router (`/d/` = this app running in a
  page, `/m/` = the Flutter web build) and picks by device.

### Moving data between desktop and mobile

The two sides share table definitions, not a file layout: this app keeps one
`.ddx` file per Nexus (plus `app.ddx`), while the Flutter app keeps everything in
a single `novel-manager.db`. See `docs/VAULTS.md` in DraconDex-APP.

## Project structure

```
electron/                  THE APP
  main.js                  main process — window creation, all IPC handlers (delegates to database.js)
  preload.js               contextBridge — exposes window.api.<namespace>.<fn>, 1:1 with main.js channels
  database.js              require()s + re-exports everything in src/db/*.js as one object
  index.html               near-empty HTML shell; loads css/ and every renderer script IN ORDER
  css/                     all styling (tokens → themes → base → chrome → layout → components → v3)
  src/db/                  data layer (runs in main process), one file per system
  src/db/schema/           ddl.js / indexes.js / seed.js / init.js / migrations.js
  src/renderer/            UI layer, one file per system
  src/renderer/core/       global state, UI primitives, settings/theme, nav, routing, welcome window
  src/renderer/hub/        the v3 Hub: kind registry, nest tree, menus, module CRUD
  src/renderer/mod/        UI layer for the 15 v3 "module kind" renderers
  vendor/                  vendored D3 + Konva (offline-first; unpkg CDN is fallback only)
  scripts/                 build/packaging helper scripts
  test/                    node --test regression tests

src/                       VENDORED from DraconDex-SDB — generated, do not hand-edit
  assets/brand/            logo/icon set; electron/css resolves it through url(../../src/assets/brand/…)
  schema/generated/        the vault DDL, generated from SDB's vault.sql
sdb.lock.json              which SDB release those vendored files came from

chain/                     the multi-repo contract (mirrored from DraconDex-APP)
tools/                     chain survey/propagate + the SDB pin check
package.json               "main" points at electron/main.js
```

> `electron/` stays a subdirectory on purpose. `electron/css` resolves brand
> images through `url(../../src/assets/brand/…)` and `ddl.js` requires
> `../../../../src/schema/generated/…`; keeping the prefix and vendoring `src/`
> beside it makes every relative path byte-identical to the monorepo.

## Testing and checks

```bash
node --test 'electron/test/*.test.mjs'   # note the glob — `node --test electron/test/` fails
npm run sdb:check                        # vendored DraconDex-SDB artifacts match the pinned release
```

There is no linter configured for this project. Two project-specific static
checkers cover the conventions a linter would not
(`.claude/skills/dracondex-module-style/check.mjs` for UI wiring, IPC/preload
parity and i18n locale parity, `.claude/skills/dracondex-file-arch/check-arch.mjs`
for file organization), and correctness is otherwise verified by driving the
real Electron app.

## Documentation

This repo keeps detailed, actively-maintained docs under `docs/`, written
in **Thai** (the project's primary language):

| Doc | Covers |
|---|---|
| [`docs/Architec.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/Architec.md) | Module-tree / v3 architecture, kind ↔ file ↔ IPC mapping |
| [`docs/SYSTEMS.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/SYSTEMS.md) | How each system behaves (Nexus, Scribe, wikilinks, IDE shell, workspace styles, security) |
| [`docs/FILES.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/FILES.md) | What's in each file, line-by-line responsibilities |
| [`docs/CHANGELOG.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/CHANGELOG.md) | History of what changed and why, session to session |
| [`docs/VAULTS.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/VAULTS.md) | Per-Nexus `.ddx` files, vault routing, the split migration |
| [`docs/DRIVE.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/DRIVE.md) | Google Drive backup |
| [`docs/CLOUD.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/CLOUD.md) | The cloud-provider seam (a contract written ahead of any new backend) |
| [`docs/SYNC.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/SYNC.md) | Cloud Sync / Supabase Token Sync, and the "bring your own Supabase project" setup that unlocks it |
| [`docs/PLUGINS.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/PLUGINS.md) | Sandboxed plugin runtime, installed from a git repo link |
| [`docs/PWA.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/PWA.md) | Flutter web / PWA build — storage, `dart:io` splits, tablet layout |
| [`docs/UPDATE.md`](https://github.com/ZYDRAXYL/DraconDex-APP/blob/main/docs/UPDATE.md) | Update-check notice (not an auto-updater) and the release mirror |

> เอกสารเหล่านี้เขียนเป็นภาษาไทยโดยตั้งใจ ให้สอดคล้องกับภาษาไทยที่เป็น
> ภาษาหลักของโปรเจกต์

## Contributing / AI-assisted development

This repo is developed with heavy use of [Claude Code](https://claude.com/claude-code).
[`CLAUDE.md`](CLAUDE.md) documents the architecture and conventions for AI
assistants (and human contributors) working in this codebase, and
`.claude/skills/` contains nine project-specific skills — including a driver
for running/screenshotting the real app (`run-dracondex`), static checkers
for UI/UX wiring conventions (`dracondex-module-style`) and file
organization (`dracondex-file-arch`), a doc-sync workflow (`write-docs`),
version/release helpers (`version-update`, `build-release-git`,
`procress-writing`), and UI/UX research audits (`ui-researcher`,
`ux-researcher`, also available as `.claude/agents/` subagents).

## License

[MIT](LICENSE)
