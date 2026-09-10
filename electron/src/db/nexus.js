'use strict';
// Nexus = vault. The renderer-facing module; app.ddx's `nexus_file` index that
// backs it lives in ./vaults.js.
//
// v4.9.0 split the read and the write halves apart:
//   - the LIST comes from the registry in app.ddx, so the Welcome window draws
//     it without opening any vault file (see vaults.js for why),
//   - name/memo/colour are written to BOTH the registry and the vault's own
//     single `nexus` row, so a vault file carried to another machine is
//     self-describing rather than an anonymous blob.
// Row shape is unchanged from before the split — {id, name, memo, color,
// color_code, update_at, project_count} — plus file_path and missing, so
// core/welcome.js and core/nexus.js keep their existing field names.
const fs = require('fs');
const { getAppDB, getVaultDB, createVaultDB, closeVault } = require('./core');
const { currentNexusId } = require('./vault-context');
const {
  NEXUS_PROJECT_TABLES, listVaults, getVault, insertVault, insertVaultWithId,
  updateVaultMeta, removeVault, refreshVaultCounts, countVaultItems,
  vaultDefaultPath, vaultsDir, setVaultPath, vaultPathInUse, refreshOpenVaultCounts,
  touchVaultOpened,
} = require('./vaults');
const { openVaultProbe } = require('./conn');

// Vault names used to be unique because of `nexus.name UNIQUE` inside the one
// shared database. Each vault file now holds a single nexus row, so that
// constraint no longer says anything across vaults — the registry enforces it
// instead. Thrown rather than returned because the renderer's
// createNexusSubmit/saveNexus already turn any throw into the nexusNameTaken
// toast.
// A colour id chosen in the Welcome window is an app.ddx palette id; a colour
// id chosen inside a vault is that vault's. They agree for the sixteen seeded
// colours (same fixed ordered seed on both sides) but not for a custom one, so
// the id is never carried across a file boundary — the CODE is, and this
// resolves it to an id that is valid inside the target vault.
function vaultColorId(vaultDb, colorCode) {
  if (!colorCode) return null;
  vaultDb.prepare(`INSERT OR IGNORE INTO use_color (color_code) VALUES (?)`).run(colorCode);
  return vaultDb.prepare(`SELECT id FROM use_color WHERE color_code=?`).get(colorCode)?.id ?? null;
}

// Resolves whichever palette the caller was looking at into a colour code.
function colorCodeOf(colorId) {
  if (!colorId) return null;
  const db = currentNexusId() ? getVaultDB(currentNexusId()) : getAppDB();
  return db.prepare(`SELECT color_code FROM use_color WHERE id=?`).get(colorId)?.color_code ?? null;
}

function assertNameFree(name, exceptId = null) {
  const clash = getAppDB()
    .prepare(`SELECT id FROM nexus_file WHERE name=? COLLATE NOCASE AND id IS NOT ?`)
    .get(name, exceptId);
  if (clash) throw new Error('nexus name already in use');
}

// One-time seed of the registry from a pre-split database, where the `nexus`
// table and app.ddx are still the same file. file_path stays NULL — "this
// vault has no file of its own yet"; the split migration fills it in.
//
// Runs from getNexuses() rather than the init path because it needs to read a
// VAULT table (`nexus`) while writing an APP table, which only makes sense
// while the two are the same database. Post-split the registry is already
// populated by the split migration and this finds nothing to do.
function backfillVaultRegistry() {
  const app = getAppDB();
  if (app.prepare(`SELECT id FROM nexus_file LIMIT 1`).get()) return;
  let rows;
  try {
    rows = app.prepare(`
      SELECT n.id, n.name, n.memo, c.color_code
      FROM nexus n LEFT JOIN use_color c ON c.id = n.color
      ORDER BY n.id
    `).all();
  } catch (_) {
    return; // no `nexus` table here — already split, nothing to backfill from
  }
  if (!rows.length) return;
  app.transaction(() => {
    for (const r of rows) {
      insertVaultWithId({ id: r.id, name: r.name, memo: r.memo, colorCode: r.color_code, filePath: null });
      const count = countVaultItems(app, r.id);
      app.prepare(`UPDATE nexus_file SET project_count=?, counts_at=datetime('now') WHERE id=?`).run(count, r.id);
    }
  })();
}

