'use strict';
// Setting window → Appdata → Database (Plan.md part1 #Setting): per-nexus
// and per-module export/import, reusing the snapshot format and
// serialize/apply functions Token Sync already built (src/db/sync.js) —
// this file only adds file I/O and module-subtree scoping on top. The file
// picker dialog itself lives in main.js (same split as db:exportFile/
// db:importMergeFile in the whole-database import/export flow this mirrors).
const fs = require('fs');
const { getNexuses } = require('./nexus');
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

module.exports = { exportNexusFile, importNexusFile, exportModuleFile, importModuleFile };
