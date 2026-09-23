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
  for (const k of keys) {
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
  // every stored key points at a row that exists in the NEW vault
  const exists = (k) => {
    const [, p, id] = /^([a-z]+)_(\d+)$/.exec(k);
    return !!db.prepare(`SELECT 1 FROM ${ENTITY_KINDS[p].table} WHERE id=?`).get(Number(id));
  };
  for (const row of db.prepare(`SELECT from_key, to_key, rel_type FROM entity_relation`).all()) {
    assert.ok(exists(row.from_key) && exists(row.to_key), `${row.from_key} -> ${row.to_key}`);
    assert.equal(row.rel_type, 't', 'rel_type survives the pull');
  }
});

test('entityKeyMaps names the missing map instead of dropping rows', () => {
  assert.throws(() => entityKeyMaps({ modMap: new Map() }), /no \w+Map for/);
});
