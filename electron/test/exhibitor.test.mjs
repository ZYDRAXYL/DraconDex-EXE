// v5 Part 2 — Exhibitor data layer: scene rows, the relation API after the
// entity_relation rebuild, and the snapshot round trip (new fields out, pre-v5
// kinds in). Real node-sqlite3-wasm, same harness as asset-nest.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-exh2-'));
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

test('addExhibitNodes: batch insert, one row per linker_key, z stacks upward', () => {
  freshVault();
  const ex = require('../src/db/exhibitor.js');
  const m = mkModule('Scene', 'exhibitor');
  const ids = ex.addExhibitNodes(m, [
    { linker_key: 'cobj_1', x: 10, y: 20 },
    { linker_key: 'cobj_2', x: 30, y: 40 },
    { linker_key: 'cobj_1', x: 99, y: 99 }, // duplicate in the same batch
    { node_type: 'note', label: 'Idea' },
  ]);
  assert.equal(ids.length, 3);
  assert.deepEqual(ex.addExhibitNodes(m, [{ linker_key: 'cobj_2' }]), []); // already placed
  const { nodes, view } = ex.getExhibitScene(m);
  assert.deepEqual(nodes.map((n) => [n.linker_key, n.node_type, n.z]), [['cobj_1', 'entity', 1], ['cobj_2', 'entity', 2], [null, 'note', 3]]);
  assert.deepEqual({ ...view }, { scale: 1, tx: 0, ty: 0, bg_linker_key: null, grid: 1, snap: 0 });
});

test('updateExhibitNode only writes allow-listed columns; moveExhibitNodes is one batch', () => {
  freshVault();
  const ex = require('../src/db/exhibitor.js');
  const m = mkModule('Scene', 'exhibitor');
  const [a, b] = ex.addExhibitNodes(m, [{ linker_key: 'cobj_1' }, { linker_key: 'cobj_2' }]);
  ex.updateExhibitNode(a, { label: 'Hero', locked: true, module_ref: 999, id: 5 });
  const row = db.prepare(`SELECT * FROM exhibit_node WHERE id=?`).get(a);
  assert.deepEqual([row.label, row.locked, row.module_ref, row.id], ['Hero', 1, m, a]);
  ex.moveExhibitNodes([{ id: a, x: 1.5, y: 2 }, { id: b, x: -3, y: 4 }]);
  assert.deepEqual(db.prepare(`SELECT x, y FROM exhibit_node ORDER BY id`).all().map((r) => [r.x, r.y]), [[1.5, 2], [-3, 4]]);
});

test('group delete takes its members; module delete takes the scene and camera', () => {
  freshVault();
  const ex = require('../src/db/exhibitor.js');
  const m = mkModule('Scene', 'exhibitor');
  const [g] = ex.addExhibitNodes(m, [{ node_type: 'group' }]);
  ex.addExhibitNodes(m, [{ linker_key: 'cobj_1', parent_id: g }, { linker_key: 'cobj_2' }]);
  ex.setExhibitView(m, { scale: 2, tx: 5, ty: 6, bogus: 1 });
  assert.deepEqual({ ...ex.getExhibitScene(m).view }, { scale: 2, tx: 5, ty: 6, bg_linker_key: null, grid: 1, snap: 0 });
  ex.deleteExhibitNode(g);
  assert.deepEqual(ex.getExhibitScene(m).nodes.map((n) => n.linker_key), ['cobj_2']);
  db.prepare(`DELETE FROM module WHERE id=?`).run(m);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM exhibit_node`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM exhibit_view`).get().n, 0);
});

