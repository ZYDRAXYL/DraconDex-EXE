// Procress 28 part 5 — Author Part dividers: where they sit among the
// chapters, where a drag puts one, and what deleting a chapter does. Pure
// functions of mod/author-parts.js; the column itself is driven in
// ui-smoke.driver.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/mod/author-parts.js', import.meta.url), 'utf8');
const P = vm.runInContext(`${src}\n;({ authorPartsOf, authorPartRows, authorPartMove, authorPartsAfterDelete })`, vm.createContext({}));
const ch = [{ id: 10 }, { id: 11 }, { id: 12 }];
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects made in the vm context are another realm's
const seq = (parts) => P.authorPartRows(ch, parts).map((r) => (r.ch ? `c${r.ch.id}` : r.part.id)).join(' ');

test('rows: a part sits before chapter `at`; past the end = after the last; same `at` keeps array order', () => {
  assert.equal(seq([{ id: 'A', at: 0 }, { id: 'B', at: 2 }, { id: 'C', at: 2 }, { id: 'D', at: 9 }]), 'A c10 c11 B C c12 D');
  assert.equal(seq([]), 'c10 c11 c12');
});

test('move: before or after a chapter or another part', () => {
  const parts = [{ id: 'A', at: 0 }, { id: 'B', at: 2 }];
  assert.equal(seq(P.authorPartMove(ch, parts, 'A', { ch: 12 }, false)), 'c10 c11 B c12 A', 'after the last chapter');
  assert.equal(seq(P.authorPartMove(ch, parts, 'B', { ch: 10 }, true)), 'A B c10 c11 c12', 'to the top, behind A');
  assert.equal(seq(P.authorPartMove(ch, parts, 'A', { part: 'B' }, false)), 'c10 c11 B A c12', 'after another part');
  assert.deepEqual(plain(P.authorPartMove(ch, parts, 'Z', { ch: 10 }, true)), parts, 'an unknown part moves nothing');
});

test('deleting a chapter closes the parts after it up by one; those before stay', () => {
  assert.deepEqual(plain(P.authorPartsAfterDelete([{ id: 'A', at: 0 }, { id: 'B', at: 1 }, { id: 'C', at: 2 }], 1).map((p) => p.at)), [0, 1, 1]);
});

test('read: bad or missing JSON is no parts; fields are cleaned', () => {
  assert.deepEqual(plain(P.authorPartsOf({})), []);
  assert.deepEqual(plain(P.authorPartsOf({ authorParts: '{oops' })), []);
  assert.deepEqual(plain(P.authorPartsOf({ authorParts: JSON.stringify([{ id: 'A', at: -3, label: 7 }, { at: 1 }]) })), [{ id: 'A', at: 0, label: '7' }]);
});
