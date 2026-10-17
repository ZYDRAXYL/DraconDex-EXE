// Blocks re-inserted with their parent_id go parent first. A columns row made
// by moveBeside has a higher id than the blocks inside it, so re-inserting in
// id (or block_order) order under foreign_keys=ON failed: Undo of "Apply
// template" rolled back and lost the page, deleting a nested row lost the
// level below its columns, and splitting an element page dropped a column's
// blocks to the top level.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-blocktree-'));
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
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db, getAppDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  db.exec(`CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT)`);
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,NULL,?,?)`).run(name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const pb = require('../src/db/page-block.js');
const ptpl = require('../src/db/page-template.js');
const versions = require('../src/db/versions.js');

// id:type:content<-parent, ordered by id
const page = (m, key = null) => db.prepare(`SELECT id, parent_id, block_type, content FROM page_block
  WHERE module_ref=? AND ${key == null ? 'item_key IS NULL' : 'item_key=?'} ORDER BY id`)
  .all(...(key == null ? [m] : [m, key])).map((r) => `${r.id}:${r.block_type}:${r.content ?? ''}<-${r.parent_id}`);

// shape without ids: each block's content and its parent's type/content
const shape = (m, key) => {
  const rows = db.prepare(`SELECT * FROM page_block WHERE module_ref=? AND item_key=? ORDER BY block_order, id`).all(m, key);
  const by = new Map(rows.map((r) => [r.id, r]));
  return rows.map((r) => {
    const p = by.get(r.parent_id);
    return `${r.block_type}:${r.content ?? ''}<-${p ? `${p.block_type}:${p.content ?? ''}` : 'top'}`;
  });
};

test('parentFirst puts every parent before its children, roots in the given order', () => {
  const rows = [{ id: 1, parent_id: 5 }, { id: 2, parent_id: 5 }, { id: 3, parent_id: null }, { id: 4, parent_id: 3 }, { id: 5, parent_id: 3 }, { id: 9, parent_id: 99 }];
  const out = pb.parentFirst(rows).map((r) => r.id);
  assert.equal(out.length, rows.length);
  for (const r of rows) if (out.includes(r.parent_id)) assert.ok(out.indexOf(r.parent_id) < out.indexOf(r.id), `${r.parent_id} before ${r.id}`);
  assert.deepEqual(out, [3, 4, 5, 1, 2, 9]);
});

test('undo of Apply template puts back a page that has a columns row', () => {
  freshVault();
  const m = mkModule('Doc', 'drafter');
  const A = pb.addBlock(m, null, { type: 'text', content: 'A' });
  const B = pb.addBlock(m, null, { type: 'text', content: 'B' });
  pb.moveBeside(B, A, 'left'); // the row gets id 3, above A and B
  const before = page(m);
  const r = ptpl.applyTemplate(m, { page: [{ type: 'text', content: 'T' }] });
  assert.equal(r.ok, true);
  assert.notDeepEqual(page(m), before);
  ptpl.restorePageLayout(m, r.old);
  assert.deepEqual(page(m), before);
});

test('revert of a split element page with a columns row restores from history', () => {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  const A = pb.addBlock(m, 'cobj_1', { type: 'text', content: 'A' });
  const B = pb.addBlock(m, 'cobj_1', { type: 'text', content: 'B' });
  pb.moveBeside(B, A, 'left');
  const before = page(m, 'cobj_1');
  assert.equal(pb.revertItemPage(m, 'cobj_1'), true);
  assert.deepEqual(page(m, 'cobj_1'), []);
  const v = db.prepare(`SELECT id FROM module_version WHERE module_ref=? AND action='blockDel' ORDER BY id DESC`).get(m);
  assert.ok(v, 'the revert is in the history');
  assert.deepEqual(versions.restoreVersion(v.id), { ok: true });
  assert.deepEqual(page(m, 'cobj_1'), before);
});

test('undo of deleting a row puts back every level under it, not just its columns', () => {
  freshVault();
  const m = mkModule('Doc', 'drafter');
  const A = pb.addBlock(m, null, { type: 'text', content: 'A' });
  const B = pb.addBlock(m, null, { type: 'text', content: 'B' });
  const row1 = pb.moveBeside(B, A, 'left');
  const C = pb.addBlock(m, null, { type: 'text', content: 'C' });
  pb.moveBeside(B, C, 'right'); // nested: row1 = [A | row2], row2 = [B | C]
  const before = page(m);
  const r = pb.deleteBlock(row1);
  assert.deepEqual(page(m), []);
  assert.equal(r.rows.length, 5);
  pb.restoreBlocks(r.rows);
  assert.deepEqual(page(m), before);
});

test('splitting a shared layout keeps a column\'s blocks inside their row', () => {
  freshVault();
  const m = mkModule('Cast', 'classifier');
  const A = pb.addBlock(m, '*', { type: 'text', content: 'A' });
  const B = pb.addBlock(m, '*', { type: 'text', content: 'B' });
  pb.moveBeside(B, A, 'left'); // A sorts before its row in block_order
  assert.equal(pb.splitItemPage(m, 'cobj_1'), true);
  assert.deepEqual(shape(m, 'cobj_1'), shape(m, '*'));
  assert.deepEqual(shape(m, 'cobj_1').filter((s) => s.endsWith('<-top')), ['columns:<-top']);
});
