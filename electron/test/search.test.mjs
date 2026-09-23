// v5 Part 7 (V5.md §11.4) — content search. The Thai case is the reason for
// trigram (unicode61 finds nothing inside an unspaced Thai sentence), and a
// query under 3 characters, which trigram cannot match, falls back to LIKE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-search-'));
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

const search = require('../src/db/search.js');
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;

test('finds text inside Thai, inside Classifier field values, and short queries by LIKE', () => {
  freshVault();
  const cls = mkModule('Cast', 'classifier');
  const o = one(`INSERT INTO classifier_object (module_ref, name, note) VALUES (?, 'อัศวิน', 'อัศวินมังกรเดินทางไปยังปราสาทหิมะ')`, cls);
  const f = one(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Bio', 'textarea')`, cls);
  one(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?, 'rides a silver wyvern')`, o, f);
  const book = mkModule('Book', 'author');
  one(`INSERT INTO book_chapter (module_ref, name, chapter_content) VALUES (?, 'Ch1', 'The dragon sleeps under the mountain')`, book);
  search.invalidateSearch(1);
  search.rebuildSearch(1, true);
  const keys = (q) => search.searchContent(1, q).map((r) => r.key);
  assert.deepEqual(keys('มังกร'), [`cobj_${o}`]);
  assert.deepEqual(keys('ปราสาท'), [`cobj_${o}`]);
  assert.deepEqual(keys('silver wyvern'), [`cobj_${o}`], 'a field value is searchable');
  assert.equal(keys('dragon')[0].startsWith('bchp_'), true);
  assert.deepEqual(keys('หิ'), [`cobj_${o}`], 'a 2-character query uses LIKE');
  assert.deepEqual(keys('"; DROP TABLE x; --'), [], 'nothing typed is FTS syntax');
  assert.match(search.searchContent(1, 'mountain')[0].snippet, /\[mountain\]/);
});

test('rebuild sees what changed since; a forced rebuild picks up deletions', () => {
  freshVault();
  const cls = mkModule('Cast', 'classifier');
  const o = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Zephyrine')`, cls);
  search.invalidateSearch(1);
  search.rebuildSearch(1, true);
  assert.equal(search.searchContent(1, 'zephyr').length, 1);
  db.prepare(`DELETE FROM classifier_object WHERE id=?`).run(o);
  search.rebuildSearch(1, true);
  assert.equal(search.searchContent(1, 'zephyr').length, 0);
});
