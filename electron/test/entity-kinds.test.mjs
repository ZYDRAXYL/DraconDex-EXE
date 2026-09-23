// v5 Part 7 (V5.md §11.1–§11.2) — the round trip the §11.1 bug slipped
// through. One row of EVERY entity family that declares `sync` in
// db/entity-kinds.js, a relation between every pair, a sketch pin and a
// Designer link to each → serializeVault → applySnapshot into an empty
// vault → nothing dropped. A new family registered with `sync` but no
// fixture here fails the first test on purpose — no one has to remember.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-ekind-'));
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

const sync = require('../src/db/sync.js');
const { ENTITY_KINDS, entityKeyMaps } = require('../src/db/entity-kinds.js');
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;

// prefix -> () => id of a fresh row, in a vault that has module 1 ('Holder').
const SEED = {
  note: () => one(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'N', '')`),
  module: () => mkModule('M2', 'drafter'),
  bchp: () => one(`INSERT INTO book_chapter (module_ref, name) VALUES (?, 'Ch')`, mkModule('Book', 'author')),
  chss: () => one(`INSERT INTO chat_session (module_ref, name) VALUES (?, 'Chat')`, mkModule('Scribe', 'scribe')),
  cobj: () => one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Obj')`, mkModule('Cls', 'classifier')),
  tlev: () => {
    const tl = one(`INSERT INTO timeline (module_ref, line_name) VALUES (?, 'Line')`, mkModule('Chr', 'chronicler'));
    const dt = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 1, 1)`);
    return one(`INSERT INTO timeline_event (timeline_id, event_name, start_at) VALUES (?, 'Ev', ?)`, tl, dt);
  },
  sdlg: () => one(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'Dlg')`, mkModule('Nar', 'narrator')),
  skpg: () => one(`INSERT INTO sketch_page (module_ref, name) VALUES (?, 'Page')`, mkModule('Sk2', 'sketcher')),
  ctpl: () => one(`INSERT INTO classifier_template (module_ref, description) VALUES (?, 'Field')`, mkModule('Cls2', 'classifier')),
  divt: () => one(`INSERT INTO diviner_table (module_ref, name) VALUES (?, 'Tbl')`, mkModule('Div', 'diviner')),
};
const synced = Object.keys(ENTITY_KINDS).filter((p) => ENTITY_KINDS[p].sync);

test('every family that syncs has a fixture here', () => {
  assert.deepEqual(synced.filter((p) => !SEED[p]), []);
});

test('every family, every pair: nothing dropped through serialize → apply', () => {
  freshVault();
  const keys = synced.map((p) => `${p}_${SEED[p]()}`);
  for (const a of keys) for (const b of keys) {
    if (a !== b) one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label, rel_type) VALUES (1,?,?,'rel','t')`, a, b);
  }
  const page = one(`INSERT INTO sketch_page (module_ref, name) VALUES (?, 'P')`, mkModule('Sk', 'sketcher'));
  const dm = mkModule('Dg', 'designer');
  const dtab = one(`INSERT INTO diviner_table (module_ref, name) VALUES (?, 'Links')`, mkModule('Div2', 'diviner'));
  for (const k of keys) {
    one(`INSERT INTO diviner_entry (table_ref, linker_key) VALUES (?,?)`, dtab, k);
    one(`INSERT INTO sketch_pin (page_ref, linker_key, x, y) VALUES (?,?,0,0)`, page, k);
    one(`INSERT INTO design_node (module_ref, shape, x, y, linker_key) VALUES (?, 'box', 0, 0, ?)`, dm, k);
  }
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));

  freshVault();
  mkModule('Pad', 'drafter'); // shifts every id, so a key that is not remapped cannot pass by luck
  const r = sync.applySnapshot(1, snap);
  assert.equal(r.ok, true);
  assert.equal(r.summary?.droppedRelations ?? r.droppedRelations, 0);
  assert.equal(r.summary?.droppedPins ?? r.droppedPins, 0);
  const n = keys.length;
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM entity_relation`).get().c, n * (n - 1));
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM sketch_pin`).get().c, n);
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM design_node WHERE linker_key IS NOT NULL`).get().c, n);
  const dkeys = db.prepare(`SELECT linker_key FROM diviner_entry WHERE linker_key IS NOT NULL`).all().map((r) => r.linker_key);
  assert.equal(dkeys.length, n, 'a Diviner entry keeps its link (§11.5)');
  // every stored key points at a row that exists in the NEW vault
  const exists = (k) => {
    const [, p, id] = /^([a-z]+)_(\d+)$/.exec(k);
    return !!db.prepare(`SELECT 1 FROM ${ENTITY_KINDS[p].table} WHERE id=?`).get(Number(id));
  };
  for (const k of dkeys) assert.ok(exists(k), k);
  for (const row of db.prepare(`SELECT from_key, to_key, rel_type FROM entity_relation`).all()) {
    assert.ok(exists(row.from_key) && exists(row.to_key), `${row.from_key} -> ${row.to_key}`);
    assert.equal(row.rel_type, 't', 'rel_type survives the pull');
  }
});

