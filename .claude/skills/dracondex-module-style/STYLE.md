<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# DraconDex UI/UX conventions

Extracted from the real code (`electron/src/renderer/*.js`, `style.css`, `electron/index.html`)
— every pattern below is what the existing 5 modules actually do. Paths are
relative to the repo root.

## Files that matter (and one that doesn't)

- `electron/src/renderer/i18n.js` — i18n data: locale dict `const L` (13 languages),
  `LANGUAGE_LABELS`, `COMMON_UI_TEXT`. Loaded before core.js.
- `electron/src/renderer/core.js` — app shell: nexus home, `selectModule()`, sidebar,
  `t()`, `toast()`, `confirmBox()`, `openModal()`, icon
  dict `I`, escape helper `x()`, `loadModule()`.
- `electron/src/renderer/<module>.js` — one file per module (director, navigator, hero,
  writer, sage) + shared panels (modals, timeline, map, relation, hashtag, search).
- `electron/src/db/<module>.js` → spread into `electron/database.js` → IPC in `electron/main.js`
  (`h('group:method', fn)`) → exposed in `electron/preload.js` (`inv('group:method')`)
  → called as `api.group.method()` in renderer.
- `electron/index.html` loads `electron/src/renderer/i18n.js` + `core.js` + `director.js` +
  `modals.js` + `search.js`; other modules lazy-load via `loadModule()`.
  (The legacy root `renderer.js` was removed — all renderer code lives in
  `electron/src/renderer/`.)

## Design tokens — never hardcode colors

`style.css` `:root` + 8 theme overrides. Any hardcoded hex breaks theme
switching. Use:

`--bg --surface --raised --hover --border` (surfaces) · `--t1 --t2 --t3`
(text tiers) · `--accent --accentH --danger --success` · radii `--r`(8px)
`--rs`(4px) `--rl`(12px) · `--nav`(56px) `--sidebar`(264px) · `--ease`.

The ONLY sanctioned hex is the user-data color fallback: `g.color_code || '#6366f1'`.

## Layout chrome every module lives in

```
#title-tab-bar   frameless drag bar: project tabs, settings, #win-min/#win-max/#win-close
#nav-sidebar     56px icon rail: module icons (top), import/export/tags/colors utils (bottom)
#left-panel      264px sidebar: search box, then module content → q('#left-panel-inner')
#main-area       detail area → q('#main-inner')
```

A module renders its sidebar into `#left-panel-inner` and its detail into
`#main-inner`. It does not create new top-level layout.

## Module anatomy — the wiring checklist (checked by check.mjs --module)

1. `electron/index.html`: nav rail buttons `class="nav-btn <name>-only"` with
   `style="display:none"`, plus you rely on core.js to toggle them.
2. `electron/src/renderer/core.js`:
   - module tile in `renderNexusHome()`: `<div class="module-item" onclick="selectModule('<name>')">`
   - branch in `selectModule()`: set `S.view`, clear `.nav-btn` actives,
     `loadModule('electron/src/renderer/<name>.js').then(() => render<Name>View())`
   - visibility block: toggle `.nav-btn.<name>-only` like the others
   - state reset in `returnToNexus()`
   - i18n keys added to **all 13 locales** in `const L` (en ja ko th zh vi id es pt fr de ru qd)
3. `electron/src/renderer/<name>.js`: entry `render<Name>View()` — sets
   `S.view`/`S.activeModule`, renders `.ph` header + list into
   `#left-panel-inner`, detail/empty into `#main-inner`, ends with
   `updateTopNavButton()`.
4. `electron/src/db/<name>.js` exporting plain functions; spread into `electron/database.js`.
5. `electron/main.js`: `h('<group>:<method>', ...)` per operation.
6. `electron/preload.js`: `<group>: { method: (...) => inv('<group>:<method>', ...) }`.

## UI primitives (copy these shapes)

Sidebar header — module name + icon actions:
```js
let h = `<div class="ph"><h4>${t('hero')}</h4>
  <button class="btn btn-g btn-i" onclick="openGameModal()" title="${t('gameNew')}">${I.plus}</button>
</div>`;
```

List row — selectable, color dot, edit button that doesn't trigger select:
```js
h += `<div class="li${sel}" onclick="selectGame(${g.id})" style="display:flex;align-items:center;gap:8px">
  <div class="dot" style="background:${col}"></div>
  <span class="name" style="flex:1">${x(g.name)}</span>
  <button class="btn btn-g btn-i" onclick="event.stopPropagation();openGameModal(${g.id})" title="Edit">${I.edit}</button>
</div>`;
```

Empty state — icon, headline, primary CTA:
```js
h += `<div class="empty" style="margin-top:80px">
  <div class="ei">${I.hero}</div><h3>${t('hero')}</h3><p>${t('nexusWelcomeText')}</p></div>`;
```

Modal — `openModal(title, html)`, `.fg` form groups, `.mfoot` footer with
`btn-s` cancel + `btn-p` confirm, focus the first input after ~60ms:
```js
openModal(t('gameNew'), `
  <div class="fg"><label>${t('name')} *</label><input id="gn"></div>
  <div class="mfoot">
    <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
    <button class="btn btn-p" onclick="createGame()">${t('create')}</button>
  </div>`);
setTimeout(() => q('#gn').focus(), 60);
```

Detail header — entity color as left border, tab label in `--t3`:
```js
`<div class="detail-head" style="border-left:4px solid ${col};padding-left:12px">
  <h2 style="margin:0;font-size:1.1em">${x(g.name)} <span style="color:var(--t3);font-weight:400;font-size:.8em">· ${x(label)}</span></h2>`
```

## Hard rules

- Buttons: always `btn` + one of `btn-p` (primary) `btn-s` (secondary)
  `btn-g` (ghost) `btn-d` (danger), `btn-i` for icon-only. Icons from `I.*`.
- Every user-visible string goes through `t('key')`; the key must exist in all
  13 locales or `t()` renders the raw key.
- Escape all data interpolation with `x()`.
- `toast(msg, 'ok')` for feedback; `confirmBox()` for destructive confirms —
  **never** `alert()` / `window.confirm()` (broken in the frameless window).
- Inline `style=""` for layout tweaks is house style (everyone does it), but
  colors inside them must be `var(--…)` or data-driven `${col}`.
- Success actions: mutate → `closeModal()` → re-render list → select new item
  → `toast(...)` (see `createProject()` in `electron/src/renderer/modals.js`).
