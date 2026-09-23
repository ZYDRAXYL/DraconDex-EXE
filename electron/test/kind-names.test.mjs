// v5 Part 6 (V5.md §10.5) — Classic is the default kind name now. The
// regression §7.8 warned about: Dragon's search matched only the name in the
// CURRENT mode, so flipping the default would break every English search.
// kindSearchText() must carry every name a kind answers to, in either mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const state = read('../src/renderer/core/state.js');
const kinds = read('../src/renderer/hub/kinds.js');
const pick = (src, re) => src.match(re)?.[0] || assert.fail(`not found: ${re}`);

function load(nameMode, locale) {
  const L = { en: { kcCategory: 'Category' }, th: { kcCategory: 'หมวดหมู่' } };
  const ctx = { L, S: { settings: { nameMode } }, t: (k) => (L[locale][k] ?? L.en[k] ?? k) };
  vm.createContext(ctx);
  const code = [
    pick(state, /const KIND_CLASSIC_KEY = \{[\s\S]*?\n\};/),
    pick(state, /function kindLabel\(kind\) \{[\s\S]*?\n\}/),
    pick(kinds, /const KIND_LABEL = \{[\s\S]*?\n\};/),
    pick(kinds, /const kindUniqueLabel[\s\S]*?function kindSearchText\(kind\) \{[\s\S]*?\n\}/),
  ].join('\n');
  return vm.runInContext(`${code}\n;({ kindLabel, kindLabelBoth, kindSearchText })`, ctx);
}

test('the saved-settings reader defaults nameMode to classic', () => {
  assert.match(state, /const nameMode = saved\.nameMode === 'unique' \? 'unique' : 'classic';/);
});

test('search finds a kind by its unique, localized and English classic name in both modes', () => {
  for (const mode of ['classic', 'unique']) {
    const s = load(mode, 'th').kindSearchText('classifier').toLowerCase();
    for (const word of ['classifier', 'category', 'หมวดหมู่']) assert.ok(s.includes(word), `${mode}: missing ${word}`);
  }
});

test('the label shows the other name as the secondary', () => {
  assert.equal(load('classic', 'th').kindLabelBoth('classifier'), 'หมวดหมู่ · Classifier');
  assert.equal(load('unique', 'th').kindLabelBoth('classifier'), 'Classifier · หมวดหมู่');
});
