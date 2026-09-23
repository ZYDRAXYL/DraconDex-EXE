// v5 Part 4 (V5.md §8.4) — every text field that can hold [[links]] is an
// entry in db/wiki-sources.js. The risk §8.12 ranks highest: a field that is
// indexed but whose links are NOT rewritten when the target is renamed —
// it fails silently, later, somewhere else. So: put [[Target]] in one row of
// EVERY registered source, rename Target, and check every row was rewritten.
// A new source added without a fixture here fails the first test on purpose.
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

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;

// One row per source prefix, each holding "[[Target]]" in its text field.
// Returns { prefix: { id, read() } }.
function seedSources() {
  const L = 'see [[Target]] here';
  const mod = mkModule('Holder', 'classifier');
  const proj = one(`INSERT INTO project (name, nexus_ref) VALUES ('P', 1)`);
  const cat = one(`INSERT INTO object_category (category_name, project_id) VALUES ('C', ?)`, proj);
  const wp = one(`INSERT INTO write_project (project_name, nexus_ref) VALUES ('W', 1)`);
  const ws = one(`INSERT INTO write_series (project_id, name) VALUES (?, 'S')`, wp);
  const wb = one(`INSERT INTO write_book (series_id, name) VALUES (?, 'B')`, ws);
  const sess = one(`INSERT INTO chat_session (module_ref, name) VALUES (?, 'Chat')`, mod);
  const tl = one(`INSERT INTO timeline (module_ref, line_name) VALUES (?, 'Line')`, mod);
  const date = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 1, 1)`);
  const cobj = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Holder obj')`, mod);
  const tpl = one(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Bio', 'textarea')`, mod);
  const attr = one(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`, cobj, tpl, L);
  const col = (table, c, id) => () => db.prepare(`SELECT ${c} AS v FROM ${table} WHERE id=?`).get(id).v;
  const rows = {
    note:   { id: one(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'N', ?)`, L) },
    obj:    { id: one(`INSERT INTO object (name, project_id, category_id, note) VALUES ('O', ?, ?, ?)`, proj, cat, L) },
    wchp:   { id: one(`INSERT INTO write_chapter (book_id, name, chapter_content) VALUES (?, 'Ch', ?)`, wb, L) },
    module: { id: mod },
    bchp:   { id: one(`INSERT INTO book_chapter (module_ref, name, chapter_content) VALUES (?, 'BC', ?)`, mod, L) },
    chss:   { id: sess },
    cobj:   { id: cobj },
    tlev:   { id: one(`INSERT INTO timeline_event (timeline_id, event_name, start_at, story) VALUES (?, 'Ev', ?, ?)`, tl, date, L) },
    sdlg:   { id: one(`INSERT INTO story_dialogue (module_ref, name, description) VALUES (?, 'Dl', ?)`, mod, L) },
    exn:    { id: one(`INSERT INTO exhibit_node (module_ref, node_type, label) VALUES (?, 'note', ?)`, mkModule('Scene', 'exhibitor'), L) },
  };
  db.prepare(`UPDATE module SET description=? WHERE id=?`).run(L, mod);
  one(`INSERT INTO chat_message (session_ref, message) VALUES (?, ?)`, sess, L);
  rows.note.read = col('note', 'content', rows.note.id);
  rows.obj.read = col('object', 'note', rows.obj.id);
  rows.wchp.read = col('write_chapter', 'chapter_content', rows.wchp.id);
  rows.module.read = col('module', 'description', mod);
  rows.bchp.read = col('book_chapter', 'chapter_content', rows.bchp.id);
  rows.chss.read = () => db.prepare(`SELECT message AS v FROM chat_message WHERE session_ref=?`).get(sess).v;
  rows.cobj.read = col('classifier_attribute', 'attribute_value', attr);
  rows.tlev.read = col('timeline_event', 'story', rows.tlev.id);
  rows.sdlg.read = col('story_dialogue', 'description', rows.sdlg.id);
  rows.exn.read = col('exhibit_node', 'label', rows.exn.id);
  return rows;
}

