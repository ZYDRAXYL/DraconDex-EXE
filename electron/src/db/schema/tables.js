'use strict';
// Which tables belong to app.ddx, read off APP_DDL_SQL itself — so a table
// added there later is known everywhere at once, instead of being missed by a
// hand-written list (split-migrate.js's lists predated port_link/port_mount
// and left them inside every vault it made).
// Kept out of ddl.js: everything ddl.js exports must be a SQL string.
const { APP_DDL_SQL } = require('./ddl');

const tablesIn = (sql) => [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);

const APP_TABLES = new Set(tablesIn(APP_DDL_SQL));
// In both halves on purpose: every vault table's `color` references it.
const SHARED_TABLES = new Set(['use_color']);
// What a vault file must not carry.
const APP_ONLY_TABLES = new Set([...APP_TABLES].filter((t) => !SHARED_TABLES.has(t)));

// Drop any app-only table found in a VAULT file (left there by an older split).
// They are meaningless in a vault and their foreign keys point at nexus_file,
// which a vault does not have — any write that touches them then fails.
// → the names dropped. Never call this on app.ddx.
function dropAppOnlyTables(db) {
  const stray = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()
    .map((r) => r.name).filter((t) => APP_ONLY_TABLES.has(t));
  for (const t of stray) db.exec(`DROP TABLE IF EXISTS "${t}"`);
  return stray;
}

module.exports = { tablesIn, APP_TABLES, SHARED_TABLES, APP_ONLY_TABLES, dropAppOnlyTables };
