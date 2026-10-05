// Procress 16 part 3a — kind 'page': a vault built from the vendored DDL
// (no 'page' in the CHECK yet) is widened by the migration; a page module can
// then be created, and every row and index survives the rebuild.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-page-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};
const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const mig = require('../src/db/schema/migrations.js');
test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

test('the migration lets a module be a page, keeping every existing row', () => {
  const db = adaptDb(new Database(join(tmp, 'v.ddx')), 'vault');
  db.exec(VAULT_DDL_SQL);
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  db.prepare(`INSERT INTO module (nexus_ref, name, kind, handle) VALUES (1, 'Cast', 'classifier', 'cast')`).run();
  mig.migrateInlineColumns(db);
  db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1, 'Home page', 'page')`).run();
  assert.deepEqual(db.prepare(`SELECT name, kind, handle FROM module ORDER BY id`).all().map((r) => [r.name, r.kind, r.handle]),
    [['Cast', 'classifier', 'cast'], ['Home page', 'page', null]]);
  assert.throws(() => db.prepare(`INSERT INTO module (nexus_ref, name, kind, handle) VALUES (1, 'X', 'classifier', 'CAST')`).run(), 'the handle index is back');
  assert.throws(() => db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1, 'Bad', 'nope')`).run(), 'the CHECK still checks');
  mig.migrateInlineColumns(db); // twice is fine
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM module`).get().n, 2);
});
