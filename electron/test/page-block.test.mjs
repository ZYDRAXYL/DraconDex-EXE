// v5 Part 8 (V5.md §12) — pages made of blocks. module_attribute rows become
// property blocks and the table goes; an element page falls back to the
// shared '*' layout until split; deleting an element takes its page along;
// a snapshot carries blocks as format 2, and a format 1 snapshot's
// moduleAttrs still land as property blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-blocks-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const { INDEX_SQL } = require('../src/db/schema/indexes.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db, getAppDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  db.exec(`CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT)`); // versions.js reads its limit
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const pb = require('../src/db/page-block.js');
const sync = require('../src/db/sync.js');
const classifier = require('../src/db/classifier.js');
const versions = require('../src/db/versions.js');

test('an old vault: module_attribute rows become property blocks, the table goes, indexes still build', () => {
  freshVault();
  const m = mkModule('World', 'drafter');
  db.exec(`CREATE TABLE module_attribute (id INTEGER PRIMARY KEY AUTOINCREMENT,
    module_ref INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE, attr_name TEXT NOT NULL,
    attr_value TEXT, display_order INTEGER NOT NULL DEFAULT 0, update_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare(`INSERT INTO module_attribute (module_ref, attr_name, attr_value, display_order) VALUES (?, 'era', 'third age', 1)`).run(m);
  db.prepare(`INSERT INTO module_attribute (module_ref, attr_name, attr_value, display_order) VALUES (?, 'genre', 'fantasy', 0)`).run(m);
  mig.migrateInlineColumns(db);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='module_attribute'`).get().n, 0);
  assert.deepEqual(pb.listProps(m).map((p) => [p.prop_name, p.content]), [['genre', 'fantasy'], ['era', 'third age']]);
  db.exec(INDEX_SQL); // idx_module_attribute_module would throw here if it were still listed
  mig.migrateInlineColumns(db); // idempotent
  assert.equal(pb.listProps(m).length, 2);
});

test('a page is laid out once, and properties never stack as blocks', () => {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  pb.setProp(m, null, null, 'era', 'x');
  const defs = [{ component: 'core.properties' }, { component: 'classifier.view', config: { preset: 'table' } }];
  assert.equal(pb.ensurePage(m, null, defs), true);
  const { blocks, from } = pb.listBlocks(m);
  assert.equal(from, 'own');
  assert.deepEqual(blocks.map((b) => b.component), ['core.properties', 'classifier.view']);
  assert.equal(blocks[1].config.preset, 'table');
  // The user empties the page: it stays empty.
  for (const b of blocks) pb.deleteBlock(b.id);
  assert.equal(pb.ensurePage(m, null, defs), false);
  assert.equal(pb.listBlocks(m).blocks.length, 0);
});

test('element pages: shared layout, split, revert; delete clears the page', () => {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  const a = classifier.createObject(m, 'Aria');
  const key = `cobj_${a}`;
  pb.ensurePage(m, '*', [{ component: 'item.fields' }, { component: 'core.related' }]);
  let r = pb.listBlocks(m, key);
  assert.equal(r.from, 'shared');
  assert.equal(pb.splitItemPage(m, key), true);
  r = pb.listBlocks(m, key);
  assert.equal(r.from, 'own');
  pb.addBlock(m, key, { type: 'text', content: 'Only Aria has this' });
  assert.equal(pb.listBlocks(m, key).blocks.length, 3);
  assert.equal(pb.listBlocks(m, '*').blocks.length, 2, 'the shared layout is untouched');
  assert.equal(pb.revertItemPage(m, key), true);
  assert.equal(pb.listBlocks(m, key).from, 'shared');
  pb.splitItemPage(m, key);
  pb.setProp(m, key, null, 'mood', 'calm');
  classifier.deleteObject(a);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM page_block WHERE item_key=?`).get(key).n, 0);
});

test('delete a block, restore it from history', () => {
  freshVault();
  const m = mkModule('Notes', 'drafter');
  const id = pb.addBlock(m, null, { type: 'text', content: 'hello [[World]]' });
  pb.deleteBlock(id);
  assert.equal(pb.listBlocks(m).blocks.length, 0);
  const v = db.prepare(`SELECT id FROM module_version WHERE module_ref=? AND action='blockDel'`).get(m);
  assert.ok(v, 'the delete is in the history');
  assert.deepEqual(versions.restoreVersion(v.id), { ok: true });
  assert.equal(pb.listBlocks(m).blocks[0].content, 'hello [[World]]');
});

test('snapshot v2 carries blocks and remaps their keys; v1 moduleAttrs still land', () => {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  const a = classifier.createObject(m, 'Aria');
  pb.ensurePage(m, null, [{ component: 'classifier.view', config: { preset: 'cards' } }]);
  pb.setProp(m, null, null, 'era', 'third age');
  const cols = pb.addBlock(m, null, { type: 'columns' });
  pb.addBlock(m, null, { type: 'text', content: 'inside', parentId: cols });
  pb.addBlock(m, `cobj_${a}`, { type: 'text', content: 'Aria page' });
  pb.addBlock(m, null, { component: 'classifier.view', sourceKey: `cobj_${a}` });
  const snap = sync.serializeVault(1);
  assert.equal(snap.version, 2);
  assert.equal(snap.moduleAttrs, undefined);
  assert.equal(snap.pageBlocks.length, 6);

  db.prepare(`INSERT INTO nexus (id, name) VALUES (2, 'Copy')`).run();
  const r = sync.applySnapshot(2, snap);
  assert.equal(r.ok, true, r.code);
  const m2 = db.prepare(`SELECT id FROM module WHERE nexus_ref=2`).get().id;
  const a2 = db.prepare(`SELECT id FROM classifier_object WHERE module_ref=?`).get(m2).id;
  assert.notEqual(a2, a);
  const rows = db.prepare(`SELECT * FROM page_block WHERE module_ref=? ORDER BY id`).all(m2);
  assert.equal(rows.length, 6);
  assert.ok(rows.some((b) => b.item_key === `cobj_${a2}`), 'the element page follows its element');
  assert.ok(rows.some((b) => b.source_key === `cobj_${a2}`), 'a borrowed source is remapped');
  const inner = rows.find((b) => b.content === 'inside');
  const outer = rows.find((b) => b.block_type === 'columns');
  assert.equal(inner.parent_id, outer.id);

  db.prepare(`INSERT INTO nexus (id, name) VALUES (3, 'Old')`).run();
  const v1 = sync.applySnapshot(3, {
    format: 'dracondex-vault-snapshot', version: 1, nexus: { name: 'x' },
    modules: [{ id: 5, name: 'People', kind: 'classifier' }],
    moduleAttrs: [{ moduleId: 5, name: 'era', value: 'old', displayOrder: 0 }],
  });
  assert.equal(v1.ok, true, v1.code);
  const m3 = db.prepare(`SELECT id FROM module WHERE nexus_ref=3`).get().id;
  assert.deepEqual(pb.listProps(m3).map((p) => [p.prop_name, p.content]), [['era', 'old']]);
  assert.equal(sync.applySnapshot(3, { ...snap, version: 3 }).ok, false);
});

test('a page\'s text blocks are link sources of the page', () => {
  freshVault();
  const m = mkModule('Notes', 'drafter');
  const target = mkModule('World', 'drafter');
  pb.addBlock(m, null, { type: 'text', content: 'See [[World]]' });
  const n = db.prepare(`SELECT COUNT(*) AS n FROM wiki_link WHERE src_key=? AND target_key=?`).get(`module_${m}`, `module_${target}`).n;
  assert.equal(n, 1);
});
