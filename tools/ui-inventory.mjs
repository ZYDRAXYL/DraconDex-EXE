#!/usr/bin/env node
// Procress 22 part 1 — the UI inventory (read-only). Counts, from the source
// rather than by eye, how many *different* things the app has for one job:
//
//   variants.<group>  distinct CSS classes defined for that kind of component
//                     (button, popup, chip, card, input, segmented, empty,
//                     list, modal) — the number Procress 22 drives down
//   hex.js / hex.css  hard-coded #colours in renderer JS / in CSS outside
//                     themes.css + tokens.css, per file (user-data palettes
//                     are listed in USER_DATA_HEX and not counted)
//   inlineStyle       style="…" in renderer JS + index.html
//   zIndexRaw         a z-index that is not var(--z-*) / calc(var(--z-*) ± n)
//   icons.svg         ${I.name} uses   icons.char  character/emoji icons
//
//   node tools/ui-inventory.mjs            print the numbers
//   node tools/ui-inventory.mjs --update   write ui-inventory.json — only LOWERS a
//                                          number (or adds a new one) unless --force
//   node tools/ui-inventory.mjs --check    exit 1 if any number went UP vs the
//                                          baseline, a file gained a hex, or a new
//                                          file has one (what CI runs)
//
// The registry these numbers measure against is APP docs/COMPONENTS.md.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, 'ui-inventory.json');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const walk = (dir, ext) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), ext) : e.name.endsWith(ext) ? [path.join(dir, e.name)] : []));

const RENDERER = path.join(root, 'electron/src/renderer');
const CSS_DIR = path.join(root, 'electron/css');
// Translations are text, not UI code.
const jsFiles = walk(RENDERER, '.js').filter((f) => !rel(f).startsWith('electron/src/renderer/i18n/'));
const cssFiles = walk(CSS_DIR, '.css');
const html = readFileSync(path.join(root, 'electron/index.html'), 'utf8');

// Colours that ARE the user's data — a palette the user picks from, a
// default a user-made thing starts with — are not theme leaks. Whole files
// whose hexes are such palettes; keep this list short and say why.
const USER_DATA_HEX = new Set([
  'electron/css/themes.css',           // the themes themselves
  'electron/css/tokens.css',           // the token defaults
  'electron/src/renderer/core/theme.js', // the custom-theme editor's palettes
]);
// The icon catalog is what users pick their module/event icons from — not UI chrome.
const USER_ICON_FILES = new Set(['electron/src/renderer/core/icon-catalog.js', 'electron/src/renderer/iconpicker.js']);

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

