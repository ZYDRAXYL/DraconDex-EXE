// v5 Part 7 (V5.md §11.10) — the two app-level tools. Problems finds an
// unresolved [[link]], an empty content module and a relation whose end is
// gone; CSV reads a Thai file Excel saved as windows-874, honours a BOM and
// quotes, guesses column types, and lands as ONE Classifier (no folder).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-tools-'));
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

const { listProblems } = require('../src/db/problems.js');
const csv = require('../src/db/csv-import.js');
const bundle = require('../src/db/bundle.js');
const wiki = require('../src/db/wiki.js');
const { writeFileSync } = require('node:fs');

test('problems: dangling link, empty module, relation to a deleted row', () => {
  freshVault();
  const cls = mkModule('Cast', 'classifier');
  mkModule('Empty book', 'author');
  const d = mkModule('Notes', 'drafter');
  db.prepare(`UPDATE module SET description='See [[Nobody]]' WHERE id=?`).run(d);
  wiki.reindexWikiLinks(`module_${d}`, 'See [[Nobody]]', 1);
  const a = db.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'A')`).run(cls).lastInsertRowid;
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type) VALUES (1, ?, 'cobj_999', 'friend')`).run(`cobj_${a}`);
  const p = listProblems(1);
  assert.deepEqual(p.filter((x) => x.type === 'link').map((x) => [x.key, x.detail]), [[`module_${d}`, '[[Nobody]]']]);
  assert.deepEqual(p.filter((x) => x.type === 'empty').map((x) => x.name), ['Empty book']); // Cast has an object; Notes has text
  const rel = p.find((x) => x.type === 'relation');
  assert.equal(rel.key, `cobj_${a}`);
  assert.match(rel.detail, /friend → cobj_999/);
});

test('csv: BOM, UTF-8, windows-874; quotes; delimiter; type guesses', () => {
  const thai874 = Buffer.from([0xaa, 0xd7, 0xe8, 0xcd, 0x2c, 0xcd, 0xd2, 0xc2, 0xd8, 0x0a, 0xc1, 0xd4, 0xc3, 0xd2, 0x2c, 0x33, 0x34]); // ชื่อ,อายุ / มิรา,34
  assert.deepEqual(csv.decodeCsvBuffer(thai874), { text: 'ชื่อ,อายุ\nมิรา,34', encoding: 'windows-874' });
  assert.equal(csv.decodeCsvBuffer(Buffer.from('﻿a,b', 'utf8')).encoding, 'utf-8');
  assert.equal(csv.decodeCsvBuffer(Buffer.from('ชื่อ', 'utf8')).text, 'ชื่อ');
  assert.deepEqual(csv.parseCsv('Name,Note\r\n"Mira, the captain","says ""hi""\nthen leaves"\r\n\r\nTobin,x').rows,
    [['Name', 'Note'], ['Mira, the captain', 'says "hi"\nthen leaves'], ['Tobin', 'x']]);
  assert.equal(csv.parseCsv('a;b;c\n1;2;3').delimiter, ';');
  assert.equal(csv.guessColumnType(['1', '2.5', '1,000', '']), 'number');
  assert.equal(csv.guessColumnType(['จริง', 'เท็จ', 'yes']), 'checkbox');
  assert.equal(csv.guessColumnType(['2024-01-02', '1999-12-31']), 'date');
  assert.equal(csv.guessColumnType(['hello', '3']), 'text');
});

test('csv file → one Classifier, no folder, values typed', () => {
  freshVault();
  const f = join(tmp, 'cast.csv');
  writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Name,Age,Alive\nมิรา,34,yes\nTobin,58,no\n', 'utf8')]));
  const r = csv.readCsvFile(f);
  assert.equal(r.ok, true);
  assert.deepEqual(r.types, ['name', 'number', 'checkbox']);
  const made = bundle.createBundle(1, null, { name: 'Cast', folder: false, modules: [{ kind: 'classifier', name: 'Cast',
    fields: [{ name: 'Age', type: 'number' }, { name: 'Alive', type: 'checkbox' }],
    objects: r.rows.map((row) => ({ name: row[0], values: { Age: row[1], Alive: row[2] === 'yes' } })) }] });
  assert.equal(made.ok, true);
  assert.equal(made.folderId, null);
  assert.deepEqual(db.prepare(`SELECT kind, parent_id FROM module`).all().map((m) => [m.kind, m.parent_id]), [['classifier', null]]);
  const vals = db.prepare(`SELECT o.name, a.attribute_value v FROM classifier_attribute a JOIN classifier_object o ON o.id=a.object_ref ORDER BY o.id, a.template_ref`).all().map((x) => [x.name, x.v]);
  assert.deepEqual(vals, [['มิรา', '34'], ['มิรา', '1'], ['Tobin', '58'], ['Tobin', '0']]);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
