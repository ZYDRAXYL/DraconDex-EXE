#!/usr/bin/env node
// Writes the shared STRESS fixture (Procress 19 part 1): the vault every
// performance number in Plan.md is measured on — 20 folders holding 500
// Drafters (520 modules) and one Classifier with 3,000 objects and 5,000
// values (2 fields: every object has "Age", the first 2,000 also "Role").
// It is the same shape electron/test/perf.driver.mjs builds through the UI,
// written through THIS app's serializeVault so both apps import the exact
// bytes: the master copy lives in DraconDex-SDB (fixtures/stress-v2.json),
// EXE measures with the driver, APK with flutter/test/perf_data_test.dart.
//
//   node tools/stress-fixture.mjs <out.json>
//
// Deterministic: no clock, no randomness — regenerating it diffs only when
// the snapshot format changes.
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
const one = (sql, ...a) => db.prepare(sql).run(...a).lastInsertRowid;

one(`INSERT INTO nexus (id, name) VALUES (1, 'Stress')`);
db.exec('BEGIN');
const folders = Array.from({ length: 20 }, (_, i) =>
  one(`INSERT INTO module (nexus_ref, parent_id, name, kind, display_order) VALUES (1, NULL, ?, 'collector', ?)`, `Folder ${i}`, i));
for (let i = 0; i < 500; i++) {
  one(`INSERT INTO module (nexus_ref, parent_id, name, kind, display_order) VALUES (1, ?, ?, 'drafter', ?)`, folders[i % 20], `Doc ${i}`, Math.floor(i / 20));
}
const cls = one(`INSERT INTO module (nexus_ref, parent_id, name, kind, cat_type, display_order) VALUES (1, NULL, 'Big category', 'classifier', 'object', 20)`);
const age = one(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?, 'Age', 'text', 0)`, cls);
const role = one(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?, 'Role', 'text', 1)`, cls);
for (let i = 0; i < 3000; i++) {
  const o = one(`INSERT INTO classifier_object (module_ref, name, display_order) VALUES (?, ?, ?)`, cls, `Object ${i}`, i);
  one(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?, ?, ?)`, o, age, String(i));
  if (i < 2000) one(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?, ?, ?)`, o, role, i % 3 ? 'r' : 'lead');
}
one(`INSERT INTO page_block (module_ref, item_key, block_type, component, config, block_order) VALUES (?, NULL, 'component', 'classifier.view', ?, 0)`,
  cls, JSON.stringify({ preset: 'table' }));
db.exec('COMMIT');

const snap = JSON.parse(JSON.stringify(sync.serializeVault(1)));
snap.exportedAt = '2026-10-10T00:00:00.000Z';
const STAMP = /^(create|update)(At|_at)$/;
// Compact (no indent): 3,000 objects pretty-printed is 4× the bytes for nothing a human reads.
writeFileSync(resolve(out), JSON.stringify(snap, (k, v) => (STAMP.test(k) && typeof v === 'string' ? '2026-10-10 00:00:00' : v)) + '\n');
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}: ${snap.modules.length} modules, ${snap.classifier.objects.length} objects, ${snap.classifier.attributes.length} values`);
