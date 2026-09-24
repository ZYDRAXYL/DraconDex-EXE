// ENTITY_KINDS is data vendored from DraconDex-SDB (APP docs/APK-V3.md §9.1);
// only the index row mappers are code. These pin the two halves together and
// the declaration's own promises.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ENTITY_KINDS, KEY_COLUMNS } = require('../src/db/entity-kinds.js');
const DECL = require('../../src/schema/generated/entity-kinds.json');

test('every vendored family is loaded, in order, with a row mapper where it indexes', () => {
  assert.deepEqual(Object.keys(ENTITY_KINDS), DECL.families.map((f) => f.prefix));
  for (const [prefix, k] of Object.entries(ENTITY_KINDS)) {
    if (k.index) assert.equal(typeof k.index.row, 'function', `${prefix} row mapper`);
  }
});

test('the families both apps rely on are all there, and file resolves last', () => {
  for (const p of ['note', 'module', 'bchp', 'chss', 'cobj', 'tlev', 'sdlg', 'skpg', 'divt', 'ctpl', 'exn', 'file']) {
    assert.ok(ENTITY_KINDS[p], p);
  }
  const wiki = Object.entries(ENTITY_KINDS).filter(([, k]) => k.wiki).map(([p]) => p);
  assert.equal(wiki.at(-1), 'file');
  // §11.1: the families whose maps were once forgotten.
  assert.equal(ENTITY_KINDS.tlev.sync, 'evtMap');
  assert.equal(ENTITY_KINDS.sdlg.sync, 'dlgMap');
});

test('key columns keep their json and pattern rules', () => {
  const rel = KEY_COLUMNS.find((k) => k.table === 'entity_relation' && k.only);
  assert.ok(rel.only.test('ctpl_3') && !rel.only.test('friend'));
  assert.ok(KEY_COLUMNS.find((k) => k.table === 'story_choice_option').json);
  const item = KEY_COLUMNS.find((k) => k.table === 'page_block' && k.cols.includes('item_key'));
  assert.ok(!item.only.test('*'));
});

test('a null facet in the declaration always says why', () => {
  for (const f of DECL.families) {
    for (const facet of ['owner', 'wiki', 'sync', 'index', 'search']) {
      if (f[facet] == null) assert.ok(f.why?.[facet], `${f.prefix}.${facet}`);
    }
  }
});
