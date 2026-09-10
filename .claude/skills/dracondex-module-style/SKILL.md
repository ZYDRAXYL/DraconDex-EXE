---
name: dracondex-module-style
description: Check and enforce DraconDex UI/UX style consistency when adding or changing a function, module, or submodule — verify wiring (nav/selectModule/IPC/preload), i18n locale parity, theme-safe colors, button/modal/toast conventions, and visually compare the new UI against existing modules. Use when creating a new module/panel/feature, reviewing renderer changes, or asked to ตรวจสอบ style/ความสอดคล้องของ UI.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# DraconDex module style & UX consistency

Two tools, run from the repo root (all paths relative to it):

1. **`check.mjs`** — static conformance checker (wiring, i18n, IPC chain, style lint).
2. **The run-dracondex driver** — screenshot the new UI next to existing modules
   and compare with your eyes.

Read [STYLE.md](STYLE.md) (same directory:
`.claude/skills/dracondex-module-style/STYLE.md`) **before writing new UI code**
— it has the copy-paste shapes (`.ph` header, `.li` row, empty state, modal,
detail head) and the module wiring checklist extracted from the real modules.

## Check (agent path)

After any renderer/module change:

```bash
# lint the file(s) you touched + global IPC/i18n checks
node .claude/skills/dracondex-module-style/check.mjs electron/src/renderer/hero.js

# adding a whole module? verify all wiring for it
node .claude/skills/dracondex-module-style/check.mjs --module hero electron/src/renderer/hero.js

# full sweep (baseline table for comparison)
node .claude/skills/dracondex-module-style/check.mjs
```

ERRORs (exit 1) are hard failures: `api.*` call with no preload entry, preload
channel with no `electron/main.js` handler, `t('key')` missing from a locale,
`alert()`/`window.confirm()` usage, missing module wiring. Fix them.

Warnings are metrics — hardcoded colors, Thai literals (untranslated strings),
`<button>` without `.btn`, classes undefined in `style.css`. The existing
codebase has a known baseline (~23 warnings, translation work in progress);
**new code should add zero new warnings.**

## Visual comparison (UX path)

Screenshot the new module/panel AND its closest existing sibling, then look at
both — same sidebar header shape? same empty state? same button hierarchy?

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh \
  "ss 00-nexus" \
  "click .module-item:has-text('Hero')" "wait 500" "ss 01-hero" \
  "click #nav-logo-btn" "wait 300" \
  "click .module-item:has-text('Writer')" "wait 500" "ss 02-writer"
```

Shots land in `tmp-driver-data/shots/`. `#nav-logo-btn` returns to the nexus
between modules. See `/run-dracondex` for the full driver command set
(`click`, `fill`, `eval`, …).

What to compare (the shared chrome every module must have):
- 56px icon rail: module's `<name>-only` icons appear, active state highlighted
- sidebar: search box → `.ph` header (module name + `btn-g btn-i` actions) → `.li` list or `.empty`
- main area: `.empty` (icon + h3 + p) when nothing selected; `.detail-head`
  with color left-border when something is
- theme check: switch theme in settings (⚙ menu) and re-screenshot — hardcoded
  colors show up immediately

## Gotchas

- All renderer code lives in `electron/src/renderer/*.js` (the legacy root `renderer.js`
  was removed in the architecture cleanup).
- `t()` falls back to the raw key, so a key missing from `const L` renders
  literally (this exact bug shipped in writer.js — `t('cancel')` showed
  "cancel" until 2026-07-02). The checker catches it.
- i18n keys must be added to **all 13 locales** including `qd` (the fictional
  "dragonish" one — invent a word matching its tone, e.g. `Vokhal`).
- `sage.js` legitimately has ~20 hex colors (chart palette) and `core.js` has
  a few — warnings there are known baseline, not new debt.
- The checker's unknown-CSS-class warnings include intentionally unstyled
  marker classes (e.g. `table-name-input`) — treat as "check spelling," not
  "must fix."

## Troubleshooting

- Checker reports `api.X() called but electron/preload.js exposes no such path` for
  code that works → you called it as `api.a.b.c()` with a group nesting the
  parser missed; check `electron/preload.js` group braces are one-per-line (house
  format). All 276 current channels parse clean.
- `locale 'xx' missing N key(s) vs en` warnings after you add keys → you added
  to `en` only. Every locale block in `const L` (electron/src/renderer/i18n.js) needs
  the key.
