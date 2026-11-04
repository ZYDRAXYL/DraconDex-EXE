'use strict';
// ═══ Port Link — finding portable drives (Procress 32 part 1) ══════════════
// An INSTALLED copy looks for portable DraconDex copies on the drives that are
// plugged in: a `dracondex-portable.json` (written by src/db/portable.js) at a
// drive root or one folder down. For each one found it reads the drive's own
// registry (its app.ddx nexus_file) — through a scratch copy, read-only, the
// way import-merge.js reads a picked file — so the drive is never written to
// here, even if the portable app on it is open right now.
//
// Electron has no "drive plugged in" event on Windows, so this polls: every
// POLL_MS it checks which roots exist (A:\…Z:\ — cheap), and only when that
// set changes does it scan for markers and read registries. A marker that
// appears on a drive that was already plugged in is picked up by rescan().
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const { adaptDb, forceLegacyJournalMode, hasTable } = require('./conn');
const { MARKER, RUNNING, rebase } = require('./portable');

const POLL_MS = 3000;

// Where drives are mounted. DRACONDEX_DRIVE_ROOTS (path-delimited) overrides
// it — the tests and the driver point it at scratch folders.
function driveRoots() {
  if (process.env.DRACONDEX_DRIVE_ROOTS) return process.env.DRACONDEX_DRIVE_ROOTS.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const out = [];
    for (let c = 65; c <= 90; c++) { const r = `${String.fromCharCode(c)}:\\`; if (fs.existsSync(r)) out.push(r); }
    return out;
  }
  const user = os.userInfo().username;
  const kids = (d) => { try { return fs.readdirSync(d).map((n) => path.join(d, n)); } catch (_) { return []; } };
  return process.platform === 'darwin' ? kids('/Volumes') : [...kids(`/media/${user}`), ...kids(`/run/media/${user}`)];
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const isMarker = (m) => m && m.format === 'dracondex-portable' && typeof m.driveUid === 'string' && m.driveUid;

// Portable roots on one drive: the drive root itself, or a folder right under it.
function findPortableRoots(driveRoot) {
  const found = [];
  const at = (dir) => { const m = readJson(path.join(dir, MARKER)); if (isMarker(m)) found.push({ root: dir, marker: m }); };
  at(driveRoot);
  let names = [];
  try { names = fs.readdirSync(driveRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) {}
  for (const n of names) if (!n.startsWith('$') && !n.startsWith('.')) at(path.join(driveRoot, n)); // $RECYCLE.BIN, .Trashes…
  return found;
}

// Is the portable app on this drive open right now? A lock from another
// machine (the drive was pulled out while it ran there) or from a process
// that is gone (a crash) does not count.
function portableRunning(root) {
  const l = readJson(path.join(root, RUNNING));
  if (!l || !l.pid) return false;
  if (l.host !== os.hostname()) return false;
  try { process.kill(l.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The drive's registry, read from a scratch copy. Paths come back rebased
// onto where the drive is mounted now (the portable copy rebases them itself
// on its next start, but it may not have run on this machine yet).
function readDriveNexuses(root, marker) {
  const dataDir = path.join(root, ...String(marker.dataDir || 'novel-manager-data').split('/'));
  const src = path.join(dataDir, 'app.ddx');
  if (!fs.existsSync(src)) return [];
  const tmp = path.join(os.tmpdir(), `dracondex-portlink-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ddx`);
  const clean = () => { for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(tmp + s, { force: true }); } catch (_) {} } };
  let db;
  try {
    fs.copyFileSync(src, tmp);
    if (fs.existsSync(src + '-wal')) {
      try { fs.copyFileSync(src + '-wal', tmp + '-wal'); } catch (_) {}
      try { fs.copyFileSync(src + '-shm', tmp + '-shm'); } catch (_) {}
    } else forceLegacyJournalMode(tmp);
    db = adaptDb(new _RawDatabase(tmp, { readOnly: true }));
    if (!hasTable(db, 'nexus_file')) return [];
    const was = hasTable(db, 'app_setting') ? db.prepare(`SELECT value FROM app_setting WHERE key='portableRoot'`).get()?.value : null;
    const fix = (p) => (p && was ? rebase(p, was, root) : p);
    return db.prepare(`SELECT id, name, memo, color_code, file_path, locate_dir, update_at, project_count FROM nexus_file ORDER BY name COLLATE NOCASE`).all()
      .map((r) => {
        const file_path = fix(r.file_path), locate_dir = fix(r.locate_dir);
        return { ...r, file_path, locate_dir, missing: file_path && fs.existsSync(file_path) ? 0 : 1 };
      });
  } finally {
    try { db?.close(); } catch (_) {}
    clean();
  }
}

// ── State + polling ────────────────────────────────────────────────────────
let drives = [];          // [{ driveUid, root, appVersion, running, nexuses, error }]
let lastRoots = '';
let timer = null;
let onChange = null;

function scan() {
  const seen = new Set();
  const out = [];
  for (const dr of driveRoots()) {
    for (const { root, marker } of findPortableRoots(dr)) {
      if (seen.has(marker.driveUid)) continue; // the same folder reached twice
      seen.add(marker.driveUid);
      let nexuses = [], error = null;
      try { nexuses = readDriveNexuses(root, marker); } catch (e) { error = String(e?.message || e); }
      out.push({ driveUid: marker.driveUid, root, appVersion: marker.appVersion || null, running: portableRunning(root), nexuses, error });
    }
  }
  return out;
}

const listDrives = () => drives;

// → the new list. Calls onChange only when what it found differs.
function rescan() {
  const next = scan();
  const changed = JSON.stringify(next) !== JSON.stringify(drives);
  drives = next;
  if (changed && onChange) { try { onChange(drives); } catch (_) {} }
  return drives;
}

function tick() {
  const roots = driveRoots().join('|');
  if (roots !== lastRoots) { lastRoots = roots; rescan(); }
}

function startWatching(cb) {
  onChange = cb || null;
  if (timer) return;
  lastRoots = driveRoots().join('|');
  rescan();
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
}
function stopWatching() { if (timer) clearInterval(timer); timer = null; onChange = null; }

module.exports = {
  POLL_MS, driveRoots, findPortableRoots, portableRunning, readDriveNexuses,
  listDrives, rescan, tick, startWatching, stopWatching,
};
