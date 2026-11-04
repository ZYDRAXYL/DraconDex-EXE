'use strict';
// ═══ Port Link — open a drive Nexus straight from the drive (part 3b) ══════
// The owner asked for a Nexus that is on a plugged-in drive (and not linked
// here) to open and edit like any other. A window cannot open the drive file
// itself: a window is keyed by a registry id, and nexus_file.id must equal the
// vault's own nexus row id — which, in the drive's file, is the DRIVE
// registry's id, free to collide with one of ours.
//
// So "open" mounts it: the drive file is copied here, renumbered to a registry
// row of this machine's own, and that copy is what the window edits. Assets
// are NOT copied — the copy's asset rows point at the drive's folder, so a
// picture added while it is open lands on the drive. Every write-back
// (window closed, every 60 s while open, quitting, the drive plugged back in)
// copies the working file back onto the drive: VACUUM INTO a .tmp beside the
// drive file, renumbered to the drive's id, asset paths in the drive's own
// root, renamed over it. After the last one the mount and its copy go.
//
// Never over someone else's work: if the drive file changed since this mount
// last wrote it (the drive went to another machine meanwhile), the write-back
// stops, the mount becomes 'conflict' and the copy stays here — it is a local
// Nexus from then on, to be merged (part 4), not a silent overwrite.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getAppDB, getVaultDB, closeVault } = require('./conn');
const { getVault, insertVault, setVaultPath, setVaultLocateDir, removeVault } = require('./vaults');
const { renumberNexusIn } = require('./nexus');
const { rebase } = require('./portable');
const { repointAssets } = require('./mirror');
const drives = require('./portlink-drives');
const pl = require('./portlink');

const mountDir = () => path.join(pl.baseDir(), 'mounts');
const mountRow = (r) => (!r ? null : {
  nexusId: r.nexus_ref, driveUid: r.drive_uid, driveNexusId: r.drive_nexus_id,
  workPath: r.work_path, localSig: r.local_sig, driveSig: r.drive_sig, state: r.state,
});
const listMounts = () => getAppDB().prepare(`SELECT * FROM port_mount`).all().map(mountRow);
const mountOf = (nexusId) => mountRow(getAppDB().prepare(`SELECT * FROM port_mount WHERE nexus_ref=?`).get(nexusId));
const setMount = (nexusId, patch) => {
  const cols = Object.keys(patch);
  getAppDB().prepare(`UPDATE port_mount SET ${cols.map((c) => `${c}=?`).join(', ')} WHERE nexus_ref=?`).run(...cols.map((c) => patch[c]), nexusId);
};

// → { ok, nexusId } — the existing mount when it is already open.
function openFromDrive(driveUid, driveNexusId) {
  let drive;
  try { drive = pl.driveOrThrow(driveUid); } catch (e) { return { ok: false, code: e.code }; }
  if (drive.running) return { ok: false, code: 'drive_busy' };
  const dn = drive.nexuses.find((n) => n.id === Number(driveNexusId));
  if (!dn || dn.missing) return { ok: false, code: 'not_found' };
  const linked = pl.linkOfDrive(driveUid, dn.id);
  if (linked) return { ok: true, nexusId: linked.nexusId, linked: true }; // its local twin is the one to open
  const had = mountRow(getAppDB().prepare(`SELECT * FROM port_mount WHERE drive_uid=? AND drive_nexus_id=?`).get(driveUid, dn.id));
  if (had) return { ok: true, nexusId: had.nexusId };

  // Not unique-checked against local names: the row is hidden from the local
  // list while the drive is in, and the name is the drive's.
  const id = Number(insertVault({ name: dn.name, memo: dn.memo, colorCode: dn.color_code, filePath: null }));
  fs.mkdirSync(mountDir(), { recursive: true });
  const work = path.join(mountDir(), `${crypto.randomUUID()}.ddx`), tmp = pl.tmpOf(work);
  try {
    fs.copyFileSync(dn.file_path, tmp);
    const copy = pl.openRaw(tmp);
    try {
      renumberNexusIn(copy, dn.id, id);
      // asset rows name the drive in its remembered root; here they need today's
      if (drive.ownRoot) repointAssets(copy, id, drive.ownRoot, drive.root);
    } finally { copy.close(); }
    fs.renameSync(tmp, work);
    setVaultPath(id, work);
    setVaultLocateDir(id, dn.locate_dir || null);
    getAppDB().prepare(`INSERT INTO port_mount (nexus_ref, drive_uid, drive_nexus_id, work_path, local_sig, drive_sig) VALUES (?,?,?,?,?,?)`)
      .run(id, driveUid, dn.id, work, pl.sigOf(work), pl.sigOf(dn.file_path));
    return { ok: true, nexusId: id };
  } catch (e) {
    closeVault(id);
    pl.rmQuiet(tmp); pl.rmQuiet(work);
    removeVault(id);
    return { ok: false, code: e.code || 'copy_failed', error: String(e?.message || e) };
  }
}

