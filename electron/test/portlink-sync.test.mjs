// Procress 32 part 5 — when a sync runs: every changed link on the drives
// plugged in, never one a window holds, never one that needs a choice (that
// is reported); Eject says what is not on the drive yet; Unlink keeps both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portsync-'));
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
const { syncLinks, ejectDrive } = require('../src/db/portlink-sync.js');
const { APP_DDL_SQL } = require('../src/db/schema/ddl.js');
const { MARKER } = require('../src/db/portable.js');
test.after(() => { locate.unwatchAll(); drives.stopWatching(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

const usb = join(dir, 'usb'), root = join(usb, 'DDX'), data = join(root, 'novel-manager-data');
mkdirSync(data, { recursive: true });
writeFileSync(join(root, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'drive-s', dataDir: 'novel-manager-data' }));
{ const db = new Database(join(data, 'app.ddx')); db.exec(APP_DDL_SQL); db.run(`INSERT INTO app_setting (key, value) VALUES ('portableRoot', ?)`, [root]); db.close(); }
process.env.DRACONDEX_DRIVE_ROOTS = usb;
drives.rescan();

function linked(name) {
  const id = nexus.createNexus(name, '', null, null);
  runWithVault(id, () => locate.syncLocate(id, { reason: 'create' }));
  const db = conn.getVaultDB(id);
  const mid = Number(db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(id, 'M', 'classifier').lastInsertRowid);
  const oid = Number(db.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'A')`).run(mid).lastInsertRowid);
  const r = portlink.cloneToDrive(id, 'drive-s');
  const file = drives.listDrives()[0].nexuses.find((n) => n.id === r.driveNexusId).file_path;
  return { id, mid, oid, file };
}
const onDrive = (file, sql, ...a) => { conn.closeAllVaults(); const db = new Database(file); try { db.run(sql, a); } finally { db.close(); } };

test('auto-sync: merges what changed, skips what is in sync or open, reports what needs a choice', () => {
  const quiet = linked('Quiet');
  const plain = linked('Plain');
  const open = linked('Open');
  const clash = linked('Clash');
  onDrive(plain.file, `UPDATE classifier_object SET name='A on drive' WHERE id=?`, plain.oid);
  onDrive(open.file, `UPDATE classifier_object SET name='changed' WHERE id=?`, open.oid);
  onDrive(clash.file, `UPDATE classifier_object SET name='drive' WHERE id=?`, clash.oid);
  conn.getVaultDB(clash.id).prepare(`UPDATE classifier_object SET name='here' WHERE id=?`).run(clash.oid);

  const res = syncLinks({ isOpen: (id) => id === open.id });
  const by = Object.fromEntries(res.map((r) => [r.name, r.ok ? 'ok' : r.code]));
  assert.deepEqual(by, { Plain: 'ok', Clash: 'needs_choice' }, 'Quiet was in sync, Open is held by a window');
  assert.equal(conn.getVaultDB(plain.id).prepare(`SELECT name FROM classifier_object`).get().name, 'A on drive');
  assert.equal(portlink.linkStatus(portlink.linkOf(clash.id)), 'both', 'a choice to make keeps saying so');
  void quiet;
});

test('eject: writes what it can, then names what is not on the drive yet', () => {
  const open = conn.getAppDB().prepare(`SELECT nexus_ref FROM port_link`).all().map((r) => r.nexus_ref)
    .find((id) => vaults.getVault(id).name === 'Open');
  const r = ejectDrive('drive-s', (id) => id === open);
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending.sort(), ['Clash', 'Open']);
  const after = ejectDrive('drive-s', () => false);
  assert.deepEqual(after.pending, ['Clash'], 'Open synced once its window was gone; Clash still waits for a choice');
});

test('unlink: the link and its base go; both copies stay', () => {
  const x = linked('Apart');
  const base = portlink.linkOf(x.id).basePath;
  assert.deepEqual(portlink.unlink(x.id), { ok: true });
  assert.equal(portlink.linkOf(x.id), null);
  assert.ok(!existsSync(base));
  assert.ok(existsSync(vaults.getVault(x.id).file_path));
  assert.ok(existsSync(x.file));
});
