// v5 Part 4 (V5.md §8.8) — a module's parent must be a collector. The two
// write paths refuse anything else, and an old vault's stranded children are
// wrapped into collectors: moved, never deleted, counted before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-mpar-'));
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

const raw = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind, display_order) VALUES (1,?,?,?,0)`).run(parent, name, kind).lastInsertRowid;
const row = (id) => db.prepare(`SELECT id, parent_id, name, kind FROM module WHERE id=?`).get(id);

test('createModule and moveModule refuse a parent that is not a collector', () => {
  freshVault();
  const mod = require('../src/db/module.js');
  const folder = mod.createModule({ nexus_ref: 1, name: 'Folder', kind: 'collector' });
  const cls = mod.createModule({ nexus_ref: 1, parent_id: folder, name: 'Cast', kind: 'classifier' });
  assert.throws(() => mod.createModule({ nexus_ref: 1, parent_id: cls, name: 'Inside', kind: 'drafter' }), /collector/);
  const loose = mod.createModule({ nexus_ref: 1, name: 'Loose', kind: 'drafter' });
  assert.throws(() => mod.moveModule(1, loose, cls, [loose]), /collector/);
  assert.equal(row(loose).parent_id, null);
  mod.moveModule(1, loose, folder, [cls, loose]);
  assert.equal(row(loose).parent_id, folder);
});

test('normalize: nested stranded children are wrapped top-down, nothing is lost', () => {
  freshVault();
  const { normalizeModuleParents, takeParentNormalizeReport } = require('../src/db/module-parents.js');
  const top = raw('Top', 'collector');
  const mgr = raw('Saga', 'manager', top);        // v3 "project"
  const cls = raw('Cast', 'classifier', mgr);     // stranded
  const deep = raw('Bio', 'drafter', cls);        // stranded under a stranded one
  const ok = raw('Notes', 'drafter', top);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM module`).get().n;

  const r = normalizeModuleParents(db);
  assert.deepEqual(r, { moved: 2, collectors: 2 });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module`).get().n, before + 2);
  // Every parent is now a collector (or the top level).
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module c JOIN module p ON c.parent_id=p.id WHERE p.kind<>'collector'`).get().n, 0);
  // Saga's content lives in a collector named "Saga" beside it; Cast's in "Cast".
  const sagaDir = row(row(cls).parent_id);
  assert.deepEqual([sagaDir.name, sagaDir.kind, sagaDir.parent_id], ['Saga', 'collector', top]);
  const castDir = row(row(deep).parent_id);
  assert.deepEqual([castDir.name, castDir.kind, castDir.parent_id], ['Cast', 'collector', sagaDir.id]);
  assert.equal(row(mgr).parent_id, top);
  assert.equal(row(ok).parent_id, top);
  // The Manager still selects what it held — through its filter now (§8.9).
  const def = JSON.parse(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(mgr).ui_value);
  assert.deepEqual(def, { groups: [{ rules: [{ field: 'childOf', moduleId: sagaDir.id }] }] });
  // Reported once; idempotent.
  assert.equal(takeParentNormalizeReport(), 2);
  assert.equal(takeParentNormalizeReport(), 0);
  assert.deepEqual(normalizeModuleParents(db), { moved: 0, collectors: 0 });
});

test('normalize reuses a same-named collector and keeps a Manager filter the user set', () => {
  freshVault();
  const { normalizeModuleParents } = require('../src/db/module-parents.js');
  const mgr = raw('Saga', 'manager');
  const existing = raw('Saga', 'collector');
  const a = raw('A', 'drafter', mgr);
  db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?, 'filterDef', ?)`)
    .run(mgr, JSON.stringify({ groups: [{ rules: [{ field: 'name', op: 'is', value: 'x' }] }] }));
  assert.deepEqual(normalizeModuleParents(db), { moved: 1, collectors: 0 });
  assert.equal(row(a).parent_id, existing);
  assert.match(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(mgr).ui_value, /"name"/);
});
