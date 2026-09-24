#!/usr/bin/env node
// DraconDex module style & wiring conformance checker (agent tooling).
//
// Usage (from repo root):
//   node .claude/skills/dracondex-module-style/check.mjs                     # lint all renderer modules + global checks
//   node .claude/skills/dracondex-module-style/check.mjs electron/src/renderer/foo.js # lint specific file(s)
//   node .claude/skills/dracondex-module-style/check.mjs --module hero       # wiring checks for one module name
//
// ERRORs (exit 1): broken IPC chain, api.* call with no preload entry,
//   t('key') missing in a locale, alert()/window.confirm() usage, missing wiring.
// WARNINGs (exit 0): hardcoded colors, unknown CSS classes, <button> without
//   .btn, Thai string literals (untranslated). Compare counts against the
//   baseline table printed for existing modules — new code should not be worse.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = f => readFileSync(path.join(root, f), 'utf8');

// The Electron app lives under electron/; paths handed to read()/walkJs() are
// relative to the repo root, so they carry the prefix. Paths that appear
// *inside* the source (script tags, loadModule(), database.js requires) stay
// relative to electron/ and are matched verbatim.
const APP_DIR = 'electron';
const app = f => `${APP_DIR}/${f}`;

let errors = 0, warnings = 0;
const err = m => { errors++; console.log(`  ERROR   ${m}`); };
const warn = m => { warnings++; console.log(`  warning ${m}`); };
const ok = m => console.log(`  ok      ${m}`);

// --- argv ---
const argv = process.argv.slice(2);
let moduleName = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--module') moduleName = argv[++i];
  else files.push(argv[i].replace(/\\/g, '/'));
}

// style.css and src/renderer/core.js were each split into a folder (Plan
// part1) — these two checks need the whole family, not one file, or they go
// green while checking nothing.
const readDirJoined = (dir, ext) => readdirSync(path.join(root, dir))
  .filter(f => f.endsWith(ext)).sort().map(f => read(`${dir}/${f}`)).join('\n');

const coreSrc = readDirJoined(app('src/renderer/core'), '.js');
const i18nSrc = read(app('src/renderer/i18n.js'));
const preloadSrc = read(app('preload.js'));
const mainSrc = read(app('main.js'));
const indexSrc = read(app('index.html'));
const cssSrc = readDirJoined(app('css'), '.css');

const stripInterp = s => s.replace(/\$\{[^}]*\}/g, '');
const stripStrings = s => s.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");

