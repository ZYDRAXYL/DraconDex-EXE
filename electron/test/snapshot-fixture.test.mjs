// Procress 12 part 0 — the shared snapshot fixture (vendored from
// DraconDex-SDB fixtures/, written by tools/snapshot-fixture.mjs). The
// phone's test imports the very same file; here the desktop must take its
// own output back whole: every module, relation, pin, link, Diviner entry
// and page block, nothing dropped, every key pointing at a row that exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-fix-'));
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
test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const sync = require('../src/db/sync.js');
const { ENTITY_KINDS } = require('../src/db/entity-kinds.js');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/snapshot-v2.json', import.meta.url), 'utf8'));
const count = (sql) => db.prepare(sql).get().c;

test('the shared fixture imports whole into an empty vault', () => {
  db = adaptDb(new Database(join(tmp, 'v.ddx')), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1, 'Pad', 'drafter')`).run(); // a pull replaces it, but AUTOINCREMENT ids stay shifted

  assert.equal(fixture.version, 2);
  const r = sync.applySnapshot(1, fixture);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.summary?.droppedRelations ?? r.droppedRelations ?? 0, 0);
  assert.equal(r.summary?.droppedPins ?? r.droppedPins ?? 0, 0);

  assert.equal(count(`SELECT COUNT(*) AS c FROM module WHERE nexus_ref=1`), fixture.modules.length);
  assert.equal(count(`SELECT COUNT(*) AS c FROM entity_relation`), fixture.relations.length);
  assert.equal(count(`SELECT COUNT(*) AS c FROM page_block`), fixture.pageBlocks.length);
  const exists = (k) => {
    const m = /^([a-z]+)_(\d+)$/.exec(k);
    return !!m && !!db.prepare(`SELECT 1 FROM ${ENTITY_KINDS[m[1]].table} WHERE id=?`).get(Number(m[2]));
  };
  for (const row of db.prepare(`SELECT from_key, to_key FROM entity_relation`).all()) assert.ok(exists(row.from_key) && exists(row.to_key), `${row.from_key} -> ${row.to_key}`);
  for (const t of ['sketch_pin', 'design_node', 'diviner_entry']) {
    const keys = db.prepare(`SELECT linker_key FROM ${t} WHERE linker_key IS NOT NULL`).all();
    assert.equal(keys.length, 10, `${t} links`);
    for (const { linker_key } of keys) assert.ok(exists(linker_key), `${t}: ${linker_key}`);
  }
  const items = db.prepare(`SELECT item_key, source_key FROM page_block WHERE item_key IS NOT NULL OR source_key IS NOT NULL`).all();
  assert.ok(items.some((b) => b.item_key === '*'), 'the shared element layout');
  for (const b of items) {
    if (b.item_key && b.item_key !== '*') assert.ok(exists(b.item_key), b.item_key);
    if (b.source_key) assert.ok(exists(b.source_key), b.source_key);
  }
});
