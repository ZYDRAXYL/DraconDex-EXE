// Element pages for dialogues, Diviner tables, Sketcher pages and map pins
// (V5.md §12.4): the Nest rows they are listed by, the path a mevt_ link
// takes, and a deleted pin taking its page with it. Real node-sqlite3-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-elpages-'));
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

const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const moduleDb = require('../src/db/module.js');
const wiki = require('../src/db/wiki.js');
const wanderer = require('../src/db/wanderer.js');
const pageBlock = require('../src/db/page-block.js');

test('the Nest lists dialogues, tables, sketch pages and pins in their getters\' order', () => {
  freshVault();
  const nar = mkModule('Story', 'narrator');
  const div = mkModule('Rumors', 'diviner');
  const sk = mkModule('Sketch', 'sketcher');
  const wd = mkModule('Travels', 'wanderer');
  one(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'B')`, nar);
  one(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'A')`, nar);
  one(`INSERT INTO diviner_table (module_ref, name, display_order) VALUES (?, 'Second', 1)`, div);
  one(`INSERT INTO diviner_table (module_ref, name, display_order) VALUES (?, 'First', 0)`, div);
  one(`INSERT INTO sketch_page (module_ref, name, page_order) VALUES (?, 'P2', 1)`, sk);
  one(`INSERT INTO sketch_page (module_ref, name, page_order) VALUES (?, 'P1', 0)`, sk);
  const pin = wanderer.createMapEvent(wd, null, `module_${nar}`, 1, 2, null);
  wanderer.setMapEventLabel(pin, 'The harbor');

  const items = moduleDb.getNestItems(1);
  assert.deepEqual(items[nar].map((r) => r.name), ['B', 'A'], 'dialogues by id');
  assert.deepEqual(items[div].map((r) => r.name), ['First', 'Second']);
  assert.deepEqual(items[sk].map((r) => r.name), ['P1', 'P2']);
  assert.deepEqual(items[wd].map((r) => [r.id, r.label, r.linker_key]), [[pin, 'The harbor', `module_${nar}`]]);
});

test('a mevt_ key has a path, and a deleted pin takes its page with it', () => {
  freshVault();
  const wd = mkModule('Travels', 'wanderer');
  const pin = wanderer.createMapEvent(wd, null, null, 1, 2, null);
  assert.deepEqual(wiki.getEntityPath(`mevt_${pin}`), { kind: 'mevt', moduleId: wd, pinId: pin });

  pageBlock.splitItemPage(wd, `mevt_${pin}`);
  one(`INSERT INTO page_block (module_ref, item_key, block_type, content) VALUES (?, ?, 'text', 'Notes')`, wd, `mevt_${pin}`);
  assert.ok(db.prepare(`SELECT COUNT(*) c FROM page_block WHERE item_key=?`).get(`mevt_${pin}`).c > 0);
  wanderer.deleteMapEvent(pin);
  assert.equal(db.prepare(`SELECT COUNT(*) c FROM page_block WHERE item_key=?`).get(`mevt_${pin}`).c, 0);
  assert.ok(!wiki.getEntityPath(`mevt_${pin}`), "a deleted pin has no path");
});
