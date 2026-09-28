// .dxpack import (APP docs/ASSET-PACK.md): the tree and the files the APK /
// PWA sorted into folders arrive as collectors + import_file rows, with every
// file written into its collector's folder under the Locate root — at the
// very path db/mirror.js plans for that collector — and filed by the
// manifest's moduleId, never by the folder it sat in inside the zip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-pack-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};
const { Database } = require('node-sqlite3-wasm');
const conn = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const mig = require('../src/db/schema/migrations.js');
let db;
let locateRoot;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db, getAppDB: () => db } };
// syncNexusMirror resolves these at call time — point them at the test vault.
conn.getVaultDB = () => db;
require('../src/db/vaults.js').getVault = () => ({ locate_dir: locateRoot, locate_missing: 0 });
test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const { writeZip, openZip, safeEntryName } = require('../src/db/zip.js');
const { importAssetPack } = require('../src/db/asset-pack.js');

const sha = (b) => createHash('sha256').update(b).digest('hex');
const MAP = Buffer.from('map-bytes');
const FACE = Buffer.from('portrait-bytes');
const THUMB = Buffer.from('proxy-bytes');

function freshVault() {
  db = conn.adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  locateRoot = join(tmp, `locate-${Math.random().toString(36).slice(2)}`);
  mkdirSync(locateRoot);
}

// The phone's ids (100+) are deliberately not the ids the desktop will give.
const snapshot = {
  format: 'dracondex-vault-snapshot', version: 2, app: 'test', nexus: { name: 'Phone' },
  modules: [
    { id: 100, parentId: null, name: 'World', kind: 'collector', displayOrder: 0 },
    { id: 101, parentId: 100, name: 'Maps', kind: 'collector', displayOrder: 0 },
    { id: 102, parentId: 100, name: 'Cast', kind: 'classifier', displayOrder: 1 },
  ],
};
const assets = [
  { id: 1, moduleId: 101, name: 'map.png', type: 'png', size: MAP.length, sha256: sha(MAP), quality: 'full', zip: 'Assets/World/Maps/map.png' },
  // Filed in a non-collector: sits in its nearest collector's folder.
  { id: 2, moduleId: 102, name: 'face.jpg', type: 'jpg', size: FACE.length, sha256: sha(FACE), quality: 'full', zip: 'Assets/World/face.jpg' },
  { id: 3, moduleId: 100, name: 'cover.png', type: 'png', size: 9999, sha256: null, quality: 'proxy', zip: 'Assets/World/cover.png' },
  { id: 4, moduleId: 101, name: 'trailer.mp4', type: 'mp4', size: 5, sha256: 'ab', quality: 'none', zip: null },
  { id: 5, moduleId: 101, name: 'tool.exe', type: 'exe', size: 1, quality: 'full', zip: 'Assets/World/Maps/tool.exe' },
];

function buildPack(name, extra = []) {
  const p = join(tmp, name);
  const r = writeZip(p, [
    { name: 'pack.json', data: JSON.stringify({ format: 'dracondex-asset-pack', version: 1, app: 'test', scope: { moduleId: null }, assets }) },
    { name: 'snapshot.json', data: JSON.stringify(snapshot) },
    { name: 'Assets/World/Maps/map.png', data: MAP, store: true },
    { name: 'Assets/World/face.jpg', data: FACE, store: true },
    { name: 'Assets/World/cover.png', data: THUMB, store: true },
    { name: 'Assets/World/Maps/tool.exe', data: 'x', store: true },
    ...extra,
  ]);
  assert.equal(r.ok, true);
  return p;
}

test('zip entry names: relative, no .., no drive, no leading slash', () => {
  assert.equal(safeEntryName('Assets/World/a.png'), 'Assets/World/a.png');
  for (const bad of ['../x.png', 'Assets/../../x', '/etc/x', 'C:/x', 'a\\..\\b', 'a//b', './a']) assert.equal(safeEntryName(bad), null, bad);
});

