'use strict';
// ═══ Port Link — links + clone (Procress 32 part 3) ════════════════════════
// A link is a local Nexus and its clone on a portable drive (app.ddx
// `port_link`). Two ways to make one:
//
//   cloneToDrive(nexusId, driveUid)       this machine → the drive
//   cloneFromDrive(driveUid, driveNexusId) the drive → this machine
//
// Either way three files come out the same: the local .ddx, the drive's .ddx,
// and the BASE — this machine's copy of the drive file, the "B" the 3-way
// merge (part 4) compares both sides against. All three are in the DRIVE's
// id space where it matters (the drive is the hub: Plan.md Procress 32), and
// the local copy carries this machine's own registry id, because
// nexus_file.id == the vault's nexus row id is the invariant every
// vault-scoped query rests on (nexus.js renumberNexusIn).
//
// Nothing is half-made: every file is written under a .tmp name and renamed
// into place last; a failure removes what was written and leaves both
// registries as they were. The drive's registry is only written while the
// portable app on it is NOT running (it would be holding that file).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const { getAppDB, getVaultDB, adaptDb, forceLegacyJournalMode, closeVault, dataDir } = require('./conn');
const { getVault, insertVault, setVaultPath, setVaultLocateDir, removeVault, vaultDefaultPath, refreshVaultCounts, countVaultItems } = require('./vaults');
const { renumberNexusIn, freeName, localNameTaken } = require('./nexus');
const { rebase } = require('./portable');
const drives = require('./portlink-drives');

const baseDir = () => path.join(dataDir(), 'portlink');
const tmpOf = (p) => `${p}.${process.pid}.${Date.now()}.tmp`;
const rmQuiet = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };

// "Has this file changed since?" — size:mtime. Cheap enough to run on every
// list draw. ponytail: opening a vault can touch its mtime with no real edit;
// that only shows "changed" where the merge (part 4) then finds nothing.
function sigOf(file) {
  try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch (_) { return null; }
}

