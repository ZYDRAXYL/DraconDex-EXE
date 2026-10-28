// Procress 30 — the icon picker's colour row and recent icons (iconpicker.js,
// core/icon-catalog.js). Pure helpers here; the two-row / three-row clipping
// is CSS and is checked in the running app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../src/renderer/${p}`, import.meta.url), 'utf8');
const store = {};
const ctx = vm.createContext({
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
  sortColorsByHex: (c) => [...(c || [])].sort((a, b) => a.color_code.localeCompare(b.color_code)),
});
vm.runInContext(read('core/icon-catalog.js'), ctx);
const P = vm.runInContext(`${read('iconpicker.js')}\n;({ ipkHex, ipkColorsByUse, iconRecent, iconRecentPush, ICON_RECENT_MAX })`, ctx);

test('a typed colour code is normalised, a bad one refused', () => {
  assert.equal(P.ipkHex('#AABBCC'), '#aabbcc');
  assert.equal(P.ipkHex('abc'), '#aabbcc');
  assert.equal(P.ipkHex(' #1a2B3c '), '#1a2b3c');
  for (const bad of ['', '#ab', '#abcd', 'red', '#gggggg', '#1234567']) assert.equal(P.ipkHex(bad), null, bad);
});

test('colours are listed by last use, never-used ones after by hex', () => {
  const t0 = '2026-01-01 00:00:00';
  const colors = [
    { id: 1, color_code: '#ff0000', update_at: t0 },
    { id: 2, color_code: '#00ff00', update_at: '2026-10-28 09:00:00' },
    { id: 3, color_code: '#0000ff', update_at: t0 },
    { id: 4, color_code: '#123456', update_at: '2026-10-28 10:00:00' },
  ];
  assert.deepEqual(P.ipkColorsByUse(colors).map((c) => c.id), [4, 2, 3, 1]);
});

test('recent icons keep enough to fill two rows, newest first, no duplicates', () => {
  for (let i = 0; i < 40; i++) P.iconRecentPush(`svg:i${i}`);
  P.iconRecentPush('svg:i5');
  const r = P.iconRecent();
  assert.equal(r.length, P.ICON_RECENT_MAX);
  assert.ok(P.ICON_RECENT_MAX >= 14, 'two rows of the 320 px popup hold 14');
  assert.equal(r[0], 'svg:i5');
  assert.equal(new Set(r).size, r.length);
});
