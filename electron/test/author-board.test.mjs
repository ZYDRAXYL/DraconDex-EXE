// v5 Part 7 (V5.md §11.6) — the Author corkboard's chapter facts: written one
// at a time, an unknown status or a malformed POV key is refused, not stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-auboard-'));
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

const au = require('../src/db/author.js');

test('chapter meta: partial writes, statuses and POV keys validated', () => {
  freshVault();
  const m = mkModule('Book', 'author');
  const id = au.createBookChapter(m, 'One');
  au.setBookChapterMeta(id, { synopsis: 'They meet.', status: 'draft', povKey: 'cobj_4' });
  au.setBookChapterMeta(id, { status: 'done' }); // synopsis and POV untouched
  const row = () => ({ ...db.prepare(`SELECT synopsis, status, pov_key FROM book_chapter WHERE id=?`).get(id) });
  assert.deepEqual(row(), { synopsis: 'They meet.', status: 'done', pov_key: 'cobj_4' });
  au.setBookChapterMeta(id, { status: 'finished?', povKey: 'DROP TABLE' });
  assert.deepEqual(row(), { synopsis: 'They meet.', status: null, pov_key: null });
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