// A vault file outside conn.js's cache (it would key it by an id that means
// something else in this registry). Journal mode is DELETE app-wide.
function openRaw(file) {
  forceLegacyJournalMode(file);
  const db = adaptDb(new _RawDatabase(file));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

const linkRow = (r) => (!r ? null : {
  linkUid: r.link_uid, nexusId: r.nexus_ref, driveUid: r.drive_uid, driveNexusId: r.drive_nexus_id,
  basePath: r.base_path, localSig: r.local_sig, driveSig: r.drive_sig, lastSyncAt: r.last_sync_at,
});
const listLinks = () => getAppDB().prepare(`SELECT * FROM port_link ORDER BY create_at`).all().map(linkRow);
const linkOf = (nexusId) => linkRow(getAppDB().prepare(`SELECT * FROM port_link WHERE nexus_ref=?`).get(nexusId));
const linkOfDrive = (driveUid, driveNexusId) =>
  linkRow(getAppDB().prepare(`SELECT * FROM port_link WHERE drive_uid=? AND drive_nexus_id=?`).get(driveUid, driveNexusId));

// ── The drive's registry ───────────────────────────────────────────────────
// Paths in it are written the way the portable app will read them: in terms
// of the root IT last remembered (portable.js rebases from there on its next
// start). Written with today's letter, a path would stop matching the moment
// the drive came up as another one.
function openDriveRegistry(drive) {
  if (drive.running) throw Object.assign(new Error('portable app running'), { code: 'drive_busy' });
  const file = path.join(drive.dataDir, 'app.ddx');
  if (!fs.existsSync(file)) throw Object.assign(new Error('no registry'), { code: 'drive_not_ready' });
  if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-journal`)) throw Object.assign(new Error('registry mid-write'), { code: 'drive_busy' });
  const db = openRaw(file);
  const own = db.prepare(`SELECT value FROM app_setting WHERE key='portableRoot'`).get()?.value || drive.root;
  return { db, toDrive: (p) => (p ? rebase(p, drive.root, own) : p) };
}

function driveOrThrow(driveUid) {
  const d = drives.listDrives().find((x) => x.driveUid === driveUid);
  if (!d) throw Object.assign(new Error('drive not plugged in'), { code: 'no_drive' });
  return d;
}

// <base>/<name>, or "<name> (2)"… — a folder nobody has.
function freeDirIn(parent, name) {
  return path.join(parent, freeName(name, (n) => fs.existsSync(path.join(parent, n))) || `${name}-${Date.now()}`);
}

// Copy a Nexus's folder (its assets + mirror) and point the copy's asset rows
// at it. Assets that lived outside the folder are not copied — they never
// were part of the Nexus's folder; Locate's "Gather" brings them in first.
// rowsFrom / rowsTo: the folder as the asset rows name it on each side — on
// the drive that is in the drive's own remembered root, not today's letter.
function copyFolder(fromDir, toDir, vaultDb, nexusId, rowsFrom = fromDir, rowsTo = toDir) {
  if (fromDir && fs.existsSync(fromDir)) fs.cpSync(fromDir, toDir, { recursive: true, errorOnExist: true, force: false });
  else fs.mkdirSync(toDir, { recursive: true });
  if (rowsFrom) require('./mirror').repointAssets(vaultDb, nexusId, rowsFrom, rowsTo);
}

function insertLink({ nexusId, driveUid, driveNexusId, basePath, localFile, driveFile }) {
  const linkUid = crypto.randomUUID();
  getAppDB().prepare(`INSERT INTO port_link (link_uid, nexus_ref, drive_uid, drive_nexus_id, base_path, local_sig, drive_sig, last_sync_at)
    VALUES (?,?,?,?,?,?,?,datetime('now'))`).run(linkUid, nexusId, driveUid, driveNexusId, basePath, sigOf(localFile), sigOf(driveFile));
  return linkUid;
}

// ── This machine → the drive ───────────────────────────────────────────────
function cloneToDrive(nexusId, driveUid) {
  const v = getVault(nexusId);
  if (!v?.file_path || v.missing) return { ok: false, code: 'not_found' };
  if (linkOf(nexusId)) return { ok: false, code: 'already_linked' };
  let drive, reg;
  try { drive = driveOrThrow(driveUid); reg = openDriveRegistry(drive); } catch (e) { return { ok: false, code: e.code || 'drive_failed' }; }
  const made = [];
  let committed = false;
  try {
    const name = freeName(v.name, (n) => !!reg.db.prepare(`SELECT 1 FROM nexus_file WHERE name=? COLLATE NOCASE`).get(n));
    if (!name) return { ok: false, code: 'name_taken' };
    const vaults = path.join(drive.dataDir, 'vaults');
    const locRoot = path.join(drive.root, 'DraconDex');
    fs.mkdirSync(vaults, { recursive: true });
    let out;
    reg.db.transaction(() => {
      const dId = Number(reg.db.prepare(`INSERT INTO nexus_file (name, memo, color_code) VALUES (?,?,?)`).run(name, v.memo, v.color_code).lastInsertRowid);
      const slug = path.basename(vaultDefaultPath(name, dId));
      const file = path.join(vaults, slug), tmp = tmpOf(file);
      const loc = freeDirIn(locRoot, require('./mirror').dirNameOf(name));
      // 1. the vault, consistent even while a window edits it (VACUUM INTO),
      //    renumbered into the drive's id space, assets pointed at the drive folder
      made.push(tmp);
      getVaultDB(nexusId).prepare(`VACUUM INTO ?`).run(tmp);
      const copy = openRaw(tmp);
      let count;
      try {
        renumberNexusIn(copy, nexusId, dId, name);
        made.push(loc);
        copyFolder(v.locate_dir, loc, copy, dId, v.locate_dir, reg.toDrive(loc));
        // the portable app's Welcome list shows this cached count until the
        // Nexus is first opened there — without it the clone reads "0 projects"
        count = countVaultItems(copy, dId);
      } finally { copy.close(); }
      // 2. the base: this machine's copy of exactly what is now on the drive
      fs.mkdirSync(baseDir(), { recursive: true });
      const base = path.join(baseDir(), `${crypto.randomUUID()}.base.ddx`);
      made.push(base);
      fs.copyFileSync(tmp, base);
      // 3. into place, then the registry row points at it
      fs.renameSync(tmp, file);
      made[0] = file;
      reg.db.prepare(`UPDATE nexus_file SET file_path=?, locate_dir=?, project_count=?, counts_at=datetime('now') WHERE id=?`).run(reg.toDrive(file), reg.toDrive(loc), count, dId);
      out = { dId, file, base, name };
    })();
    committed = true;
    const linkUid = insertLink({ nexusId, driveUid, driveNexusId: out.dId, basePath: out.base, localFile: v.file_path, driveFile: out.file });
    drives.rescan();
    return { ok: true, linkUid, driveNexusId: out.dId, name: out.name };
  } catch (e) {
    if (!committed) for (const p of made) rmQuiet(p);
    return { ok: false, code: e.code || 'copy_failed', error: String(e?.message || e) };
  } finally {
    try { reg.db.close(); } catch (_) {}
  }
}

// ── The drive → this machine ───────────────────────────────────────────────
function cloneFromDrive(driveUid, driveNexusId) {
  let drive;
  try { drive = driveOrThrow(driveUid); } catch (e) { return { ok: false, code: e.code }; }
  if (drive.running) return { ok: false, code: 'drive_busy' };
  const dn = drive.nexuses.find((n) => n.id === Number(driveNexusId));
  if (!dn || dn.missing) return { ok: false, code: 'not_found' };
  if (linkOfDrive(driveUid, dn.id)) return { ok: false, code: 'already_linked' };
  const name = freeName(dn.name, localNameTaken);
  if (!name) return { ok: false, code: 'name_taken' };
  const id = Number(insertVault({ name, memo: dn.memo, colorCode: dn.color_code, filePath: null }));
  const made = [];
  try {
    const file = vaultDefaultPath(name, id), tmp = tmpOf(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The portable app is not running (checked) and vaults are journal_mode
    // DELETE, so the file on the drive is the whole, consistent state.
    made.push(tmp);
    fs.copyFileSync(dn.file_path, tmp);
    fs.mkdirSync(baseDir(), { recursive: true });
    const base = path.join(baseDir(), `${crypto.randomUUID()}.base.ddx`);
    made.push(base);
    fs.copyFileSync(dn.file_path, base);
    const { locateRoot } = require('./locate');
    const loc = freeDirIn(locateRoot(), require('./mirror').dirNameOf(name));
    const copy = openRaw(tmp);
    try {
      renumberNexusIn(copy, dn.id, id, name);
      made.push(loc);
      // the drive copy's rows name its folder in the drive's remembered root
      copyFolder(dn.locate_dir, loc, copy, id, dn.locate_dir && rebase(dn.locate_dir, drive.root, drive.ownRoot || drive.root), loc);
    } finally { copy.close(); }
    fs.renameSync(tmp, file);
    made[0] = file;
    setVaultPath(id, file);
    setVaultLocateDir(id, loc);
    refreshVaultCounts(id);
    const linkUid = insertLink({ nexusId: id, driveUid, driveNexusId: dn.id, basePath: base, localFile: file, driveFile: dn.file_path });
    return { ok: true, linkUid, nexusId: id, name };
  } catch (e) {
    closeVault(id);
    for (const p of made) rmQuiet(p);
    removeVault(id);
    return { ok: false, code: e.code || 'copy_failed', error: String(e?.message || e) };
  }
}

// ── Status, for the list ───────────────────────────────────────────────────
//   away     the drive is not plugged in (or its file is gone)
//   synced   neither file changed since the last sync
//   local    only this machine's changed  ·  drive   only the drive's
//   both     both did — a merge (part 4) will sort it out
function linkStatus(l, driveList = drives.listDrives()) {
  const d = driveList.find((x) => x.driveUid === l.driveUid);
  const dn = d?.nexuses.find((n) => n.id === l.driveNexusId);
  if (!dn || dn.missing) return 'away';
  const here = sigOf(getVault(l.nexusId)?.file_path) !== l.localSig;
  const there = sigOf(dn.file_path) !== l.driveSig;
  return here && there ? 'both' : here ? 'local' : there ? 'drive' : 'synced';
}
const listLinksWithStatus = () => { const ds = drives.listDrives(); return listLinks().map((l) => ({ ...l, status: linkStatus(l, ds) })); };

// Part 5: stop syncing. Both copies stay — two independent Nexuses from now on.
function unlink(nexusId) {
  const l = linkOf(nexusId);
  if (!l) return { ok: false, code: 'not_linked' };
  getAppDB().prepare(`DELETE FROM port_link WHERE link_uid=?`).run(l.linkUid);
  rmQuiet(l.basePath);
  return { ok: true };
}

module.exports = { unlink, openRaw, openDriveRegistry, driveOrThrow, baseDir, tmpOf, rmQuiet, sigOf, freeDirIn, listLinks, listLinksWithStatus, linkOf, linkOfDrive, linkStatus, cloneToDrive, cloneFromDrive };
