// Procress 32 part 3 — cloning a Nexus between this machine and a portable
// drive, both ways, makes a link with three identical-content files (local,
// drive, base), each carrying the id ITS registry gave it; the drive's files
// name paths in the drive's own remembered root; nothing is left half-made.
// Also: Duplicate now renumbers every table that has a nexus_ref.
// Runs on the real data layer (conn.js + real vault files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portclone-'));
const local = join(dir, 'installed');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(local, 'electron-user-data'), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = local;

const { Database } = require('node-sqlite3-wasm');
const conn = require('../src/db/conn.js');
const { runWithVault } = require('../src/db/vault-context.js');
const nexus = require('../src/db/nexus.js');
const vaults = require('../src/db/vaults.js');
const locate = require('../src/db/locate.js');
const drives = require('../src/db/portlink-drives.js');
const portlink = require('../src/db/portlink.js');
const { APP_DDL_SQL } = require('../src/db/schema/ddl.js');
const { MARKER, RUNNING } = require('../src/db/portable.js');
test.after(() => { locate.unwatchAll(); drives.stopWatching(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

// A drive whose portable app last ran as E:\DDX, mounted here somewhere else.
const usb = join(dir, 'usb'), root = join(usb, 'DDX'), data = join(root, 'novel-manager-data');
const OWN = join(dir, 'E-drive', 'DDX');
mkdirSync(data, { recursive: true });
writeFileSync(join(root, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'drive-1', dataDir: 'novel-manager-data' }));
{
  const db = new Database(join(data, 'app.ddx'));
  db.exec(APP_DDL_SQL);
  db.run(`INSERT INTO app_setting (key, value) VALUES ('portableRoot', ?)`, [OWN]);
  db.run(`INSERT INTO nexus_file (name) VALUES ('Already here')`); // takes id 1 on the drive
  db.close();
}
process.env.DRACONDEX_DRIVE_ROOTS = usb;
drives.rescan();

const reg = (sql, ...a) => { const db = new Database(join(data, 'app.ddx'), { readOnly: true }); try { return db.all(sql, a); } finally { db.close(); } };
const inFile = (file, sql, ...a) => { const db = new Database(file, { readOnly: true }); try { return db.all(sql, a); } finally { db.close(); } };
const make = (name) => { const id = nexus.createNexus(name, '', null, null); runWithVault(id, () => locate.syncLocate(id, { reason: 'create' })); return id; };
const v = (id) => conn.getVaultDB(id);

test('this machine → drive: renumbered into the drive\'s id space, assets copied, paths in the drive\'s own root, base == drive file', () => {
  const id = make('Atlas');
  assert.equal(id, 1, 'collides with the drive\'s id 1 on purpose');
  v(id).prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(id, 'Heroes', 'classifier');
  v(id).prepare(`INSERT INTO nexus_history (nexus_ref, seq, action, module_name) VALUES (?,1,'create','Heroes')`).run(id);
  const asset = join(vaults.getVault(id).locate_dir, 'map.png');
  writeFileSync(asset, 'png-bytes');
  v(id).prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path) VALUES (?,?,?)`).run(id, 'map.png', asset);

  const r = portlink.cloneToDrive(id, 'drive-1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.driveNexusId, 2);
  const row = reg(`SELECT * FROM nexus_file WHERE id=2`)[0];
  assert.equal(row.name, 'Atlas');
  assert.ok(row.file_path.startsWith(OWN), `registry path in the drive's own root: ${row.file_path}`);
  const onDrive = join(data, 'vaults', 'Atlas-2.ddx');
  assert.ok(existsSync(onDrive));
  assert.deepEqual(inFile(onDrive, `SELECT id FROM nexus`).map((x) => x.id), [2]);
  assert.deepEqual(inFile(onDrive, `SELECT DISTINCT nexus_ref FROM module`).map((x) => x.nexus_ref), [2]);
  assert.deepEqual(inFile(onDrive, `SELECT nexus_ref FROM nexus_history`).map((x) => x.nexus_ref), [2], 'a table the old list missed');
  assert.equal(inFile(onDrive, `SELECT file_path FROM import_file`)[0].file_path, join(OWN, 'DraconDex', 'Atlas', 'map.png'));
  assert.equal(readFileSync(join(root, 'DraconDex', 'Atlas', 'map.png'), 'utf8'), 'png-bytes', 'the asset itself is on the drive');
  const l = portlink.linkOf(id);
  assert.ok(readFileSync(l.basePath).equals(readFileSync(onDrive)), 'base is exactly the drive file');
  assert.deepEqual(inFile(vaults.getVault(id).file_path, `SELECT id FROM nexus`).map((x) => x.id), [1], 'the local file is untouched');
  assert.equal(portlink.linkStatus(l), 'synced');
  assert.equal(portlink.cloneToDrive(id, 'drive-1').code, 'already_linked');
  assert.equal(portlink.cloneFromDrive('drive-1', 2).code, 'already_linked');
});

test('status follows each side\'s file', () => {
  const l = portlink.linkOf(1);
  conn.closeAllVaults();
  const f = new Database(vaults.getVault(1).file_path);
  f.run(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,'Places','classifier')`); f.close();
  assert.equal(portlink.linkStatus(l), 'local');
  const g = new Database(join(data, 'vaults', 'Atlas-2.ddx'));
  g.run(`INSERT INTO module (nexus_ref, name, kind) VALUES (2,'Gods','classifier')`); g.close();
  assert.equal(portlink.linkStatus(l), 'both');
  process.env.DRACONDEX_DRIVE_ROOTS = join(dir, 'nothing-plugged');
  drives.rescan();
  assert.equal(portlink.linkStatus(l), 'away');
  process.env.DRACONDEX_DRIVE_ROOTS = usb;
  drives.rescan();
});

test('drive → this machine: a Nexus made elsewhere gets this machine\'s next id, a free name, and its assets', () => {
  // A drive Nexus this machine has never seen: cloned there by "another
  // machine" — simulated by cloning Borea and then forgetting it here.
  const b = make('Borea');
  const asset = join(vaults.getVault(b).locate_dir, 'sigil.png');
  writeFileSync(asset, 'sigil');
  v(b).prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path) VALUES (?,?,?)`).run(b, 'sigil.png', asset);
  const r = portlink.cloneToDrive(b, 'drive-1');
  assert.equal(r.ok, true);
  conn.getAppDB().prepare(`DELETE FROM port_link WHERE nexus_ref=?`).run(b);

  const back = portlink.cloneFromDrive('drive-1', r.driveNexusId);
  assert.equal(back.ok, true, JSON.stringify(back));
  assert.equal(back.name, 'Borea (2)', 'local names stay unique');
  const nv = vaults.getVault(back.nexusId);
  assert.deepEqual(inFile(nv.file_path, `SELECT id FROM nexus`).map((x) => x.id), [back.nexusId]);
  const p = inFile(nv.file_path, `SELECT file_path FROM import_file`)[0].file_path;
  assert.equal(p, join(nv.locate_dir, 'sigil.png'), 'asset row points at this machine\'s copy');
  assert.equal(readFileSync(p, 'utf8'), 'sigil');
  assert.equal(portlink.linkStatus(portlink.linkOf(back.nexusId)), 'synced');
  assert.deepEqual(inFile(conn.getVaultDB(back.nexusId) && nv.file_path, `SELECT name FROM nexus`).map((x) => x.name), ['Borea (2)']);
});

