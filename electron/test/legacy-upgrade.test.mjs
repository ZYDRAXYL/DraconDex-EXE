// Upgrading from a pre-v3.11 data folder: all that is there is novel-manager.db,
// left by an older build in WAL mode with its (empty) -wal sidecar beside it —
// exactly what a 1.x portable copy leaves on a flash drive. The first start of
// this build must rename it, open it and split it into app.ddx + vaults/, not
// start empty (the split used to be gated on novel-manager.ddx only) and not
// fail with "unable to open database file" (the -wal kept the WAL header from
// being reset, which node-sqlite3-wasm cannot open).
// Runs on the real data layer (conn.js + split-migrate.js + real files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-legacy-'));
const data = join(dir, 'novel-manager-data');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(data, 'electron-user-data'), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = data;

const { Database } = require('node-sqlite3-wasm');
const { APP_DDL_SQL, VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');

// The old single file: app + vault tables in one, one Nexus, then flagged WAL
// (header bytes 18/19 = 2) with a header-only -wal, as a clean WAL shutdown leaves it.
mkdirSync(data, { recursive: true });
const legacy = join(data, 'novel-manager.db');
{
  const db = new Database(legacy);
  db.exec(APP_DDL_SQL);
  db.exec(VAULT_DDL_SQL);
  db.run(`INSERT INTO nexus (name) VALUES ('Old Atlas')`);
  db.close();
  const fd = openSync(legacy, 'r+');
  writeSync(fd, Buffer.from([2, 2]), 0, 2, 18);
  closeSync(fd);
  writeFileSync(`${legacy}-wal`, Buffer.alloc(32));
  writeFileSync(`${legacy}-shm`, Buffer.alloc(32768));
}

const conn = require('../src/db/conn.js');
test.after(() => { try { conn.closeAllVaults(); } catch (_) {} rmSync(dir, { recursive: true, force: true }); });

test('a .db-only legacy folder is upgraded on first start, its Nexus kept', () => {
  const app = conn.getAppDB();
  const rows = app.prepare(`SELECT name, file_path FROM nexus_file`).all();
  assert.deepEqual(rows.map((r) => r.name), ['Old Atlas'], 'the old Nexus must be in the registry, not an empty start');
  assert.ok(rows[0].file_path && existsSync(rows[0].file_path), 'its vault file exists');
  assert.ok(readdirSync(join(data, 'vaults')).length === 1);
  assert.ok(!existsSync(legacy), 'novel-manager.db was renamed (the split keeps the original as .ddx.bak)');
  assert.ok(existsSync(join(data, 'novel-manager.ddx.bak')));
});

// The split stripped only the app tables it knew of when it was written, so
// port_link / port_mount (newer) were left in every vault it made — each with
// a foreign key to nexus_file, which a vault does not have. Renumbering such a
// vault (open from drive, clone, duplicate) then failed with
// "no such table: main.nexus_file".
test('the split leaves no app-only table in a vault, and keeps every app table in app.ddx', () => {
  const { APP_ONLY_TABLES, APP_TABLES } = require('../src/db/schema/tables.js');
  assert.ok(APP_ONLY_TABLES.has('port_link') && APP_ONLY_TABLES.has('port_mount') && !APP_ONLY_TABLES.has('use_color'));
  const vault = conn.getAppDB().prepare(`SELECT file_path FROM nexus_file`).get().file_path;
  const db = new Database(vault, { readOnly: true });
  const inVault = db.all(`SELECT name FROM sqlite_master WHERE type='table'`).map((r) => r.name);
  db.close();
  assert.deepEqual(inVault.filter((t) => APP_ONLY_TABLES.has(t)), [], 'app-only tables left in the vault');
  const inApp = conn.getAppDB().prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map((r) => r.name);
  assert.deepEqual([...APP_TABLES].filter((t) => !inApp.includes(t)), []);
});

test('a vault an older split left app tables in still renumbers — they are dropped first', () => {
  const { renumberNexusIn } = require('../src/db/nexus.js');
  const { openRaw } = require('../src/db/portlink.js');
  const f = join(dir, 'old-split-vault.ddx');
  {
    const db = new Database(f);
    db.exec(VAULT_DDL_SQL);
    db.run(`INSERT INTO nexus (id, name) VALUES (1, 'Old Atlas')`);
    db.run(`INSERT INTO module (nexus_ref, name, kind) VALUES (1, 'Heroes', 'classifier')`);
    // what the old split left behind: app tables pointing at a nexus_file that is not here
    db.exec(`CREATE TABLE port_link (link_uid TEXT PRIMARY KEY, nexus_ref INTEGER NOT NULL UNIQUE REFERENCES nexus_file(id) ON DELETE CASCADE, drive_uid TEXT, drive_nexus_id INTEGER, base_path TEXT)`);
    db.exec(`CREATE TABLE port_mount (nexus_ref INTEGER PRIMARY KEY REFERENCES nexus_file(id) ON DELETE CASCADE, drive_uid TEXT)`);
    db.close();
  }
  const db = openRaw(f);
  try {
    renumberNexusIn(db, 1, 7, 'Old Atlas');
    assert.deepEqual(db.prepare(`SELECT DISTINCT nexus_ref FROM module`).all().map((r) => r.nexus_ref), [7]);
    assert.equal(db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name IN ('port_link','port_mount')`).get().n, 0);
  } finally { db.close(); }
});

test('a WAL file with no frames is dropped so the file opens; one holding data is left alone', () => {
  const f = join(dir, 'x.ddx');
  { const db = new Database(f); db.exec('CREATE TABLE t (a)'); db.close(); }
  const fd = openSync(f, 'r+'); writeSync(fd, Buffer.from([2, 2]), 0, 2, 18); closeSync(fd);
  writeFileSync(`${f}-wal`, Buffer.alloc(32));
  conn.dropEmptyWal(f);
  assert.ok(!existsSync(`${f}-wal`), 'header-only -wal removed');
  writeFileSync(`${f}-wal`, Buffer.alloc(32 + 24 + 4096)); // one frame: real, uncheckpointed data
  conn.dropEmptyWal(f);
  assert.ok(existsSync(`${f}-wal`), 'a -wal with frames must never be deleted');
});
