// v5 Part 7 (V5.md §11.6) — story variables, choice conditions and set-ops.
// The variables come from Classifier fields marked by role (the preset), the
// type by the select's POSITION (its text is translated); the evaluation is
// the pure part of mod/narrator-logic.js, run in a vm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-narlogic-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  mig.migrateInlineColumns(db); // creates idx_entity_relation_v5 on a fresh vault too
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const nar = require('../src/db/narrator.js');
const cls = require('../src/db/classifier.js');

test('variables: role-marked fields, type by choice position, keys remap in a snapshot', () => {
  freshVault();
  const m = mkModule('ตัวแปร', 'classifier');
  const tType = cls.createTemplate(m, 'ชนิด', 'select', false, false, null, { choices: ['ตัวเลข', 'จริง/เท็จ', 'ข้อความ'], role: 'varType' });
  const tDef = cls.createTemplate(m, 'ค่าเริ่ม', 'text', false, false, null, { role: 'varDefault' });
  const obj = (name, type, def) => {
    const id = cls.createObject(m, name, null, null);
    if (type != null) db.prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(id, tType, type);
    db.prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(id, tDef, def);
    return id;
  };
  const gold = obj('Gold', 'ตัวเลข', '5'), met = obj('MetKing', 'จริง/เท็จ', 'false'), guess = obj('Guess', null, 'true');
  mkModule('Other', 'classifier'); // no role fields: not variables
  const vars = nar.getStoryVariables(1);
  assert.deepEqual(vars.map((v) => [v.key, v.type, v.initial]),
    [[`cobj_${gold}`, 'number', '5'], [`cobj_${met}`, 'bool', 'false'], [`cobj_${guess}`, 'bool', 'true']]);

  // conditions are cleaned on save: a bad op or a non-variable key goes
  const n = mkModule('Story', 'narrator');
  const dl = db.prepare(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'A')`).run(n).lastInsertRowid;
  const tk = db.prepare(`INSERT INTO story_talk (dialogue_ref, row_type) VALUES (?, 'choice')`).run(dl).lastInsertRowid;
  const op = nar.createChoiceOption(tk, 'Pay');
  nar.setChoiceOptionLogic(op, [{ key: `cobj_${gold}`, op: '>=', value: 3 }, { key: 'module_1', op: '==', value: 1 }, { key: `cobj_${gold}`, op: '~', value: 1 }],
    [{ key: `cobj_${gold}`, op: '-=', value: '3' }, { key: `cobj_${met}`, op: 'toggle', value: 'x' }]);
  const row = db.prepare(`SELECT condition, set_ops FROM story_choice_option WHERE id=?`).get(op);
  assert.deepEqual(JSON.parse(row.condition), [{ key: `cobj_${gold}`, op: '>=', value: '3' }]);
  assert.deepEqual(JSON.parse(row.set_ops), [{ key: `cobj_${gold}`, op: '-=', value: '3' }, { key: `cobj_${met}`, op: 'toggle', value: '' }]);

  // …and follow their variables through a snapshot into a vault where every id moved
  const sync = require('../src/db/sync.js');
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));
  freshVault();
  mkModule('Pad', 'drafter'); cls.createObject(mkModule('Pad2', 'classifier'), 'x', null, null);
  assert.equal(sync.applySnapshot(1, snap).ok, true);
  const newGold = db.prepare(`SELECT id FROM classifier_object WHERE name='Gold'`).get().id;
  assert.notEqual(newGold, gold);
  const after = db.prepare(`SELECT condition FROM story_choice_option`).get();
  assert.equal(JSON.parse(after.condition)[0].key, `cobj_${newGold}`);
});

test('evaluation: conditions AND together; set-ops by type; unknown fails', () => {
  const src = readFileSync(new URL('../src/renderer/mod/narrator-logic.js', import.meta.url), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  const L = vm.runInContext(`${src}\n;({ narConditionHolds, narApplySetOps, narCoerce })`, ctx);
  const vars = new Map([
    ['cobj_1', { type: 'number', value: 5 }], ['cobj_2', { type: 'bool', value: false }], ['cobj_3', { type: 'text', value: 'a' }],
  ]);
  assert.equal(L.narConditionHolds([{ key: 'cobj_1', op: '>=', value: '3' }, { key: 'cobj_2', op: '==', value: 'false' }], vars), true);
  assert.equal(L.narConditionHolds([{ key: 'cobj_1', op: '>', value: '5' }], vars), false);
  assert.equal(L.narConditionHolds([{ key: 'cobj_9', op: '==', value: '1' }], vars), false);
  assert.equal(L.narConditionHolds([], vars), true);
  L.narApplySetOps([{ key: 'cobj_1', op: '-=', value: '3' }, { key: 'cobj_2', op: 'toggle' }, { key: 'cobj_3', op: '+=', value: 'b' }, { key: 'cobj_1', op: '+=', value: 'x' }], vars);
  assert.deepEqual([...vars.values()].map((v) => v.value), [2, true, 'ab']);
  L.narApplySetOps([{ key: 'cobj_1', op: '=', value: '10' }], vars);
  assert.equal(vars.get('cobj_1').value, 10);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
