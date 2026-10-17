// Nest ▸ Duplicate copies a module's CONTENT, not just its row. Before the
// fix (module.js cloneModuleSubtree) a Classifier with fields and objects
// came out as an empty "X (Copy)", a Chronicler with events came out with
// none — and the toast still said it worked. Real node-sqlite3-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-dup-'));
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
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const mkModule = (name, kind, parent = null) =>
  one(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`, parent, name, kind);
const count = (sql, ...a) => db.prepare(sql).get(...a).c;
const copyOf = (name) => db.prepare(`SELECT * FROM module WHERE name=?`).get(`${name} (Copy)`);

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const mod = require('../src/db/module.js');

test('Classifier: fields, objects, values, levels and an internal relation all come across, remapped', () => {
  freshVault();
  const folder = mkModule('World', 'collector');
  const cast = mkModule('Characters', 'classifier', folder);
  const other = mkModule('Places', 'classifier', folder);
  const town = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Town')`, other);
  const tpl = [];
  for (let i = 0; i < 11; i++) tpl.push(one(`INSERT INTO classifier_template (module_ref, description, display_order) VALUES (?,?,?)`, cast, `F${i}`, i));
  const rank = one(`INSERT INTO classifier_template (module_ref, description, levelable) VALUES (?, 'Rank', 1)`, cast);
  const rival = one(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Rival', 'relation')`, cast);
  const objs = [];
  for (let i = 0; i < 5; i++) {
    const o = one(`INSERT INTO classifier_object (module_ref, name, display_order) VALUES (?,?,?)`, cast, `O${i}`, i);
    objs.push(o);
    for (const t of tpl) one(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`, o, t, `v${i}-${t}`);
  }
  one(`INSERT INTO classifier_level (object_ref, template_ref, level_label, display_order) VALUES (?,?, 'I', 0)`, objs[0], rank);
  one(`INSERT INTO classifier_level (object_ref, template_ref, level_label, display_order) VALUES (?,?, 'II', 1)`, objs[0], rank);
  // internal: O0 -> O1 through the Rival relation field
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type, module_ref) VALUES (1,?,?,?,?)`, `cobj_${objs[0]}`, `cobj_${objs[1]}`, `ctpl_${rival}`, cast);
  // outgoing: O2 -> Town (outside) — kept pointing at Town
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1,?,?, 'lives in')`, `cobj_${objs[2]}`, `cobj_${town}`);
  // incoming: Town -> O3 — Places' content, not duplicated
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1,?,?, 'home of')`, `cobj_${town}`, `cobj_${objs[3]}`);
  const before = db.prepare(`SELECT * FROM entity_relation ORDER BY id`).all();

  const newId = mod.duplicateModule(cast);
  const c = copyOf('Characters');
  assert.equal(c.id, newId);
  assert.notEqual(newId, cast);
  assert.equal(c.parent_id, folder, 'a sibling of the source');
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_template WHERE module_ref=?`, newId), 13);
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_object WHERE module_ref=?`, newId), 5);
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_attribute a JOIN classifier_object o ON a.object_ref=o.id WHERE o.module_ref=?`, newId), 55);
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_level l JOIN classifier_object o ON l.object_ref=o.id WHERE o.module_ref=?`, newId), 2);
  // values landed on the copy's own templates, not the source's
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_attribute a JOIN classifier_object o ON a.object_ref=o.id
    JOIN classifier_template t ON a.template_ref=t.id WHERE o.module_ref=? AND t.module_ref<>?`, newId, newId), 0);

  const o = (n) => db.prepare(`SELECT id FROM classifier_object WHERE module_ref=? AND name=?`).get(newId, n).id;
  const rival2 = db.prepare(`SELECT id FROM classifier_template WHERE module_ref=? AND description='Rival'`).get(newId).id;
  const added = db.prepare(`SELECT from_key, to_key, label, rel_type, module_ref FROM entity_relation WHERE id > ? ORDER BY id`).all(before.at(-1).id);
  assert.deepEqual(added.map((r) => [r.from_key, r.to_key, r.rel_type ?? r.label, r.module_ref]), [
    [`cobj_${o('O0')}`, `cobj_${o('O1')}`, `ctpl_${rival2}`, newId],
    [`cobj_${o('O2')}`, `cobj_${town}`, 'lives in', null],
  ], 'internal relation remapped to the copy, outgoing kept, incoming not duplicated');

  // originals untouched
  assert.deepEqual(db.prepare(`SELECT * FROM entity_relation WHERE id <= ? ORDER BY id`).all(before.at(-1).id), before);
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_object WHERE module_ref=?`, cast), 5);
  assert.equal(count(`SELECT COUNT(*) c FROM classifier_template WHERE module_ref=?`, cast), 13);
});

