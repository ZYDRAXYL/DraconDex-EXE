// Procress 14 (APP docs/TEMPLATES.md §6) — block style. The mapping from
// config.style to classes (an unknown value from a newer template is dropped,
// never an error), options() read through pbOpt, and the contrast §6.4
// promises, computed from the CSS itself for every built-in theme and all
// eight accents: tinted's text on its 12% ground, hero's white on its 60%
// (darkest-40%) ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// style.js in a sandbox with just what it reads.
const COMPONENTS = {};
const ctx = {
  COMPONENTS,
  componentOf: (b) => (b?.block_type === 'component' ? COMPONENTS[b.component] || null : null),
  componentLabel: (c) => c?.labelKey || '?',
  t: (k) => k, x: (s) => String(s ?? ''), xj: (s) => JSON.stringify(String(s)), I: { star: '<svg/>' },
  PB_TYPE_KEY: { text: 'pbText' }, CSS: { escape: (s) => s },
};
vm.createContext(ctx);
vm.runInContext(`${read('src/renderer/page/style.js')}
this.api = { blockStyleOf, blockStyleClasses, pbAnchorOf, pbHideOf, pbOpt, pbIconHtml };`, ctx);
const S = ctx.api;

test('no style → no classes (a page looks as it did before §6)', () => {
  assert.deepEqual([...S.blockStyleClasses(S.blockStyleOf({}))], []);
  assert.deepEqual([...S.blockStyleClasses(S.blockStyleOf({ style: {} }))], []);
});

test('each known value maps to its class', () => {
  const cls = [...S.blockStyleClasses(S.blockStyleOf({ style: {
    variant: 'hero', accent: 'rose', width: 'narrow', align: 'center', density: 'compact', collapsible: 'closed',
  } }))];
  assert.deepEqual(cls, ['pb-v-hero', 'pb-acc-rose', 'pb-w-narrow', 'pb-al-center', 'pb-d-compact', 'pb-collapsible']);
});

test('unknown values are dropped, not errors', () => {
  const st = S.blockStyleOf({ style: { variant: 'glass', accent: '#ff0000', width: 12, hideOn: 'tv', header: 'yes', anchor: 'Bio <Arin>!', later: 1 } });
  assert.equal(st.variant, 'plain');
  assert.equal(st.accent, 'accent');
  assert.equal(st.width, 'normal');
  assert.equal(st.hideOn, 'none');
  assert.equal(st.header.show, false);
  assert.equal(st.anchor, 'bio-arin');
  assert.equal('later' in st, false);
  assert.deepEqual([...S.blockStyleClasses(st)], []);
});

test('the anchor defaults to the block id; hideOn never hides item.body', () => {
  assert.equal(S.pbAnchorOf({ id: 7, config: {} }), 'b7');
  assert.equal(S.pbAnchorOf({ id: 7, config: { style: { anchor: 'powers' } } }), 'powers');
  const st = S.blockStyleOf({ style: { hideOn: 'phone' } });
  assert.equal(S.pbHideOf({ component: 'core.navbox' }, st), 'phone');
  assert.equal(S.pbHideOf({ component: 'item.body' }, st), 'none');
});

test('a header icon is an app icon or a symbol, never markup', () => {
  assert.match(S.pbIconHtml('star'), /<svg\/>/);
  assert.match(S.pbIconHtml('sym:★'), /★/);
  assert.equal(S.pbIconHtml('nope'), '');
});

test('pbOpt: config.opts, then the older top-level key, then the default; bad values fall back', () => {
  COMPONENTS['core.x'] = { options: () => [
    { key: 'dock', type: 'select', choices: ['right', 'left'], default: 'right' },
    { key: 'goal', type: 'number', min: 0, max: 100 },
    { key: 'on', type: 'toggle', default: true },
  ] };
  const c = (config) => ({ block: { block_type: 'component', component: 'core.x' }, config });
  assert.equal(S.pbOpt(c({}), 'dock'), 'right');
  assert.equal(S.pbOpt(c({ dock: 'left' }), 'dock'), 'left');
  assert.equal(S.pbOpt(c({ dock: 'left', opts: { dock: 'right' } }), 'dock'), 'right');
  assert.equal(S.pbOpt(c({ opts: { dock: 'middle' } }), 'dock'), 'right');
  assert.equal(S.pbOpt(c({ opts: { goal: 500 } }), 'goal'), 100);
  assert.equal(S.pbOpt(c({ opts: { goal: 'x' } }), 'goal'), undefined);
  assert.equal(S.pbOpt(c({ opts: { on: 'yes' } }), 'on'), true);
  assert.equal(S.pbOpt(c({ opts: { on: false } }), 'on'), false);
});

