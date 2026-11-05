// Procress 32 part 4 — the 3-way merge between this machine and its clone on
// a portable drive. The drive side is edited the way "another machine" or the
// portable app would: straight in the drive's file, under the drive's id.
// The owner's own example is the first test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portmerge-'));
const local = join(dir, 'installed');
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(local, 'electron-user-data'), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = local;

const { Database } = require('node-sqlite3-wasm');
const conn = require('../src/db/conn.js');
const { runWithVault } = require('../src/db/vault-context.js');
const nexus = require('../src/db/nexus.js');
const locate = require('../src/db/locate.js');
const drives = require('../src/db/portlink-drives.js');
const portlink = require('../src/db/portlink.js');
const { mergeLink } = require('../src/db/portlink-merge.js');
const { APP_DDL_SQL } = require('../src/db/schema/ddl.js');
const { MARKER, RUNNING } = require('../src/db/portable.js');
test.after(() => { locate.unwatchAll(); drives.stopWatching(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

const usb = join(dir, 'usb'), root = join(usb, 'DDX'), data = join(root, 'novel-manager-data');
mkdirSync(data, { recursive: true });
writeFileSync(join(root, MARKER), JSON.stringify({ format: 'dracondex-portable', version: 1, driveUid: 'drive-x', dataDir: 'novel-manager-data' }));
{ const db = new Database(join(data, 'app.ddx')); db.exec(APP_DDL_SQL); db.run(`INSERT INTO app_setting (key, value) VALUES ('portableRoot', ?)`, [root]); db.close(); }
process.env.DRACONDEX_DRIVE_ROOTS = usb;
drives.rescan();

// One linked Nexus per test: a Classifier module with the given objects.
function linked(name, objects) {
  const id = nexus.createNexus(name, '', null, null);
  runWithVault(id, () => locate.syncLocate(id, { reason: 'create' }));
  const db = conn.getVaultDB(id);
  const mid = Number(db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(id, 'Heroes', 'classifier').lastInsertRowid);
  const oid = {};
  for (const o of objects) oid[o] = Number(db.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?,?)`).run(mid, o).lastInsertRowid);
  const r = portlink.cloneToDrive(id, 'drive-x');
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = drives.listDrives()[0].nexuses.find((n) => n.id === r.driveNexusId).file_path;
  return { id, dId: r.driveNexusId, mid, oid, file, here: () => conn.getVaultDB(id) };
}
// "comB": the drive's file, edited directly
function onDrive(file, fn) { conn.closeAllVaults(); const db = new Database(file); try { return fn(db); } finally { db.close(); } }
const objectsIn = (file) => onDrive(file, (db) => db.all(`SELECT name FROM classifier_object ORDER BY name`).map((r) => r.name));
const objectsHere = (x) => x.here().prepare(`SELECT name FROM classifier_object ORDER BY name`).all().map((r) => r.name);

test('the owner\'s example: A renamed to B on the drive while this machine made C → B and C, on both sides', () => {
  const x = linked('Example', ['A']);
  onDrive(x.file, (db) => db.run(`UPDATE classifier_object SET name='B' WHERE id=?`, [x.oid.A]));
  x.here().prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'C')`).run(x.mid);
  const r = mergeLink(x.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(objectsIn(x.file), ['B', 'C']);
  assert.deepEqual(objectsHere(x), ['B', 'C']);
  assert.deepEqual(x.here().prepare(`SELECT id FROM nexus`).all().map((n) => n.id), [x.id], 'this machine keeps its own id');
  const l = portlink.linkOf(x.id);
  assert.ok(readFileSync(l.basePath).equals(readFileSync(x.file)), 'the new base is what the drive now holds');
  assert.equal(portlink.linkStatus(l), 'synced');
});

test('the same field changed on both sides: asks — and writes nothing until told', () => {
  const x = linked('Both', ['A']);
  onDrive(x.file, (db) => db.run(`UPDATE classifier_object SET name='Drive name' WHERE id=?`, [x.oid.A]));
  x.here().prepare(`UPDATE classifier_object SET name='Local name' WHERE id=?`).run(x.oid.A);
  const before = readFileSync(x.file);
  const r = mergeLink(x.id);
  assert.equal(r.code, 'needs_choice');
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0];
  assert.deepEqual([c.key, c.base, c.local, c.drive], [`classifier_object:${x.oid.A}:name`, 'A', 'Local name', 'Drive name']);
  assert.ok(readFileSync(x.file).equals(before), 'the drive file is untouched');
  assert.deepEqual(objectsHere(x), ['Local name']);
  assert.equal(mergeLink(x.id, { choices: { [c.key]: 'local' } }).ok, true);
  assert.deepEqual(objectsIn(x.file), ['Local name']);
  assert.deepEqual(objectsHere(x), ['Local name']);
});

test('delete vs edit: an edit wins; a delete of something the other side left alone goes through', () => {
  const x = linked('Deletes', ['X', 'Y', 'Z']);
  onDrive(x.file, (db) => { db.run(`UPDATE classifier_object SET note='drive note' WHERE id=?`, [x.oid.X]); db.run(`DELETE FROM classifier_object WHERE id=?`, [x.oid.Y]); });
  const h = x.here();
  h.prepare(`DELETE FROM classifier_object WHERE id=?`).run(x.oid.X);
  h.prepare(`UPDATE classifier_object SET note='local note' WHERE id=?`).run(x.oid.Y);
  h.prepare(`DELETE FROM classifier_object WHERE id=?`).run(x.oid.Z);
  assert.equal(mergeLink(x.id).ok, true);
  const rows = onDrive(x.file, (db) => db.all(`SELECT name, note FROM classifier_object ORDER BY name`));
  assert.deepEqual(rows, [{ name: 'X', note: 'drive note' }, { name: 'Y', note: 'local note' }]);
});

test('both sides made a new row with the same id: ours is renumbered, and what points at it follows', () => {
  const x = linked('Collide', ['A']);
  // the drive makes Q, this machine makes P — both get the next id
  onDrive(x.file, (db) => db.run(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Q')`, [x.mid]));
  const h = x.here();
  const p = Number(h.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'P')`).run(x.mid).lastInsertRowid);
  h.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, label) VALUES (?,?,?,?)`).run(x.id, `cobj_${p}`, `cobj_${x.oid.A}`, 'P knows A');
  const r = mergeLink(x.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(objectsIn(x.file), ['A', 'P', 'Q']);
  const res = onDrive(x.file, (db) => ({
    p: db.get(`SELECT id FROM classifier_object WHERE name='P'`).id,
    q: db.get(`SELECT id FROM classifier_object WHERE name='Q'`).id,
    rel: db.get(`SELECT from_key, to_key FROM entity_relation WHERE label='P knows A'`),
  }));
  assert.notEqual(res.p, res.q);
  assert.equal(res.q, p, 'the drive\'s row keeps its id');
  assert.deepEqual(res.rel, { from_key: `cobj_${res.p}`, to_key: `cobj_${x.oid.A}` }, 'the relation follows P, not Q');
});

test('a renumber only moves what came from this machine: the drive\'s own reference stays put', () => {
  // both make a module (same next id → ours is renumbered); the drive moves A
  // into its module, this machine only renames A. A must stay in the drive's module.
  const x = linked('Moved', ['A']);
  onDrive(x.file, (db) => {
    db.run(`INSERT INTO module (nexus_ref, name, kind) VALUES (?, 'Drive mod', 'classifier')`, [x.dId]);
    db.run(`UPDATE classifier_object SET module_ref=(SELECT id FROM module WHERE name='Drive mod') WHERE id=?`, [x.oid.A]);
  });
  const h = x.here();
  h.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?, 'Local mod', 'classifier')`).run(x.id);
  h.prepare(`UPDATE classifier_object SET name='A2' WHERE id=?`).run(x.oid.A);
  const r = mergeLink(x.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  const rows = onDrive(x.file, (db) => db.all(`SELECT o.name, m.name AS mod FROM classifier_object o JOIN module m ON m.id=o.module_ref`));
  assert.deepEqual(rows, [{ name: 'A2', mod: 'Drive mod' }]);
});

test('both made the same tag: one tag, both modules tagged', () => {
  const x = linked('Tags', []);
  onDrive(x.file, (db) => { const t = db.run(`INSERT INTO hashtag (tag_name) VALUES ('fire')`).lastInsertRowid; db.run(`INSERT INTO module_hashtag (module_ref, hashtag_id) VALUES (?,?)`, [x.mid, t]); });
  const h = x.here();
  const m2 = Number(h.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?,?,?)`).run(x.id, 'Places', 'classifier').lastInsertRowid);
  const t = Number(h.prepare(`INSERT INTO hashtag (tag_name) VALUES ('fire')`).run().lastInsertRowid);
  h.prepare(`INSERT INTO module_hashtag (module_ref, hashtag_id) VALUES (?,?)`).run(m2, t);
  assert.equal(mergeLink(x.id).ok, true);
  const res = onDrive(x.file, (db) => ({
    tags: db.all(`SELECT tag_name FROM hashtag`).map((r) => r.tag_name),
    tagged: db.all(`SELECT m.name FROM module_hashtag mh JOIN module m ON m.id=mh.module_ref JOIN hashtag h ON h.id=mh.hashtag_id WHERE h.tag_name='fire' ORDER BY m.name`).map((r) => r.name),
  }));
  assert.deepEqual(res, { tags: ['fire'], tagged: ['Heroes', 'Places'] });
});

