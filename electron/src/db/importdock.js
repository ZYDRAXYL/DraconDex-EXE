'use strict';
// Import Dock (progress.md Phase 18) — imported files and their links to
// nest entities. Files stay on disk at their source path; only metadata
// lives here.
const { getDB } = require('./core');

const getImportFiles = (nexusId) => getDB().prepare(`
  SELECT * FROM import_file WHERE nexus_ref=? ORDER BY folder, file_name COLLATE NOCASE
`).all(nexusId);

const getImportFile = (id) => getDB().prepare(`SELECT * FROM import_file WHERE id=?`).get(id);

function addImportFiles(nexusId, files) {
  const d = getDB();
  const ins = d.prepare(`
    INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, folder)
    VALUES (?,?,?,?,?,?)
  `);
  const seen = d.prepare(`SELECT id FROM import_file WHERE nexus_ref=? AND file_path=?`);
  // One transaction for the whole batch — importing a folder is hundreds of
  // rows, and unwrapped each dedupe probe + insert paid its own file-lock cycle.
  // (The dedupe probe is now index-backed too: idx_import_file_nexus covers
  // exactly this nexus_ref + file_path lookup.)
  return d.transaction(() => {
    let added = 0;
    for (const f of files || []) {
      if (seen.get(nexusId, f.path)) continue;
      ins.run(nexusId, f.name, f.path, f.type || null, f.size || 0, f.folder || null);
      added++;
    }
    return added;
  })();
}

const setImportLinker = (id, linkerKey) => getDB().prepare(`
  UPDATE import_file SET linker_key=?, use_as_image=CASE WHEN ? IS NULL THEN 0 ELSE use_as_image END WHERE id=?
`).run(linkerKey || null, linkerKey || null, id);

function setImportUseAsImage(id, on) {
  const d = getDB();
  const f = d.prepare(`SELECT linker_key FROM import_file WHERE id=?`).get(id);
  if (!f) return;
  if (on && f.linker_key) {
    d.prepare(`UPDATE import_file SET use_as_image=0 WHERE linker_key=? AND id<>?`).run(f.linker_key, id);
  }
  d.prepare(`UPDATE import_file SET use_as_image=? WHERE id=?`).run(on ? 1 : 0, id);
}

const deleteImportFile = (id) => getDB().prepare(`DELETE FROM import_file WHERE id=?`).run(id);

// linker_key -> import_file id for every display image in the vault — one
// batched call per render for the card/grid thumbnails.
const getDisplayImages = (nexusId) => getDB().prepare(`
  SELECT id, linker_key, file_path FROM import_file
  WHERE nexus_ref=? AND use_as_image=1 AND linker_key IS NOT NULL
`).all(nexusId);

module.exports = {
  getImportFiles, getImportFile, addImportFiles,
  setImportLinker, setImportUseAsImage, deleteImportFile, getDisplayImages,
};
