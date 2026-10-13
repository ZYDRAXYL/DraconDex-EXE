// Procress 22 — core/popover.js: the one positioner (APP docs/COMPONENTS.md
// "Popover"). Pure maths here; opening, Escape, outside click and the focus
// trap are driven in the real app (ui-audit.driver.mjs, the Gallery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/popover.js', import.meta.url), 'utf8');
const ctx = vm.createContext({ document: { body: {} }, MutationObserver: class { observe() {} }, window: { innerWidth: 1000, innerHeight: 800 }, S: {} });
const P = vm.runInContext(`${src}\n;({ floatingRect, anchorRect, pointAnchor })`, ctx);
const R = (left, top, w = 40, h = 20) => ({ left, top, right: left + w, bottom: top + h });

test('below the anchor, start-aligned, by default', () => {
  assert.deepEqual({ ...P.floatingRect(R(100, 100), 200, 150, 1000, 800) }, { left: 100, top: 126, side: 'bottom' });
});
test('flips above when there is no room below', () => {
  const p = P.floatingRect(R(100, 700), 200, 150, 1000, 800);
  assert.equal(p.side, 'top');
  assert.equal(p.top, 700 - 150 - 6);
});
test('shifts left instead of running off the right edge', () => {
  assert.equal(P.floatingRect(R(950, 100), 200, 150, 1000, 800).left, 1000 - 200 - 8);
});
test('never off-screen, even with no room either side', () => {
  const p = P.floatingRect(R(10, 390), 300, 700, 1000, 800);
  assert.ok(p.top >= 8 && p.left >= 8);
});
test('a submenu goes right, and flips left at the edge', () => {
  assert.deepEqual({ ...P.floatingRect(R(500, 100, 280, 28), 200, 100, 1000, 800, 'right-start') }, { left: 782, top: 100, side: 'right' });
  const p = P.floatingRect(R(700, 100, 280, 28), 200, 100, 1000, 800, 'right-start');
  assert.equal(p.side, 'left');
  assert.equal(p.left, 700 - 200 - 2);
});
test('end and centre alignment', () => {
  assert.equal(P.floatingRect(R(400, 100, 100), 200, 50, 1000, 800, 'bottom-end').left, 300);
  assert.equal(P.floatingRect(R(400, 100, 100), 200, 50, 1000, 800, 'bottom-center').left, 350);
});
test('anchors: an element-like, a rect, a point', () => {
  assert.deepEqual({ ...P.anchorRect(P.pointAnchor(5, 7)) }, { left: 5, top: 7, right: 5, bottom: 7, width: 0, height: 0 });
  assert.deepEqual({ ...P.anchorRect({ left: 1, top: 2 }) }, { left: 1, top: 2, right: 1, bottom: 2 });
  assert.equal(P.anchorRect(null), null);
});
