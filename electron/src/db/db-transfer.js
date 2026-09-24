'use strict';
// Setting window → Appdata → Database (Plan.md part1 #Setting): per-nexus
// and per-module export/import, reusing the snapshot format and
// serialize/apply functions Token Sync already built (src/db/sync.js) —
// this file only adds file I/O and module-subtree scoping on top. The file
// picker dialog itself lives in main.js (same split as db:exportFile/
// db:importMergeFile in the whole-database import/export flow this mirrors).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getNexuses, exportNexusVaultFile } = require('./nexus');
const { getVaultDB } = require('./conn');
const { ASSET_CLASS } = require('./asset-media');
const { writeZip } = require('./zip');
const {
  serializeVault, applySnapshot, collectModuleSubtreeIds, importModuleSnapshot,
} = require('./sync');

function exportNexusFile(nexusId, filePath) {
  const snapshot = serializeVault(nexusId);
  if (!snapshot) return { ok: false, code: 'not_found' };
  fs.writeFileSync(filePath, JSON.stringify(snapshot));
  return { ok: true };
}

function importNexusFile(nexusId, filePath) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { return { ok: false, code: 'bad_file', error: String(e?.message || e) }; }
  return applySnapshot(nexusId, payload);
}

function exportModuleFile(nexusId, moduleId, filePath) {
  const moduleIds = collectModuleSubtreeIds(nexusId, moduleId);
  if (!moduleIds.length) return { ok: false, code: 'not_found' };
  const snapshot = serializeVault(nexusId, moduleIds);
  if (!snapshot) return { ok: false, code: 'not_found' };
  fs.writeFileSync(filePath, JSON.stringify(snapshot));
  return { ok: true };
}

function importModuleFile(nexusId, parentModuleId, filePath) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch (e) { return { ok: false, code: 'bad_file', error: String(e?.message || e) }; }
  return importModuleSnapshot(nexusId, parentModuleId, payload);
}

// ── Nexus as .zip (v5 Part 4, APP docs/V5.md §8.7) ──────────────────────
// A .ddx carries the data but its media only as paths on this machine —
// the receiving end has to relink (§2.5). The .zip is "take all of it": the
// .ddx plus the real image / video / sound / document files, one folder per
// class (img, vdo, sound, doc). media/manifest.json maps every asset row to
// its file in the archive with its sha256, which is exactly what Relink
// missing from folder… matches on after the zip is extracted.
const ZIP_CLASS_DIR = { image: 'img', video: 'vdo', audio: 'sound', doc: 'doc' };

function exportNexusZip(nexusId, zipPath) {
  const tmp = path.join(os.tmpdir(), `ddx-export-${process.pid}-${Date.now()}.ddx`);
  const vault = exportNexusVaultFile(nexusId, tmp);
  if (!vault.ok) return vault;
  try {
    const nx = getVaultDB(nexusId).prepare(`SELECT name FROM nexus WHERE id=?`).get(nexusId);
    const safe = String(nx?.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
    const rows = getVaultDB(nexusId).prepare(`
      SELECT id, file_name, file_path, file_type, sha256 FROM import_file
      WHERE nexus_ref=? AND source_kind='file' ORDER BY id`).all(nexusId);
    const used = new Set();
    const media = [];
    let skipped = 0;
    for (const r of rows) {
      if (!r.file_path || !fs.existsSync(r.file_path)) { skipped++; continue; }
      const dir = ZIP_CLASS_DIR[ASSET_CLASS[String(r.file_type || '').toLowerCase()]] || 'other';
      let name = String(r.file_name || path.basename(r.file_path)).replace(/[\\/:*?"<>|]/g, '_');
      if (used.has(`${dir}/${name}`.toLowerCase())) name = `${r.id}-${name}`;
      used.add(`${dir}/${name}`.toLowerCase());
      media.push({ id: r.id, sha256: r.sha256 || null, original: r.file_path, name: `media/${dir}/${name}` });
    }
    const manifestPath = `${tmp}.json`;
    fs.writeFileSync(manifestPath, JSON.stringify({
      note: 'Extract, open the .ddx, then use Relink missing from folder… on the media folder.',
      files: media.map(({ id, sha256, original, name }) => ({ id, sha256, original, zip: name })),
    }, null, 1));
    const out = writeZip(zipPath, [
      { name: `${safe}.ddx`, path: tmp, deflate: true },
      { name: 'media/manifest.json', path: manifestPath, deflate: true },
      ...media.map((m) => ({ name: m.name, path: m.original })),
    ]);
    fs.rmSync(manifestPath, { force: true });
    if (!out.ok) { fs.rmSync(zipPath, { force: true }); return out; }
    return { ok: true, filePath: zipPath, media: media.length, skipped };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { exportNexusFile, importNexusFile, exportModuleFile, importModuleFile, exportNexusZip };
