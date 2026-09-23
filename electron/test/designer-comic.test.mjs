// v5 Part 7 (V5.md §11.6) — comic pages in Designer: reading order is numbered
// by rows top to bottom, left to right within a row, panels and balloons
// only; a size is kept with a floor so a panel cannot vanish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-dgcomic-'));
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

const dg = require('../src/db/designer.js');

test('renumber: rows, then left to right; other shapes untouched; resize has a floor', () => {
  freshVault();
  const m = mkModule('Page 1', 'designer');
  const node = (shape, x, y, h = 120) => {
    const id = dg.createDesignNode(m, shape, x, y, '', null, null);
    db.prepare(`UPDATE design_node SET h=? WHERE id=?`).run(h, id);
    return id;
  };
  const c = node('panel', 400, 10), a = node('panel', 10, 0), b = node('balloon', 200, 30, 60);
  const e = node('panel', 10, 300), box = node('box', 0, 0);
  assert.deepEqual(dg.renumberDesignReadOrder(m), { ok: true, count: 4 });
  const ord = (id) => db.prepare(`SELECT read_order FROM design_node WHERE id=?`).get(id).read_order;
  assert.deepEqual([a, b, c, e].map(ord), [1, 2, 3, 4]);
  assert.equal(ord(box), null);
  dg.renumberDesignReadOrder(m, true); // right-to-left (manga)
  assert.deepEqual([c, b, a, e].map(ord), [1, 2, 3, 4]);
  dg.resizeDesignNode(a, 5, 5);
  assert.deepEqual({ ...db.prepare(`SELECT w, h FROM design_node WHERE id=?`).get(a) }, { w: 40, h: 30 });
  dg.setDesignNodeComic(b, 'cobj_9', '');
  assert.deepEqual({ ...db.prepare(`SELECT linker_key, read_order FROM design_node WHERE id=?`).get(b) }, { linker_key: 'cobj_9', read_order: null });
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
