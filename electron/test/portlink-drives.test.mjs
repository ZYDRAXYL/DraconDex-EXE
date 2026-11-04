// Procress 32 part 1 — an installed copy finds portable DraconDex drives:
// the marker at a drive root or one folder down, the drive's Nexus list read
// from a scratch copy (paths rebased onto where the drive is mounted now, the
// drive's files untouched), and whether the portable app on it is running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, delimiter } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portlink-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(dir, 'installed', 'electron-user-data'), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = join(dir, 'installed');

const { Database } = require('node-sqlite3-wasm');
const drives = require('../src/db/portlink-drives.js');
const { MARKER, RUNNING } = require('../src/db/portable.js');
test.after(() => { drives.stopWatching(); rmSync(dir, { recursive: true, force: true }); });

// A drive as a portable copy leaves it: <drive>/DDX/{marker, novel-manager-data/app.ddx, vaults}
// whose registry still says E:\DDX (where it was mounted last time).
const driveA = join(dir, 'driveA'), driveB = join(dir, 'driveB');
const root = join(driveA, 'DDX');
const data = join(root, 'novel-manager-data');
const OLD = join(dir, 'E-drive', 'DDX');
mkdirSync(join(data, 'vaults'), { recursive: true });
mkdirSync(driveB, { recursive: true });
writeFileSync(join(data, 'vaults', 'atlas-1.ddx'), 'x');
writeFileSync(join(root, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'uid-A', dataDir: 'novel-manager-data', appVersion: '5.7.0' }));
writeFileSync(join(driveB, MARKER), JSON.stringify({ format: 'something-else', driveUid: 'nope' }));
{
  const db = new Database(join(data, 'app.ddx'));
  db.exec(`CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE nexus_file (id INTEGER PRIMARY KEY, name TEXT, memo TEXT, color_code TEXT, file_path TEXT, locate_dir TEXT, update_at TEXT, project_count INTEGER)`);
  db.run(`INSERT INTO app_setting VALUES ('portableRoot', ?)`, [OLD]);
  db.run(`INSERT INTO nexus_file VALUES (1,'Atlas',NULL,NULL,?,?,'2026-11-04 09:00:00',3)`, [join(OLD, 'novel-manager-data', 'vaults', 'atlas-1.ddx'), join(OLD, 'DraconDex', 'Atlas')]);
  db.run(`INSERT INTO nexus_file VALUES (2,'Gone',NULL,NULL,?,NULL,'2026-11-04 09:00:00',0)`, [join(OLD, 'novel-manager-data', 'vaults', 'gone-2.ddx')]);
  db.close();
}
process.env.DRACONDEX_DRIVE_ROOTS = [driveA, driveB, join(dir, 'empty-slot')].join(delimiter);

test('finds the marker one folder down; ignores a file that is not a DraconDex marker', () => {
  assert.deepEqual(drives.findPortableRoots(driveA).map((f) => f.root), [root]);
  assert.deepEqual(drives.findPortableRoots(driveB), []);
});

test('reads the drive\'s Nexus list with paths rebased onto where it is mounted now — and leaves the drive untouched', () => {
  const before = readFileSync(join(data, 'app.ddx'));
  const list = drives.rescan();
  assert.equal(list.length, 1);
  const [d] = list;
  assert.equal(d.driveUid, 'uid-A');
  assert.equal(d.root, root);
  assert.equal(d.running, false);
  assert.deepEqual(d.nexuses.map((n) => [n.name, n.missing]), [['Atlas', 0], ['Gone', 1]]);
  assert.equal(d.nexuses[0].file_path, join(data, 'vaults', 'atlas-1.ddx'));
  assert.equal(d.nexuses[0].locate_dir, join(root, 'DraconDex', 'Atlas'));
  assert.ok(readFileSync(join(data, 'app.ddx')).equals(before), 'the drive\'s app.ddx is byte-identical');
});

test('running: only a live process on THIS machine counts', () => {
  const lock = (o) => writeFileSync(join(root, RUNNING), JSON.stringify(o));
  lock({ pid: process.pid, host: hostname() });
  assert.equal(drives.portableRunning(root), true);
  lock({ pid: process.pid, host: 'some-other-pc' });
  assert.equal(drives.portableRunning(root), false, 'pulled out while it ran elsewhere');
  lock({ pid: 2147483646, host: hostname() });
  assert.equal(drives.portableRunning(root), false, 'a crash left it behind');
  rmSync(join(root, RUNNING));
  assert.equal(drives.portableRunning(root), false);
});

test('watching: change is reported once per real change, and when a drive goes away', () => {
  const seen = [];
  drives.startWatching((l) => seen.push(l.length));
  assert.deepEqual(seen, [], 'nothing new since the last rescan');
  writeFileSync(join(driveB, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'uid-B' }));
  drives.rescan();
  assert.deepEqual(seen, [2]);
  drives.rescan();
  assert.deepEqual(seen, [2], 'same drives, no event');
  process.env.DRACONDEX_DRIVE_ROOTS = driveA; // driveB unplugged
  drives.tick();
  assert.deepEqual(seen, [2, 1]);
  drives.stopWatching();
});