test('the drive deleted a module this machine added to: the module comes back with both', () => {
  const x = linked('Parent', ['A']);
  onDrive(x.file, (db) => db.run(`DELETE FROM module WHERE id=?`, [x.mid])); // cascades A on the drive
  x.here().prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'New here')`).run(x.mid);
  assert.equal(mergeLink(x.id).ok, true);
  const res = onDrive(x.file, (db) => ({
    mods: db.all(`SELECT name FROM module`).map((r) => r.name),
    objs: db.all(`SELECT name FROM classifier_object ORDER BY name`).map((r) => r.name),
    broken: db.all(`PRAGMA foreign_key_check`).length,
  }));
  assert.deepEqual(res.mods, ['Heroes']);
  assert.ok(res.objs.includes('New here'));
  assert.equal(res.broken, 0);
});

test('not while a window has it open, nor while the portable app is running', () => {
  const x = linked('Guard', ['A']);
  assert.equal(mergeLink(x.id, { isOpen: () => true }).code, 'open');
  writeFileSync(join(root, RUNNING), JSON.stringify({ pid: process.pid, host: hostname() }));
  drives.rescan();
  assert.equal(mergeLink(x.id).code, 'drive_busy');
  rmSync(join(root, RUNNING));
  drives.rescan();
});

test('nothing changed anywhere: a sync writes nothing new', () => {
  const x = linked('Quiet', ['A']);
  const r = mergeLink(x.id);
  assert.equal(r.ok, true);
  assert.deepEqual([r.summary.fromLocal, r.summary.updated, r.summary.deleted, r.summary.conflicts], [0, 0, 0, 0]);
  assert.deepEqual(objectsIn(x.file), ['A']);
});

test('round after round: each sync\'s result is the next one\'s base', () => {
  const x = linked('Rounds', ['A']);
  // round 1: the drive renames, here adds
  onDrive(x.file, (db) => db.run(`UPDATE classifier_object SET name='A1' WHERE id=?`, [x.oid.A]));
  x.here().prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'B')`).run(x.mid);
  assert.equal(mergeLink(x.id).ok, true);
  // round 2: here renames what round 1 just brought in; the drive deletes B
  // (made here in round 1) — not a conflict: the base already has both
  x.here().prepare(`UPDATE classifier_object SET name='A2' WHERE name='A1'`).run();
  onDrive(x.file, (db) => db.run(`DELETE FROM classifier_object WHERE name='B'`));
  const r = mergeLink(x.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(objectsIn(x.file), ['A2']);
  assert.deepEqual(objectsHere(x), ['A2']);
});