test('Chronicler: its timeline and events come across (and no extra empty timeline is seeded)', () => {
  freshVault();
  const chr = mkModule('History', 'chronicler');
  const tl = one(`INSERT INTO timeline (line_name, module_ref) VALUES ('Main', ?)`, chr);
  for (let i = 1; i <= 3; i++) {
    const dt = one(`INSERT INTO timeline_date (day, month, years, hour, minute) VALUES (1,1,?,0,0)`, 1000 + i);
    one(`INSERT INTO timeline_event (timeline_id, event_name, start_at, story) VALUES (?,?,?,?)`, tl, `E${i}`, dt, `story ${i}`);
  }
  const newId = mod.duplicateModule(chr);
  assert.equal(count(`SELECT COUNT(*) c FROM timeline WHERE module_ref=?`, newId), 1);
  assert.equal(count(`SELECT COUNT(*) c FROM timeline_event e JOIN timeline t ON e.timeline_id=t.id WHERE t.module_ref=?`, newId), 3);
  assert.equal(count(`SELECT COUNT(*) c FROM timeline_event e JOIN timeline t ON e.timeline_id=t.id WHERE t.module_ref=?`, chr), 3);
});

test('Author: chapters with their text come across; a POV key outside the copy is kept', () => {
  freshVault();
  const cast = mkModule('Cast', 'classifier');
  const hero = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Hero')`, cast);
  const book = mkModule('Book', 'author');
  for (let i = 0; i < 4; i++) {
    one(`INSERT INTO book_chapter (module_ref, name, chapter_content, chapter_order, pov_key) VALUES (?,?,?,?,?)`, book, `Ch${i}`, `text ${i}`, i, `cobj_${hero}`);
  }
  const newId = mod.duplicateModule(book);
  const rows = db.prepare(`SELECT name, chapter_content, pov_key FROM book_chapter WHERE module_ref=? ORDER BY chapter_order`).all(newId);
  assert.deepEqual(rows.map((r) => [r.name, r.chapter_content, r.pov_key]),
    [0, 1, 2, 3].map((i) => [`Ch${i}`, `text ${i}`, `cobj_${hero}`]));
  assert.equal(count(`SELECT COUNT(*) c FROM book_chapter WHERE module_ref=?`, book), 4);
});

