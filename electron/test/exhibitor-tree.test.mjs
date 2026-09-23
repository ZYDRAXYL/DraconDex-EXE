// v5 Part 7 (V5.md §11.6) — the Exhibitor's family-tree layout. A child sits
// a generation below its LOWEST parent, siblings sit under their parents,
// a loop is cut rather than recursed, and untouched items get their own row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/mod/exhibitor-tree.js', import.meta.url), 'utf8');
const ctx = {};
vm.createContext(ctx);
const { exhibitorTreeLayout } = vm.runInContext(`${src}\n;({ exhibitorTreeLayout })`, ctx);

test('generations by the longest parent chain; siblings under parents; loose row last', () => {
  // gran → mum; mum + dad → kid1, kid2; dad has no parents; uncle ← gran; stray untouched
  const links = [['gran', 'mum'], ['gran', 'uncle'], ['mum', 'kid1'], ['dad', 'kid1'], ['mum', 'kid2'], ['dad', 'kid2']]
    .map(([parent, child]) => ({ parent, child }));
  const keys = ['kid1', 'kid2', 'dad', 'mum', 'gran', 'uncle', 'stray'];
  const p = exhibitorTreeLayout(keys, links, 1600);
  const row = (k) => p[k].y;
  assert.equal(row('gran'), row('dad'));      // both roots: generation 0
  assert.equal(row('mum'), row('uncle'));
  assert.ok(row('kid1') > row('mum'));        // below the lower parent, not dad's level + 1
  assert.equal(row('kid1'), row('kid2'));
  assert.ok(row('stray') > row('kid1'));
  const mid = (p.mum.x + p.dad.x) / 2;
  assert.ok(Math.abs((p.kid1.x + p.kid2.x) / 2 - mid) < 400, 'children centred-ish under their parents');
  for (const k of keys) assert.ok(p[k].x >= 0 && p[k].x <= 1600, k);
});

test('a loop is cut, not followed; self-links ignored', () => {
  const p = exhibitorTreeLayout(['a', 'b', 'c'], [{ parent: 'a', child: 'b' }, { parent: 'b', child: 'a' }, { parent: 'c', child: 'c' }], 1600);
  assert.ok(Number.isFinite(p.a.y) && Number.isFinite(p.b.y));
  assert.notEqual(p.a.y, p.b.y);
});
