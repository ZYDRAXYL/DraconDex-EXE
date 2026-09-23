// v5 Part 6 (V5.md §10.8) — module presets. A preset captured from one
// module and applied to a new one reproduces its shape (look, view settings,
// a Classifier's shared fields) and nothing that names another row by id;
// the user's presets ride a whole-vault snapshot. Real node-sqlite3-wasm,
// same harness as classifier-v5.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-preset-'));
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

const preset = require('../src/db/preset.js');
const cls = require('../src/db/classifier.js');
const fields = (m) => db.prepare(`SELECT description AS name, attribute_type AS type, levelable FROM classifier_template
  WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id`).all(m);

test('capture → apply reproduces a Classifier\'s shape, not its content or its id-bearing settings', () => {
  freshVault();
  const src = mkModule('Cast', 'classifier');
  db.prepare(`INSERT INTO use_color (color_code) VALUES ('#ff0088')`).run();
  const col = db.prepare(`SELECT id FROM use_color WHERE color_code='#ff0088'`).get().id;
  db.prepare(`UPDATE module SET icon='person', color=?, description='The cast', cat_type='character' WHERE id=?`).run(col, src);
  cls.createTemplate(src, 'Age', 'text', false, false, null);
  cls.createTemplate(src, 'Rank', 'text', true, false, null);
  const o = cls.createObject(src, 'Aria', null, null);
  cls.createTemplate(src, 'Secret', 'text', false, false, o); // private: not part of the shape
  db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?, 'activeView', 'grid'), (?, 'filterDef', '{"x":1}')`).run(src, src);

  const { kind, spec } = preset.capturePreset(src);
  assert.equal(kind, 'classifier');
  assert.deepEqual(spec.ui, { activeView: 'grid' }, 'filterDef names rows by id — never captured');
  assert.deepEqual(spec.fields.map((f) => f.name), ['Age', 'Rank']);

  const dst = mkModule('New', 'classifier');
  cls.createTemplate(dst, 'Age', 'text', false, false, null); // already there: not duplicated
  assert.deepEqual(preset.applyPreset(dst, spec), { fields: 1 });
  const m = db.prepare(`SELECT icon, description, cat_type, c.color_code FROM module LEFT JOIN use_color c ON module.color=c.id WHERE module.id=?`).get(dst);
  assert.deepEqual({ ...m }, { icon: 'person', description: 'The cast', cat_type: 'character', color_code: '#ff0088' });
  assert.deepEqual(fields(dst), [{ name: 'Age', type: 'text', levelable: 0 }, { name: 'Rank', type: 'text', levelable: 1 }]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM classifier_object WHERE module_ref=?`).get(dst).n, 0, 'no content copied');
  assert.equal(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='activeView'`).get(dst).ui_value, 'grid');
});

test('a built-in style spec (as the renderer sends it) applies; junk is narrowed away', () => {
  freshVault();
  const m = mkModule('Places', 'classifier');
  preset.applyPreset(m, { catType: 'object', fields: [{ name: 'Region' }, { name: 'Notes', type: 'textarea' }, { name: '' }, { name: 'X', type: 'bogus' }],
    ui: { filterDef: '{}' }, color: 'red; drop' });
  assert.deepEqual(fields(m).map((f) => [f.name, f.type]), [['Region', 'text'], ['Notes', 'textarea'], ['X', 'text']]);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module_ui WHERE module_ref=?`).get(m).n, 0);
  assert.equal(db.prepare(`SELECT color FROM module WHERE id=?`).get(m).color, null);
});

test('save replaces by kind + name; list and delete; presets ride a whole-vault snapshot', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const m = mkModule('Cast', 'classifier');
  cls.createTemplate(m, 'Age', 'text', false, false, null);
  preset.savePreset(1, m, 'Hero sheet');
  cls.createTemplate(m, 'Role', 'text', false, false, null);
  preset.savePreset(1, m, 'Hero sheet'); // same name: an update
  const list = preset.listPresets(1, 'classifier');
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].spec.fields.map((f) => f.name), ['Age', 'Role']);
  assert.deepEqual(preset.listPresets(1, 'narrator'), []);

  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));
  assert.equal(snap.modulePresets.length, 1);
  assert.equal(sync.serializeVault(1, [m]).modulePresets.length, 0, 'a module-scoped export carries no presets');

  freshVault();
  assert.equal(sync.applySnapshot(1, snap).ok, true);
  assert.deepEqual(preset.listPresets(1, null).map((p) => [p.kind, p.name]), [['classifier', 'Hero sheet']]);
  assert.equal(preset.deletePreset(preset.listPresets(1, null)[0].id), 1);
  assert.deepEqual(preset.listPresets(1, null), []);
});
