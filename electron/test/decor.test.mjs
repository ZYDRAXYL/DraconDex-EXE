// Procress 14 (APP docs/EXPORT-DECOR.md D1–D4) — decoration. The scrim a
// banner's title sits on is checked the way D3 asks: white text over a
// PURE-WHITE picture, at the point the text starts; picture and icon
// options accept only the references the app stores; and "Import new…"
// offers only the asset class that was asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('banner scrim: white title over a pure-white picture >= 4.69:1 where the text starts', () => {
  const css = read('css/page-decor.css');
  const pad = /\.pc-banner-text\{[^}]*padding:(\d+)px/.exec(css);
  assert.ok(pad, 'the text box has a top padding');
  for (const kind of ['soft', 'strong']) {
    const g = new RegExp(`\\.pc-banner-text\\[data-scrim="${kind}"\\]\\{background:linear-gradient\\(([^;]+)\\)\\}`).exec(css);
    assert.ok(g, `${kind} scrim declared`);
    const stop = new RegExp(`rgba\\(0,0,0,([.\\d]+)\\) ${pad[1]}px`).exec(g[1]);
    assert.ok(stop, `${kind}: a stop exactly where the text starts (${pad[1]}px)`);
    const a = Number(stop[1]);
    const ground = [0, 1, 2].map(() => Math.round(255 * (1 - a))); // black at α over white
    const r = ratio([255, 255, 255], ground);
    assert.ok(r >= 4.69, `${kind}: ${r.toFixed(2)}:1`);
  }
});

test('picture and icon options take only stored references', () => {
  const ctx = { COMPONENTS: {}, componentOf: () => null, componentLabel: () => '', t: (k) => k, x: String, xj: JSON.stringify, I: { star: '<svg/>' }, PB_TYPE_KEY: {}, CSS: { escape: String } };
  vm.createContext(ctx);
  vm.runInContext(`${read('src/renderer/page/style.js')}\nthis.api = { pbOptValid, pbIconHtml };`, ctx);
  const { pbOptValid, pbIconHtml } = ctx.api;
  assert.equal(pbOptValid({ type: 'image' }, 'file_12'), 'file_12');
  assert.equal(pbOptValid({ type: 'image' }, 'ddx-file://1-12'), undefined);
  assert.equal(pbOptValid({ type: 'image' }, 'https://example.com/a.png'), undefined);
  assert.deepEqual([...pbOptValid({ type: 'images' }, ['file_1', 'x', 'file_2', 3])], ['file_1', 'file_2']);
  assert.equal(pbOptValid({ type: 'icon' }, 'svg:star'), 'svg:star');
  assert.equal(pbOptValid({ type: 'icon' }, 'sym:🐉'), 'sym:🐉');
  assert.equal(pbOptValid({ type: 'icon' }, 'img:javascript:alert(1)'), undefined);
  assert.deepEqual({ ...pbOptValid({ type: 'focus' }, { x: 140, y: -3 }) }, { x: 100, y: 0 });
  assert.equal(pbIconHtml('img:javascript:alert(1)'), '', 'an img: icon must be a raster data URI');
});

test('"Import new…" offers only the class asked for, and main picks the files', () => {
  const main = read('main.js');
  const h = main.slice(main.indexOf("h('importdock:pickFiles'"), main.indexOf("h('importdock:pickFolder'"));
  assert.ok(h.length > 0);
  assert.match(h, /registerChosenFiles\(nx, res\.filePaths, moduleRef, classes\)/, 'extensions come from the asked class');
  assert.match(h, /if \(!exts\.length\) return \{ canceled: true \}/, 'an unknown class opens nothing');
  assert.match(h, /dialog\.showOpenDialog/, 'the paths come from main’s own dialog');
  const reg = main.slice(main.indexOf('function registerChosenFiles'), main.indexOf('const DROPPABLE'));
  assert.match(reg, /exts\.includes\(type\)/, 'a picked file of another type is dropped');
});
