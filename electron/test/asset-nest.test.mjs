// v5 Asset Nest (APP docs/V5.md §2) — the first test here that opens a real
// database: node-sqlite3-wasm is pure wasm, so it runs in plain Node. The one
// Electron dependency on the path (conn.js's top-level require('electron'))
// is stubbed, and src/db/core.js is swapped for a single in-memory vault so
// the db functions' ambient getDB() lands on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-asset-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const { INDEX_SQL } = require('../src/db/schema/indexes.js');
const media = require('../src/db/asset-media.js');

const V5_COLS = ['module_ref', 'source_kind', 'sha256', 'proxy', 'proxy_type', 'missing', 'last_seen_at'];

// The import_file table exactly as every pre-v5 vault has it: the vendored
// DDL minus the seven v5 columns.
const V4_DDL = VAULT_DDL_SQL.replace(
  /(create_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)),\s*module_ref[\s\S]*?last_seen_at TEXT\n/,
  '$1\n',
);

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db } };

function freshVault(ddl) {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(ddl);
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

test('the v4 fixture really lacks the v5 columns (guards the regex above)', () => {
  freshVault(V4_DDL);
  for (const c of V5_COLS) assert.ok(!cols('import_file').includes(c), `${c} should be absent in the v4 shape`);
});

test('migrateInlineColumns adds every v5 import_file column to an existing vault', () => {
  freshVault(V4_DDL);
  db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type) VALUES (1,'a.png','/x/a.png','png')`).run();
  const { migrateInlineColumns } = require('../src/db/schema/migrations.js');
  migrateInlineColumns(db);
  migrateInlineColumns(db); // idempotent
  db.exec(INDEX_SQL);
  for (const c of V5_COLS) assert.ok(cols('import_file').includes(c), `${c} missing after migration`);
  const row = db.prepare(`SELECT source_kind, missing, module_ref FROM import_file`).get();
  assert.deepEqual({ ...row }, { source_kind: 'file', missing: 0, module_ref: null });
  assert.throws(() => db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, source_kind) VALUES (1,'b','b','ftp')`).run(),
    /CHECK constraint failed/);
});

test('the vendored v5 DDL and the migrated v4 vault agree on import_file', () => {
  freshVault(VAULT_DDL_SQL);
  const fresh = cols('import_file');
  freshVault(V4_DDL);
  require('../src/db/schema/migrations.js').migrateInlineColumns(db);
  assert.deepEqual(cols('import_file'), fresh);
});

test('deleting a module returns its assets to the unfiled tray', () => {
  freshVault(VAULT_DDL_SQL);
  const mid = db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,'Art','collector')`).run().lastInsertRowid;
  const dock = require('../src/db/importdock.js');
  dock.addImportFiles(1, [{ name: 'a.png', path: '/x/a.png', type: 'png', size: 1 }], mid);
  assert.equal(dock.getModuleAssets(mid).length, 1);
  db.prepare(`DELETE FROM module WHERE id=?`).run(mid);
  assert.equal(db.prepare(`SELECT module_ref FROM import_file`).get().module_ref, null);
});

test('importFolderTree mirrors the directory as collectors and converges on re-import', () => {
  freshVault(VAULT_DDL_SQL);
  const dock = require('../src/db/importdock.js');
  const dirs = [['Art'], ['Art', 'maps'], ['Art', 'maps', 'old']];
  const files = [
    { name: 'cover.png', path: '/p/Art/cover.png', type: 'png', size: 1, dir: ['Art'] },
    { name: 'world.jpg', path: '/p/Art/maps/world.jpg', type: 'jpg', size: 1, dir: ['Art', 'maps'] },
    { name: 'v1.jpg', path: '/p/Art/maps/old/v1.jpg', type: 'jpg', size: 1, dir: ['Art', 'maps', 'old'] },
  ];
  const r1 = dock.importFolderTree(1, null, dirs, files);
  assert.equal(r1.collectors, 3);
  assert.equal(r1.added, 3);
  const mods = db.prepare(`SELECT id, parent_id, name, kind FROM module ORDER BY id`).all();
  assert.deepEqual(mods.map((m) => [m.name, m.kind]), [['Art', 'collector'], ['maps', 'collector'], ['old', 'collector']]);
  assert.equal(mods[1].parent_id, mods[0].id);
  assert.equal(mods[2].parent_id, mods[1].id);
  const nest = dock.getNestAssets(1);
  assert.deepEqual(nest[mods[2].id].map((a) => a.file_name), ['v1.jpg']);
  // Same folder again: no new collectors, no duplicate rows.
  const r2 = dock.importFolderTree(1, null, dirs, files);
  assert.deepEqual([r2.collectors, r2.added], [0, 0]);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_file`).get().n, 3);
});

