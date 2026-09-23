// v5 Part 2 (APP docs/V5.md §4.2) — the two table rebuilds, run against a
// v4-shaped vault that already holds data, because §4.2.3 is explicit: this
// repo's DDL has failed on real vaults (SQLITE_LOCKED) where empty ones
// passed. Same real-database harness as asset-nest.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-exh-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const { INDEX_SQL } = require('../src/db/schema/indexes.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db } };

// The v4 shape: the old kind CHECK and the old 3-column entity_relation.
const V4_DDL = VAULT_DDL_SQL
  .replace(`'exhibitor','sketcher','designer','diviner'`, `'viewer','connector','sketcher','designer'`)
  .replace(/(label TEXT,\s*color INTEGER REFERENCES use_color\(id\),\s*create_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)),\s*module_ref INTEGER REFERENCES module\(id\) ON DELETE SET NULL,\s*rel_type TEXT,\s*directed INTEGER NOT NULL DEFAULT 1,\s*UNIQUE\(from_key, to_key, label, rel_type\)/,
    '$1,\n      UNIQUE(from_key, to_key, label)');

function openVault(ddl) {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(ddl);
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}

function seedV4() {
  openVault(V4_DDL);
  const ins = db.prepare(`INSERT INTO module (id, nexus_ref, parent_id, name, kind, handle) VALUES (?,1,?,?,?,?)`);
  ins.run(1, null, 'Root', 'collector', 'root');
  ins.run(2, 1, 'Cast', 'classifier', null);
  ins.run(3, 1, 'Lens', 'viewer', null);
  ins.run(4, 1, 'Web', 'connector', 'web');
  ins.run(5, 4, 'Child of web', 'drafter', null);
  const ui = db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)`);
  ui.run(3, 'activeView', 'cards');
  ui.run(4, 'activeView', 'edgelist');
  ui.run(4, 'filterDef', '{"groups":[]}');
  db.prepare(`INSERT INTO classifier_object (id, module_ref, name) VALUES (10, 2, 'Aria')`).run();
  db.prepare(`INSERT INTO classifier_object (id, module_ref, name) VALUES (11, 2, 'Bram')`).run();
  const rel = db.prepare(`INSERT INTO entity_relation (id, nexus_ref, from_key, to_key, label) VALUES (?,1,?,?,?)`);
  rel.run(100, 'cobj_10', 'cobj_11', 'sibling');
  rel.run(101, 'cobj_10', 'cobj_11', null); // NULL label: the old UNIQUE let these pile up (§4.2.1)
  rel.run(102, 'cobj_10', 'cobj_11', null);
  rel.run(103, 'cobj_10', 'cobj_11', null);
  rel.run(104, 'module_2', 'module_4', 'feeds');
}

const kinds = () => Object.fromEntries(db.prepare(`SELECT id, kind FROM module`).all().map((r) => [r.id, r.kind]));
const ui = (id, k) => db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key=?`).get(id, k)?.ui_value;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

test('the v4 fixture really has the old shapes (guards the regexes above)', () => {
  seedV4();
  assert.match(db.prepare(`SELECT sql FROM sqlite_master WHERE name='module'`).get().sql, /'connector'/);
  assert.ok(!db.prepare(`PRAGMA table_info(entity_relation)`).all().some((c) => c.name === 'rel_type'));
});

test('module rebuild: viewer/connector become exhibitor, ids and children survive', () => {
  seedV4();
  mig.migrateInlineColumns(db);
  db.exec(INDEX_SQL);
  assert.deepEqual(kinds(), { 1: 'collector', 2: 'classifier', 3: 'exhibitor', 4: 'exhibitor', 5: 'drafter' });
  assert.equal(db.prepare(`SELECT parent_id FROM module WHERE id=5`).get().parent_id, 4);
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
  // The saved view carries over; a former Connector is flagged for seeding.
  assert.equal(ui(3, 'activeView'), 'cards');
  assert.equal(ui(4, 'activeView'), 'edges');
  assert.equal(ui(4, 'seedScene'), '1');
  assert.equal(ui(3, 'seedScene'), undefined);
  // The new CHECK is live, and the handle index came back.
  assert.throws(() => db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,'x','viewer')`).run(), /CHECK/);
  db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,'d','diviner')`).run();
  assert.throws(() => db.prepare(`INSERT INTO module (nexus_ref, name, kind, handle) VALUES (1,'y','drafter','ROOT')`).run(), /UNIQUE/);
  // Cascades still point at the rebuilt table.
  db.prepare(`DELETE FROM module WHERE id=2`).run();
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_object`).get().n, 0);
});

test('entity_relation rebuild: ids kept, NULL-label duplicates removed and reported, index blocks new ones', () => {
  seedV4();
  mig.takeRelationDedupeReport();
  mig.migrateInlineColumns(db);
  const ids = db.prepare(`SELECT id FROM entity_relation ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(ids, [100, 101, 104]); // lowest id of the 101-103 group survives
  assert.equal(mig.takeRelationDedupeReport(), 2);
  assert.equal(mig.takeRelationDedupeReport(), 0); // reported once
  const r = db.prepare(`SELECT directed, rel_type, module_ref FROM entity_relation WHERE id=100`).get();
  assert.deepEqual({ ...r }, { directed: 1, rel_type: null, module_ref: null });
  assert.throws(() => db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key) VALUES (1,'cobj_10','cobj_11')`).run(), /UNIQUE/);
  // Same pair + label but a different rel_type is now allowed — the point of §4.2.
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label, rel_type) VALUES (1,'cobj_10','cobj_11','sibling','family')`).run();
  assert.deepEqual(db.prepare(`PRAGMA foreign_key_check`).all(), []);
});

test('both rebuilds are idempotent and leave a fresh v5 vault untouched', () => {
  seedV4();
  mig.migrateInlineColumns(db);
  const once = db.prepare(`SELECT sql FROM sqlite_master WHERE name IN ('module','entity_relation') ORDER BY name`).all();
  mig.migrateInlineColumns(db);
  assert.deepEqual(db.prepare(`SELECT sql FROM sqlite_master WHERE name IN ('module','entity_relation') ORDER BY name`).all(), once);
  openVault(VAULT_DDL_SQL);
  const fresh = db.prepare(`SELECT sql FROM sqlite_master WHERE name IN ('module','entity_relation') ORDER BY name`).all();
  mig.migrateInlineColumns(db);
  assert.deepEqual(db.prepare(`SELECT sql FROM sqlite_master WHERE name IN ('module','entity_relation') ORDER BY name`).all(), fresh);
  assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name='idx_entity_relation_v5'`).get());
});

test('a migrated vault and a fresh one end with the same table definitions', () => {
  seedV4();
  mig.migrateInlineColumns(db);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`);
  const migrated = { m: cols('module'), r: cols('entity_relation') };
  openVault(VAULT_DDL_SQL);
  assert.deepEqual({ m: cols('module'), r: cols('entity_relation') }, migrated);
});
