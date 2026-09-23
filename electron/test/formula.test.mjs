// v5 Part 7 (V5.md §11.6) — formula fields. core/formula.js is a parser, not
// eval(): it must compute, refuse anything that is not arithmetic, and turn
// a bad formula or a reference cycle into an error rather than a throw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/formula.js', import.meta.url), 'utf8');
const ctx = {};
vm.createContext(ctx);
const { evalFormula, formulaValue, formatFormulaValue } = vm.runInContext(`${src}\n;({ evalFormula, formulaValue, formatFormulaValue })`, ctx);
const vals = { str: 12, lvl: 3, empty: NaN };
const look = (n) => vals[n.toLowerCase()];

test('arithmetic, precedence, power, unary minus, functions', () => {
  const v = (s) => evalFormula(s, look).value;
  assert.equal(v('1 + 2 * 3'), 7);
  assert.equal(v('(1 + 2) * 3'), 9);
  assert.equal(v('2 ^ 3 ^ 2'), 512);
  assert.equal(v('-{Str} + 20'), 8);
  assert.equal(v('{Str} * 2 + {LVL}'), 27);
  assert.equal(v('max({str}, 20, 3)'), 20);
  assert.equal(v('round(10 / 3, 2)'), 3.33);
  assert.equal(v('10 % 4'), 2);
});

test('refuses what is not arithmetic, without throwing', () => {
  for (const bad of ['', '1 +', '{Nope} + 1', 'alert(1)', 'constructor', '1; 2', '"x"', '{str', '((1)', 'max(1 2)']) {
    const r = evalFormula(bad, look);
    assert.equal(r.ok, false, bad);
    assert.ok(r.error, bad);
  }
});

test('formulaValue: reads fields by name, chains formulas, stops on a cycle, empty stays empty', () => {
  const fields = [
    { id: 1, description: 'STR', attribute_type: 'number' },
    { id: 2, description: 'Attack', attribute_type: 'formula', options: JSON.stringify({ expr: '{STR} * 2' }) },
    { id: 3, description: 'Damage', attribute_type: 'formula', options: JSON.stringify({ expr: '{Attack} + {Bonus}' }) },
    { id: 4, description: 'Bonus', attribute_type: 'checkbox' },
    { id: 5, description: 'A', attribute_type: 'formula', options: JSON.stringify({ expr: '{B} + 1' }) },
    { id: 6, description: 'B', attribute_type: 'formula', options: JSON.stringify({ expr: '{A} + 1' }) },
  ];
  assert.equal(formulaValue(fields[2], fields, { 1: '10', 4: '1' }).value, 21);
  assert.equal(formulaValue(fields[2], fields, { 1: '', 4: '1' }).value, null, 'an empty STR leaves the result empty, not 1');
  assert.deepEqual({ ...formulaValue(fields[4], fields, {}) }, { ok: false, error: 'cycle' });
  assert.equal(formatFormulaValue(2 / 3), '0.667');
  assert.equal(formatFormulaValue(null), '');
});
