'use strict';
// ═══ The vault index (v4.9.0) ══════════════════════════════════════════════
// app.ddx's `nexus_file` table: one row per Nexus, holding what the Welcome
// window needs to draw the vault list with no vault file open. src/db/nexus.js
// is the module the renderer talks to; this file is the storage underneath it.
//
// The invariant that makes the whole per-vault-file design cheap:
//   nexus_file.id  ==  the id of the single `nexus` row inside that vault file
// so the id the renderer already passes everywhere keeps its exact meaning,
// `WHERE nexus_ref = ?` still matches inside a vault, and the split migration
// is a copy-and-prune rather than a renumber.
const fs = require('fs');
const path = require('path');
const { getAppDB, getVaultDB, dataDir, openVaultIds } = require('./conn');

// The folder new vaults go in unless the user picks somewhere else. Exposed on
// its own because the create form shows the DIRECTORY, not a filename: the
// filename embeds the vault id, which does not exist until the registry row is
// inserted, so a full path shown up front would name a file that never appears.
const vaultsDir = () => path.join(dataDir(), 'vaults');

// Where a new vault goes unless the user picks somewhere else. The id suffix
// keeps two vaults with the same name from colliding, and keeps the filename
// stable across a later rename.
function vaultDefaultPath(name, id) {
  const slug = String(name || 'nexus')
    .replace(/[\\/:*?"<>|]/g, '_')   // characters Windows forbids in a filename
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'nexus';
  return path.join(vaultsDir(), `${slug}-${id}.ddx`);
}

// A vault whose file has gone (moved, deleted, drive unplugged) must not stop
// the list from rendering — it renders greyed with a Locate action instead. A
// NULL file_path means "still inside the pre-split single database", which is
// never missing.
const rowMissing = (r) => (r.file_path ? !fs.existsSync(r.file_path) : false);

function listVaults() {
  return getAppDB().prepare(`
    SELECT * FROM nexus_file ORDER BY name COLLATE NOCASE
  `).all().map((r) => ({ ...r, missing: rowMissing(r) ? 1 : 0 }));
}

function getVault(id) {
  const r = getAppDB().prepare(`SELECT * FROM nexus_file WHERE id=?`).get(id);
  return r ? { ...r, missing: rowMissing(r) ? 1 : 0 } : null;
}

// The registry row is written FIRST and AUTOINCREMENT hands out the id, which
// the caller then writes into the vault file's own `nexus` row. That ordering
// is deliberate: reserving an id up front would mean bumping sqlite_sequence
// by hand, and sqlite_sequence has no UNIQUE constraint on `name`, so the
// obvious upsert is not even valid SQL there. A caller that fails to write the
// vault file afterwards deletes the row again (see createNexus).
function insertVault({ name, memo = null, colorCode = null, filePath = null }) {
  return getAppDB().prepare(`
    INSERT INTO nexus_file (name, memo, color_code, file_path) VALUES (?,?,?,?)
  `).run(name, memo, colorCode, filePath).lastInsertRowid;
}

// Same, with the id forced — for the two paths that must preserve ids that
// already exist elsewhere: the backfill from a pre-split database, and the
// split migration.
function insertVaultWithId({ id, name, memo = null, colorCode = null, filePath = null }) {
  getAppDB().prepare(`
    INSERT INTO nexus_file (id, name, memo, color_code, file_path) VALUES (?,?,?,?,?)
  `).run(id, name, memo, colorCode, filePath);
  return id;
}

const updateVaultMeta = (id, { name, memo, colorCode }) => getAppDB().prepare(`
  UPDATE nexus_file SET name=?, memo=?, color_code=?, update_at=datetime('now') WHERE id=?
`).run(name, memo ?? null, colorCode ?? null, id);

const setVaultPath = (id, filePath) => getAppDB().prepare(`
  UPDATE nexus_file SET file_path=?, missing=0, update_at=datetime('now') WHERE id=?
`).run(filePath, id);

const touchVaultOpened = (id) => getAppDB().prepare(`
  UPDATE nexus_file SET last_opened_at=datetime('now') WHERE id=?
`).run(id);

const removeVault = (id) => getAppDB().prepare(`DELETE FROM nexus_file WHERE id=?`).run(id);

// True when some OTHER vault already points at this file. Compared by resolved
// real path so `C:\x` and `c:\X\..\x` (or a symlink) can't be registered twice.
function vaultPathInUse(filePath, exceptId = null) {
  const norm = (p) => {
    try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
    catch (_) { return path.resolve(p); }
  };
  const target = norm(filePath);
  return getAppDB().prepare(`SELECT id, file_path FROM nexus_file WHERE file_path IS NOT NULL`).all()
    .some((r) => r.id !== exceptId && norm(r.file_path) === target);
}

// The count shown on the Welcome card: legacy projects across the four
// pre-v3 module tables plus top-level (Major) v3 modules — exactly the sum
// nexus.js used to compute inline, but written to the registry so the list can
// be drawn without opening anything.
//
// Called when a vault is opened and when it is closed, NOT on every module
// create/delete: those are hot paths, and "counts as of the last time this
// vault was open" is correct the moment its window closes.
const NEXUS_PROJECT_TABLES = ['project', 'world_project', 'game_project', 'write_project'];

function countVaultItems(db, nexusId) {
  let n = 0;
  for (const t of NEXUS_PROJECT_TABLES) {
    n += db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE nexus_ref=?`).get(nexusId).c;
  }
  n += db.prepare(`SELECT COUNT(*) AS c FROM module WHERE nexus_ref=? AND parent_id IS NULL`).get(nexusId).c;
  return n;
}

function refreshVaultCounts(nexusId) {
  try {
    const count = countVaultItems(getVaultDB(nexusId), nexusId);
    getAppDB().prepare(`
      UPDATE nexus_file SET project_count=?, counts_at=datetime('now') WHERE id=?
    `).run(count, nexusId);
    return count;
  } catch (_) {
    // A vault whose file is gone simply keeps its last known count.
    return null;
  }
}

// Refreshes the cached counts of every vault that ALREADY has a connection —
// free, because nothing is opened. Covers the case the window lifecycle alone
// misses: an app window is open and editing a vault, the user opens the Welcome
// window beside it, and that vault's count would otherwise be whatever it was
// when the window opened.
function refreshOpenVaultCounts() {
  for (const id of openVaultIds()) refreshVaultCounts(id);
}

module.exports = {
  NEXUS_PROJECT_TABLES, refreshOpenVaultCounts,
  vaultDefaultPath, vaultsDir, listVaults, getVault, insertVault, insertVaultWithId,
  updateVaultMeta, setVaultPath, touchVaultOpened, removeVault, vaultPathInUse,
  countVaultItems, refreshVaultCounts,
};