// ── component groups: classify every class DEFINED in css/ ──────────────
// First match wins, in this order — so `tag-search-input` is an input, not a chip.
const GROUPS = {
  modal: /(^|-)(modal|dialog)(-|$)/,
  popup: /(^|-)(popup|popover|dropdown|flyout|picker)$|(^|-)menu$/,
  input: /(^|-)(input|inp|field|select|number)$/,
  segmented: /(^|-)(seg|segmented|tab|tabs|switcher)$/,
  card: /(^|-)cards?$/,
  button: /^btn(-|$)|(^|-)(btn|button)$/,
  empty: /(^|-)empty$/,
  list: /^ls-row$|-(row|item)$/,
  chip: /(^|-)(chips?|tag|htag|badge|pill)$/,
};
const defined = new Set();
for (const f of cssFiles) {
  const css = stripComments(readFileSync(f, 'utf8'));
  // selectors only (the part before each {), so a url(.png) or a decimal is not a class
  for (const [, sel] of css.matchAll(/([^{}]+)\{/g)) for (const m of sel.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) defined.add(m[1]);
}
const variants = {};
const members = {};
for (const g of Object.keys(GROUPS)) members[g] = [];
for (const c of [...defined].sort()) { const g = Object.keys(GROUPS).find((k) => GROUPS[k].test(c)); if (g) members[g].push(c); }
for (const g of Object.keys(GROUPS)) variants[g] = members[g].length;

// ── hex colours ───────────────────────────────────────────────────────────
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const hexIn = (src, isCss) => {
  const s = stripComments(src);
  let n = 0;
  for (const m of s.matchAll(HEX)) {
    const len = m[0].length - 1;
    if (![3, 4, 6, 8].includes(len)) continue;
    // an element id selector or href="#x" that happens to be hex-like
    if (!isCss && /(?:id=|href=|querySelector\(|q\(|getElementById\()['"`]?$/.test(s.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (isCss && /^#[0-9a-fA-F]+$/.test(m[0]) && /[{,]\s*$/.test(s.slice(m.index + m[0].length, m.index + m[0].length + 3))) continue;
    n++;
  }
  return n;
};
const hex = { js: {}, css: {} };
for (const f of jsFiles) { const r = rel(f); if (USER_DATA_HEX.has(r) || USER_ICON_FILES.has(r)) continue; const n = hexIn(readFileSync(f, 'utf8'), false); if (n) hex.js[r] = n; }
for (const f of cssFiles) { const r = rel(f); if (USER_DATA_HEX.has(r)) continue; const n = hexIn(readFileSync(f, 'utf8'), true); if (n) hex.css[r] = n; }
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ── inline style, z-index, icons ─────────────────────────────────────────
const jsSrc = jsFiles.map((f) => [rel(f), stripComments(readFileSync(f, 'utf8'))]);
let inlineStyle = (html.match(/\sstyle="/g) || []).length;
for (const [, s] of jsSrc) inlineStyle += (s.match(/\sstyle="/g) || []).length;

const Z_OK = /^(auto|inherit|initial|unset|var\(--z-[a-z]+\)|calc\(var\(--z-[a-z]+\)\s*[+-]\s*\d+\))$/;
const zRaw = [];
for (const f of cssFiles) {
  const s = stripComments(readFileSync(f, 'utf8'));
  for (const m of s.matchAll(/z-index\s*:\s*([^;}!]+)/g)) if (!Z_OK.test(m[1].trim())) zRaw.push(`${rel(f)}: ${m[1].trim()}`);
}
for (const [r, s] of [...jsSrc, ['electron/index.html', html]]) {
  for (const m of s.matchAll(/z-index\s*:\s*([^;"'`}!]+)/g)) if (!Z_OK.test(m[1].trim()) && !/\$\{/.test(m[1])) zRaw.push(`${r}: ${m[1].trim()}`);
  for (const m of s.matchAll(/zIndex\s*=\s*([^;\n]+)/g)) if (!/--z-/.test(m[1])) zRaw.push(`${r}: zIndex = ${m[1].trim()}`);
}

// Character/emoji used as an icon: arrows, dingbats, misc symbols, emoji —
// inside string literals of renderer code (comments stripped). `→` inside a
// sentence is counted too: it is text there, but the number only has to fall.
const CHAR_ICON = /[←-⇿⌀-⏿■-➿⬀-⯿\u{1F300}-\u{1FAFF}]/gu;
let svg = 0, char = 0;
const charByFile = {};
for (const [r, s] of jsSrc) {
  svg += (s.match(/\$\{\s*I\.[A-Za-z_]\w*/g) || []).length + (s.match(/\bI\[['"`][\w-]+['"`]\]/g) || []).length;
  if (USER_ICON_FILES.has(r)) continue;
  const n = (s.match(CHAR_ICON) || []).length;
  if (n) { char += n; charByFile[r] = n; }
}
char += (html.replace(/<script[\s\S]*?<\/script>/g, '').match(CHAR_ICON) || []).length;

const now = {
  variants,
  hexJs: sum(hex.js), hexCss: sum(hex.css), inlineStyle, zIndexRaw: zRaw.length,
  iconsSvg: svg, iconsChar: char,
  hexByFile: { ...hex.js, ...hex.css },
};

// ── modes ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const base = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
const flat = (o) => ({ ...Object.fromEntries(Object.entries(o.variants).map(([k, v]) => [`variants.${k}`, v])), hexJs: o.hexJs, hexCss: o.hexCss, inlineStyle: o.inlineStyle, zIndexRaw: o.zIndexRaw, iconsChar: o.iconsChar });

if (argv.includes('--verbose')) {
  for (const [g, list] of Object.entries(members)) console.log(`${g} (${list.length}): ${list.join(' ')}`);
  console.log(`z-index not a token (${zRaw.length}):\n  ${zRaw.join('\n  ')}`);
  console.log(`char icons by file: ${JSON.stringify(charByFile, null, 1)}`);
}

const table = (b) => {
  const a = flat(now); const o = b ? flat(b) : {};
  for (const k of Object.keys(a)) console.log(`  ${k.padEnd(20)} ${String(a[k]).padStart(5)}${b ? `   (baseline ${o[k] ?? '—'})` : ''}`);
  console.log(`  ${'iconsSvg'.padEnd(20)} ${String(now.iconsSvg).padStart(5)}   (informational — should grow)`);
};

if (argv.includes('--check')) {
  if (!base) { console.error('no ui-inventory.json — run with --update first'); process.exit(1); }
  const bad = [];
  const a = flat(now), b = flat(base);
  for (const [k, v] of Object.entries(a)) if (v > (b[k] ?? 0)) bad.push(`${k}: ${v} > baseline ${b[k] ?? 0}`);
  for (const [f, n] of Object.entries(now.hexByFile)) {
    const was = base.hexByFile?.[f];
    if (was == null) bad.push(`${f}: ${n} hard-coded hex colour(s) in a file that had none — use a token (var(--accent) …), or list the file in USER_DATA_HEX if they are user data`);
    else if (n > was) bad.push(`${f}: ${n} hex colour(s), baseline ${was}`);
  }
  if (base.zIndexRaw === 0 && zRaw.length) bad.push(...zRaw.map((z) => `z-index not a token: ${z} — use var(--z-base|sticky|dropdown|popover|modal|toast|tooltip)`));
  table(base);
  if (bad.length) { console.log(`\nui-inventory: ${bad.length} regression(s) — see APP docs/COMPONENTS.md:\n  ${bad.join('\n  ')}`); process.exit(1); }
  const lower = Object.entries(a).filter(([k, v]) => v < (b[k] ?? 0)).map(([k]) => k);
  console.log(`\nui-inventory: no number went up${lower.length ? ` · lower than the baseline: ${lower.join(', ')} — run --update to lock it in` : ''}`);
} else if (argv.includes('--update')) {
  const force = argv.includes('--force');
  let out = now;
  if (base && !force) {
    const raised = Object.entries(flat(now)).filter(([k, v]) => v > (flat(base)[k] ?? Infinity));
    if (raised.length) { console.error(`refusing to raise: ${raised.map(([k, v]) => `${k} ${v}`).join(', ')} (--force to accept on purpose)`); process.exit(1); }
  }
  writeFileSync(BASELINE, `${JSON.stringify({ note: 'Procress 22 baseline — written by tools/ui-inventory.mjs --update; numbers may only go down', ...out }, null, 2)}\n`);
  console.log('ui-inventory.json written');
  table(null);
} else table(base);