test('openZip reads back what writeZip wrote, stored and deflated', () => {
  const p = join(tmp, 'rt.zip');
  writeZip(p, [{ name: 'a.txt', data: 'hello '.repeat(200) }, { name: 'b/c.bin', data: MAP, store: true }, { name: '../evil', data: 'x' }]);
  const z = openZip(p);
  assert.equal(z.ok, true);
  assert.equal(z.read('a.txt').toString(), 'hello '.repeat(200));
  assert.ok(z.read('b/c.bin').equals(MAP));
  assert.equal(z.unsafe, 1);
  assert.equal(z.entries.has('../evil'), false);
  z.close();
});

test('a pack becomes the collector tree, its files land in their folders, filed by moduleId', () => {
  freshVault();
  const r = importAssetPack(1, buildPack('p1.dxpack', [{ name: '../escape.png', data: 'x' }]), { destRoot: locateRoot });
  assert.equal(r.ok, true, JSON.stringify(r));
  const s = r.summary;
  assert.deepEqual([s.modules, s.collectors, s.files, s.proxyOnly, s.missing, s.skipped, s.badHash, s.unsafe], [3, 2, 4, 1, 1, 1, 0, 1]);

  const mod = (name) => db.prepare(`SELECT id, parent_id, kind FROM module WHERE name=?`).get(name);
  const world = mod('World'), maps = mod('Maps'), cast = mod('Cast');
  assert.equal(maps.parent_id, world.id);
  assert.equal(cast.parent_id, world.id);

  const row = (n) => db.prepare(`SELECT * FROM import_file WHERE file_name=?`).get(n);
  assert.equal(row('map.png').module_ref, maps.id);
  assert.equal(row('map.png').file_path, join(locateRoot, 'World', 'Maps', 'map.png'));
  assert.equal(row('map.png').sha256, sha(MAP));
  assert.ok(readFileSync(join(locateRoot, 'World', 'Maps', 'map.png')).equals(MAP));
  // Filed in the Classifier itself, stored in World/ (Cast is a .mddx file).
  assert.equal(row('face.jpg').module_ref, cast.id);
  assert.equal(row('face.jpg').file_path, join(locateRoot, 'World', 'face.jpg'));
  // A proxy is still written — it is the only copy the PWA had.
  assert.ok(readFileSync(row('cover.png').file_path).equals(THUMB));
  // Nothing came with it: registered where it belongs, missing, for Relink.
  assert.equal(row('trailer.mp4').missing, 1);
  assert.equal(existsSync(row('trailer.mp4').file_path), false);
  assert.equal(row('tool.exe'), undefined);
  assert.equal(existsSync(join(tmp, 'escape.png')), false);

  // The mirror ran into the same root: the non-collector became its .mddx.
  assert.ok(existsSync(join(locateRoot, 'World', 'Cast.mddx')));
});

test('importing the same pack again is additive, like a .mddx: a second tree, never an overwrite', () => {
  freshVault();
  const p = buildPack('p2.dxpack');
  importAssetPack(1, p, { destRoot: locateRoot });
  const r = importAssetPack(1, p, { destRoot: locateRoot });
  assert.equal(r.ok, true);
  const worlds = db.prepare(`SELECT id FROM module WHERE name='World' ORDER BY id`).all();
  assert.equal(worlds.length, 2);
  // The mirror keeps same-named siblings apart by id; the files follow it.
  const second = join(locateRoot, `World (${worlds[1].id})`, 'Maps', 'map.png');
  assert.ok(readFileSync(second).equals(MAP));
  assert.ok(readFileSync(join(locateRoot, 'World', 'Maps', 'map.png')).equals(MAP));
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM import_file WHERE file_name='map.png'`).get().n, 2);
});

test('a file that is not a pack, or a pack with no Locate folder, is refused', () => {
  freshVault();
  const bad = join(tmp, 'bad.dxpack');
  writeZip(bad, [{ name: 'pack.json', data: '{"format":"nope"}' }, { name: 'snapshot.json', data: JSON.stringify(snapshot) }]);
  assert.equal(importAssetPack(1, bad, { destRoot: locateRoot }).code, 'bad_pack');
  assert.equal(importAssetPack(1, buildPack('p3.dxpack'), { destRoot: join(tmp, 'nope') }).code, 'no_dir');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM module`).get().n, 0);
});
