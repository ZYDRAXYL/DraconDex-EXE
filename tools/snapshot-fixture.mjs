#!/usr/bin/env node
// Writes the shared snapshot fixture (Procress 12 part 0): one vault with a
// row of every entity family that syncs, a relation chain through all of
// them, a sketch pin / Designer link / Diviner entry to each, and page
// blocks of every shape (a module page, a property, a shared element
// layout, an element's own page, a borrowed view) — run through THIS app's
// serializeVault. The output's master copy lives in DraconDex-SDB
// (fixtures/snapshot-v2.json) and is vendored back to both apps' tests, so
// the Dart port is held to exactly what the desktop writes.
//
//   node tools/snapshot-fixture.mjs <out.json>
//
// Regenerate it only when the snapshot format changes, commit it to SDB,
// then `npm run sdb:vendor` here and `node tools/sdb-vendor.mjs` in APK.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node tools/snapshot-fixture.mjs <out.json>'); process.exit(1); }
const require = createRequire(import.meta.url);
const Module = require('node:module');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-fixture-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};
const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../electron/src/db/conn.js');
const { VAULT_DDL_SQL } = require('../electron/src/db/schema/ddl.js');
const mig = require('../electron/src/db/schema/migrations.js');
const core = require.resolve('../electron/src/db/core.js');
const db = adaptDb(new Database(join(tmp, 'fixture.ddx')), 'vault');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db, getAppDB: () => db } };
db.exec('PRAGMA foreign_keys = ON');
db.exec(VAULT_DDL_SQL);
mig.migrateInlineColumns(db);
db.readTx = (fn) => fn;

const sync = require('../electron/src/db/sync.js');
const { ENTITY_KINDS } = require('../electron/src/db/entity-kinds.js');
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;
const mod = (name, kind, parent = null) => one(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`, parent, name, kind);

one(`INSERT INTO nexus (id, name) VALUES (1, 'Fixture')`);
const folder = mod('World', 'collector');
const cls = mod('Cast', 'classifier', folder);
const seed = {
  note: () => one(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'Old note', 'text')`),
  module: () => mod('Notes', 'drafter', folder),
  bchp: () => one(`INSERT INTO book_chapter (module_ref, name, chapter_content) VALUES (?, 'Chapter 1', 'Once')`, mod('Book', 'author', folder)),
  chss: () => one(`INSERT INTO chat_session (module_ref, name) VALUES (?, 'Session 1')`, mod('Chat', 'scribe', folder)),
  cobj: () => one(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Mira')`, cls),
  tlev: () => {
    const tl = one(`INSERT INTO timeline (module_ref, line_name) VALUES (?, 'Main')`, mod('History', 'chronicler', folder));
    const dt = one(`INSERT INTO timeline_date (day, month, years) VALUES (1, 2, 1021)`);
    return one(`INSERT INTO timeline_event (timeline_id, event_name, start_at) VALUES (?, 'The storm', ?)`, tl, dt);
  },
  sdlg: () => one(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'The meeting')`, mod('Story', 'narrator', folder)),
  skpg: () => one(`INSERT INTO sketch_page (module_ref, name) VALUES (?, 'Page 1')`, mod('Sketch', 'sketcher', folder)),
  ctpl: () => one(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Friend', 'relation')`, cls),
  divt: () => one(`INSERT INTO diviner_table (module_ref, name, dice) VALUES (?, 'Rumors', '1d6')`, mod('Rumors', 'diviner', folder)),
};
const families = Object.keys(ENTITY_KINDS).filter((p) => ENTITY_KINDS[p].sync);
const missing = families.filter((p) => !seed[p]);
if (missing.length) { console.error(`no fixture row for: ${missing.join(', ')}`); process.exit(1); }
const keys = families.map((p) => `${p}_${seed[p]()}`);
keys.forEach((k, i) => { if (i) one(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label, rel_type) VALUES (1,?,?,'next','t')`, keys[i - 1], k); });
const page = one(`INSERT INTO sketch_page (module_ref, name) VALUES (?, 'Pins')`, mod('Pinboard', 'sketcher', folder));
const dg = mod('Plan', 'designer', folder);
const dtab = one(`INSERT INTO diviner_table (module_ref, name) VALUES (?, 'Links')`, mod('Links', 'diviner', folder));
for (const k of keys) {
  one(`INSERT INTO sketch_pin (page_ref, linker_key, x, y) VALUES (?,?,1,2)`, page, k);
  one(`INSERT INTO design_node (module_ref, shape, x, y, linker_key) VALUES (?, 'box', 3, 4, ?)`, dg, k);
  one(`INSERT INTO diviner_entry (table_ref, linker_key) VALUES (?,?)`, dtab, k);
}
// Page blocks: every item_key shape the importer remaps.
const cobj = keys.find((k) => k.startsWith('cobj_'));
const block = (m, item, type, extra = {}) => one(`INSERT INTO page_block (module_ref, item_key, block_type, component, source_key, config, content, prop_name, prop_type, block_order)
  VALUES (?,?,?,?,?,?,?,?,?,?)`, m, item, type, extra.component ?? null, extra.source ?? null, extra.config ? JSON.stringify(extra.config) : null,
  extra.content ?? null, extra.prop ?? null, extra.prop ? 'text' : null, extra.order ?? 0);
// A levelled + conditioned field: its value lives in classifier_level rows,
// not in classifier_attribute — both importers must bring the rows back.
const rank = one(`INSERT INTO classifier_template (module_ref, description, attribute_type, levelable, has_condition) VALUES (?, 'Rank', 'text', 1, 1)`, cls);
[['Novice', null, 'First stage'], ['Adept', 'After the storm', 'Second stage']].forEach(([lv, cond, info], i) =>
  one(`INSERT INTO classifier_level (object_ref, template_ref, level_label, condition_value, info_value, display_order) VALUES (?,?,?,?,?,?)`,
    Number(cobj.slice(5)), rank, lv, cond, info, i));
block(cls, null, 'component', { component: 'classifier.view', config: { preset: 'table' } });
block(cls, null, 'property', { prop: 'Era', content: 'Third age' });
block(cls, null, 'text', { content: 'About [[Mira]]', order: 1 });
block(cls, '*', 'component', { component: 'item.body' });
block(cls, cobj, 'heading', { content: 'Mira alone' });
block(cls, null, 'component', { component: 'diviner.view', source: keys.find((k) => k.startsWith('module_')), order: 2 });

const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));
snap.exportedAt = '2026-09-24T00:00:00.000Z'; // stable: the fixture is compared, not timestamped
// Row timestamps are pinned too, so regenerating the fixture diffs only what changed.
const STAMP = /^(create|update)(At|_at)$/;
writeFileSync(resolve(out), JSON.stringify(snap, (k, v) => (STAMP.test(k) && typeof v === 'string' ? '2026-09-24 00:00:00' : v), 2) + '\n');
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}: version ${snap.version}, ${keys.length} key families, ${snap.pageBlocks?.length} page blocks`);
