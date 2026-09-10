'use strict';
// The whole CREATE TABLE surface, as SQL strings. DATA FILE — it is long by
// nature and is exempt from the file-size split rules; adding a table here (or
// to indexes.js/seed.js) changes schemaStamp(), which is what makes initDB's
// "skip when already current" fast path safe.
//
// (Originally: "Schema source, hoisted to module scope so schemaStamp() can
// fingerprint it. Editing any of these three changes the stamp, which is what
// makes the 'skip initDB when already current' fast path safe to add.")

// ─── App-level schema (app.ddx) ─────────────────────────────────────────────
// Tables that belong to the INSTALL, not to any one vault: preferences,
// credentials and installed plugins. They live in their own database file so a
// vault .ddx is a self-contained, shareable world and nothing else — handing
// someone a Nexus must not hand them your Google refresh token.
//
// use_color is deliberately in BOTH this and VAULT_DDL_SQL, seeded identically
// in each. Every vault table references it, so a vault needs its own copy to
// stand alone; and the Welcome window has no vault open yet still has to render
// vault colours AND run colorPicker() when creating one. The seed is a fixed
// ordered list, so the sixteen base colours get the same ids on both sides.
const APP_DDL_SQL = `
    CREATE TABLE IF NOT EXISTS use_color (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      color_code TEXT UNIQUE NOT NULL,
      update_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO use_color (color_code) VALUES
      ('#6366f1'),('#8b5cf6'),('#ec4899'),('#f43f5e'),
      ('#f97316'),('#eab308'),('#22c55e'),('#06b6d4'),
      ('#3b82f6'),('#64748b'),('#a78bfa'),('#34d399'),
      ('#fb923c'),('#f472b6'),('#38bdf8'),('#a3e635');

    CREATE TABLE IF NOT EXISTS app_setting (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- The vault index (v4.9.0). One row per Nexus, holding everything the
    -- Welcome window needs to draw the list WITHOUT opening a single vault
    -- file — name, colour, and a cached item count refreshed whenever that
    -- vault is open. Opening N databases to render a list of N rows would be
    -- unacceptable, and would fail outright for a vault on a disconnected
    -- drive.
    --
    -- id is the SAME id as the single "nexus" row inside the vault file, and
    -- the same id the renderer already passes around (?nexus=<id>, the MRU
    -- list, window:openNexus) — so nothing downstream has to learn a new
    -- identifier. AUTOINCREMENT so an id is never REUSED after a delete: a
    -- reused id would collide with a stale vault file the user later re-adds.
    --
    -- file_path NULL means: still inside the pre-split single database. The
    -- split migration fills it in. color_code is stored literally rather than
    -- as a use_color FK because a vault's colour has to be readable with no
    -- vault open.
    CREATE TABLE IF NOT EXISTS nexus_file (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      memo TEXT,
      color_code TEXT,
      file_path TEXT UNIQUE,
      project_count INTEGER NOT NULL DEFAULT 0,
      counts_at TEXT,
      last_opened_at TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      create_at TEXT NOT NULL DEFAULT (datetime('now')),
      update_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Plugins (v4.0.0 as "Github extensions", renamed v4.2.0 — see
    -- migratePluginV42 in schema/migrations.js): a downloaded plugin owns its
    -- own plg_<key>_<name> table(s), tracked here so src/db/plugin.js can
    -- enforce ownership before any dynamic SQL touches a plugin-derived
    -- identifier. table_name is the ONLY identifier ever spliced into a query
    -- — always resolved by ?-bound lookup on (plugin_ref, local_name), never
    -- reconstructed by string concatenation from renderer/plugin-window input.
    CREATE TABLE IF NOT EXISTS plugin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      version TEXT,
      repo_host TEXT NOT NULL DEFAULT 'github',
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      repo_ref TEXT NOT NULL DEFAULT 'main',
      entry_html TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      update_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_ref INTEGER NOT NULL REFERENCES plugin(id) ON DELETE CASCADE,
      local_name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,
      columns_json TEXT NOT NULL,
      create_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(plugin_ref, local_name)
    );

    -- One row per entry in a plugin manifest's "dependencies" array, resolved
    -- at install time. manifest_json already holds the raw URLs, but "is this
    -- dependency installed?" needs the plugin id a URL resolves to, and that
    -- costs a network fetch — so the resolution is recorded here once and the
    -- check stays local SQL afterwards. dep_key NULL means the URL could not
    -- be resolved at install time (fail_code says why); such a row counts as
    -- missing, so the plugin stays un-launchable until the user retries it.
    -- (No backticks in this file — DDL_SQL is one template literal.)
    -- Packages installed from ZYDRAXYL/DraconDex-PKG (themes, locales, view
    -- presets). App-level like plugin/app_setting, NOT vault-level: a package
    -- belongs to the install, not to one Nexus, so it deliberately stays out of
    -- the shared vault.sql the Flutter side also generates from.
    --
    -- payload_json holds the whole payload rather than a path on disk. These
    -- are a few KB of JSON, they are read at boot on every start, and keeping
    -- them in the DB means an install is one transaction that either happened
    -- or did not — no half-written file to reconcile.
    --
    -- source_sha256 is the hash the catalog declared, recorded so a later
    -- integrity re-check can tell "this payload was tampered with on disk"
    -- apart from "PKG republished this package".
    CREATE TABLE IF NOT EXISTS installed_package (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pkg_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      display_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_repo TEXT NOT NULL,
      source_release TEXT NOT NULL,
      source_asset TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plugin_dependency (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plugin_ref INTEGER NOT NULL REFERENCES plugin(id) ON DELETE CASCADE,
      dep_url TEXT NOT NULL,
      dep_key TEXT,
      dep_name TEXT,
      fail_code TEXT,
      create_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(plugin_ref, dep_url)
    );
`;

// ─── Vault-level schema (one <name>.ddx per Nexus) ──────────────────────────
// GENERATED from src/schema/vault.sql — shared with the Flutter port, see
// src/schema/README.md. Edit vault.sql, then `node src/schema/generate.mjs`;
// never edit this table text by hand or Electron and Flutter drift again.
const { VAULT_DDL_SQL } = require('../../../../src/schema/generated/vault-ddl.electron.js');

// DDL_SQL is the pre-split whole-schema string, kept for the one-time
// split migration (src/db/split-migrate.js), which has to open a database
// holding both halves at once.
const DDL_SQL = APP_DDL_SQL + VAULT_DDL_SQL;

module.exports = { APP_DDL_SQL, VAULT_DDL_SQL, DDL_SQL };