test('refused cleanly: the portable app is open, or the drive cannot take the file', () => {
  const c = make('Cinder');
  const before = reg(`SELECT COUNT(*) n FROM nexus_file`)[0].n;
  writeFileSync(join(root, RUNNING), JSON.stringify({ pid: process.pid, host: hostname() }));
  drives.rescan();
  assert.equal(portlink.cloneToDrive(c, 'drive-1').code, 'drive_busy');
  rmSync(join(root, RUNNING));
  drives.rescan();
  // vaults/ is a FILE on this drive: the copy fails half-way
  rmSync(join(data, 'vaults'), { recursive: true, force: true });
  writeFileSync(join(data, 'vaults'), 'not a folder');
  const r = portlink.cloneToDrive(c, 'drive-1');
  assert.equal(r.ok, false);
  assert.equal(reg(`SELECT COUNT(*) n FROM nexus_file`)[0].n, before, 'the drive registry is as it was');
  assert.equal(portlink.linkOf(c), null);
  assert.ok(!existsSync(join(root, 'DraconDex', 'Cinder')), 'no folder left behind');
});

test('Duplicate renumbers every table with a nexus_ref (presets, history, trash were left behind)', () => {
  const id = make('Dune');
  v(id).prepare(`INSERT INTO nexus_history (nexus_ref, seq, action) VALUES (?,1,'create')`).run(id);
  v(id).prepare(`INSERT INTO module_preset (nexus_ref, kind, name) VALUES (?,'classifier','P')`).run(id);
  const d = nexus.duplicateNexus(id);
  assert.equal(d.ok, true);
  assert.equal(d.name, 'Dune (copy)');
  const f = vaults.getVault(d.id).file_path;
  conn.closeAllVaults();
  assert.deepEqual(inFile(f, `SELECT nexus_ref FROM nexus_history`).map((x) => x.nexus_ref), [d.id]);
  assert.deepEqual(inFile(f, `SELECT nexus_ref FROM module_preset`).map((x) => x.nexus_ref), [d.id]);
  assert.equal(nexus.duplicateNexus(id).name, 'Dune (copy 2)');
});
