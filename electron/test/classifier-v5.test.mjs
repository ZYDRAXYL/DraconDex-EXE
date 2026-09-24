// v5 Part 3 — Classifier duplicate / move (V5.md §7.4) and the §7.9
// card/table props surviving a snapshot's template renumbering. Real
// node-sqlite3-wasm, same harness as exhibitor.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-cls3-'));
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

function seedCategory(name) {
  const cls = require('../src/db/classifier.js');
  const m = mkModule(name, 'classifier');
  const hp = cls.createTemplate(m, 'HP', 'text', false, false, null);
  const rank = cls.createTemplate(m, 'Rank', 'text', true, false, null);
  return { m, hp, rank };
}

test('duplicateObject copies values, level rows and private fields under new ids', () => {
  freshVault();
  const cls = require('../src/db/classifier.js');
  const { m, hp, rank } = seedCategory('Cast');
  const o = cls.createObject(m, 'Aria', null, null);
  cls.upsertAttr(o, hp, '12');
  const lv = cls.createLevel(o, rank);
  cls.updateLevelField(lv, 'level_label', 'Captain');
  const priv = cls.createTemplate(m, 'Secret', 'text', false, false, o);
  cls.upsertAttr(o, priv, 'shh');

  const c = cls.duplicateObject(o, 'Aria copy');
  assert.notEqual(c, o);
  const full = cls.getObjectsFull(m);
  const copy = full.objects.find((x) => x.id === c);
  assert.equal(copy.name, 'Aria copy');
  assert.equal(copy.attrMap[hp], '12');
  assert.equal(copy.levelMap[rank][0].level_label, 'Captain');
  assert.equal(copy.privateTemplates.length, 1);
  assert.notEqual(copy.privateTemplates[0].id, priv); // its own field, not the source's
  assert.equal(copy.privateTemplates[0].value, 'shh');
  // The copy sits right after the source.
  assert.deepEqual(full.objects.map((x) => x.name), ['Aria', 'Aria copy']);
});

test('moveObject re-points values at same-named target fields and creates the missing ones', () => {
  freshVault();
  const cls = require('../src/db/classifier.js');
  const a = seedCategory('Cast');
  const b = mkModule('Crew', 'classifier');
  const bHp = cls.createTemplate(b, 'hp', 'text', false, false, null); // matched case-insensitively
  const o = cls.createObject(a.m, 'Bram', null, null);
  cls.upsertAttr(o, a.hp, '7');
  cls.updateLevelField(cls.createLevel(o, a.rank), 'level_label', 'Mate');

  assert.equal(cls.moveObject(o, a.m), false); // same category
  assert.equal(cls.moveObject(o, mkModule('Notes', 'inspector')), false); // not a classifier
  assert.equal(cls.moveObject(o, b), true);

  const full = cls.getObjectsFull(b);
  const moved = full.objects.find((x) => x.id === o);
  assert.equal(moved.attrMap[bHp], '7');
  const bRank = full.templates.find((tp) => tp.description === 'Rank');
  assert.ok(bRank, 'Rank was created in the target');
  assert.equal(moved.levelMap[bRank.id][0].level_label, 'Mate');
  assert.equal(cls.getObjectsFull(a.m).objects.length, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM classifier_attribute WHERE template_ref=?`).get(a.hp).n, 0);
});

test('a card/table node keeps its chosen fields through a snapshot (template ids remapped)', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const ex = require('../src/db/exhibitor.js');
  const cls = require('../src/db/classifier.js');
  const { m, hp, rank } = seedCategory('Cast');
  const o = cls.createObject(m, 'Aria', null, null);
  const scene = mkModule('Scene', 'exhibitor');
  const [tbl] = ex.addExhibitNodes(scene, [{ node_type: 'group', props: JSON.stringify({ display: 'table', columns: [rank, hp, 9999] }) }]);
  ex.addExhibitNodes(scene, [{ linker_key: `cobj_${o}`, parent_id: tbl, props: JSON.stringify({ display: 'card', fields: [hp] }) }]);
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));

  freshVault();
  seedCategory('Pad'); // pushes every template id of the import past the originals
  assert.equal(sync.importModuleSnapshot(1, null, snap).ok, true);
  const tpl = Object.fromEntries(db.prepare(`SELECT t.id, t.description FROM classifier_template t JOIN module m ON t.module_ref=m.id WHERE m.name='Cast'`)
    .all().map((r) => [r.description, r.id]));
  const nodes = db.prepare(`SELECT n.node_type, n.props FROM exhibit_node n JOIN module m ON n.module_ref=m.id WHERE m.name='Scene' ORDER BY n.id`).all();
  assert.deepEqual(JSON.parse(nodes[0].props), { display: 'table', columns: [tpl.Rank, tpl.HP] }); // 9999 dropped
  assert.deepEqual(JSON.parse(nodes[1].props), { display: 'card', fields: [tpl.HP] });
});
