// Procress 23 — a uistyle package may carry the glass group, and a package
// made for a newer app is refused. The rules must match DraconDex-PKG's
// tools/build-packages.mjs: a package that builds there installs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../src/db/pkg-rules.js');
const base = { '--r': '6px', '--rs': '4px', '--rl': '10px', '--shadow-pop': 'none', '--shadow-float': 'none', '--shadow-menu': 'none', '--shadow-modal': 'none' };
const glass = { '--glass-blur': '24px', '--glass-tint': '72%', '--glass-stroke': 'rgba(255,255,255,.14)', '--glass-shadow': '0 8px 32px rgba(0,0,0,.18)' };

test('the 7 alone, and the 7 + all four glass tokens, both pass', () => {
  assert.equal(R.validateUistyleVars(base), null);
  assert.equal(R.validateUistyleVars({ ...base, ...glass }), null);
});

test('glass is all-or-nothing and range-checked', () => {
  assert.match(R.validateUistyleVars({ ...base, '--glass-blur': '24px' }), /all-or-nothing/);
  assert.match(R.validateUistyleVars({ ...base, ...glass, '--glass-blur': '41px' }), /0–40px/);
  assert.match(R.validateUistyleVars({ ...base, ...glass, '--glass-blur': '2em' }), /0–40px/);
  assert.match(R.validateUistyleVars({ ...base, ...glass, '--glass-tint': '49%' }), /50–100%/);
  assert.match(R.validateUistyleVars({ ...base, ...glass, '--glass-tint': '101%' }), /50–100%/);
  assert.match(R.validateUistyleVars({ ...base, ...glass, '--glass-stroke': 'url(x);' }), /unsafe/);
  assert.match(R.validateUistyleVars({ ...base, '--glass-backdrop-from': 'red' }), /unknown/);
  assert.match(R.validateUistyleVars({ '--r': '1px' }), /missing required/);
});

test('minAppVersion: older app refused, equal or newer allowed, none = any', () => {
  assert.equal(R.meetsMinApp(null, '5.1.1'), true);
  assert.equal(R.meetsMinApp('5.2.0', '5.1.1'), false);
  assert.equal(R.meetsMinApp('5.1.1', '5.1.1'), true);
  assert.equal(R.meetsMinApp('5.1.1', '5.1.2-3'), true);
  assert.equal(R.meetsMinApp('5.1.1', '6.0.0'), true);
  assert.equal(R.meetsMinApp('not-a-version', '9.9.9'), false);
});

test('the token lists match DraconDex-PKG when that checkout is beside this one', (t) => {
  let src;
  try { src = readFileSync(new URL('../../../DraconDex-PKG/tools/build-packages.mjs', import.meta.url), 'utf8'); } catch { t.skip('no DraconDex-PKG checkout'); return; }
  const list = (name) => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]+\\]);`).exec(src)[1].replace(/'/g, '"'));
  assert.deepEqual(list('UISTYLE_TOKENS'), R.UISTYLE_TOKENS);
  assert.deepEqual(list('GLASS_TOKENS'), R.GLASS_TOKENS);
  assert.ok(src.includes(`const CSS_VALUE = ${R.CSS_VALUE};`), 'CSS_VALUE differs');
});

test('the renderer clears and sets the same glass tokens', () => {
  const state = readFileSync(new URL('../src/renderer/core/state.js', import.meta.url), 'utf8');
  const m = /const CUSTOM_GLASS_TOKENS = (\[[^\]]+\]);/.exec(state);
  assert.deepEqual(JSON.parse(m[1].replace(/'/g, '"')), R.GLASS_TOKENS);
});
