// Procress 32 part 3b — a drive Nexus opened straight from the drive: a
// working copy here under this machine's own id, every write-back lands on
// the drive under the drive's id with paths in the drive's root, closing
// removes the copy, an unplugged drive keeps it pending until it is back,
// and a drive file changed elsewhere is never written over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portmount-'));
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
const mount = require('../src/db/portlink-mount.js');
const { APP_DDL_SQL } = require('../src/db/schema/ddl.js');
const { MARKER } = require('../src/db/portable.js');
test.after(() => { locate.unwatchAll(); drives.stopWatching(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

const usb = join(dir, 'usb'), root = join(usb, 'DDX'), data = join(root, 'novel-manager-data');
const OWN = join(dir, 'E-drive', 'DDX');
mkdirSync(data, { recursive: true });
writeFileSync(join(root, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'drive-m', dataDir: 'novel-manager-data' }));
{ const db = new Database(join(data, 'app.ddx')); db.exec(APP_DDL_SQL); db.run(`INSERT INTO app_setting (key, value) VALUES ('portableRoot', ?)`, [OWN]); db.close(); }
const plug = () => { process.env.DRACONDEX_DRIVE_ROOTS = usb; drives.rescan(); };
const unplug = () => { process.env.DRACONDEX_DRIVE_ROOTS = join(dir, 'empty'); drives.rescan(); };
plug();

const inFile = (file, sql, ...a) => { const db = new Database(file, { readOnly: true }); try { return db.all(sql, a); } finally { db.close(); } };
const make = (name) => { const id = nexus.createNexus(name, '', null, null); runWithVault(id, () => locate.syncLocate(id, { reason: 'create' })); return id; };
const driveFile = (dId) => drives.listDrives()[0].nexuses.find((n) => n.id === dId).file_path;

// A Nexus that is only on the drive: made "on another machine" (cloned there,
// then forgotten here — its local copy deleted).
function driveOnly(name, withAsset = false) {
  const id = make(name);
  if (withAsset) {
    const a = join(vaults.getVault(id).locate_dir, 'crest.png');
    writeFileSync(a, 'crest');
    conn.getVaultDB(id).prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path) VALUES (?,?,?)`).run(id, 'crest.png', a);
  }
  const r = portlink.cloneToDrive(id, 'drive-m');
  assert.equal(r.ok, true);
  conn.getAppDB().prepare(`DELETE FROM port_link WHERE nexus_ref=?`).run(id);
  conn.closeVault(id); vaults.removeVault(id);
  return r.driveNexusId;
}

test('open: a working copy under this machine\'s own id, assets still on the drive', () => {
  const dId = driveOnly('Atlas', true);
  make('Local one'); // so the next local id is not the drive's by luck
  const r = mount.openFromDrive('drive-m', dId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.nexusId, dId);
  const v = vaults.getVault(r.nexusId);
  assert.deepEqual(inFile(v.file_path, `SELECT id FROM nexus`).map((x) => x.id), [r.nexusId]);
  const asset = inFile(v.file_path, `SELECT file_path FROM import_file`)[0].file_path;
  assert.equal(asset, join(root, 'DraconDex', 'Atlas', 'crest.png'), 'the drive\'s own folder, under today\'s mount');
  assert.ok(existsSync(asset));
  assert.equal(mount.openFromDrive('drive-m', dId).nexusId, r.nexusId, 'opening it again reuses the mount');
});

test('write-back: edits land on the drive under the drive\'s id, paths in the drive\'s root; close removes the copy', () => {
  const m = mount.listMounts()[0];
  const db = conn.getVaultDB(m.nexusId);
  db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(m.nexusId, 'Heroes', 'classifier');
  db.prepare(`UPDATE nexus SET name='Atlas Reborn' WHERE id=?`).run(m.nexusId);
  const w = mount.writeBack(m.nexusId);
  assert.deepEqual(w, { ok: true, wrote: true });
  const f = driveFile(m.driveNexusId);
  assert.deepEqual(inFile(f, `SELECT id, name FROM nexus`), [{ id: m.driveNexusId, name: 'Atlas Reborn' }]);
  assert.deepEqual(inFile(f, `SELECT nexus_ref, name FROM module`), [{ nexus_ref: m.driveNexusId, name: 'Heroes' }]);
  assert.equal(inFile(f, `SELECT file_path FROM import_file`)[0].file_path, join(OWN, 'DraconDex', 'Atlas', 'crest.png'));
  drives.rescan();
  assert.equal(drives.listDrives()[0].nexuses.find((n) => n.id === m.driveNexusId).name, 'Atlas Reborn', 'the drive registry follows the rename');
  assert.deepEqual(mount.writeBack(m.nexusId), { ok: true, wrote: false }, 'nothing new: nothing written');

  const c = mount.closeMount(m.nexusId);
  assert.equal(c.ok, true);
  assert.equal(vaults.getVault(m.nexusId), null);
  assert.ok(!existsSync(m.workPath));
  assert.equal(mount.mountOf(m.nexusId), null);
});

test('drive pulled out while open: nothing lost — pending, then written once it is back', () => {
  const dId = driveOnly('Borea');
  const { nexusId } = mount.openFromDrive('drive-m', dId);
  conn.getVaultDB(nexusId).prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(nexusId, 'Seas', 'classifier');
  unplug();
  assert.equal(mount.closeMount(nexusId).code, 'no_drive');
  assert.equal(mount.mountOf(nexusId).state, 'pending');
  assert.ok(existsSync(vaults.getVault(nexusId).file_path), 'the copy stays');
  plug();
  mount.settleMounts();
  assert.equal(mount.mountOf(nexusId), null, 'closed out once written');
  assert.deepEqual(inFile(driveFile(dId), `SELECT name FROM module`).map((x) => x.name), ['Seas']);
});

test('the drive file changed elsewhere meanwhile: never written over — the copy stays as a conflict', () => {
  const dId = driveOnly('Cinder');
  const { nexusId } = mount.openFromDrive('drive-m', dId);
  conn.getVaultDB(nexusId).prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(nexusId, 'Mine', 'classifier');
  const g = new Database(driveFile(dId)); g.run(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`, [dId, 'Theirs', 'classifier']); g.close();
  assert.equal(mount.closeMount(nexusId).code, 'conflict');
  assert.equal(mount.mountOf(nexusId).state, 'conflict');
  assert.deepEqual(inFile(driveFile(dId), `SELECT name FROM module`).map((x) => x.name), ['Theirs'], 'their edit survives');
  assert.ok(conn.getVaultDB(nexusId).prepare(`SELECT 1 FROM module WHERE name='Mine'`).get(), 'and so does ours');
  mount.settleMounts();
  assert.equal(mount.mountOf(nexusId).state, 'conflict', 'settling leaves a conflict alone');

  // part 4: the conflict becomes a linked Nexus, and the merge keeps both edits
  assert.deepEqual(mount.mountToLink(nexusId), { ok: true });
  assert.equal(mount.mountOf(nexusId), null);
  assert.notEqual(vaults.getVault(nexusId).locate_dir, join(root, 'DraconDex', 'Cinder'), 'its folder is here now, not the drive\'s');
  const r = require('../src/db/portlink-merge.js').mergeLink(nexusId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(inFile(driveFile(dId), `SELECT name FROM module ORDER BY name`).map((x) => x.name), ['Mine', 'Theirs']);
});

test('a drive Nexus that is linked here opens its local twin', () => {
  const id = make('Dune');
  const r = portlink.cloneToDrive(id, 'drive-m');
  assert.deepEqual(mount.openFromDrive('drive-m', r.driveNexusId), { ok: true, nexusId: id, linked: true });
});