test('findExhibitorFor finds the Exhibitor created for a module by its ui key', () => {
  freshVault();
  const ex = require('../src/db/exhibitor.js');
  const src = mkModule('Cast', 'classifier');
  assert.equal(ex.findExhibitorFor(src), null);
  const e = mkModule('Cast · Exhibitor', 'exhibitor');
  db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)`).run(e, 'exhibitorFor', String(src));
  assert.equal(ex.findExhibitorFor(src), e);
});

test('createEntityRelation is idempotent under the v5 index and returns the existing id', () => {
  freshVault();
  const v = require('../src/db/viewer.js');
  const m = mkModule('Scene', 'exhibitor');
  const a = v.createEntityRelation(1, 'cobj_1', 'cobj_2', null, null, { moduleRef: m });
  assert.ok(a);
  assert.equal(v.createEntityRelation(1, 'cobj_1', 'cobj_2', null, null), a); // NULL label dedupes now
  const b = v.createEntityRelation(1, 'cobj_1', 'cobj_2', null, null, { relType: 'rival', directed: false });
  assert.notEqual(b, a);
  const row = db.prepare(`SELECT rel_type, directed, module_ref FROM entity_relation WHERE id=?`).get(b);
  assert.deepEqual({ ...row }, { rel_type: 'rival', directed: 0, module_ref: null });
  assert.deepEqual(v.getRelationTypes(1), ['rival']);
  // A plain label edit (the pre-v5 call shape) leaves rel_type and direction alone.
  v.updateEntityRelation(b, 'enemies');
  assert.deepEqual({ ...db.prepare(`SELECT label, rel_type, directed FROM entity_relation WHERE id=?`).get(b) },
    { label: 'enemies', rel_type: 'rival', directed: 0 });
  v.updateEntityRelation(b, 'enemies', undefined, { directed: true });
  assert.equal(db.prepare(`SELECT directed FROM entity_relation WHERE id=?`).get(b).directed, 1);
});

test('snapshot round trip carries the scene and the v5 relation fields', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const v = require('../src/db/viewer.js');
  const ex = require('../src/db/exhibitor.js');
  const cls = mkModule('Cast', 'classifier');
  db.prepare(`INSERT INTO classifier_object (id, module_ref, name) VALUES (10, ?, 'Aria')`).run(cls);
  db.prepare(`INSERT INTO classifier_object (id, module_ref, name) VALUES (11, ?, 'Bram')`).run(cls);
  const scene = mkModule('Scene', 'exhibitor');
  const [g] = ex.addExhibitNodes(scene, [{ node_type: 'group', label: 'Family' }]);
  ex.addExhibitNodes(scene, [{ linker_key: 'cobj_10', x: 5, y: 6, parent_id: g }, { linker_key: 'cobj_11', x: 7, y: 8 }]);
  ex.setExhibitView(scene, { scale: 1.5, tx: 40, ty: 50 });
  v.createEntityRelation(1, 'cobj_10', 'cobj_11', 'sister', null, { relType: 'family', directed: false, moduleRef: scene });
  const snap = sync.serializeVault(1);
  assert.equal(snap.exhibitor.nodes.length, 3);
  assert.deepEqual({ ...snap.relations[0], moduleId: undefined }, { fromKey: 'cobj_10', toKey: 'cobj_11', label: 'sister', relType: 'family', directed: 0, moduleId: undefined });

  freshVault(); // a different vault: every id is remapped on the way in
  db.prepare(`INSERT INTO classifier_object (id, module_ref, name) SELECT 1, id, 'pad' FROM (SELECT ${mkModule('Pad', 'classifier')} AS id)`).run();
  const res = sync.importModuleSnapshot(1, null, JSON.parse(JSON.stringify(snap)));
  assert.equal(res.ok, true);
  const sceneId = db.prepare(`SELECT id FROM module WHERE name='Scene'`).get().id;
  const nodes = db.prepare(`SELECT * FROM exhibit_node WHERE module_ref=? ORDER BY id`).all(sceneId);
  const newObj = Object.fromEntries(db.prepare(`SELECT id, name FROM classifier_object`).all().map((r) => [r.name, r.id]));
  assert.deepEqual(nodes.map((n) => n.linker_key), [null, `cobj_${newObj.Aria}`, `cobj_${newObj.Bram}`]);
  assert.equal(nodes[1].parent_id, nodes[0].id); // group membership survives the id remap
  assert.deepEqual({ ...db.prepare(`SELECT scale, tx, ty FROM exhibit_view WHERE module_ref=?`).get(sceneId) }, { scale: 1.5, tx: 40, ty: 50 });
  const rel = db.prepare(`SELECT rel_type, directed, module_ref FROM entity_relation`).get();
  assert.deepEqual({ ...rel }, { rel_type: 'family', directed: 0, module_ref: sceneId });
});

test('a pre-v5 snapshot (viewer/connector kinds) applies as exhibitors', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const snap = sync.serializeVault(1);
  snap.modules = [
    { id: 1, parentId: null, name: 'Lens', kind: 'viewer' },
    { id: 2, parentId: null, name: 'Web', kind: 'connector' },
  ];
  snap.moduleUi = [
    { moduleId: 1, key: 'activeView', value: 'board' },
    { moduleId: 2, key: 'activeView', value: 'edgelist' },
  ];
  delete snap.exhibitor; // an old writer never had the key
  const res = sync.importModuleSnapshot(1, null, snap);
  assert.equal(res.ok, true);
  const kinds = db.prepare(`SELECT name, kind FROM module ORDER BY name`).all().map((r) => [r.name, r.kind]);
  assert.deepEqual(kinds, [['Lens', 'exhibitor'], ['Web', 'exhibitor']]);
  const ui = (name, k) => db.prepare(`SELECT u.ui_value v FROM module_ui u JOIN module m ON m.id=u.module_ref WHERE m.name=? AND u.ui_key=?`).get(name, k)?.v;
  assert.equal(ui('Lens', 'activeView'), 'board');
  assert.equal(ui('Web', 'activeView'), 'edges');
  assert.equal(ui('Web', 'seedScene'), '1');
});