const getNexuses = () => {
  backfillVaultRegistry();
  refreshOpenVaultCounts();
  return listVaults().map((v) => ({
    id: v.id,
    name: v.name,
    memo: v.memo,
    color: null,               // the id is meaningless across files; color_code is the value
    color_code: v.color_code,
    update_at: v.update_at,
    project_count: v.project_count,
    file_path: v.file_path,
    missing: v.missing,
  }));
};

// Reads the registry, then refreshes name/memo from the vault's own row when
// that vault happens to be open — the file is the source of truth for a vault
// that was edited on another machine and copied back.
const getNexus = (id) => {
  const v = getVault(id);
  if (!v) return undefined;
  const out = {
    id: v.id, name: v.name, memo: v.memo, color: null, color_code: v.color_code,
    update_at: v.update_at, project_count: v.project_count,
    file_path: v.file_path, missing: v.missing,
  };
  try {
    const inFile = getVaultDB(id).prepare(`
      SELECT n.name, n.memo, c.color_code FROM nexus n LEFT JOIN use_color c ON c.id = n.color WHERE n.id=?
    `).get(id);
    if (inFile) Object.assign(out, { name: inFile.name, memo: inFile.memo, color_code: inFile.color_code });
  } catch (_) { /* file missing — registry values stand */ }
  return out;
};

// Writes the vault's own `nexus` row first (it is the data), then the registry
// row (it is the index). The id is allocated from the registry up front so
// both sides carry the same one.
// `filePath` is where the user chose to keep this vault; omitted means the
// default under <dataDir>/vaults/. The id comes from the registry first
// (AUTOINCREMENT) because the filename embeds it and the vault's own `nexus`
// row must carry the same value.
const createNexus = (name, memo, colorId, filePath = null) => {
  assertNameFree(name);
  const colorCode = colorCodeOf(colorId);

  const id = insertVault({ name, memo: memo || null, colorCode, filePath: null });
  const target = filePath || vaultDefaultPath(name, id);
  if (vaultPathInUse(target, id)) { removeVault(id); throw new Error('vault file already registered'); }

  try {
    const vault = createVaultDB(id, target);
    vault.prepare(`INSERT INTO nexus (id, name, memo, color) VALUES (?,?,?,?)`)
      .run(id, name, memo || null, vaultColorId(vault, colorCode));
    setVaultPath(id, target);
  } catch (e) {
    // Leave nothing half-made: drop the connection, the file we just created,
    // and the registry row, so the failure looks like it never happened.
    closeVault(id);
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    removeVault(id);
    throw e;
  }
  return id;
};

const updateNexus = (id, name, memo, colorId) => {
  assertNameFree(name, id);
  const colorCode = colorCodeOf(colorId);
  const vault = getVaultDB(id);
  vault.prepare(`UPDATE nexus SET name=?, memo=?, color=?, update_at=datetime('now') WHERE id=?`)
    .run(name, memo || null, vaultColorId(vault, colorCode), id);
  updateVaultMeta(id, { name, memo: memo || null, colorCode });
};

// Refuses to delete a vault that still owns projects in any module; the
// renderer surfaces {blocked,count} as a toast instead of cascading data loss.
// The count comes from the vault file when it can be opened and from the
// cached registry value when it can't — a vault whose file is unreachable must
// not be deletable "because it looked empty".
const deleteNexus = (id) => {
  let count;
  try {
    count = countVaultItems(getVaultDB(id), id);
  } catch (_) {
    count = getVault(id)?.project_count ?? 0;
  }
  if (count > 0) return { blocked: true, count };
  // The file is the vault. Close the handle first (Windows will not unlink an
  // open file), then delete it, then the registry row. The path is returned so
  // the renderer can say what was removed from disk.
  const filePath = getVault(id)?.file_path || null;
  closeVault(id);
  if (filePath) { try { fs.rmSync(filePath, { force: true }); } catch (_) {} }
  removeVault(id);
  return { blocked: false, count: 0, filePath };
};

