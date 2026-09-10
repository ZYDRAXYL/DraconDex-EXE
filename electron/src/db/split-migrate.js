'use strict';
// ═══ One-time split: novel-manager.ddx -> app.ddx + one .ddx per Nexus ══════
//
// Runs once, from getAppDB()'s bootstrap, when app.ddx is absent and the
// pre-split novel-manager.ddx exists. The original is never modified in place:
// everything is built in a temp directory and renamed in, so a crash at any
// point leaves the old file exactly as it was and the migrator simply retries
// on the next launch.
//
// NOT built on serializeVault() (src/db/sync.js), even though a per-nexus
// snapshot already exists: that format captures v3 module data and notes only,
// and would silently drop the legacy project / world_project / game_project /
// write_project trees and every import_file row. Physical copy + prune keeps
// everything by construction, including tables nobody remembered to list.
//
// ─── The two orderings that matter ─────────────────────────────────────────
// 1. Legacy project rows are deleted BEFORE the nexus rows. Their nexus_ref is
//    ON DELETE SET NULL (schema/migrations.js migrateNexusV28), not CASCADE —
//    so deleting `nexus` first NULLs every other vault's nexus_ref and destroys
//    the only record of which vault they belonged to. The follow-up delete then
//    matches nothing and every vault file ends up carrying every other vault's
//    Director/Navigator/Hero/Writer data.
// 2. Vault files are renamed into place BEFORE app.ddx. app.ddx's existence is
//    the commit marker.
const fs = require('fs');
const path = require('path');
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const { adaptDb, forceLegacyJournalMode } = require('./conn');
const { NEXUS_PROJECT_TABLES } = require('./vaults');

// Tables app.ddx keeps. Everything else in sqlite_master is dropped from it —
// derived by SUBTRACTION deliberately, so a table this file forgot about is
// caught automatically instead of being silently duplicated into every vault.
const APP_KEEP = new Set(['use_color', 'app_setting', 'nexus_file', 'plugin', 'plugin_table', 'plugin_dependency', 'sqlite_sequence']);
// The mirror image: what a VAULT file must not keep. use_color and
// sqlite_sequence are in APP_KEEP but belong in both, so they are named
// separately rather than derived from it.
const VAULT_DROP = new Set(['app_setting', 'nexus_file', 'plugin', 'plugin_table', 'plugin_dependency']);
const PLUGIN_TABLE_RE = /^(plg|ext)_[a-z0-9_]{1,41}$/;

// Relations declared without ON DELETE, i.e. NO ACTION: a single cross-project
// row here aborts the whole `DELETE FROM nexus` with FOREIGN KEY constraint
// failed. Deferred inside the transaction, then swept.
const ORPHAN_SWEEPS = [
  `DELETE FROM relation_obob WHERE object_from NOT IN (SELECT id FROM object) OR object_to NOT IN (SELECT id FROM object)`,
  `DELETE FROM relation_obtl WHERE object_from NOT IN (SELECT id FROM object) OR timeline_to NOT IN (SELECT id FROM timeline_event)`,
  `DELETE FROM relation_tltl WHERE timeline_from NOT IN (SELECT id FROM timeline_event) OR timeline_to NOT IN (SELECT id FROM timeline_event)`,
];

const slug = (name) => (String(name || 'nexus')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, '-')
  .slice(0, 60) || 'nexus');

// A bare connection: no statement cache, no init path. These are surgery
// tools, not app connections.
function openRaw(filePath) {
  if (fs.existsSync(filePath) && !fs.existsSync(filePath + '-wal')) forceLegacyJournalMode(filePath);
  const conn = adaptDb(new _RawDatabase(filePath));
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA journal_mode = DELETE');
  return conn;
}

const tableNames = (conn) => conn
  .prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
  .map((r) => r.name);

