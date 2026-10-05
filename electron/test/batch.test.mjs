// Procress 17 B1 — batch write APIs. Real node-sqlite3-wasm, same harness as exhibitor.test.mjs.
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

// Procress 17 B1 — batch writes in one transaction. The plan's numbers:
// 3,000 objects + 5,000 values took 38 s over single IPC calls; target < 1 s.
const cls = require('../src/db/classifier.js');
const pb = require('../src/db/page-block.js');
const mod = require('../src/db/module.js');

test('createObjects + upsertAttrs: 3,000 objects and 5,000 values well inside the budget', () => {
  freshVault();
  const m = mkModule('Big', 'classifier');
  const tpl = db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?,?,?,0)`).run(m, 'Age', 'text').lastInsertRowid;
  const tpl2 = db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?,?,?,1)`).run(m, 'Role', 'text').lastInsertRowid;
  const t0 = performance.now();
  const ids = cls.createObjects(m, Array.from({ length: 3000 }, (_, i) => ({ name: `Obj ${i}` })));
  const n = cls.upsertAttrs(ids.flatMap((id, i) => (i < 2000 ? [{ objectId: id, templateId: tpl, value: String(i) }, { objectId: id, templateId: tpl2, value: 'x' }] : [{ objectId: id, templateId: tpl, value: String(i) }])));
  const ms = performance.now() - t0;
  assert.equal(ids.length, 3000);
  assert.equal(n, 5000);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_object WHERE module_ref=?`).get(m).n, 3000);
  assert.deepEqual(db.prepare(`SELECT display_order FROM classifier_object WHERE module_ref=? ORDER BY id LIMIT 3`).all(m).map((r) => r.display_order), [0, 1, 2]);
  console.log(`  3,000 objects + 5,000 values: ${Math.round(ms)} ms`);
  assert.ok(ms < 2000, `${Math.round(ms)} ms`); // target < 1 s (423 ms here); 2 s absorbs CI variance
});

test('createObjects is all-or-nothing', () => {
  freshVault();
  const m = mkModule('Small', 'classifier');
  assert.throws(() => cls.createObjects(m, [{ name: 'a' }, { name: null }]));
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_object WHERE module_ref=?`).get(m).n, 0);
});

test('addBlocks and createModules keep order and count', () => {
  freshVault();
  const m = mkModule('Page', 'drafter');
  const ids = pb.addBlocks(m, null, [{ type: 'text', content: 'a' }, { type: 'text', content: 'b' }, { type: 'text', content: 'c' }]);
  assert.equal(ids.length, 3);
  assert.deepEqual(db.prepare(`SELECT content FROM page_block WHERE module_ref=? AND item_key IS NULL ORDER BY block_order`).all(m).map((r) => r.content), ['a', 'b', 'c']);
  const mids = mod.createModules([1, 2, 3].map((i) => ({ nexus_ref: 1, name: `M${i}`, kind: 'drafter' })));
  assert.equal(new Set(mids).size, 3);
});

test('a batch is ONE history entry, and restoring it undoes the whole batch', () => {
  freshVault();
  const versions = require('../src/db/versions.js');
  const m = mkModule('Hist', 'classifier');
  const before = versions.listVersions(m).length;
  const ids = cls.createObjects(m, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
  const list = versions.listVersions(m);
  assert.equal(list.length, before + 1);
  assert.equal(versions.restoreVersion(list[0].id).ok, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_object WHERE id IN (${ids.join(',')})`).get().n, 0);
});

// Procress 17 B2 found this: version-history bookkeeping (a bulk prune
// DELETE) sat in the undo stack and made every field edit "irreversible".
test('a field edit can be undone (history bookkeeping is not an undo step)', () => {
  freshVault();
  db.setUndoTracking(true);
  const m = mkModule('U', 'classifier');
  const [o] = cls.createObjects(m, [{ name: 'Ann' }]);
  const tpl = db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?,?,?,0)`).run(m, 'Age', 'text').lastInsertRowid;
  cls.upsertAttr(o, tpl, '34');
  cls.upsertAttr(o, tpl, '35');
  assert.deepEqual(db.undo(), { ok: true });
  assert.equal(cls.getAttrs(o).find((a) => a.template_ref === tpl).attribute_value, '34');
  db.setUndoTracking(false);
});

// Procress 17 I3 — an object / a field deleted now and restored from the toast,
// cascaded rows included, under the same ids.
test('undo-delete: an object comes back with its values; a field with its value in every object', () => {
  freshVault();
  const ud = require('../src/db/undo-delete.js');
  const m = mkModule('U', 'classifier');
  const [a, b] = cls.createObjects(m, [{ name: 'A' }, { name: 'B' }]);
  const tpl = db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?,?,?,0)`).run(m, 'Age', 'text').lastInsertRowid;
  cls.upsertAttrs([{ objectId: a, templateId: tpl, value: '1' }, { objectId: b, templateId: tpl, value: '2' }]);
  const snapA = ud.captureRows('object', a);
  cls.deleteObject(a);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_attribute WHERE object_ref=?`).get(a).n, 0, 'the cascade took its value');
  ud.restoreRows(snapA);
  assert.equal(cls.getAttrs(a).find((x) => x.template_ref === tpl).attribute_value, '1');
  const snapF = ud.captureRows('field', tpl);
  cls.deleteTemplate(tpl);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM classifier_attribute WHERE template_ref=?`).get(tpl).n, 0);
  ud.restoreRows(snapF);
  assert.deepEqual(db.prepare(`SELECT attribute_value v FROM classifier_attribute WHERE template_ref=? ORDER BY object_ref`).all(tpl).map((r) => r.v), ['1', '2']);
});