// Points a registry row at a vault file the user located by hand, after the
// old path stopped resolving. Validated before it is accepted: an arbitrary
// .ddx must not be adoptable as a vault, and a file already registered to a
// different Nexus must not be registered twice.
function relinkNexusFile(id, filePath) {
  if (!getVault(id)) return { ok: false, code: 'not_found' };
  if (!fs.existsSync(filePath)) return { ok: false, code: 'file_missing' };
  if (vaultPathInUse(filePath, id)) return { ok: false, code: 'already_registered' };

  // Shape check: a vault file has the vault schema and exactly one nexus row.
  let probe;
  try { probe = openVaultProbe(filePath); }
  catch (e) { return { ok: false, code: 'not_a_vault' }; }
  try {
    const rows = probe.prepare(`SELECT id, name FROM nexus`).all();
    if (rows.length !== 1) return { ok: false, code: 'not_a_vault' };
    closeVault(id);
    setVaultPath(id, filePath);
    // The file is the source of truth for its own name once it is relinked —
    // it may have been renamed on the machine it came from.
    updateVaultMeta(id, { name: rows[0].name, memo: getVault(id)?.memo ?? null, colorCode: getVault(id)?.color_code ?? null });
    return { ok: true, filePath, name: rows[0].name };
  } catch (e) {
    return { ok: false, code: 'not_a_vault' };
  } finally {
    try { probe.close(); } catch (_) {}
  }
}

// Copies a vault file and registers the copy as a new Nexus. The copy's own
// `nexus` row is renumbered to the new registry id, because that id/row match
// is the invariant every vault-scoped query relies on — two files carrying the
// same nexus id would each look correct alone and collide in the registry.
// Only six tables reference nexus(id) directly, so the renumber is a short
// list rather than a graph walk.
const NEXUS_REF_TABLES = ['note_folder', 'note', 'wiki_link', 'module', 'import_file', 'entity_relation', 'calendar_template'];

function duplicateNexus(id) {
  const src = getVault(id);
  if (!src || !src.file_path) return { ok: false, code: 'not_found' };
  if (!fs.existsSync(src.file_path)) return { ok: false, code: 'file_missing' };

  // "<name> (copy)", then "(copy 2)", … — the registry enforces unique names.
  let name = `${src.name} (copy)`;
  for (let i = 2; ; i++) {
    try { assertNameFree(name); break; }
    catch (_) { name = `${src.name} (copy ${i})`; }
    if (i > 50) return { ok: false, code: 'name_taken' };
  }

  const newId = insertVault({ name, memo: src.memo, colorCode: src.color_code, filePath: null });
  const target = vaultDefaultPath(name, newId);
  try {
    fs.mkdirSync(require('path').dirname(target), { recursive: true });
    // VACUUM INTO on the live source rather than copyFileSync: the source may
    // be open and mid-transaction, and a torn copy would be a corrupt vault.
    getVaultDB(id).prepare(`VACUUM INTO ?`).run(target);

    const copy = createVaultDB(newId, target);
    copy.transaction(() => {
      copy.exec('PRAGMA defer_foreign_keys = ON');
      copy.prepare(`UPDATE nexus SET id=?, name=? WHERE id=?`).run(newId, name, id);
      for (const t of NEXUS_REF_TABLES) {
        try { copy.prepare(`UPDATE ${t} SET nexus_ref=? WHERE nexus_ref=?`).run(newId, id); } catch (_) {}
      }
      for (const t of NEXUS_PROJECT_TABLES) {
        try { copy.prepare(`UPDATE ${t} SET nexus_ref=? WHERE nexus_ref=?`).run(newId, id); } catch (_) {}
      }
    })();
    setVaultPath(newId, target);
    refreshVaultCounts(newId);
    return { ok: true, id: newId, name, filePath: target };
  } catch (e) {
    closeVault(newId);
    try { fs.rmSync(target, { force: true }); } catch (_) {}
    removeVault(newId);
    return { ok: false, code: 'copy_failed', error: String(e?.message || e) };
  }
}

// Writes a standalone copy of a vault wherever the caller says. Used by both
// Export (the user picks the path) and Share (a staging copy to hand over).
function exportNexusVaultFile(id, targetPath) {
  const v = getVault(id);
  if (!v || !v.file_path) return { ok: false, code: 'not_found' };
  if (!fs.existsSync(v.file_path)) return { ok: false, code: 'file_missing' };
  try {
    fs.rmSync(targetPath, { force: true });
    getVaultDB(id).prepare(`VACUUM INTO ?`).run(targetPath);
    return { ok: true, filePath: targetPath };
  } catch (e) {
    return { ok: false, code: 'copy_failed', error: String(e?.message || e) };
  }
}

module.exports = {
  getNexuses, getNexus, createNexus, updateNexus, deleteNexus, relinkNexusFile,
  duplicateNexus, exportNexusVaultFile,
  vaultDefaultPath, vaultsDir, refreshVaultCounts, NEXUS_PROJECT_TABLES,
  touchVaultOpened, listVaults,
};
