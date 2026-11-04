'use strict';
// ═══ A portable copy that can really be carried (Procress 32 part 0) ══════
// The portable exe / portable.flag folder keeps its data beside itself
// (main.js), but everything it stores is an ABSOLUTE path: nexus_file's
// file_path and locate_dir, the locateRoot setting, every import_file in
// every vault. Plug the drive into another machine and it is F: instead of
// E: — every Nexus reads as missing. So on start the portable copy remembers
// where its root was last time and, if that moved, rebases every path that
// lived under the old root onto the new one. A path outside the root (a vault
// the user put on C:, an asset linked from elsewhere) is left alone.
//
// It also writes `dracondex-portable.json` at the root: the marker an
// installed copy will look for to find this drive (part 1), with a driveUid
// that stays the same whatever letter the drive gets.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_KEY = 'portableRoot';
const MARKER = 'dracondex-portable.json';

let _root = null;
// main.js decides (PORTABLE_EXECUTABLE_DIR or portable.flag) and tells us once.
const setPortableRoot = (dir) => { _root = dir ? path.resolve(dir) : null; };
const portableRoot = () => _root;

// p rebased from one root onto another; p itself when it is not under `from`.
// path.relative is case-insensitive on win32, so E:\X and e:\x match.
function rebase(p, from, to) {
  if (!p) return p;
  const rel = path.relative(from, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel ? path.join(to, rel) : to;
}

// → null (not portable) · { moved:false } · { moved:true, from, to, vaults, failed }
function rebasePortable() {
  if (!_root) return null;
  const { getAppDB, getVaultDB } = require('./conn');
  const { repointAssets } = require('./mirror');
  const app = getAppDB();
  const from = app.prepare(`SELECT value FROM app_setting WHERE key=?`).get(ROOT_KEY)?.value || null;
  const to = _root;
  const remember = app.prepare(`INSERT INTO app_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  if (!from || path.relative(from, to) === '') { if (!from) remember.run(ROOT_KEY, to); return { moved: false }; }

  // The registry and the new root in ONE transaction: a crash half-way can
  // not leave some rows rebased and the old root still remembered.
  const rows = app.prepare(`SELECT id, file_path, locate_dir FROM nexus_file`).all();
  app.transaction(() => {
    const upd = app.prepare(`UPDATE nexus_file SET file_path=?, locate_dir=? WHERE id=?`);
    for (const r of rows) {
      const fp = rebase(r.file_path, from, to), ld = rebase(r.locate_dir, from, to);
      if (fp !== r.file_path || ld !== r.locate_dir) upd.run(fp, ld, r.id);
    }
    const lr = app.prepare(`SELECT value FROM app_setting WHERE key='locateRoot'`).get()?.value;
    if (lr && rebase(lr, from, to) !== lr) remember.run('locateRoot', rebase(lr, from, to));
    remember.run(ROOT_KEY, to);
  })();

  // Asset paths live inside each vault. Opened once here, only on the start
  // after a move — the rare case, so the cost is not paid on every start.
  // ponytail: a crash between two vaults leaves the rest pointing at the old
  // root; they show as missing assets (Problems), nothing is lost.
  let vaults = 0, failed = 0;
  for (const r of rows) {
    const fp = rebase(r.file_path, from, to);
    if (!fp || !fs.existsSync(fp)) continue;
    try { repointAssets(getVaultDB(r.id), r.id, from, to); vaults++; } catch (_) { failed++; }
  }
  return { moved: true, from, to, vaults, failed };
}

// The marker at the root. driveUid is made once and then kept, so the same
// drive is the same drive on every machine and under every letter.
function writePortableMarker(appVersion = null) {
  if (!_root) return null;
  const { dataDir } = require('./conn');
  const file = path.join(_root, MARKER);
  let old = {};
  try { old = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) {}
  const marker = {
    format: 'dracondex-portable', version: 1,
    driveUid: typeof old.driveUid === 'string' && old.driveUid ? old.driveUid : crypto.randomUUID(),
    dataDir: path.relative(_root, dataDir()).split(path.sep).join('/'),
    appVersion,
  };
  const text = JSON.stringify(marker, null, 1);
  try { if (fs.readFileSync(file, 'utf8') === text) return marker; } catch (_) {}
  try { fs.writeFileSync(file, text); } catch (_) { return null; } // read-only drive: still runs
  return marker;
}

module.exports = { MARKER, setPortableRoot, portableRoot, rebase, rebasePortable, writePortableMarker };
