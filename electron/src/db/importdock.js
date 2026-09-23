'use strict';
// Import Dock (progress.md Phase 18) — imported files and their links to
// nest entities. Files stay on disk at their source path; only metadata
// lives here.
//
// v5 Asset Nest (APP docs/V5.md §2): the module tree IS the asset tree.
// import_file.module_ref files an asset into a module node; NULL = unfiled,
// and the Import Dock is now just the tray for those. folder stays as
// provenance only.
const { getDB } = require('./core');
const { collectorNameOfDir } = require('./mirror');
const { PROXY_VAULT_BUDGET } = require('./asset-media');

// Every column except the proxy BLOB — a folder of images would otherwise
// ship megabytes of thumbnails across IPC on every list. has_proxy tells the
// renderer whether ddx-file://…?proxy=1 will answer.
const LIST_COLS = `id, nexus_ref, file_name, file_path, file_type, file_size, folder,
  linker_key, use_as_image, create_at, module_ref, source_kind, sha256, proxy_type,
  missing, last_seen_at, (proxy IS NOT NULL) AS has_proxy`;

const getImportFiles = (nexusId) => getDB().prepare(`
  SELECT ${LIST_COLS} FROM import_file WHERE nexus_ref=? ORDER BY folder, file_name COLLATE NOCASE
`).all(nexusId);

const getImportFile = (id) => getDB().prepare(`SELECT ${LIST_COLS} FROM import_file WHERE id=?`).get(id);

// Assets filed directly under one module node, for that module's Assets strip.
const getModuleAssets = (moduleId) => getDB().prepare(`
  SELECT ${LIST_COLS} FROM import_file WHERE module_ref=? ORDER BY file_name COLLATE NOCASE
`).all(moduleId);

// module_ref -> asset leaves, one query for the whole Nest tree (the same
// shape getNestItems returns for content items).
function getNestAssets(nexusId) {
  const out = {};
  for (const r of getDB().prepare(`
    SELECT id, module_ref, file_name, file_type, source_kind, missing FROM import_file
    WHERE nexus_ref=? AND module_ref IS NOT NULL ORDER BY module_ref, file_name COLLATE NOCASE
  `).all(nexusId)) {
    const { module_ref, ...a } = r;
    (out[module_ref] || (out[module_ref] = [])).push(a);
  }
  return out;
}

// module_ref must name a module of the same nexus, or be null. Anything else
// (a stale id from a deleted module, another vault's id) files to the tray.
function _ownModule(d, nexusId, moduleRef) {
  if (moduleRef == null) return null;
  const m = d.prepare(`SELECT id FROM module WHERE id=? AND nexus_ref=?`).get(Number(moduleRef), nexusId);
  return m ? m.id : null;
}

// files: [{ name, path, type, size, folder, module_ref? }]. A file already
// registered (same path) is not duplicated — but if it is still unfiled and
// this import names a module for it, it is filed there, so re-importing a
// folder the old flat way and then again as a tree converges instead of
// leaving the tray full.
function _addFiles(d, nexusId, files, defaultModuleRef) {
  const ins = d.prepare(`
    INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, folder, module_ref)
    VALUES (?,?,?,?,?,?,?)
  `);
  const seen = d.prepare(`SELECT id, module_ref FROM import_file WHERE nexus_ref=? AND file_path=?`);
  const file = d.prepare(`UPDATE import_file SET module_ref=? WHERE id=?`);
  let added = 0;
  let filed = 0;
  for (const f of files || []) {
    const mref = f.module_ref !== undefined ? f.module_ref : defaultModuleRef;
    const hit = seen.get(nexusId, f.path);
    if (hit) {
      if (hit.module_ref == null && mref != null) { file.run(mref, hit.id); filed++; }
      continue;
    }
    ins.run(nexusId, f.name, f.path, f.type || null, f.size || 0, f.folder || null, mref ?? null);
    added++;
  }
  return { added, filed };
}

function addImportFiles(nexusId, files, moduleRef = null) {
  const d = getDB();
  // One transaction for the whole batch — importing a folder is hundreds of
  // rows, and unwrapped each dedupe probe + insert paid its own file-lock cycle.
  // (The dedupe probe is index-backed: idx_import_file_nexus covers exactly
  // this nexus_ref + file_path lookup.)
  return d.transaction(() => _addFiles(d, nexusId, files, _ownModule(d, nexusId, moduleRef)).added)();
}

