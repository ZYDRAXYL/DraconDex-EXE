// v5 Part 8 (V5.md §12) — legacy Scribe is gone. Its notes become modules
// without a prompt the first time a tree is read, and a stale note_ key (a
// link, a relation) opens the module the note became.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-notes-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const { INDEX_SQL } = require('../src/db/schema/indexes.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db, getAppDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  db.exec(`CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT)`); // versions.js reads its limit
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

const legacy = require('../src/db/migrate_v3.js');
const wiki = require('../src/db/wiki.js');

test('notes convert silently once, and note_ keys follow them', () => {
  freshVault();
  const f = db.prepare(`INSERT INTO note_folder (nexus_ref, name) VALUES (1, 'Lore')`).run().lastInsertRowid;
  const n1 = db.prepare(`INSERT INTO note (nexus_ref, folder_ref, title, content) VALUES (1, ?, 'Dragons', 'Big [[Skies]]')`).run(f).lastInsertRowid;
  db.prepare(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'Skies', 'blue')`).run();

  assert.equal(legacy.autoMigrateNotes(1), 2);
  assert.equal(legacy.autoMigrateNotes(1), 0, 'nothing left the second time');

  const mid = legacy.moduleOfNote(n1);
  const m = db.prepare(`SELECT m.name, p.name AS parent FROM module m JOIN module p ON m.parent_id=p.id WHERE m.id=?`).get(mid);
  assert.deepEqual({ ...m }, { name: 'Dragons', parent: 'Lore' });
  assert.deepEqual(wiki.getEntityPath(`note_${n1}`), { kind: 'module', moduleId: mid });
  assert.equal(wiki.getEntityPath('note_999'), null);

  // A converted note's name resolves to the module now, not the old row.
  wiki.rebuildWikiIndex();
  const t = db.prepare(`SELECT target_key FROM wiki_link WHERE src_key=?`).get(`module_${mid}`);
  assert.match(t.target_key, /^module_\d+$/);
});

// Procress 12 part 0: a converted note's stored keys name its module, and a
// snapshot leaves converted notes out — otherwise a sync to another device
// would convert the same note a second time, into a duplicate module.
test('keys follow a converted note, and snapshots leave it out', () => {
  freshVault();
  const n1 = db.prepare(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'Dragons', 'x')`).run().lastInsertRowid;
  const other = mkModule('Other', 'inspector');
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type, directed) VALUES (1, ?, ?, 'knows', 1)`).run(`note_${n1}`, `module_${other}`);
  const nar = mkModule('Story', 'narrator');
  const dlg = db.prepare(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'A')`).run(nar).lastInsertRowid;
  const talk = db.prepare(`INSERT INTO story_talk (dialogue_ref, talk_sentence, talk_order) VALUES (?, 'hi', 0)`).run(dlg).lastInsertRowid;
  db.prepare(`INSERT INTO story_choice_option (talk_ref, option_text, condition) VALUES (?, 'go', ?)`).run(talk, JSON.stringify([{ key: `note_${n1}`, op: 'eq', value: '1' }]));

  assert.equal(legacy.autoMigrateNotes(1), 1);
  const mid = legacy.moduleOfNote(n1);
  const rel = db.prepare(`SELECT from_key FROM entity_relation WHERE to_key=?`).get(`module_${other}`);
  assert.equal(rel.from_key, `module_${mid}`);
  const cond = db.prepare(`SELECT condition FROM story_choice_option`).get().condition;
  assert.match(cond, new RegExp(`"module_${mid}"`));

  const sync = require('../src/db/sync.js');
  const snap = sync.serializeVault(1);
  assert.equal(snap.notes.notes.length, 0, 'the converted note is not sent');
  assert.ok(snap.modules.some((m) => m.id === mid), 'its module is');
});
