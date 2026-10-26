// Procress 27 part 5 — core/reorder.js: where a dragged item lands and how
// far the others slide. Pure maths here; the pointer drag itself is driven in
// the real app (ui-smoke.driver.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/reorder.js', import.meta.url), 'utf8');
const R = vm.runInContext(`${src}\n;({ reorderIds, reorderSlot, reorderShift, reorderNearest })`, vm.createContext({}));
// five rows, 20 px tall, no gap
const spans = [0, 1, 2, 3, 4].map((i) => [i * 20, i * 20 + 20]);

test('reorderIds moves one id before or after another', () => {
  assert.deepEqual([...R.reorderIds([1, 2, 3, 4], 4, 1, true)], [4, 1, 2, 3]);
  assert.deepEqual([...R.reorderIds([1, 2, 3, 4], 1, 3, false)], [2, 3, 1, 4]);
  assert.equal(R.reorderIds([1, 2], 1, 9, true), null, 'an unknown target moves nothing');
});

test('reorderSlot: the final index follows the centre past the others', () => {
  assert.equal(R.reorderSlot(spans, 1, 30).to, 1, 'not moved');
  assert.equal(R.reorderSlot(spans, 1, 51).to, 2, 'past the next centre');
  assert.equal(R.reorderSlot(spans, 1, 95).to, 4, 'to the end');
  assert.equal(R.reorderSlot(spans, 3, 5).to, 0, 'to the top');
});

test('reorderShift: only the rows between from and to slide, toward the gap', () => {
  const shifts = (from, to) => spans.map((_, i) => (i === from ? 'x' : R.reorderShift(i, from, to, 20)));
  assert.deepEqual(shifts(1, 3), [0, 'x', -20, -20, 0]);
  assert.deepEqual(shifts(3, 0), [20, 20, 20, 'x', 0]);
  assert.deepEqual(shifts(2, 2), [0, 0, 'x', 0, 0]);
});

test('reorderSlot: the middle half of an "into" item nests, its edges still reorder', () => {
  const folder = (i) => i === 3;
  assert.deepEqual({ ...R.reorderSlot(spans, 0, 70, folder) }, { to: null, into: 3 });
  assert.equal(R.reorderSlot(spans, 0, 62, folder).into, -1, 'top quarter is "before"');
  assert.equal(R.reorderSlot(spans, 0, 78, folder).into, -1, 'bottom quarter is "after"');
  assert.equal(R.reorderSlot(spans, 3, 70, folder).into, -1, 'never into itself');
});

test('reorderNearest: the grid slot closest to the dragged centre', () => {
  const grid = [0, 1, 2, 3].map((i) => ({ left: (i % 2) * 100, right: (i % 2) * 100 + 90, top: Math.floor(i / 2) * 60, bottom: Math.floor(i / 2) * 60 + 50 }));
  assert.equal(R.reorderNearest(grid, 0, 150, 80), 3);
  assert.equal(R.reorderNearest(grid, 3, 40, 20), 0);
});