// ─── Step 1: read the plan off the original ────────────────────────────────
function readNexuses(legacyPath) {
  const conn = openRaw(legacyPath);
  try {
    conn.exec('PRAGMA foreign_keys = ON');
    // No initDB() here: conn.js opens the legacy file normally (full init,
    // including the wiki backfill, against a properly published connection)
    // and closes it again before calling us, so the schema is already current.
    // Re-entering the init path on this bare connection would send the wiki
    // backfill through getDB() and open a second handle to the same file.

    // Adoption pre-pass. `WHERE nexus_ref != N` never matches NULL, so an
    // orphan (produced by a crash between migrateNexusV28's ALTER and its
    // UPDATE, or by import-merge's adoption gap) would otherwise be copied
    // into EVERY vault. Give them all to the lowest-numbered vault.
    const firstId = conn.prepare(`SELECT MIN(id) AS m FROM nexus`).get()?.m;
    if (firstId != null) {
      for (const t of NEXUS_PROJECT_TABLES) {
        try { conn.prepare(`UPDATE ${t} SET nexus_ref=? WHERE nexus_ref IS NULL`).run(firstId); } catch (_) {}
      }
    }

    return conn.prepare(`
      SELECT n.id, n.name, n.memo, c.color_code
      FROM nexus n LEFT JOIN use_color c ON c.id = n.color
      ORDER BY n.id
    `).all();
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

// ─── Step 2: one vault file ────────────────────────────────────────────────
function buildVaultFile(legacyPath, outPath, nexusId) {
  fs.copyFileSync(legacyPath, outPath);
  const conn = openRaw(outPath);
  try {
    // OUTSIDE the transaction — PRAGMA foreign_keys is a no-op inside one, and
    // with it off no cascade fires at all, leaving a nexus-less file full of
    // orphans that looks fine at a glance.
    conn.exec('PRAGMA foreign_keys = ON');

    conn.transaction(() => {
      conn.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of NEXUS_PROJECT_TABLES) {
        conn.prepare(`DELETE FROM ${t} WHERE nexus_ref IS NOT ?`).run(nexusId);
      }
      conn.prepare(`DELETE FROM nexus WHERE id <> ?`).run(nexusId);
      for (const sql of ORPHAN_SWEEPS) {
        try { conn.prepare(sql).run(); } catch (_) { /* table may predate this build */ }
      }
    })();

    const bad = conn.prepare(`PRAGMA foreign_key_check`).all();
    if (bad.length) throw new Error(`foreign_key_check failed for nexus ${nexusId}: ${JSON.stringify(bad[0])}`);

    let count = 0;
    for (const t of NEXUS_PROJECT_TABLES) {
      count += conn.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE nexus_ref=?`).get(nexusId).c;
    }
    count += conn.prepare(`SELECT COUNT(*) AS c FROM module WHERE nexus_ref=? AND parent_id IS NULL`).get(nexusId).c;

    for (const t of tableNames(conn)) {
      if (VAULT_DROP.has(t) || PLUGIN_TABLE_RE.test(t)) conn.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }
    // sqlite_sequence is deliberately left alone: the copy inherits the right
    // AUTOINCREMENT high-water marks. Ids diverging between vault files is
    // harmless — nothing joins across files.
    conn.exec('PRAGMA user_version = 0');
    conn.exec('VACUUM');
    return count;
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

// ─── Step 3: app.ddx ───────────────────────────────────────────────────────
function buildAppFile(legacyPath, outPath, nexuses, vaultPaths, counts) {
  fs.copyFileSync(legacyPath, outPath);
  const conn = openRaw(outPath);
  try {
    conn.exec('PRAGMA foreign_keys = OFF'); // bulk drop; order irrelevant
    for (const t of tableNames(conn)) {
      if (APP_KEEP.has(t) || PLUGIN_TABLE_RE.test(t)) continue;
      conn.prepare(`DROP TABLE IF EXISTS ${t}`).run();
    }
    conn.exec('PRAGMA user_version = 0');
    conn.exec('PRAGMA foreign_keys = ON');
    conn.exec('VACUUM');
    require('./schema/init').initAppDB(conn);

    conn.transaction(() => {
      // A database that ran v4.9.0's pre-split build already has a backfilled
      // nexus_file, whose rows carry file_path NULL — "still inside the single
      // database". Those are exactly the rows being replaced here, so clear
      // them rather than colliding with them on id.
      conn.prepare(`DELETE FROM nexus_file`).run();
      for (const n of nexuses) {
        conn.prepare(`
          INSERT INTO nexus_file (id, name, memo, color_code, file_path, project_count, counts_at)
          VALUES (?,?,?,?,?,?,datetime('now'))
        `).run(n.id, n.name, n.memo ?? null, n.color_code ?? null, vaultPaths.get(n.id), counts.get(n.id) ?? 0);
      }
    })();
    return conn.prepare(`SELECT COUNT(*) AS c FROM nexus_file`).get().c;
  } finally {
    try { conn.close(); } catch (_) {}
  }
}

// ─── The migration ─────────────────────────────────────────────────────────
// Returns { ok:true, vaults } or throws. The caller (conn.js) lets a throw
// propagate: booting into a half-split state would be far worse than failing
// to boot with the original file still intact.
function splitLegacyDatabase(dataDir) {
  const legacyPath = path.join(dataDir, 'novel-manager.ddx');
  const appPath = path.join(dataDir, 'app.ddx');
  const vaultsDir = path.join(dataDir, 'vaults');
  const tmp = path.join(dataDir, '.ddx-split-tmp');

  if (fs.existsSync(appPath) || !fs.existsSync(legacyPath)) return { ok: false, code: 'not_applicable' };

  // Peak usage is the original twice over per vault (copy, then VACUUM's temp
  // file) plus the finished vaults. Refuse early rather than fail halfway.
  const size = fs.statSync(legacyPath).size;
  try {
    const st = fs.statfsSync(dataDir);
    const free = st.bavail * st.bsize;
    if (free < size * 3) throw new Error(`not enough free disk space: need ~${Math.ceil(size * 3 / 1e6)}MB, have ${Math.floor(free / 1e6)}MB`);
  } catch (e) {
    if (/not enough free disk space/.test(String(e && e.message))) throw e;
    // statfsSync unavailable on this platform — proceed.
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    const nexuses = readNexuses(legacyPath);
    const vaultPaths = new Map();
    const counts = new Map();
    const staged = [];

    for (const n of nexuses) {
      const tmpFile = path.join(tmp, `vault-${n.id}.ddx`);
      counts.set(n.id, buildVaultFile(legacyPath, tmpFile, n.id));
      const finalPath = path.join(vaultsDir, `${slug(n.name)}-${n.id}.ddx`);
      vaultPaths.set(n.id, finalPath);
      staged.push([tmpFile, finalPath]);
    }

    buildAppFile(legacyPath, path.join(tmp, 'app.ddx'), nexuses, vaultPaths, counts);

    // Vault files first — app.ddx's existence is the commit marker.
    fs.mkdirSync(vaultsDir, { recursive: true });
    for (const [from, to] of staged) fs.renameSync(from, to);
    fs.renameSync(path.join(tmp, 'app.ddx'), appPath);

    // Only now is the original redundant. Kept forever as the escape hatch.
    try {
      fs.renameSync(legacyPath, legacyPath + '.bak');
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(legacyPath + ext)) fs.renameSync(legacyPath + ext, legacyPath + '.bak' + ext);
      }
    } catch (_) { /* app.ddx already exists, so this never re-runs anyway */ }

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`[split] ${nexuses.length} nexus(es) split into ${vaultsDir}; original kept as novel-manager.ddx.bak`);
    return { ok: true, vaults: nexuses.length };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { splitLegacyDatabase };
