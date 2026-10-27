// Procress 29 part 5 — the icon sets and the custom colour panel: pure parts.
// The picker itself is driven in the real app (ui-smoke.driver.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ctx = vm.createContext({ x: (s) => String(s), loadModule: () => Promise.resolve(), requestAnimationFrame: () => {}, document: { querySelectorAll: () => [] } });
vm.runInContext(read('../src/renderer/core/icon-sets.js'), ctx);
vm.runInContext(read('../vendor/icons/lucide.js'), ctx);
vm.runInContext(read('../src/renderer/core/color-panel.js'), ctx);
const C = vm.runInContext('({ isSetIconRef, setIconSvg, setIconHtml, ICON_SETS, cpHsvToRgb, cpRgbToHsv, cpRgbToHex, cpHexToRgb, cpanelGridColors })', ctx);

test('a set reference is set/name; the app\'s own keys are not', () => {
  assert.equal(C.isSetIconRef('lucide/castle'), true);
  assert.equal(C.isSetIconRef('sword'), false);
  assert.equal(C.isSetIconRef('../x'), false);
});

test('a loaded set draws its icon; an unloaded one leaves a placeholder', () => {
  assert.match(C.setIconSvg('lucide/castle'), /^<svg class="icon"[^>]*viewBox="0 0 24 24"[^>]*>.+<\/svg>$/);
  assert.match(C.setIconHtml('tabler/home'), /data-set-icon="tabler\/home"/);
  assert.equal(C.setIconSvg('lucide/no-such-icon'), null);
});

test('every vendored set script has its licence beside it', () => {
  const dir = new URL('../vendor/icons/', import.meta.url);
  const files = readdirSync(dir);
  for (const f of files.filter((n) => n.endsWith('.js'))) assert.ok(files.includes(`LICENSE-${f.slice(0, -3)}`), f);
});

test('colour maths round-trips', () => {
  for (const hex of ['#000000', '#ffffff', '#6366f1', '#55f2a4', '#123456']) {
    const rgb = C.cpHexToRgb(hex);
    assert.equal(C.cpRgbToHex(C.cpHsvToRgb(...C.cpRgbToHsv(...rgb))), hex);
  }
  assert.equal(C.cpHexToRgb('#12345'), null);
  assert.equal(C.cpanelGridColors().length, 60);
});
