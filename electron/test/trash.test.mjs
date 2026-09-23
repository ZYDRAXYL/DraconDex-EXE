// v5 Part 7 (V5.md §11.4) — the trash. A deleted module comes back with its
// content AND with the relations that touched it from outside — the ones a
// scoped snapshot never carries. Real node-sqlite3-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-trash-'));
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

const trash = require('../src/db/trash.js');
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;

test('trash → restore brings back the subtree, its content and every relation in or out', () => {
  freshVault();
  const folder = mkModule('World', 'collector');
  const cast = mkModule('Cast', 'classifier', folder);
  const aria = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Aria')`, cast);
  const field = one(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Rival', 'relation')`, cast);
  const outside = mkModule('Places', 'classifier');
  const keep = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Keep')`, outside);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1, ?, ?, 'lives in')`, `cobj_${aria}`, `cobj_${keep}`);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1, ?, ?, 'home of')`, `cobj_${keep}`, `cobj_${aria}`);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type) VALUES (1, ?, ?, ?)`, `cobj_${aria}`, `cobj_${keep}`, `ctpl_${field}`);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1, ?, ?, 'unrelated')`, `module_${outside}`, `cobj_${keep}`);

  const r = trash.trashModule(1, cast);
  assert.equal(r.ok, true);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM module WHERE id=?`).get(cast).c, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM entity_relation`).get().c, 1, 'only the unrelated relation is left');
  assert.deepEqual(trash.listTrash(1).map((t) => [t.name, t.parent_name, t.module_count]), [['Cast', 'World', 1]]);

  const back = trash.restoreTrash(1, r.trashId);
  assert.equal(back.ok, true);
  const cast2 = db.prepare(`SELECT id, parent_id FROM module WHERE name='Cast'`).get();
  assert.equal(cast2.parent_id, folder, 'back under its old folder');
  assert.equal(back.moduleId, cast2.id);
  const aria2 = db.prepare(`SELECT id FROM classifier_object WHERE name='Aria'`).get().id;
  const field2 = db.prepare(`SELECT id FROM classifier_template WHERE description='Rival'`).get().id;
  const rels = db.prepare(`SELECT from_key, to_key, label, rel_type FROM entity_relation ORDER BY id`).all().map((x) => [x.from_key, x.to_key, x.label ?? x.rel_type]);
  assert.deepEqual(rels.sort(), [
    [`cobj_${aria2}`, `cobj_${keep}`, 'lives in'],
    [`cobj_${keep}`, `cobj_${aria2}`, 'home of'],
    [`cobj_${aria2}`, `cobj_${keep}`, `ctpl_${field2}`],
    [`module_${outside}`, `cobj_${keep}`, 'unrelated'],
  ].sort());
  assert.deepEqual(trash.listTrash(1), [], 'a restored item leaves the trash');
});

test('restore goes to the top level when the old folder is gone; empty clears everything', () => {
  freshVault();
  const folder = mkModule('World', 'collector');
  const a = mkModule('A', 'drafter', folder);
  const t1 = trash.trashModule(1, a).trashId;
  db.prepare(`DELETE FROM module WHERE id=?`).run(folder);
  trash.restoreTrash(1, t1);
  assert.equal(db.prepare(`SELECT parent_id FROM module WHERE name='A'`).get().parent_id, null);
  trash.trashModule(1, db.prepare(`SELECT id FROM module WHERE name='A'`).get().id);
  trash.trashModule(1, mkModule('B', 'drafter'));
  assert.equal(trash.emptyTrash(1), 2);
  assert.deepEqual(trash.listTrash(1), []);
});

test('a nested module\'s snapshot imports (its root named a parent outside the payload)', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const folder = mkModule('World', 'collector');
  const inner = mkModule('Inner', 'collector', folder);
  mkModule('Leaf', 'drafter', inner);
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1, sync.collectModuleSubtreeIds(1, inner))));
  freshVault();
  const r = sync.importModuleSnapshot(1, null, snap);
  assert.equal(r.summary.modules, 2, 'Inner and Leaf both come in — before the fix, neither did');
  const got = db.prepare(`SELECT m.name, p.name AS parent FROM module m LEFT JOIN module p ON m.parent_id=p.id ORDER BY m.id`).all().map((x) => [x.name, x.parent]);
  assert.deepEqual(got, [['Inner', null], ['Leaf', 'Inner']]);
});
