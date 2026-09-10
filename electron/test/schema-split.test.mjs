// Guards on the app/vault schema split (v4.9.0). Source-text and pure-data
// checks only — nothing here opens a database or requires electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ddl = require('../src/db/schema/ddl.js');

const tablesIn = (sql) => (sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/g) || [])
  .map((m) => m.replace('CREATE TABLE IF NOT EXISTS ', ''));

// The bug this catches has now happened twice: a backtick inside a SQL comment
// TERMINATES the template literal, and the file then fails to parse at require
// time. It surfaces as an unrelated "Unexpected identifier" thrown from
// whichever IPC handler happened to touch the database first, which is a long
// way from the actual edit.
test('no DDL string contains a backtick', () => {
  for (const [name, sql] of Object.entries(ddl)) {
    assert.equal(typeof sql, 'string', `${name} should be a SQL string`);
    assert.ok(!sql.includes('`'), `${name} contains a backtick — it would end the template literal`);
  }
});

test('app-level tables are only in APP_DDL_SQL', () => {
  const vault = tablesIn(ddl.VAULT_DDL_SQL);
  for (const t of ['app_setting', 'nexus_file', 'plugin', 'plugin_table', 'plugin_dependency']) {
    assert.ok(tablesIn(ddl.APP_DDL_SQL).includes(t), `${t} missing from APP_DDL_SQL`);
    assert.ok(!vault.includes(t), `${t} must NOT be in VAULT_DDL_SQL — a vault file is shareable, app data is not`);
  }
});

test('vault-level tables are only in VAULT_DDL_SQL', () => {
  const app = tablesIn(ddl.APP_DDL_SQL);
  for (const t of ['nexus', 'module', 'note', 'import_file', 'entity_relation']) {
    assert.ok(tablesIn(ddl.VAULT_DDL_SQL).includes(t), `${t} missing from VAULT_DDL_SQL`);
    assert.ok(!app.includes(t), `${t} must NOT be in APP_DDL_SQL`);
  }
});

// The one deliberate exception, and the reason it exists: every vault table
// has `color INTEGER REFERENCES use_color(id)`, and the Welcome window runs
// colorPicker() with no vault open.
test('use_color is in both halves and seeded identically', () => {
  assert.ok(tablesIn(ddl.APP_DDL_SQL).includes('use_color'));
  assert.ok(tablesIn(ddl.VAULT_DDL_SQL).includes('use_color'));
  const seed = (sql) => sql.match(/INSERT OR IGNORE INTO use_color[\s\S]*?;/)?.[0];
  assert.ok(seed(ddl.APP_DDL_SQL), 'APP_DDL_SQL must seed use_color');
  assert.equal(seed(ddl.APP_DDL_SQL), seed(ddl.VAULT_DDL_SQL),
    'the seeds must match exactly, or the sixteen base colours get different ids on each side');
});

// ensureIndexes() is a bare db.exec(INDEX_SQL) with no try/catch, and
// CREATE INDEX IF NOT EXISTS still throws on a table that does not exist — so
// an index on an app-level table would break every vault open.
test('INDEX_SQL is entirely vault-scoped', () => {
  const { INDEX_SQL } = require('../src/db/schema/indexes.js');
  for (const t of ['app_setting', 'nexus_file', 'plugin', 'plugin_table', 'plugin_dependency']) {
    assert.ok(!new RegExp(`\\bON ${t}\\s*\\(`).test(INDEX_SQL),
      `INDEX_SQL indexes ${t}, but indexes only ever run against a vault file`);
  }
});

// getDB() is the ambient, vault-scoped accessor. A module that owns app-level
// tables must not use it, or it would read and write whichever vault happens
// to be open — and for plugin.js specifically, three of its functions are
// called from main.js outside any IPC handler, where there is no vault at all.
test('app-level db modules never call the ambient getDB()', () => {
  for (const f of ['plugin.js', 'vaults.js', 'cloud.js']) {
    const src = readFileSync(new URL(`../src/db/${f}`, import.meta.url), 'utf8');
    assert.ok(!/\bgetDB\(\)/.test(src), `${f} calls getDB() — app-level code must use getAppDB()`);
  }
});