test('page blocks: a nested columns layout comes across parent-first, with a child whose id is lower than its parent', () => {
  freshVault();
  const other = mkModule('Elsewhere', 'drafter');
  const page = mkModule('Notes', 'drafter');
  const asset = one(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type) VALUES (1, 'a.png', 'C:/x/a.png', 'png')`);
  // created before its future parent, then moved inside it (moveBeside)
  const early = one(`INSERT INTO page_block (module_ref, block_type, content, block_order) VALUES (?, 'text', 'early', 0)`, page);
  const cols = one(`INSERT INTO page_block (module_ref, block_type, block_order) VALUES (?, 'columns', 1)`, page);
  const left = one(`INSERT INTO page_block (module_ref, parent_id, block_type, block_order) VALUES (?,?, 'columns', 0)`, page, cols);
  db.prepare(`UPDATE page_block SET parent_id=? WHERE id=?`).run(left, early);
  one(`INSERT INTO page_block (module_ref, parent_id, block_type, content, block_order) VALUES (?,?, 'heading', 'right', 1)`, page, cols);
  one(`INSERT INTO page_block (module_ref, block_type, component, source_key, block_order) VALUES (?, 'component', 'list', ?, 2)`, page, `module_${other}`);
  one(`INSERT INTO page_block (module_ref, block_type, source_key, block_order) VALUES (?, 'image', ?, 3)`, page, `file_${asset}`);

  const newId = mod.duplicateModule(page);
  const tree = (m) => {
    const rows = db.prepare(`SELECT id, parent_id, block_type, content, source_key FROM page_block WHERE module_ref=? ORDER BY id`).all(m);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const path = (r) => (r.parent_id == null ? '' : path(byId.get(r.parent_id)) + '>') + r.block_type + (r.content ? `:${r.content}` : '');
    return rows.map((r) => [path(r), r.source_key]).sort();
  };
  const src = tree(page);
  assert.equal(src.length, 6);
  assert.deepEqual(tree(newId), src, 'same nesting; the borrowed module and the shared asset still point where they did');
  const ids = db.prepare(`SELECT id, parent_id FROM page_block WHERE module_ref=?`).all(newId);
  const own = new Set(ids.map((r) => r.id));
  assert.ok(ids.every((r) => r.parent_id == null || own.has(r.parent_id)), "the copy's blocks nest inside the copy, not the source");
  assert.equal(count(`SELECT COUNT(*) c FROM import_file`), 1, 'the asset is shared, not duplicated');
});

test('Collector: children (and their content) are copied recursively; only the root is renamed', () => {
  freshVault();
  const top = mkModule('Saga', 'collector');
  const sub = mkModule('Arc', 'collector', top);
  const a = mkModule('Cast', 'classifier', sub);
  const b = mkModule('Ideas', 'drafter', top);
  const x = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'X')`, a);
  const y = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Y')`, a);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1,?,?, 'knows')`, `cobj_${x}`, `cobj_${y}`);
  one(`INSERT INTO page_block (module_ref, block_type, content, block_order) VALUES (?, 'text', 'idea', 0)`, b);
  db.prepare(`UPDATE module SET pinned=1, handle='saga' WHERE id=?`).run(top);

  const newId = mod.duplicateModule(top);
  const names = (root) => {
    const out = [];
    const walk = (id, d) => {
      for (const r of db.prepare(`SELECT id, name, kind FROM module WHERE parent_id=? ORDER BY display_order, id`).all(id)) {
        out.push(`${'-'.repeat(d)}${r.name}:${r.kind}`); walk(r.id, d + 1);
      }
    };
    walk(root, 0);
    return out;
  };
  assert.deepEqual(names(newId), names(top));
  const root = db.prepare(`SELECT * FROM module WHERE id=?`).get(newId);
  assert.equal(root.name, 'Saga (Copy)');
  assert.equal(root.pinned, 0);
  assert.equal(root.handle, null);
  assert.equal(count(`SELECT COUNT(*) c FROM module WHERE name='Arc (Copy)'`), 0);
  assert.equal(count(`SELECT COUNT(*) c FROM module`), 8);
  const cast2 = db.prepare(`SELECT id FROM module WHERE name='Cast' AND id<>?`).get(a).id;
  const objs2 = db.prepare(`SELECT id, name FROM classifier_object WHERE module_ref=? ORDER BY name`).all(cast2);
  assert.deepEqual(objs2.map((r) => r.name), ['X', 'Y']);
  assert.equal(count(`SELECT COUNT(*) c FROM entity_relation WHERE from_key=? AND to_key=?`, `cobj_${objs2[0].id}`, `cobj_${objs2[1].id}`), 1);
  assert.equal(count(`SELECT COUNT(*) c FROM page_block p JOIN module m ON p.module_ref=m.id WHERE m.name='Ideas'`), 2);
});

test('Duplicate is one undo step: Ctrl+Z removes the whole copy and its relations, redo brings it back', () => {
  freshVault();
  db.setUndoTracking(true);
  const cast = mkModule('Cast', 'classifier');
  const x = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'X')`, cast);
  const y = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Y')`, cast);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (1,?,?, 'knows')`, `cobj_${x}`, `cobj_${y}`);
  mod.setModuleTags(cast, [one(`INSERT INTO hashtag (tag_name) VALUES ('hero')`)]);
  const snap = () => ({
    mods: count(`SELECT COUNT(*) c FROM module`),
    objs: count(`SELECT COUNT(*) c FROM classifier_object`),
    rels: count(`SELECT COUNT(*) c FROM entity_relation`),
    tags: count(`SELECT COUNT(*) c FROM module_hashtag`),
  });
  const base = snap();
  // main.js runs every module:* write inside one transaction — do the same
  db.transaction(() => mod.duplicateModule(cast))();
  assert.deepEqual(snap(), { mods: 2, objs: 4, rels: 2, tags: 2 });
  assert.deepEqual(db.undo(), { ok: true });
  assert.deepEqual(snap(), base, 'one step takes the whole copy away');
  assert.deepEqual(db.redo(), { ok: true });
  assert.deepEqual(snap(), { mods: 2, objs: 4, rels: 2, tags: 2 });
  assert.deepEqual(db.undo(), { ok: true }, 'undo follows the redone copy');
  assert.deepEqual(snap(), base);
});
