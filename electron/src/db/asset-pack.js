'use strict';
// ═══ .dxpack import (APP docs/ASSET-PACK.md) ═══════════════════════════════
// A .dxpack is what the APK / PWA hands the desktop when the user has sorted
// modules and files into folders on the phone: one zip holding
//
//   pack.json      the manifest — every asset with the module it is filed in
//   snapshot.json  the same v2 snapshot a .mddx / DDX Transfer carries
//   Assets/…       the files themselves, laid out by the collector tree
//
// The layout under Assets/ is for people (open the zip, see the folders);
// the manifest is the truth. Like a Unity .meta GUID, an asset is filed by
// the moduleId the manifest names, never by the folder it happens to sit in,
// so a name that sanitised differently on the phone cannot misfile it.
//
// The import is the tree first, then the files: the snapshot goes in through
// importModuleSnapshot (additive — the same path a .mddx takes), which hands
// back old -> new module ids; each file is then written into ITS collector's
// folder under destRoot, at exactly the path db/mirror.js's planMirror gives
// that collector, and registered as an import_file row filed into the new
// module. destRoot is the Nexus's Locate folder (main.js sets it before
// calling), so the closing syncNexusMirror only adds the .mddx files and
// every asset is already where the next Locate sync expects it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openZip } = require('./zip');
const { getVaultDB } = require('./core');
const { importModuleSnapshot } = require('./sync');
const { planMirror, dirNameOf, syncNexusMirror } = require('./mirror');
const { ASSET_CLASS } = require('./asset-media');

const PACK_FORMAT = 'dracondex-asset-pack';
const PACK_VERSIONS = new Set([1]);
const QUALITIES = new Set(['full', 'proxy', 'none']);

function validatePack(p) {
  return !!p && typeof p === 'object' && p.format === PACK_FORMAT && PACK_VERSIONS.has(p.version)
    && Array.isArray(p.assets);
}

// A file name from the pack, made safe for this disk. dirNameOf is the one
// sanitiser the mirror uses for folder names; a file name follows the same
// rules (it only differs in keeping its extension, which dirNameOf does).
const fileNameOf = (name) => dirNameOf(path.basename(String(name || '').replace(/\\/g, '/')));

// A free path for `name` inside `dir`: the name itself, or `name (2).ext`, … —
// unless a file with the same bytes is already there, in which case that one
// is reused (importing the same pack twice must not double every file).
function freePath(dir, name, bytes) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const p = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!fs.existsSync(p)) return { path: p, reused: false };
    try { if (bytes && fs.readFileSync(p).equals(bytes)) return { path: p, reused: true }; } catch (_) {}
  }
  return { path: path.join(dir, `${stem}-${Date.now()}${ext}`), reused: false };
}

// Import a .dxpack into nexusId, with the pack's root module(s) placed under
// parentModuleId (null = top level). destRoot: the folder the files go into
// (the Nexus's Locate folder). Returns { ok, summary } or { ok:false, code }.
function importAssetPack(nexusId, zipPath, { parentModuleId = null, destRoot } = {}) {
  if (!destRoot || !fs.existsSync(destRoot)) return { ok: false, code: 'no_dir' };
  const zip = openZip(zipPath);
  if (!zip.ok) return zip;
  try {
    let pack, snapshot;
    try {
      pack = JSON.parse(zip.read('pack.json')?.toString('utf8') || 'null');
      snapshot = JSON.parse(zip.read('snapshot.json')?.toString('utf8') || 'null');
    } catch (_) { return { ok: false, code: 'bad_pack' }; }
    if (!validatePack(pack) || !snapshot) return { ok: false, code: 'bad_pack' };

    const applied = importModuleSnapshot(nexusId, parentModuleId, snapshot, { withModMap: true });
    if (!applied?.ok) return applied || { ok: false, code: 'bad_snapshot' };
    const modMap = applied.modMap;

    // Where every collector of this Nexus lives under destRoot — the same
    // plan the mirror writes, so the two can never disagree about a folder.
    const db = getVaultDB(nexusId);
    const mods = db.prepare(`SELECT id, parent_id, name, kind, display_order FROM module WHERE nexus_ref=?`).all(nexusId);
    const byId = new Map(mods.map((m) => [m.id, m]));
    const dirOf = new Map(planMirror(mods).dirs.map((d) => [d.id, d.rel]));
    // An asset filed in a non-collector sits in its nearest collector's
    // folder (a module is a .mddx file, not a folder), but stays filed in
    // the module itself.
    const folderOf = (moduleId) => {
      for (let m = byId.get(moduleId); m; m = byId.get(m.parent_id)) {
        if (dirOf.has(m.id)) return dirOf.get(m.id);
      }
      return '';
    };

    const seen = db.prepare(`SELECT id, module_ref FROM import_file WHERE nexus_ref=? AND file_path=?`);
    const refile = db.prepare(`UPDATE import_file SET module_ref=? WHERE id=?`);
    const ins = db.prepare(`
      INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, folder, module_ref, sha256, missing)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const s = { collectors: 0, files: 0, proxyOnly: 0, missing: 0, badHash: 0, skipped: 0, reused: 0, unsafe: zip.unsafe };
    s.collectors = [...modMap.values()].filter((id) => byId.get(id)?.kind === 'collector').length;

    db.transaction(() => {
      for (const a of pack.assets) {
        const name = fileNameOf(a?.name);
        const type = path.extname(name).slice(1).toLowerCase();
        // file_type is derived from the name here, never taken from the
        // pack — it decides which reader later serves the bytes.
        if (!ASSET_CLASS[type]) { s.skipped++; continue; }
        const quality = QUALITIES.has(a.quality) ? a.quality : 'none';
        const moduleRef = a.moduleId != null && modMap.has(a.moduleId) ? modMap.get(a.moduleId) : (parentModuleId ?? null);
        const rel = moduleRef != null ? folderOf(moduleRef) : '';
        const dir = rel ? path.join(destRoot, ...rel.split('/')) : destRoot;

        let bytes = null;
        if (quality !== 'none' && a.zip) {
          try { bytes = zip.read(String(a.zip)); } catch (_) { bytes = null; }
        }
        let filePath, sha = null, missing = 0, size = Number(a.size) || 0;
        if (bytes) {
          sha = crypto.createHash('sha256').update(bytes).digest('hex');
          if (quality === 'full' && a.sha256 && a.sha256 !== sha) s.badHash++;
          fs.mkdirSync(dir, { recursive: true });
          const free = freePath(dir, name, bytes);
          if (free.reused) s.reused++;
          else fs.writeFileSync(free.path, bytes);
          filePath = free.path;
          size = bytes.length;
          if (quality === 'proxy') s.proxyOnly++;
        } else {
          // Nothing came with it (the PWA could not read the original):
          // register it where it belongs, marked missing, so Relink finds it.
          filePath = path.join(dir, name);
          missing = 1;
          sha = a.sha256 || null;
          s.missing++;
        }
        const hit = seen.get(nexusId, filePath);
        if (hit) {
          if (hit.module_ref == null && moduleRef != null) refile.run(moduleRef, hit.id);
          continue;
        }
        ins.run(nexusId, name, filePath, type, size, rel || null, moduleRef, sha, missing);
        s.files++;
      }
    })();

    const mirror = syncNexusMirror(nexusId);
    return { ok: true, summary: { ...applied.summary, ...s }, mirror: mirror.ok ? { dirs: mirror.dirs, files: mirror.files } : null };
  } finally {
    zip.close();
  }
}

module.exports = { importAssetPack, validatePack, PACK_FORMAT };
