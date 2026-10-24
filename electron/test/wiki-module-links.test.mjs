// Procress 26 part 4 — module links: [[obj:Module/Object]] opens the object,
// [[mod:Module/Object]] the module with it picked. Both index to the object,
// a folder path settles two modules of one name, and renaming the object or
// any module on the path rewrites the link. Same harness as wiki-sources.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-wsrc-'));
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


// Procress 26 part 4: [[obj:Module/Object]] / [[mod:Module/Object]].
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const wiki = require('../src/db/wiki.js');
const cls = require('../src/db/classifier.js');
const mod = require('../src/db/module.js');
const note = (text) => one(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'N', ?)`, text);
const noteText = (id) => db.prepare(`SELECT content FROM note WHERE id=?`).get(id).content;
const index = (id) => wiki.reindexWikiLinks(`note_${id}`, noteText(id), 1);
const keyOf = (id, text) => db.prepare(`SELECT target_key k FROM wiki_link WHERE src_key=? AND target_text=?`).get(`note_${id}`, text)?.k ?? null;

test('parse: segments, quotes, legacy obj: without a path', () => {
  assert.deepEqual(wiki.parseWikiPath('obj:Cast/Aria'), { ns: 'obj', modules: ['Cast'], object: 'Aria' });
  assert.deepEqual(wiki.parseWikiPath('MOD:Book 1/Cast/Aria'), { ns: 'mod', modules: ['Book 1', 'Cast'], object: 'Aria' });
  assert.deepEqual(wiki.parseWikiPath('obj:Stats/"HP/MP"'), { ns: 'obj', modules: ['Stats'], object: 'HP/MP' });
  assert.equal(wiki.parseWikiPath('obj:Aria'), null, 'a legacy Director link stays legacy');
  assert.equal(wiki.parseWikiPath('obj:Cast/'), null);
  assert.equal(wiki.formatWikiPath({ ns: 'obj', modules: ['Stats'], object: 'HP/MP' }), 'obj:Stats/"HP/MP"');
});

test('resolve: both prefixes index to the object; a folder path settles a clash; ambiguous is null', () => {
  freshVault();
  const b1 = mkModule('Book 1', 'collector');
  const b2 = mkModule('Book 2', 'collector');
  const c1 = mkModule('Cast', 'classifier', b1);
  const c2 = mkModule('Cast', 'classifier', b2);
  const a1 = cls.createObject(c1, 'Aria', null, null);
  const a2 = cls.createObject(c2, 'Aria', null, null);
  const only = cls.createObject(c2, 'Bram', null, null);
  const hp = cls.createObject(c1, 'HP/MP', null, null);
  assert.equal(wiki.resolveWikiName('obj:Cast/Bram', 1), `cobj_${only}`, 'two Casts, one Bram: not ambiguous');
  assert.equal(wiki.resolveWikiName('mod:Cast/Bram', 1), `cobj_${only}`);
  assert.equal(wiki.resolveWikiName('obj:Cast/Aria', 1), null, 'two Arias: ambiguous');
  assert.equal(wiki.resolveWikiName('obj:Book 1/Cast/Aria', 1), `cobj_${a1}`);
  assert.equal(wiki.resolveWikiName('obj:book 2/cast/aria', 1), `cobj_${a2}`, 'case-insensitive like every resolver');
  assert.equal(wiki.resolveWikiName('obj:Book 3/Cast/Aria', 1), null);
  assert.equal(wiki.resolveWikiName('obj:Book 1/Cast/"HP/MP"', 1), `cobj_${hp}`);
  const n = note('[[obj:Cast/Aria]] [[obj:Book 1/Cast/Aria|her]]');
  index(n);
  assert.equal(keyOf(n, 'obj:Cast/Aria'), null, 'ambiguous → unresolved → Problems');
  assert.equal(keyOf(n, 'obj:Book 1/Cast/Aria'), `cobj_${a1}`);
});

test('rename: an object and a module rewrite their path links; a same-named one elsewhere is left alone', () => {
  freshVault();
  const b1 = mkModule('Book 1', 'collector');
  const b2 = mkModule('Book 2', 'collector');
  const c1 = mkModule('Cast', 'classifier', b1);
  const c2 = mkModule('Cast', 'classifier', b2);
  const a1 = cls.createObject(c1, 'Aria', null, null);
  cls.createObject(c2, 'Aria', null, null);
  const n = note('[[obj:Book 1/Cast/Aria]] · [[mod:Book 1/Cast/Aria|she]] · [[obj:Book 2/Cast/Aria]]');
  index(n);
  cls.updateObject(a1, 'Arianne', null, null);
  assert.equal(noteText(n), '[[obj:Book 1/Cast/Arianne]] · [[mod:Book 1/Cast/Arianne|she]] · [[obj:Book 2/Cast/Aria]]');
  assert.equal(keyOf(n, 'obj:Book 1/Cast/Arianne'), `cobj_${a1}`);
  mod.updateModule(c1, { name: 'Heroes' });
  assert.equal(noteText(n), '[[obj:Book 1/Heroes/Arianne]] · [[mod:Book 1/Heroes/Arianne|she]] · [[obj:Book 2/Cast/Aria]]');
  mod.updateModule(b1, { name: 'Part One' });
  assert.match(noteText(n), /^\[\[obj:Part One\/Heroes\/Arianne\]\]/);
  cls.updateObject(a1, 'A/B', null, null);
  assert.match(noteText(n), /^\[\[obj:Part One\/Heroes\/"A\/B"\]\]/, 'a name with / is quoted');
});

test('a link typed before its object exists resolves when the object is made', () => {
  freshVault();
  const c = mkModule('Cast', 'classifier');
  const n = note('[[obj:Cast/Later]]');
  index(n);
  assert.equal(keyOf(n, 'obj:Cast/Later'), null);
  const id = cls.createObject(c, 'Later', null, null);
  assert.equal(keyOf(n, 'obj:Cast/Later'), `cobj_${id}`);
});

test('deleting an object breaks the links to it (Problems lists them); Undo mends them', () => {
  freshVault();
  const c = mkModule('Cast', 'classifier');
  const id = cls.createObject(c, 'Gone', null, null);
  const n = note('[[obj:Cast/Gone]] [[Gone]]');
  index(n);
  const undo = require('../src/db/undo-delete.js');
  const snap = undo.captureRows('object', id);
  cls.deleteObject(id);
  assert.equal(keyOf(n, 'obj:Cast/Gone'), null);
  assert.equal(keyOf(n, 'Gone'), null);
  assert.ok(require('../src/db/problems.js').listProblems(1).some((p) => p.type === 'link' && p.key === `note_${n}`));
  undo.restoreRows(snap);
  assert.equal(keyOf(n, 'obj:Cast/Gone'), `cobj_${id}`);
  assert.equal(keyOf(n, 'Gone'), `cobj_${id}`);
});