// --- parse preload: api path tree + invoked channels ---
function parsePreload(src) {
  const paths = new Set(); const channels = new Set();
  const stack = [];
  let inApi = false;
  for (const line of src.split('\n')) {
    if (!inApi) {
      if (line.includes("exposeInMainWorld('api'")) inApi = true;
      continue;
    }
    const group = line.match(/^\s*([A-Za-z0-9_]+):\s*\{\s*$/);
    const leaf = line.match(/^\s*([A-Za-z0-9_]+):\s*(?:async\s*)?\(/);
    for (const m of line.matchAll(/inv\('([^']+)'/g)) channels.add(m[1]);
    if (group) { stack.push(group[1]); continue; }
    if (leaf) { paths.add([...stack, leaf[1]].join('.')); continue; }
    // count closers minus openers to pop groups
    const net = (line.match(/\}/g) || []).length - (line.match(/\{/g) || []).length;
    for (let i = 0; i < net; i++) {
      if (stack.length) stack.pop();
      else { inApi = false; break; }
    }
  }
  return { paths, channels };
}
const api = parsePreload(preloadSrc);

// --- parse main.js registered channels ---
const mainChannels = new Set();
for (const m of mainSrc.matchAll(/\bh\('([^']+)'/g)) mainChannels.add(m[1]);
for (const m of mainSrc.matchAll(/ipcMain\.(?:handle|on)\('([^']+)'/g)) mainChannels.add(m[1]);

// --- parse i18n dict L in src/renderer/i18n.js ---
function parseLocales(src) {
  const start = src.indexOf('const L = {');
  const locales = {}; // name -> Set(keys)
  let depth = 0, current = null;
  for (const line of src.slice(start).split('\n')) {
    const localeOpen = line.match(/^  ([A-Za-z_]+): \{/);
    if (depth === 1 && localeOpen) { current = localeOpen[1]; locales[current] = new Set(); }
    if (depth >= 2 || (depth === 1 && localeOpen)) {
      const inBlock = stripStrings(line);
      for (const m of inBlock.matchAll(/([A-Za-z0-9_]+)\s*:/g)) {
        if (current && m[1] !== current) locales[current].add(m[1]);
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0 && current) break; // closed const L
  }
  return locales;
}
const locales = parseLocales(i18nSrc);
const localeNames = Object.keys(locales);

// --- parse the COMMON_UI_TEXT fallback dict in src/renderer/i18n.js ---
// Entries are one per line: `'source': { en:'…', ja:'…', … },`. Unlike `L`,
// the dict key is itself the source string, so the locale it is already
// written in needs no field — but every *other* shipped locale does, or
// tr()/translateCommonUiText() silently serve English instead.
function parseCommonUiText(src) {
  const start = src.indexOf('const COMMON_UI_TEXT = {');
  if (start < 0) return null;
  const entries = [];
  let depth = 0;
  for (const line of src.slice(start).split('\n')) {
    const entry = depth === 1 && line.match(/^\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\s*:\s*\{/);
    if (entry) {
      const tags = new Set();
      for (const m of stripStrings(line.slice(entry[0].length - 1)).matchAll(/([A-Za-z0-9_]+)\s*:/g)) tags.add(m[1]);
      entries.push({ key: entry[1].slice(1, -1), locales: tags });
    }
    const bare = stripStrings(line);
    depth += (bare.match(/\{/g) || []).length - (bare.match(/\}/g) || []).length;
    if (depth <= 0 && entries.length) break; // closed const COMMON_UI_TEXT
  }
  return entries;
}

// --- CSS classes defined in style.css ---
const cssClasses = new Set();
for (const m of cssSrc.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) cssClasses.add(m[1]);

// ═══ Global check 1: IPC chain preload -> main ═══
console.log('=== IPC chain (preload -> main.js) ===');
{
  const missing = [...api.channels].filter(c => !mainChannels.has(c));
  if (missing.length) missing.forEach(c => err(`preload invokes '${c}' but main.js has no handler`));
  else ok(`${api.channels.size} preload channels all have main.js handlers (${mainChannels.size} registered)`);
}

// ═══ Global check 2: i18n locale parity vs en ═══
console.log(`=== i18n parity (${localeNames.length} locales: ${localeNames.join(', ')}) ===`);
{
  const en = locales.en || new Set();
  let gaps = 0;
  for (const name of localeNames) {
    if (name === 'en') continue;
    const missing = [...en].filter(k => !locales[name].has(k));
    if (missing.length) { gaps++; warn(`locale '${name}' missing ${missing.length} key(s) vs en: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}`); }
  }
  if (!gaps) ok(`all locales have every 'en' key (${en.size} keys)`);
}

// ═══ Global check 2b: COMMON_UI_TEXT covers every locale ═══
// `L` parity above only covers t('key') lookups. The ~400 strings that modules
// still render as raw literals go through COMMON_UI_TEXT instead, and a locale
// missing there degrades to English with no error — invisible without this
// check (it is how it/nl/pl/uk/tr shipped in the picker but not in this dict).
console.log('=== i18n parity (COMMON_UI_TEXT fallback dict) ===');
{
  const entries = parseCommonUiText(i18nSrc);
  if (!entries) warn('could not locate `const COMMON_UI_TEXT` in src/renderer/i18n.js');
  else {
    const isThai = s => /[฀-๿]/.test(s);
    const gaps = new Map(); // locale -> [keys]
    for (const e of entries) {
      // The key is already the source text, so its own locale is implicit.
      const self = isThai(e.key) ? 'th' : 'en';
      for (const name of localeNames) {
        if (name === self || e.locales.has(name)) continue;
        if (!gaps.has(name)) gaps.set(name, []);
        gaps.get(name).push(e.key);
      }
    }
    if (gaps.size) {
      for (const [name, keys] of [...gaps].sort((a, b) => b[1].length - a[1].length)) {
        err(`COMMON_UI_TEXT: locale '${name}' missing from ${keys.length}/${entries.length} entries — falls back to English: ${keys.slice(0, 3).map(k => `'${k}'`).join(', ')}${keys.length > 3 ? ', …' : ''}`);
      }
    } else ok(`all ${entries.length} COMMON_UI_TEXT entries cover every locale`);
  }
}

// ═══ Global check 2c: every module kind is fully registered ═══
// V5.md §9.4. MODULE_KINDS is a flat array and each kind's metadata sits in
// separate flat maps beside it (hub/kinds.js). A 16th kind added to the
// array but forgotten in KIND_CATEGORY would not throw anywhere — it would
// fall through as "not data", drop out of the Manager's pool and out of the
// kind picker's groups, silently. The APK gets this for free from Dart's
// exhaustive switch; here the checker does it.
console.log('=== module kind registry (hub/kinds.js) ===');
{
  let kindsSrc = '';
  try { kindsSrc = read(app('src/renderer/hub/kinds.js')); } catch (_) {}
  const arrayOf = (name) => {
    const m = kindsSrc.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
    return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]) : null;
  };
  const mapOf = (name) => {
    const m = kindsSrc.match(new RegExp(`const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
    return m ? new Map([...m[1].replace(/\/\/[^\n]*/g, '').matchAll(/([a-z_]+)\s*:\s*'([^']*)'/g)].map((x) => [x[1], x[2]])) : null;
  };
  const kinds = arrayOf('MODULE_KINDS');
  if (!kinds) warn('could not locate `const MODULE_KINDS` in hub/kinds.js');
  else {
    const CATEGORIES = new Set(['structure', 'view', 'data']);
    let bad = 0;
    for (const name of ['KIND_CATEGORY', 'KIND_ICON', 'KIND_LABEL', 'KIND_COLOR', 'KIND_DESC_KEY']) {
      const map = mapOf(name);
      if (!map) { bad++; err(`hub/kinds.js: \`const ${name}\` not found`); continue; }
      const missing = kinds.filter((k) => !map.has(k));
      if (missing.length) { bad++; err(`${name} has no entry for kind(s): ${missing.join(', ')}`); }
      const stray = [...map.keys()].filter((k) => !kinds.includes(k));
      if (stray.length) { bad++; err(`${name} lists kind(s) not in MODULE_KINDS: ${stray.join(', ')}`); }
      if (name === 'KIND_CATEGORY') {
        const wrong = [...map].filter(([, v]) => !CATEGORIES.has(v)).map(([k, v]) => `${k}=${v}`);
        if (wrong.length) { bad++; err(`KIND_CATEGORY values must be structure/view/data: ${wrong.join(', ')}`); }
      }
    }
    // The picker's groups (§9.5) must place every kind exactly once.
    const groupsSrc = kindsSrc.match(/const KIND_GROUPS\s*=\s*\[([\s\S]*?)\n\];/)?.[1] || '';
    const grouped = [...groupsSrc.matchAll(/kinds:\s*\[([^\]]*)\]/g)].flatMap((g) => [...g[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]));
    const ungrouped = kinds.filter((k) => !grouped.includes(k));
    const twice = grouped.filter((k, i) => grouped.indexOf(k) !== i);
    if (ungrouped.length) { bad++; err(`KIND_GROUPS never lists kind(s): ${ungrouped.join(', ')} — they vanish from the create picker`); }
    if (twice.length) { bad++; err(`KIND_GROUPS lists kind(s) twice: ${[...new Set(twice)].join(', ')}`); }
    if (!bad) ok(`${kinds.length} kinds, each with a category, icon, label, colour, description and picker group`);
  }
}

// ═══ Global check 2d: every command is findable two ways ═══
// V5.md §10.1. A button may only be hidden while its command stays reachable
// another way, so the palette (Ctrl+P, which lists every COMMANDS entry by
// construction) plus at least one more surface. This makes the rule a build
// error instead of a review comment:
//   (a) every entry names a surface besides the palette
//   (b) every named surface's file really references the command
//   (c) no menu is built from a raw `label: t(...)` — only via cmdItem(), so
//       nothing lands in a context menu without also landing in the palette
//   (d) every cmdItem / cmdBtn / runCommand / data-cmd id exists
//   (e) every label key exists in the en locale
console.log('=== command registry (core/commands.js) ===');
{
  const R = 'src/renderer/';
  const SURFACE_FILES = {
    'nest.ctx': ['hub/menus.js'], 'nest.head': ['hub/sections.js'], 'pane.ctx': ['hub/menus.js'],
    'rail': ['hub/kinds.js'], 'settings.menu': ['core/settings.js'], 'shortcut': ['core/shortcuts.js'],
    'dock': ['mod/importdock.js'], 'assets.strip': ['mod/importdock.js'], 'asset.ctx': ['mod/importdock.js'],
    'asset.viewer': ['mod/fileviewer.js'], 'text.ctx': ['core/wiki-field.js'],
    'canvas.ctx': ['mod/canvas-ctx.js'], 'classifier.ctx': ['mod/classifier-ctx.js'], 'exhibitor.ctx': ['mod/exhibitor-cards.js'],
    'locator.page': ['mod/locator.js'], 'sketcher.board': ['mod/sketcher.js'], 'scribe.toolbar': ['mod/chatscribe.js'],
    'empty.state': ['hub/kind-page.js'],
    'kind.picker': ['hub/menus.js'], 'nexus.options': ['core/nexus-options.js'], 'bundle.picker': ['hub/bundles.js'], 'left.panel': ['hub/activity.js'], 'setting.data': ['core/db-transfer.js'],
    'page.head': ['hub/open.js'],
    'page.layout': ['page/item-page.js'],
  };
  const surfaceFiles = (sf) => SURFACE_FILES[sf] || (sf.endsWith('.toolbar') ? [`mod/${sf.slice(0, -8)}.js`] : null);
  const srcOf = (f) => { try { return read(app(R + f)); } catch (_) { return null; } };
  const cmdSrc = srcOf('core/commands.js');
  const block = cmdSrc?.match(/const COMMANDS = \{([\s\S]*?)\n\};/)?.[1];
  if (!block) warn('could not locate `const COMMANDS` in core/commands.js');
  else {
    const en = locales.en || new Set();
    const settingSrc = srcOf('core/setting-window.js') || '';
    const settingGroups = settingSrc.match(/const SETTING_GROUPS\s*=\s*\{([\s\S]*?)\n\};/)?.[1] || '';
    const settingLabels = new Map([...(settingSrc.match(/const SETTING_PAGE_LABEL_KEY\s*=\s*\{([\s\S]*?)\n\};/)?.[1] || '')
      .matchAll(/([a-z]+)\s*:\s*'([A-Za-z0-9_]+)'/g)].map((x) => [x[1], x[2]]));
    const heads = [...block.matchAll(/^  '([a-z]+\.[A-Za-z]+)':/gm)];
    const ids = new Set(heads.map((h) => h[1]));
    let bad = 0;
    heads.forEach((h, i) => {
      const id = h[1];
      const body = block.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : block.length);
      const setting = body.match(/settingCmd\('([a-z]+)',\s*'([a-z]+)'\)/);
      const surfaces = setting ? ['setting.nav'] : (body.match(/surfaces:\s*\[([^\]]*)\]/)?.[1].match(/'([^']+)'/g) || []).map((q) => q.slice(1, -1));
      if (!surfaces.length) { bad++; err(`command ${id}: no surface besides the palette — it would be findable one way only (§10.1)`); }
      for (const sf of surfaces) {
        if (sf === 'setting.nav') {
          if (!setting || !new RegExp(`\\b${setting[1]}:\\s*\\[[^\\]]*'${setting[2]}'`).test(settingGroups)) { bad++; err(`command ${id}: setting page is not in SETTING_GROUPS`); }
          continue;
        }
        const files = surfaceFiles(sf);
        if (!files) { bad++; err(`command ${id}: unknown surface '${sf}' — add it to SURFACE_FILES in check.mjs`); continue; }
        if (!files.some((f) => (srcOf(f) || '').match(new RegExp(`['"]${id.replace('.', '\\.')}['"]`)))) { bad++; err(`command ${id}: surface '${sf}' (${files.join(', ')}) never references it`); }
      }
      const keys = setting ? [settingLabels.get(setting[2]), 'settingWindowTitle']
        : [...(body.match(/(?:label|prefix):\s*(?:'[^']*'|\([^)]*\)\s*=>[^,]*?(?:'[^']*'[^,]*?)+)(?=,)/g) || [])].flatMap((l) => (l.match(/'([^']+)'/g) || []).map((q) => q.slice(1, -1)));
      if (!keys.length) { bad++; err(`command ${id}: no label key found`); }
      for (const k of keys) if (!k || !en.has(k)) { bad++; err(`command ${id}: label key '${k}' is not in the en locale`); }
    });
    // (c) + (d) across the renderer
    const walk = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));
    for (const f of walk(app('src/renderer'))) {
      if (f.endsWith('/core/commands.js')) continue;
      const src = read(f);
      const rel = f.slice(app(R).length);
      if (/label:\s*t\(/.test(src)) { bad++; err(`${rel}: a menu item built with \`label: t(...)\` — build it with cmdItem() so it is also a palette command (§10.2)`); }
      // KIND_PAGE's `start:` names a command too — only there; `start:` is a
      // common key elsewhere (theme gradients, ranges).
      const startRe = rel === 'hub/kind-page.js' ? /\bstart:\s*'([^']+)'/g : null;
      const refs = [...src.matchAll(/(?:cmdItem|cmdBtn|runCommand)\(\s*'([^']+)'|data-cmd="([^"$]+)"/g), ...(startRe ? src.matchAll(startRe) : [])];
      for (const m of refs) {
        const id = m[1] || m[2];
        if (!ids.has(id)) { bad++; err(`${rel}: command '${id}' is not in COMMANDS`); }
      }
    }
    // §10.4: every kind with a page of its own content has an empty state,
    // and its one button is the KIND_PAGE `start` command. Inspector and
    // Drafter are always an editor, so they are the exceptions.
    const kindPage = srcOf('hub/kind-page.js') || '';
    const pageBlock = kindPage.match(/const KIND_PAGE = \{([\s\S]*?)\n\};/)?.[1] || '';
    const pageKinds = [...pageBlock.matchAll(/^  ([a-z]+):/gm)].map((x) => [x[1], pageBlock.slice(x.index).split(/\n  [a-z]+:/)[0]]);
    for (const [k, body] of pageKinds) {
      if (['inspector', 'drafter'].includes(k)) continue;
      if (!/\bstart:\s*'/.test(body)) { bad++; err(`KIND_PAGE.${k} has no \`start\` command — its empty page would offer no way to begin (§10.4)`); }
    }
    if (!bad) ok(`${ids.size} commands, each in the palette and on at least one other surface; every kind page has a start command`);
  }
}

// ═══ Per-file lint ═══
// Recursive: renderer code lives in src/renderer/{,mod/,core/,hub/,navigator/,
// hero/}. A flat readdir here used to skip mod/ entirely and would now skip
// every folder the Plan part1 split created.
const walkJs = (dir) => readdirSync(path.join(root, dir), { withFileTypes: true })
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap(e => e.isDirectory() ? walkJs(`${dir}/${e.name}`) : (e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []));

const targets = files.length ? files : walkJs(app('src/renderer'));

const usedT = new Set();
for (const file of targets) {
  console.log(`=== ${file} ===`);
  if (!existsSync(path.join(root, file))) { err('file does not exist'); continue; }
  const src = read(file);
  const lines = src.split('\n');
  const lineOf = idx => src.slice(0, idx).split('\n').length;

  // api.* usage must exist in preload
  const badApi = new Set();
  for (const m of src.matchAll(/\bapi\.([A-Za-z0-9_.]+)\s*\(/g)) {
    if (!api.paths.has(m[1])) badApi.add(m[1]);
  }
  if (badApi.size) [...badApi].forEach(p => err(`api.${p}() called but preload.js exposes no such path`));
  else ok('all api.* calls exist in preload.js');

  // t('key') must exist in every locale
  const missingT = [];
  for (const m of src.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]\s*[,)]/g)) {
    usedT.add(m[1]);
    const gone = localeNames.filter(l => !locales[l].has(m[1]));
    if (gone.length === localeNames.length) missingT.push(`t('${m[1]}') defined in NO locale`);
    else if (gone.length) missingT.push(`t('${m[1]}') missing in: ${gone.join(', ')}`);
  }
  if (missingT.length) [...new Set(missingT)].forEach(err);
  else ok("all t('key') strings exist in all locales");

  // native dialogs are banned (frameless window; house style is toast()/confirmBox())
  for (const m of src.matchAll(/\b(alert|window\.confirm|window\.prompt)\s*\(/g)) {
    const line = lines[lineOf(m.index) - 1];
    const col = m.index - src.lastIndexOf('\n', m.index) - 1;
    const commentAt = line.indexOf('//');
    if (commentAt !== -1 && commentAt < col) continue;
    err(`${m[1]}() at line ${lineOf(m.index)} — use toast() / confirmBox() (${app('src/renderer/core')}/)`);
  }

  // hardcoded hex colors (allow `|| '#xxxxxx'` data-color fallbacks)
  const hexLines = [];
  for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const before = src.slice(Math.max(0, m.index - 12), m.index);
    if (/\|\|\s*['"]$/.test(before)) continue;
    hexLines.push(`${m[0]}@L${lineOf(m.index)}`);
  }
  if (hexLines.length) warn(`${hexLines.length} hardcoded color(s) — prefer var(--accent/--danger/…): ${hexLines.slice(0, 6).join(' ')}${hexLines.length > 6 ? ' …' : ''}`);
  else ok('no hardcoded colors (theme-safe)');

  // buttons without .btn class
  const badBtn = [];
  for (const m of src.matchAll(/<button[^>]*/g)) {
    if (!/class="[^"]*\bbtn\b/.test(stripInterp(m[0])) && !/class=\$\{|class="\$\{/.test(m[0])) badBtn.push(`L${lineOf(m.index)}`);
  }
  if (badBtn.length) warn(`${badBtn.length} <button> without .btn class (${badBtn.slice(0, 5).join(' ')}) — use btn btn-p/btn-s/btn-g/btn-d (+btn-i for icon)`);

  // Thai literals = untranslated UI strings
  const thai = [];
  lines.forEach((l, i) => { if (/[฀-๿]/.test(l)) thai.push(i + 1); });
  if (thai.length) warn(`${thai.length} line(s) with hardcoded Thai text (use t() + add key to all locales in ${app('src/renderer/i18n.js')}): L${thai.slice(0, 8).join(' L')}${thai.length > 8 ? ' …' : ''}`);

  // CSS classes used but not defined in style.css
  const unknown = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const cls of stripInterp(m[1]).split(/\s+/).filter(Boolean)) {
      if (!cssClasses.has(cls)) unknown.add(cls);
    }
  }
  if (unknown.size) warn(`class(es) not defined in style.css: ${[...unknown].join(', ')}`);
}

