// Procress 28 part 6 — linked modules: a module ↔ module relation, or a
// [[link]] either way between anything of two modules, links them. The
// [[link]] side is read, not stored: drop the [[…]] and the link goes.
// Same harness as wiki-module-links.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-lmod-'));
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


const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const wiki = require('../src/db/wiki.js');
const viewer = require('../src/db/viewer.js');
const obj = (moduleId, name) => one(`INSERT INTO classifier_object (module_ref, name) VALUES (?,?)`, moduleId, name);
const linked = (id) => viewer.linkedModules(id).sort((a, b) => a.id - b.id);

test('a module relation links both ends; another relation does not', () => {
  freshVault();
  const a = mkModule('Author', 'author'), b = mkModule('Cast', 'classifier'), c = mkModule('Places', 'classifier');
  const rel = viewer.createEntityRelation(1, `module_${a}`, `module_${b}`, null, null, {});
  viewer.createEntityRelation(1, `cobj_${obj(b, 'Aria')}`, `cobj_${obj(c, 'Port')}`, null, null, {});
  const relId = typeof rel === 'object' ? rel.id : rel;
  assert.deepEqual(linked(a), [{ id: b, relationId: relId, wiki: false }]);
  assert.deepEqual(linked(b).map((e) => e.id), [a], 'from the other end too; an object relation is not a module link');
  assert.deepEqual(linked(c), []);
});

test('a [[link]] to another module or to one of its objects links them, both ways, until it is removed', () => {
  freshVault();
  const a = mkModule('Author', 'author'), b = mkModule('Cast', 'classifier'), c = mkModule('Places', 'classifier');
  const aria = obj(b, 'Aria');
  wiki.reindexWikiLinks(`module_${a}`, 'see [[obj:Cast/Aria]] and [[Places]]', 1);
  assert.ok(db.prepare(`SELECT 1 FROM wiki_link WHERE target_key=?`).get(`cobj_${aria}`), 'the object link resolved');
  assert.deepEqual(linked(a), [{ id: b, relationId: null, wiki: true }, { id: c, relationId: null, wiki: true }]);
  assert.deepEqual(linked(b), [{ id: a, relationId: null, wiki: true }], 'a backlink counts');
  wiki.reindexWikiLinks(`module_${a}`, 'nothing now', 1);
  assert.deepEqual(linked(a), [], 'gone with the text');
});

test('a link inside one module, or to itself, links nothing', () => {
  freshVault();
  const b = mkModule('Cast', 'classifier');
  const aria = obj(b, 'Aria');
  obj(b, 'Bram');
  wiki.reindexWikiLinks(`cobj_${aria}`, '[[obj:Cast/Bram]] [[Cast]]', 1);
  assert.deepEqual(linked(b), []);
});