// One write-back. → { ok, wrote } · { ok:false, code: 'no_drive'|'drive_busy'|'gone'|'conflict'|… }
// 'no_drive' / 'drive_busy' leave the mount 'pending'; the next one retries.
function writeBack(nexusId) {
  const m = mountOf(nexusId);
  if (!m) return { ok: false, code: 'not_mounted' };
  if (m.state === 'conflict') return { ok: false, code: 'conflict' };
  const drive = drives.listDrives().find((d) => d.driveUid === m.driveUid);
  const dn = drive?.nexuses.find((n) => n.id === m.driveNexusId);
  const pending = (code) => { setMount(nexusId, { state: 'pending' }); return { ok: false, code }; };
  if (!drive) return pending('no_drive');
  if (drive.running) return pending('drive_busy');
  if (!dn || dn.missing) return pending('gone');
  // Live connection if a window has it open (VACUUM INTO is consistent), else the file.
  const local = getVault(nexusId);
  const changedHere = pl.sigOf(local?.file_path) !== m.localSig;
  // nothing edited here: nothing to write, and nothing to conflict with
  if (!changedHere) { if (m.state !== 'open') setMount(nexusId, { state: 'open' }); return { ok: true, wrote: false }; }
  if (pl.sigOf(dn.file_path) !== m.driveSig) { setMount(nexusId, { state: 'conflict' }); return { ok: false, code: 'conflict' }; }
  const tmp = pl.tmpOf(dn.file_path);
  try {
    pl.rmQuiet(tmp);
    getVaultDB(nexusId).prepare(`VACUUM INTO ?`).run(tmp);
    const copy = pl.openRaw(tmp);
    let name;
    try {
      renumberNexusIn(copy, nexusId, m.driveNexusId);
      if (drive.ownRoot) repointAssets(copy, m.driveNexusId, drive.root, drive.ownRoot);
      name = copy.prepare(`SELECT name FROM nexus WHERE id=?`).get(m.driveNexusId)?.name;
    } finally { copy.close(); }
    fs.renameSync(tmp, dn.file_path);
    // a rename in the window shows on the drive too (best effort: the file is what counts)
    try {
      const reg = pl.openDriveRegistry(drive);
      try {
        reg.db.prepare(`UPDATE nexus_file SET name=COALESCE(?, name), locate_dir=COALESCE(?, locate_dir), update_at=datetime('now') WHERE id=?`)
          .run(name || null, reg.toDrive(getVault(nexusId)?.locate_dir) || null, m.driveNexusId);
      } finally { reg.db.close(); }
    } catch (_) {}
    setMount(nexusId, { state: 'open', local_sig: pl.sigOf(local.file_path), drive_sig: pl.sigOf(dn.file_path) });
    return { ok: true, wrote: true };
  } catch (e) {
    pl.rmQuiet(tmp);
    return pending(e.code || 'write_failed');
  }
}

// The last window on it closed (or the app is settling leftovers): write back,
// and when that worked drop the mount, its registry row and its copy.
// A conflict or a missing drive keeps everything — nothing is ever lost here.
function closeMount(nexusId) {
  const r = writeBack(nexusId);
  if (!r.ok) return r;
  const m = mountOf(nexusId);
  closeVault(nexusId);
  removeVault(nexusId); // cascades port_mount
  pl.rmQuiet(m.workPath);
  return { ok: true, closed: true };
}

// isOpen(id): does a window still hold it. Open ones get a plain write-back;
// the rest are closed out (a crash or an unplugged drive left them).
function settleMounts(isOpen = () => false) {
  for (const m of listMounts()) {
    if (m.state === 'conflict') continue;
    try { if (isOpen(m.nexusId)) writeBack(m.nexusId); else closeMount(m.nexusId); } catch (_) {}
  }
}

module.exports = { listMounts, mountOf, openFromDrive, writeBack, closeMount, settleMounts };
