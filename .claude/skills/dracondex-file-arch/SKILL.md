---
name: dracondex-file-arch
description: Decide whether a DraconDex file should be split, split it safely, and keep the folder tree tidy — line-count bands as a signal, responsibility as the rule, plus the wiring a split can silently break (script tags, cascade order, duplicate globals, orphan files). Use before adding code to an already-large file, when a file passes ~500 lines, when reorganising folders, after any split, or when asked to แยกไฟล์ / จัดระเบียบไฟล์ / ตรวจว่าไฟล์ใหญ่ไปไหม.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# DraconDex file architecture

One checker, run from the repo root:

```bash
node .claude/skills/dracondex-file-arch/check-arch.mjs              # whole repo
node .claude/skills/dracondex-file-arch/check-arch.mjs electron/src/renderer/hub/tree.js
```

Errors (exit 1) are wiring failures a split can introduce. Notices and warnings
are the size/responsibility signals — they are evidence for a judgement call,
not a to-do list. **Do not split a file just because the checker listed it.**

## When to split

From `Plan.md`, in priority order:

1. **One file, one main job.**
2. **If the part can be named as its own module, split it.**
3. **If you keep folding code or scrolling to find things, it is too big.**
4. **If the code is reusable elsewhere, split it.**
5. **Line count is a signal, not a rule:**

   | lines | what it means |
   |---|---|
   | 0–500 | normal |
   | 500–1000 | check whether it has more than one job |
   | 1000–2000 | start considering a split |
   | 2000+ | re-evaluate — this is doing too much |
   | 4000+ | split, unless it is a data file (i18n, constants, DDL) |

   Split when the file's **responsibilities** outgrow it, not when it merely
   gets long. A 900-line file that does exactly one thing is fine; a 400-line
   file doing four things is not.

Data files are exempt and listed in `DATA_FILES` in the checker
(`electron/src/renderer/i18n.js`, `electron/src/db/schema/{ddl,indexes,seed}.js`,
`electron/css/themes.css`). Adding a new one? Add it there too.

## Where things live

```
electron/main.js electron/preload.js electron/database.js      entry points — the only app .js in the repo root
electron/css/                                14 stylesheets, cascade order = <link> order in electron/index.html
electron/src/renderer/core/                  state, ui primitives, settings, theme, nav, pickers, views, nexus, router, shortcuts
electron/src/renderer/{hub,navigator,hero}/  one folder per split module family
electron/src/renderer/mod/                   the 15 v3 module-kind renderers
electron/src/renderer/*.js                   still-single-file modules (director, writer, scribe, …)
electron/src/db/                             one file per system; schema/ holds DDL, indexes, seed, init, migrations
```

A module family that outgrows one file becomes a **folder**, not
`foo-bar.js` siblings. Keep `electron/src/db` flat except for `schema/`.

## How to split safely (this codebase, specifically)

The renderer has no bundler and no modules — every file is a classic `<script>`
sharing one global scope. That makes splitting cheap and makes four things
load-bearing:

1. **Cut contiguous ranges and keep the original order.** If every new file is a
   verbatim slice and the `<script>`/`<link>` tags stay in sequence, the
   concatenation is byte-identical to the original — evaluation order and CSS
   cascade are then unchanged *by construction*, not by inspection. Prove it:

   ```bash
   # after splitting, this must print nothing
   diff <(cat electron/css/tokens.css electron/css/themes.css …) style.css.orig
   ```

2. **Top-level `const`/`let` are in a cross-script TDZ.** The file that declares
   them must load first (`core/state.js`, `hub/kinds.js`,
   `navigator/shell.js`). Function declarations are hoisted per file, so
   function-to-function calls across files are order-free.

3. **Lazy groups load out of order.** `loadModule()` appends a `<script>` to
   `<head>`, which is async — a folder loaded lazily has *no* intra-group
   ordering. Register it in `LAZY_GROUPS` (`electron/src/renderer/core/views.js`) and
   call `loadGroup(name)`, which awaits all of them, and make sure no file in
   the group reads another file's binding at top level.

4. **`url()` in CSS resolves against the stylesheet.** Moving a rule from a
   root-level file into `electron/css/` turns `url('src/assets/brand/x.png')` into a 404 — it needs
   `../../src/assets/brand/x.png`. The checker enforces this.

For CommonJS (`electron/src/db/`), a split needs real `require`/`module.exports` wiring:
keep the old file as a **façade** that re-exports the same names, so the ~29
`require('./core')` call sites never learn about the change. Watch for
`require('./x')` paths that move a directory deeper, and for the original
file's trailing `module.exports` riding along in the last slice.

## What the checker verifies

| check | severity | why |
|---|---|---|
| size bands + data-file exemption | notice/warn | the Plan.md signal |
| >500 lines with ≥4 banner sections or ≥25 top-level declarations | warning | prints the banner seams a split would follow |
| loose source files in the repo root; db files outside `electron/src/db{,/schema}` | warning | folder conventions |
| every `electron/src/renderer/**/*.js` has a `<script>` tag, a `loadModule()` reference, or a `LAZY_GROUPS` folder | **error** | a split file that nobody loads fails silently |
| no top-level name declared in two renderer files | **error** | one global scope: a duplicate `const` throws, a duplicate `function` silently shadows |
| every `electron/css/*.css` is linked, every link exists, every relative `url()` starts with `../` | **error** | unlinked styles / 404 assets |
| `package.json` `build.files` covers `src`, `css`, `Image`, and the entry files | **error** | a packaged build shipping without its CSS |
| every `electron/src/db/**/*.js` is reachable from `electron/database.js` | **error** | orphan data-layer file |

The duplicate-globals check is not theoretical: it found `flattenModuleTree`
defined differently in `hub/menus.js` and `mod/viewer.js`, with viewer's
zero-argument version winning and making the nest row's "Move to…" menu throw.

## After a split

1. `node .claude/skills/dracondex-file-arch/check-arch.mjs` → 0 errors.
2. `node .claude/skills/dracondex-module-style/check.mjs` → 0 errors, warnings
   not above the baseline (they redistribute across the new files; the total
   can rise slightly because per-file warnings are deduped per file).
3. `node --test 'electron/test/*.test.mjs'`.
4. Drive the real app (`/run-dracondex`) and **read** the screenshots. A bad cut
   shows up in the console as `SyntaxError`, `X is not defined`, or
   `Identifier 'S' has already been declared`, and a CSS mistake shows up as a
   layout that silently differs — compare against a screenshot taken from a
   `git stash` of the pre-split tree.
5. Update `docs/FILES.md` + `docs/Architec.md` (`/write-docs`), and the repo
   layout block in `CLAUDE.md`.
