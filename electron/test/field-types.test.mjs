// v5 Part 7 (V5.md §11.3, §11.6) — a Classifier relation FIELD's values are
// entity_relation rows it owns (rel_type ctpl_<field id>): they must follow
// the field through retyping and deletion, and the object through
// duplicate and move. And a relation's story-time span round-trips through
// the relation API as {day, month, years}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-ftype-'));
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

const cls = require('../src/db/classifier.js');
const viewer = require('../src/db/viewer.js');
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const rels = () => db.prepare(`SELECT from_key, to_key, rel_type, module_ref FROM entity_relation ORDER BY id`).all().map((r) => ({ ...r }));

function seed() {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  const a = cls.createObject(m, 'Aria', null, null);
  const b = cls.createObject(m, 'Bram', null, null);
  const f = cls.createTemplate(m, 'Spouse', 'relation', false, false, null, { targetKinds: ['object'] });
  viewer.createEntityRelation(1, `cobj_${a}`, `cobj_${b}`, null, null, { relType: `ctpl_${f}`, moduleRef: m });
  return { m, a, b, f };
}

test('options are stored, kept by an update that does not pass them, replaced by one that does', () => {
  const { f } = seed();
  const opt = () => db.prepare(`SELECT options FROM classifier_template WHERE id=?`).get(f).options;
  assert.equal(opt(), '{"targetKinds":["object"]}');
  cls.updateTemplate(f, 'Spouse', 'relation', false, false);
  assert.equal(opt(), '{"targetKinds":["object"]}');
  cls.updateTemplate(f, 'Spouse', 'relation', false, false, null);
  assert.equal(opt(), null);
});

test('retyping or deleting the field takes its rows with it', () => {
  let { f } = seed();
  cls.updateTemplate(f, 'Spouse', 'text', false, false);
  assert.deepEqual(rels(), []);
  ({ f } = seed());
  cls.deleteTemplate(f);
  assert.deepEqual(rels(), []);
});

test('duplicate gives the copy its own row; move re-points the row at the target field', () => {
  const { m, a, b, f } = seed();
  const copy = cls.duplicateObject(a);
  assert.deepEqual(rels().map((r) => [r.from_key, r.to_key, r.rel_type]),
    [[`cobj_${a}`, `cobj_${b}`, `ctpl_${f}`], [`cobj_${copy}`, `cobj_${b}`, `ctpl_${f}`]]);
  const other = mkModule('Other', 'classifier');
  cls.moveObject(a, other);
  const tf = db.prepare(`SELECT id FROM classifier_template WHERE module_ref=? AND description='Spouse'`).get(other).id;
  const moved = rels().find((r) => r.from_key === `cobj_${a}`);
  assert.deepEqual([moved.rel_type, moved.module_ref], [`ctpl_${tf}`, other]);
  assert.equal(db.prepare(`SELECT options FROM classifier_template WHERE id=?`).get(tf).options, '{"targetKinds":["object"]}');
  assert.ok(m);
});

test('a relation span is written, read back as dates, and cleared', () => {
  freshVault();
  const id = viewer.createEntityRelation(1, 'module_1', 'module_2', 'married', null,
    { validFrom: { years: 1020, month: 3, day: 5 }, validTo: { years: 1045 } });
  const read = () => viewer.getEntityRelations(1).find((r) => r.id === id);
  assert.deepEqual(read().validFrom, { day: 5, month: 3, years: 1020 });
  assert.deepEqual(read().validTo, { day: 1, month: 1, years: 1045 });
  viewer.updateEntityRelation(id, 'married', undefined, { validFrom: null });
  assert.equal(read().validFrom, null);
  assert.deepEqual(read().validTo, { day: 1, month: 1, years: 1045 }, 'an update that does not name validTo keeps it');
});
