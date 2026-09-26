// Title layout per page travels with its element through a snapshot.
// Real node-sqlite3-wasm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-phead-'));
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


// Procress 13 part 4 (APP docs/REDESIGN.md C6): an element page's title
// layout lives in module_ui under "pageHead:<itemKey>". The key names an
// element by id, so a snapshot import has to remap it like page_block.item
// — copied verbatim it would point at whatever element owns that id here.
test('an element page title layout follows its element through a snapshot', () => {
  freshVault();
  const sync = require('../src/db/sync.js');
  const cls = require('../src/db/classifier.js');
  const m = mkModule('Cast', 'classifier');
  const o = cls.createObject(m, 'Aria', null, null);
  const ui = (k, v) => db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)`).run(m, k, v);
  ui('pageHead', JSON.stringify({ align: 'center', cover: null, icon: null }));
  ui(`pageHead:cobj_${o}`, JSON.stringify({ align: 'right', cover: null, icon: '🐉' }));
  ui('pageHead:cobj_99999', JSON.stringify({ align: 'center', cover: null, icon: null })); // no such element
  const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));

  freshVault();
  const pad = mkModule('Pad', 'classifier');
  for (let i = 0; i < 5; i++) cls.createObject(pad, `p${i}`, null, null); // shifts every imported object id
  assert.equal(sync.importModuleSnapshot(1, null, snap).ok, true);
  const cast = db.prepare(`SELECT id FROM module WHERE name='Cast'`).get().id;
  const aria = db.prepare(`SELECT id FROM classifier_object WHERE name='Aria'`).get().id;
  const rows = Object.fromEntries(db.prepare(`SELECT ui_key, ui_value FROM module_ui WHERE module_ref=? AND ui_key LIKE 'pageHead%'`)
    .all(cast).map((r) => [r.ui_key, JSON.parse(r.ui_value)]));
  assert.notEqual(aria, o);
  assert.deepEqual(Object.keys(rows).sort(), ['pageHead', `pageHead:cobj_${aria}`]);
  assert.equal(rows[`pageHead:cobj_${aria}`].icon, '🐉');
});