// ── contrast ────────────────────────────────────────────────────────────
const hex = (h) => {
  let s = h.replace('#', '');
  if (s.length === 3) s = [...s].map((ch) => ch + ch).join('');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
// color-mix(in srgb, a p%, b) — the same straight interpolation the CSS does
const mix = (a, p, b) => a.map((v, i) => Math.round(v * p + b[i] * (1 - p)));

const css = read('css/page-style.css');
const accents = Object.fromEntries([...css.matchAll(/\.pb-acc-([a-z]+)\{--pb-acc:([^}]+)\}/g)].map((m) => [m[1], m[2].trim()]));

// Every built-in theme: the palette block in themes.css (midnight = :root in
// tokens.css), plus its --t3-aa from the vendored design tokens.
function themes() {
  const out = {};
  const block = (src, sel) => {
    const i = src.indexOf(sel);
    if (i < 0) return null;
    const body = src.slice(src.indexOf('{', i) + 1, src.indexOf('}', i));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,6})/g)].map((m) => [m[1], m[2]]));
  };
  const th = read('css/themes.css');
  const gen = readFileSync(join(root, '../src/design/generated/tokens.css'), 'utf8');
  for (const name of [...th.matchAll(/body\[data-theme="([a-z]+)"\]\{/g)].map((m) => m[1])) {
    const p = block(th, `body[data-theme="${name}"]{`);
    if (!p?.bg || !p?.t1) continue;
    out[name] = { ...(block(gen, `body[data-theme="${name}"]`) || {}), ...p };
  }
  return out;
}

test('the palette has the eight accents §6.1 names', () => {
  assert.deepEqual(Object.keys(accents).sort(), ['accent', 'amber', 'blue', 'green', 'kind', 'rose', 'slate', 'violet']);
});

test('tinted: text >= 12.5:1 on the base themes (AAA and >= 80% of the theme elsewhere), quiet text >= 4.5:1', () => {
  const T = themes();
  assert.ok(Object.keys(T).length >= 4, 'the four built-in themes');
  assert.match(css, /\.pb-v-tinted\{[^}]*--t3-aa:var\(--th-t2\)/, 'quiet text in a tinted block is --t2');
  const BASE = ['daylight', 'moonlight', 'midnight'];
  const bad = [];
  for (const [name, th] of Object.entries(T)) {
    const own = ratio(hex(th.t1), hex(th.bg));
    for (const [acc, v] of Object.entries(accents)) {
      const ground = mix(hex(v.startsWith('var(') ? th.accent : v), 0.12, hex(th.bg));
      const r1 = ratio(hex(th.t1), ground);
      if (BASE.includes(name) ? r1 < 12.5 : (r1 < 7 || r1 < own * 0.8)) bad.push(`${name}/${acc} t1 ${r1.toFixed(2)}`);
      const r2 = ratio(hex(th.t2), ground);
      if (r2 < 4.5) bad.push(`${name}/${acc} t2 ${r2.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('hero: white >= 5.4:1 on the accent darkened 40%, every theme, every accent', () => {
  assert.match(css, /color-mix\(in srgb,var\(--pb-acc,var\(--accent\)\) 60%,#000\)/, 'the lightest point of the hero ground is the 60% mix');
  const heroInks = [...css.matchAll(/\.pb-v-hero\{[^}]*--t2:(#[0-9a-f]+);--t3-aa:(#[0-9a-f]+)/g)].flatMap((m) => [m[1], m[2]]);
  assert.equal(heroInks.length, 2, 'hero sets its own --t2 and --t3-aa');
  const bad = [];
  for (const [name, th] of Object.entries(themes())) {
    for (const [acc, v] of Object.entries(accents)) {
      const ground = mix(hex(v.startsWith('var(') ? th.accent : v), 0.6, [0, 0, 0]);
      const r = ratio([255, 255, 255], ground);
      if (r < 5.4) bad.push(`${name}/${acc} ${r.toFixed(2)}`);
      // the secondary inks hero sets
      for (const ink of heroInks) { const r2 = ratio(hex(ink), ground); if (r2 < 4.5) bad.push(`${name}/${acc} ${ink} ${r2.toFixed(2)}`); }
    }
  }
  assert.deepEqual(bad, []);
});