test('entityKeyMaps names the missing map instead of dropping rows', () => {
  assert.throws(() => entityKeyMaps({ modMap: new Map() }), /no \w+Map for/);
});

test('Part 7 key columns come across remapped: field relations, time spans, POV, choice conditions', () => {
  freshVault();
  const cls = mkModule('Cast', 'classifier');
  const a = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'A')`, cls);
  const b = one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'B')`, cls);
  const f = one(`INSERT INTO classifier_template (module_ref, description, attribute_type, options) VALUES (?, 'Spouse', 'relation', '{"targetKinds":["cobj"]}')`, cls);
  const d1 = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 1, 1020)`);
  const d2 = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 1, 1045)`);
  one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type, module_ref, valid_from, valid_to) VALUES (1,?,?,?,?,?,?)`,
    `cobj_${a}`, `cobj_${b}`, `ctpl_${f}`, cls, d1, d2);
  const book = mkModule('Book', 'author');
  one(`INSERT INTO book_chapter (module_ref, name, synopsis, status, pov_key) VALUES (?, 'Ch1', 'They meet', 'draft', ?)`, book, `cobj_${a}`);
  const nar = mkModule('Nar', 'narrator');
  const dlg = one(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'D')`, nar);
  const talk = one(`INSERT INTO story_talk (dialogue_ref, row_type) VALUES (?, 'choice')`, dlg);
  one(`INSERT INTO story_choice_option (talk_ref, option_text, condition, set_ops) VALUES (?, 'Go', ?, ?)`, talk,
    JSON.stringify([{ key: `cobj_${a}`, op: '>=', value: '3' }, { key: 'cobj_99999', op: '=', value: '1' }]),
    JSON.stringify([{ key: `cobj_${b}`, op: '+=', value: '1' }]));
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));

  freshVault();
  mkModule('Pad', 'drafter');
  one(`INSERT INTO classifier_object (module_ref, name) VALUES (1, 'pad')`); // shift cobj ids
  one(`INSERT INTO classifier_template (module_ref, description) VALUES (1, 'pad')`); // shift ctpl ids
  const r = sync.applySnapshot(1, snap);
  assert.equal(r.ok, true);
  const id = (sql, ...x) => db.prepare(sql).get(...x).id;
  const A = id(`SELECT id FROM classifier_object WHERE name='A'`);
  const B = id(`SELECT id FROM classifier_object WHERE name='B'`);
  const F = id(`SELECT id FROM classifier_template WHERE description='Spouse'`);
  const rel = db.prepare(`SELECT r.*, f.years fy, u.years uy FROM entity_relation r
    LEFT JOIN timeline_date f ON r.valid_from=f.id LEFT JOIN timeline_date u ON r.valid_to=u.id`).get();
  assert.deepEqual([rel.from_key, rel.to_key, rel.rel_type, rel.fy, rel.uy], [`cobj_${A}`, `cobj_${B}`, `ctpl_${F}`, 1020, 1045]);
  assert.equal(db.prepare(`SELECT options FROM classifier_template WHERE id=?`).get(F).options, '{"targetKinds":["cobj"]}');
  const ch = db.prepare(`SELECT synopsis, status, pov_key FROM book_chapter`).get();
  assert.deepEqual({ ...ch }, { synopsis: 'They meet', status: 'draft', pov_key: `cobj_${A}` });
  const op = db.prepare(`SELECT condition, set_ops FROM story_choice_option`).get();
  assert.deepEqual(JSON.parse(op.condition), [{ key: `cobj_${A}`, op: '>=', value: '3' }], 'an unmappable condition entry is left out');
  assert.deepEqual(JSON.parse(op.set_ops), [{ key: `cobj_${B}`, op: '+=', value: '1' }]);
});
