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

// Procress 31 part 1: a module or object whose name holds | [ ] — the link
// pattern used to end the name at the first | and read the rest as an alias.
test('names with | [ ] : quoted links resolve, are written quoted, and old unquoted ones still resolve', () => {
  freshVault();
  const abs = mkModule('Absolute |12|', 'collector');
  const cast = mkModule('Charactors', 'classifier', abs);
  mkModule('Charactors', 'classifier'); // a second Charactors: the folder is needed
  const o1 = cls.createObject(cast, 'object1', null, null);
  const br = cls.createObject(cast, 'A[1]', null, null);
  assert.equal(wiki.formatWikiPath({ ns: 'mod', modules: ['Absolute |12|', 'Charactors'], object: 'A[1]' }), 'mod:"Absolute |12|"/Charactors/"A[1]"');
  const n = note('[[mod:"Absolute |12|"/Charactors/object1]] · [[obj:"Absolute |12|"/Charactors/"A[1]"|her]] · [[mod:Absolute |12|/Charactors/object1]]');
  index(n);
  assert.equal(keyOf(n, 'mod:"Absolute |12|"/Charactors/object1'), `cobj_${o1}`);
  assert.equal(keyOf(n, 'obj:"Absolute |12|"/Charactors/"A[1]"'), `cobj_${br}`, 'the |alias after a quoted name still works');
  assert.equal(keyOf(n, 'mod:Absolute |12|/Charactors/object1'), `cobj_${o1}`, 'a link written before the quotes is read whole');
  cls.updateObject(o1, 'object one', null, null);
  assert.equal(noteText(n), '[[mod:"Absolute |12|"/Charactors/object one]] · [[obj:"Absolute |12|"/Charactors/"A[1]"|her]] · [[mod:"Absolute |12|"/Charactors/object one]]',
    'rename rewrites both, the old one now quoted');
});

test('the link pattern: a lone " is a character, a quote never spans ]] , and many quotes stay fast', () => {
  const all = (s) => [...s.matchAll(wiki.WIKILINK_RE)].map((m) => [m[1], m[2] ?? null]);
  assert.deepEqual(all('[[Name|alias]] [[B]]'), [['Name', 'alias'], ['B', null]]);
  assert.deepEqual(all('[[He said "hi]] then [[x]]'), [['He said "hi', null], ['x', null]]);
  assert.deepEqual(all('[[a "b]] text "c]]'), [['a "b', null]]);
  assert.deepEqual(all('[[a]][[b]]'), [['a', null], ['b', null]]);
  const t0 = Date.now();
  all('[[' + '"x'.repeat(20000) + ' |');
  all('[[' + '""'.repeat(20000));
  assert.ok(Date.now() - t0 < 500, 'no exponential backtracking');
});

// Procress 31 part 4: the relation view's dashed lines.
test('linksAmong: links whose both ends are in the set, each pair once, either direction', () => {
  freshVault();
  const c = mkModule('Cast', 'classifier');
  const a = cls.createObject(c, 'Ann', null, null), b = cls.createObject(c, 'Bo', null, null), z = cls.createObject(c, 'Zed', null, null);
  const ins = db.prepare(`INSERT INTO wiki_link (nexus_ref, src_key, target_key, target_text) VALUES (1,?,?,?)`);
  ins.run(`cobj_${a}`, `cobj_${b}`, 'Bo'); ins.run(`cobj_${b}`, `cobj_${a}`, 'Ann'); // both ways: one pair
  ins.run(`cobj_${a}`, `cobj_${z}`, 'Zed');                                          // Zed is not in the set
  ins.run(`cobj_${a}`, null, 'Nobody');                                              // unresolved
  ins.run(`cobj_${a}`, `cobj_${a}`, 'Ann');                                          // itself
  const got = wiki.linksAmong(1, [`cobj_${a}`, `cobj_${b}`]);
  assert.equal(got.length, 1);
  assert.deepEqual(new Set([got[0].from_key, got[0].to_key]), new Set([`cobj_${a}`, `cobj_${b}`]));
  assert.deepEqual(wiki.linksAmong(1, [`cobj_${a}`]), []);
});