// ═══ Wiring checks for --module <name> ═══
if (moduleName) {
  const m = moduleName;
  console.log(`=== module wiring: '${m}' ===`);
  // A module is either one file or a folder of them (Plan part1 split hub,
  // navigator and hero into src/renderer/<name>/).
  const moduleIsFolder = existsSync(path.join(root, app(`src/renderer/${m}`)));
  moduleIsFolder || existsSync(path.join(root, app(`src/renderer/${m}.js`)))
    ? ok(`${app(`src/renderer/${m}`)}${moduleIsFolder ? '/' : '.js'} exists`) : err(`${app(`src/renderer/${m}.js`)} missing`);
  coreSrc.includes(`selectModule('${m}')`)
    ? ok(`nexus tile / selectModule('${m}') present in core.js`) : err(`no selectModule('${m}') in ${app('src/renderer/core')}/ — add a .module-item in renderNexusHome() and a branch in selectModule()`);
  coreSrc.includes(`.nav-btn.${m}-only`)
    ? ok(`.nav-btn.${m}-only visibility handled in core.js`) : err(`core.js never toggles '.nav-btn.${m}-only' — add it to the nav visibility block`);
  indexSrc.includes(`${m}-only`)
    ? ok(`index.html has ${m}-only nav button(s)`) : err(`index.html has no 'nav-btn ${m}-only' buttons in #nav-sidebar`);
  if (m !== 'director') {
    // One file → loadModule('src/renderer/x.js'); a folder → loadGroup('x'),
    // which awaits every file in LAZY_GROUPS (src/renderer/core/views.js).
    coreSrc.includes(`src/renderer/${m}.js`) || coreSrc.includes(`loadGroup('${m}')`)
      ? ok(`lazy-loaded via ${moduleIsFolder ? `loadGroup('${m}')` : `loadModule('src/renderer/${m}.js')`}`)
      : err(`core/ must loadModule('src/renderer/${m}.js') (or loadGroup('${m}') for a folder) then call its render entry`);
  }
  if (existsSync(path.join(root, app(`src/db/${m}.js`)))) {
    // database.js sits inside electron/, so its require path stays './src/db/…'.
    read(app('database.js')).includes(`./src/db/${m}`)
      ? ok(`${app(`src/db/${m}.js`)} required by database.js`) : err(`${app(`src/db/${m}.js`)} exists but database.js does not require/spread it`);
  } else {
    console.log(`  note    no ${app(`src/db/${m}.js`)} (fine if the module reuses another db file)`);
  }
}

console.log(`\n${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