test('viewerIndex emits assets as file_<id>, filed or not', () => {
  freshVault(VAULT_DDL_SQL);
  const dock = require('../src/db/importdock.js');
  const mid = db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,'Art','collector')`).run().lastInsertRowid;
  dock.addImportFiles(1, [{ name: 'a.png', path: '/x/a.png', type: 'png', size: 1 }], mid);
  const urlId = dock.addImportUrl(1, 'https://example.com/', 'Ref', null);
  db.readTx = (fn) => fn; // the adapter's read-tx wrapper is irrelevant here
  const { viewerIndex } = require('../src/db/viewer.js');
  const files = viewerIndex(1).filter((it) => it.kind === 'file');
  assert.equal(files.length, 2);
  const filed = files.find((f) => f.name === 'a.png');
  assert.match(filed.key, /^file_\d+$/);
  assert.equal(filed.moduleId, mid);
  const url = files.find((f) => f.key === `file_${urlId}`);
  assert.equal(url.moduleId, null);
  assert.equal(url.sourceKind, 'url');
});

test('setImportModule refuses a module of another nexus', () => {
  freshVault(VAULT_DDL_SQL);
  db.prepare(`INSERT INTO nexus (id, name) VALUES (2, 'Other')`).run();
  const foreign = db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (2,'X','collector')`).run().lastInsertRowid;
  const dock = require('../src/db/importdock.js');
  dock.addImportFiles(1, [{ name: 'a.png', path: '/x/a.png', type: 'png', size: 1 }]);
  const id = db.prepare(`SELECT id FROM import_file`).get().id;
  dock.setImportModule(id, foreign);
  assert.equal(db.prepare(`SELECT module_ref FROM import_file`).get().module_ref, null);
});

test('proxy budget: a vault never stores thumbnails past PROXY_VAULT_BUDGET', () => {
  freshVault(VAULT_DDL_SQL);
  const dock = require('../src/db/importdock.js');
  dock.addImportFiles(1, [{ name: 'a.png', path: '/x/a.png', type: 'png', size: 1 }]);
  const id = db.prepare(`SELECT id FROM import_file`).get().id;
  assert.equal(dock.setImportProxy(id, Buffer.alloc(16), 'image/jpeg'), true);
  assert.equal(dock.setImportProxy(id, Buffer.alloc(media.PROXY_VAULT_BUDGET), 'image/jpeg'), false);
  assert.equal(dock.getImportFile(id).has_proxy, 1);
});

// ── Pure helpers (asset-media.js) ───────────────────────────────────────────
test('parseRange: absent, open, closed, suffix, clamped and unsatisfiable', () => {
  const { parseRange } = media;
  assert.equal(parseRange(null, 100), null);
  assert.equal(parseRange('items=0-1', 100), null);
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-500', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=0-1, 5-6', 100), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=100-', 100), { invalid: true });
  assert.deepEqual(parseRange('bytes=20-10', 100), { invalid: true });
  assert.deepEqual(parseRange('bytes=-0', 100), { invalid: true });
});

test('asset classes and MIME cover every §2.4 extension', () => {
  const want = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
    audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac'],
    video: ['mp4', 'webm', 'mov', 'mkv'],
    doc: ['md', 'txt', 'docx', 'pdf'],
  };
  for (const [cls, exts] of Object.entries(want)) {
    for (const e of exts) {
      assert.equal(media.assetClassOf(e), cls, e);
      assert.notEqual(media.mimeOf(e), 'application/octet-stream', `${e} has no MIME`);
    }
  }
  assert.equal(media.assetClassOf('exe'), null);
  assert.equal(media.isStreamable('mkv'), true);
  assert.equal(media.isStreamable('docx'), false);
});

test('normalizeAssetUrl only lets http(s) through', () => {
  assert.equal(media.normalizeAssetUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(media.normalizeAssetUrl(' http://x.org '), 'http://x.org/');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ddx-file://1-1', 'nope', '']) {
    assert.equal(media.normalizeAssetUrl(bad), null, bad);
  }
});
