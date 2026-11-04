// Procress 32 part 0 — a portable copy carried to another machine (another
// drive letter, or its folder moved) still opens every Nexus and every asset,
// keeps its folders on its own drive, and marks the drive with a stable uid.
// Runs on the real data layer (conn.js + a real vault file per Nexus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portable-'));
const root = join(dir, 'NEW-DRIVE');                 // where the portable copy is now
const data = join(root, 'novel-manager-data');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: (k) => (k === 'documents' ? join(dir, 'HOST-DOCUMENTS') : join(data, 'electron-user-data')), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = data;

const conn = require('../src/db/conn.js');
const { runWithVault } = require('../src/db/vault-context.js');
const nexus = require('../src/db/nexus.js');
const vaults = require('../src/db/vaults.js');
const locate = require('../src/db/locate.js');
const portable = require('../src/db/portable.js');
portable.setPortableRoot(root);
test.after(() => { locate.unwatchAll(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

const setting = (k) => conn.getAppDB().prepare(`SELECT value FROM app_setting WHERE key=?`).get(k)?.value;

test('rebase(): only a path under the old root moves', () => {
  const from = join(dir, 'E'), to = join(dir, 'F');
  assert.equal(portable.rebase(join(from, 'a', 'b.ddx'), from, to), join(to, 'a', 'b.ddx'));
  assert.equal(portable.rebase(from, from, to), to);
  assert.equal(portable.rebase(join(dir, 'Elsewhere', 'x'), from, to), join(dir, 'Elsewhere', 'x'));
  assert.equal(portable.rebase(null, from, to), null);
});

test('a portable copy keeps its Nexus folders on its own drive, not in the host Documents', () => {
  assert.equal(locate.defaultLocateRoot(), join(root, 'DraconDex'));
});

test('the first start only remembers the root', () => {
  assert.deepEqual(portable.rebasePortable(), { moved: false });
  assert.equal(setting('portableRoot'), root);
});

test('carried to another root: vault, locate folder and assets all follow', () => {
  const id = nexus.createNexus('Atlas', '', null, null);
  runWithVault(id, () => locate.syncLocate(id, { reason: 'create' }));
  const v0 = vaults.getVault(id);
  assert.ok(v0.locate_dir.startsWith(join(root, 'DraconDex')), 'folder on the drive');
  const asset = join(v0.locate_dir, 'map.png');
  writeFileSync(asset, 'png');
  const outside = join(dir, 'HOST-ONLY', 'ref.png');
  mkdirSync(join(dir, 'HOST-ONLY'), { recursive: true }); writeFileSync(outside, 'png');
  const vdb = conn.getVaultDB(id);
  const addFile = (p) => vdb.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path) VALUES (?,?,?)`).run(id, 'f', p);
  addFile(asset); addFile(outside);

  // What the registry looks like when the same drive was E: last time.
  const old = join(dir, 'OLD-DRIVE');
  const toOld = (p) => portable.rebase(p, root, old);
  conn.closeAllVaults();
  conn.getAppDB().prepare(`UPDATE nexus_file SET file_path=?, locate_dir=? WHERE id=?`).run(toOld(v0.file_path), toOld(v0.locate_dir), id);
  conn.getAppDB().prepare(`UPDATE app_setting SET value=? WHERE key='portableRoot'`).run(old);
  // the vault's asset rows were written under E: too — open the file directly to set that up
  const { Database } = require('node-sqlite3-wasm');
  const f = new Database(v0.file_path);
  f.run(`UPDATE import_file SET file_path=? WHERE file_path=?`, [toOld(asset), asset]);
  f.close();
  assert.equal(vaults.getVault(id).missing, 1, 'before the rebase the Nexus reads as missing');

  const r = portable.rebasePortable();
  assert.equal(r.moved, true);
  assert.equal(r.vaults, 1);
  const v1 = vaults.getVault(id);
  assert.equal(v1.file_path, v0.file_path);
  assert.equal(v1.locate_dir, v0.locate_dir);
  assert.equal(v1.missing, 0);
  const paths = conn.getVaultDB(id).prepare(`SELECT file_path FROM import_file ORDER BY id`).all().map((x) => x.file_path);
  assert.deepEqual(paths, [asset, outside], 'asset under the root follows; one outside it stays put');
  assert.equal(setting('portableRoot'), root);
  assert.deepEqual(portable.rebasePortable(), { moved: false }, 'idempotent');
});

test('the drive marker: written at the root, driveUid kept across starts', () => {
  const m1 = portable.writePortableMarker('5.7.0');
  const file = join(root, portable.MARKER);
  assert.ok(existsSync(file));
  assert.equal(m1.dataDir, 'novel-manager-data');
  assert.match(m1.driveUid, /^[0-9a-f-]{36}$/);
  const m2 = portable.writePortableMarker('5.8.0');
  assert.equal(m2.driveUid, m1.driveUid);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).appVersion, '5.8.0');
});

test('an installed copy (no portable root) does nothing', () => {
  portable.setPortableRoot(null);
  assert.equal(portable.rebasePortable(), null);
  assert.equal(portable.writePortableMarker('x'), null);
  portable.setPortableRoot(root);
});