// Folder import = "locate folder asset" (§2.3): mirror the directory tree as
// collector modules under parentId (null = top level) and file each asset
// into its own folder's collector. dirs: every directory as a path array
// relative to the picked root's PARENT, i.e. [rootName], [rootName, 'sub'], …;
// files carry the same `dir` array. Find-or-create by (parent, name,
// 'collector') — the migrate_v3 mkModule pattern — so importing the same
// folder twice reuses the tree instead of growing a second copy. Written as
// the one disk-dir -> collector mechanism Part 4 (d)(e) runs the other way
// (§8.11.4); do not grow a second one.
function importFolderTree(nexusId, parentId, dirs, files) {
  const d = getDB();
  const module_ = require('./module');
  return d.transaction(() => {
    const root = _ownModule(d, nexusId, parentId);
    const find = d.prepare(`SELECT id FROM module WHERE nexus_ref=? AND parent_id IS ? AND kind='collector' AND name=?`);
    const idOf = new Map();
    let collectors = 0;
    const ensure = (segs) => {
      const key = segs.join('/');
      if (idOf.has(key)) return idOf.get(key);
      const parent = segs.length > 1 ? ensure(segs.slice(0, -1)) : root;
      // The folder's name IS the collector's name — the same pair db/mirror.js
      // uses the other way round, so import and mirror meet (§8.11.4).
      const name = collectorNameOfDir(segs[segs.length - 1]);
      let id = find.get(nexusId, parent, name)?.id;
      if (!id) {
        // Only the top folder is a user-visible "create" in nexus history;
        // its subfolders are part of the same act.
        id = module_.createModule({ nexus_ref: nexusId, parent_id: parent, name, kind: 'collector' },
          { logHistory: segs.length === 1 });
        collectors++;
      }
      idOf.set(key, id);
      return id;
    };
    for (const segs of dirs || []) if (segs?.length) ensure(segs);
    const withRefs = (files || []).map((f) => ({ ...f, module_ref: f.dir?.length ? ensure(f.dir) : root }));
    const { added, filed } = _addFiles(d, nexusId, withRefs, root);
    return { collectors, added, filed, rootModule: idOf.get((dirs?.[0] || []).join('/')) ?? null };
  })();
}

// URL asset (§2.2): the URL lives in file_path, file_type='url', size 0.
// The caller (main.js) has already normalized it to http(s).
function addImportUrl(nexusId, url, name, moduleRef = null) {
  const d = getDB();
  const hit = d.prepare(`SELECT id FROM import_file WHERE nexus_ref=? AND file_path=?`).get(nexusId, url);
  if (hit) return hit.id;
  return d.prepare(`
    INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, source_kind, module_ref)
    VALUES (?,?,?,'url',0,'url',?)
  `).run(nexusId, String(name || url).slice(0, 200), url, _ownModule(d, nexusId, moduleRef)).lastInsertRowid;
}

// Move an asset between nodes (or back to the tray with null) — the one
// statement §2.3 promises a drag in the Nest costs.
function setImportModule(id, moduleRef) {
  const d = getDB();
  const f = d.prepare(`SELECT nexus_ref FROM import_file WHERE id=?`).get(id);
  if (!f) return;
  d.prepare(`UPDATE import_file SET module_ref=? WHERE id=?`).run(_ownModule(d, f.nexus_ref, moduleRef), id);
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
  SELECT id, linker_key, file_path, missing FROM import_file
  WHERE nexus_ref=? AND use_as_image=1 AND linker_key IS NOT NULL
`).all(nexusId);

// ── Sweep / proxy / relink (§2.5) ──────────────────────────────────────────
// The sweep itself (stat, hash, thumbnail) is async fs work and lives in
// main.js; these are its synchronous bookkeeping statements.
const getSweepRows = (nexusId) => getDB().prepare(`
  SELECT id, file_path, file_type, file_size, sha256, missing, last_seen_at, (proxy IS NULL) AS needs_proxy
  FROM import_file WHERE nexus_ref=? AND source_kind='file' ORDER BY id
`).all(nexusId);

function markImportSeen(id, present) {
  const d = getDB();
  if (present) {
    d.prepare(`UPDATE import_file SET missing=0, last_seen_at=datetime('now') WHERE id=?`).run(id);
  } else {
    d.prepare(`UPDATE import_file SET missing=1 WHERE id=?`).run(id);
  }
}

const setImportHash = (id, sha256, size) => getDB().prepare(`
  UPDATE import_file SET sha256=?, file_size=COALESCE(?, file_size) WHERE id=?
`).run(sha256, size ?? null, id);

// Stores a proxy only while the vault stays under its thumbnail budget
// (§5.1 — the wasm driver holds the whole vault in memory). Returns whether
// it was stored.
function setImportProxy(id, buf, type) {
  const d = getDB();
  const f = d.prepare(`SELECT nexus_ref FROM import_file WHERE id=?`).get(id);
  if (!f) return false;
  const used = d.prepare(`SELECT COALESCE(SUM(LENGTH(proxy)),0) AS n FROM import_file WHERE nexus_ref=?`).get(f.nexus_ref).n;
  if (used + buf.length > PROXY_VAULT_BUDGET) return false;
  d.prepare(`UPDATE import_file SET proxy=?, proxy_type=? WHERE id=?`).run(buf, type, id);
  return true;
}

const getImportProxy = (id) => getDB().prepare(`SELECT proxy, proxy_type FROM import_file WHERE id=?`).get(id);

const getMissingImports = (nexusId) => getDB().prepare(`
  SELECT id, file_name, file_path, file_type, sha256 FROM import_file
  WHERE nexus_ref=? AND source_kind='file' AND missing=1
`).all(nexusId);

// Point a row at a new path on disk. The file_type is kept — a relink is
// "this is where that same file went", not a new import.
const relinkImportFile = (id, newPath, size) => getDB().prepare(`
  UPDATE import_file SET file_path=?, file_size=?, missing=0, last_seen_at=datetime('now') WHERE id=?
`).run(newPath, size || 0, id);

module.exports = {
  getImportFiles, getImportFile, addImportFiles, importFolderTree, addImportUrl,
  getModuleAssets, getNestAssets, setImportModule,
  setImportLinker, setImportUseAsImage, deleteImportFile, getDisplayImages,
  getSweepRows, markImportSeen, setImportHash, setImportProxy, getImportProxy,
  getMissingImports, relinkImportFile,
};