test('every registered source has a fixture here', () => {
  const { CONTENT_SOURCES } = require('../src/db/wiki-sources.js');
  freshVault();
  assert.deepEqual(Object.keys(seedSources()).sort(), Object.keys(CONTENT_SOURCES).sort());
});

test('rebuild indexes every source; renaming the target rewrites every one', () => {
  freshVault();
  const wiki = require('../src/db/wiki.js');
  const target = mkModule('Target', 'inspector');
  const rows = seedSources();
  wiki.rebuildWikiIndex();
  const srcs = db.prepare(`SELECT src_key FROM wiki_link WHERE target_key=? ORDER BY src_key`).all(`module_${target}`).map((r) => r.src_key);
  assert.deepEqual(srcs, Object.entries(rows).map(([p, r]) => `${p}_${r.id}`).sort());

  db.prepare(`UPDATE module SET name='Renamed' WHERE id=?`).run(target);
  const changed = wiki.renameWikiTarget(`module_${target}`, 'Target', 'Renamed');
  assert.equal(changed, Object.keys(rows).length);
  for (const [prefix, r] of Object.entries(rows)) {
    assert.equal(r.read(), 'see [[Renamed]] here', `${prefix} was not rewritten`);
  }
  // …and the index still points at the target from every source.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM wiki_link WHERE target_key=? AND target_text='Renamed'`).get(`module_${target}`).n, Object.keys(rows).length);
});

test('save hooks index the new fields; deleting the row drops its links', () => {
  freshVault();
  const cls = require('../src/db/classifier.js');
  const tlm = require('../src/db/timeline.js');
  const nar = require('../src/db/narrator.js');
  const ex = require('../src/db/exhibitor.js');
  const target = mkModule('Target', 'inspector');
  const links = (src) => db.prepare(`SELECT target_key FROM wiki_link WHERE src_key=?`).all(src).map((r) => r.target_key);

  const m = mkModule('Cast', 'classifier');
  const o = cls.createObject(m, 'Aria', null, null);
  const bio = cls.createTemplate(m, 'Bio', 'text', false, false, null);
  const born = cls.createTemplate(m, 'Born', 'date', false, false, null);
  cls.upsertAttr(o, bio, 'friend of [[Target]]');
  cls.upsertAttr(o, born, '[[Target]]'); // a date field is not free text
  assert.deepEqual(links(`cobj_${o}`), [`module_${target}`]);
  cls.deleteTemplate(bio);
  assert.deepEqual(links(`cobj_${o}`), []); // the field's value left with it

  const tl = one(`INSERT INTO timeline (module_ref, line_name) VALUES (?, 'L')`, m);
  const date = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 1, 1)`);
  const ev = tlm.createEvent(tl, 'Ev', date, null, null, 'at [[Target]]').lastInsertRowid;
  assert.deepEqual(links(`tlev_${ev}`), [`module_${target}`]);
  tlm.updateEventStory(ev, 'nothing');
  assert.deepEqual(links(`tlev_${ev}`), []);
  tlm.updateEventStory(ev, '[[Target]]');
  tlm.deleteEvent(ev);
  assert.deepEqual(links(`tlev_${ev}`), []);

  const nm = mkModule('Story', 'narrator');
  const dl = nar.createDialogue(nm, 'Dl', null, 0, 0);
  nar.updateDialogueDescription(dl, '[[Target]]');
  assert.deepEqual(links(`sdlg_${dl}`), [`module_${target}`]);

  const sc = mkModule('Scene', 'exhibitor');
  const [note, box] = ex.addExhibitNodes(sc, [{ node_type: 'note' }, { linker_key: 'cobj_1' }]);
  ex.updateExhibitNode(note, { label: 'see [[Target]]' });
  ex.updateExhibitNode(box, { label: '[[Target]]' }); // a display name, not text
  assert.deepEqual(links(`exn_${note}`), [`module_${target}`]);
  assert.deepEqual(links(`exn_${box}`), []);
  ex.deleteExhibitNode(note);
  assert.deepEqual(links(`exn_${note}`), []);
});
