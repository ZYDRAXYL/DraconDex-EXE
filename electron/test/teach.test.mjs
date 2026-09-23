// v5 Part 6 (V5.md §10.4) — nexus.taught: the vault remembers which
// just-in-time tips it has shown. The column rides the v4 -> v5 migration
// (NOT NULL DEFAULT '{}', so old rows backfill), and a final answer
// (done / dismissed) is never downgraded back to "shown".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-teach-'));
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
const { getTaught, markTaught } = require('../src/db/teach.js');

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

test('a v4 nexus row gains taught = {} through the migration', () => {
  db = adaptDb(new Database(join(tmp, 'v4.ddx')), 'vault');
  // The v4 shape of nexus, before the column existed.
  db.exec(VAULT_DDL_SQL.replace(/\n\s*taught TEXT NOT NULL DEFAULT '\{\}',/, ''));
  assert.ok(!db.prepare(`PRAGMA table_info(nexus)`).all().some((c) => c.name === 'taught'), 'fixture is the v4 shape');
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'Old')`).run();
  mig.migrateInlineColumns(db);
  mig.migrateInlineColumns(db); // idempotent
  assert.equal(db.prepare(`SELECT taught FROM nexus WHERE id=1`).get().taught, '{}');
  assert.deepEqual(getTaught(1), {});
});

test('markTaught records answers and never downgrades one to shown', () => {
  assert.deepEqual(markTaught(1, 'filter', 'shown'), { filter: 'shown' });
  assert.deepEqual(markTaught(1, 'filter', 'dismissed'), { filter: 'dismissed' });
  assert.deepEqual(markTaught(1, 'filter', 'shown'), { filter: 'dismissed' });
  markTaught(1, 'workspace', 'done');
  assert.deepEqual(getTaught(1), { filter: 'dismissed', workspace: 'done' });
});

test('markTaught rejects a bad tip id or state; a corrupt value reads as {}', () => {
  assert.throws(() => markTaught(1, 'x"; DROP', 'done'));
  assert.throws(() => markTaught(1, 'filter', 'maybe'));
  db.prepare(`UPDATE nexus SET taught='not json' WHERE id=1`).run();
  assert.deepEqual(getTaught(1), {});
});
