'use strict';
// Schema fingerprints + the one-time init paths. A stamp hashes the SQL *and
// the source text* of every migration function it covers, so any edit to them
// invalidates the stamp and the (idempotent) init work re-runs once.
//
// v4.9.0: there are now TWO schemas and therefore two stamps — app.ddx
// (preferences, credentials, plugins) and a per-Nexus vault .ddx. They are
// separate database files with independent PRAGMA user_version fields, so the
// two stamps never collide. initDB() remains as the single-file path both
// halves still share until the vault split lands.
const { _now, _t, hasTable, hasColumn, hasAnyMissingColumns } = require('../conn');
const { APP_DDL_SQL, VAULT_DDL_SQL } = require('./ddl');
// The shared vault schema version (src/schema/version.json) — the ONE central
// number both this app and the Flutter port read. Folding it into the vault
// stamp means a hand bump of vaultSchemaVersion forces every existing
// Electron install to re-run its (idempotent) init path too, same as it
// forces Flutter's onUpgrade — see src/schema/README.md.
const { VAULT_SCHEMA_VERSION } = require('../../../../src/schema/generated/vault-ddl.electron.js');
const { INDEX_SQL } = require('./indexes');
const { SEED_SYMBOLS } = require('./seed');
const {
  migrateInlineColumns, migrateNexusV28, migrateMapV3, migrateTimelineV3,
  migrateWriterV27, migrateHeroV26, migratePluginV42, ensureIndexes,
  migrateDesignNodeShapes,
} = require('./migrations');
// Bumped to 2 by the app/vault schema split: every existing database re-runs
// its (idempotent) init path once and re-stamps.
const SCHEMA_EPOCH = 2;

// user_version is a signed 32-bit field; take 4 bytes and force it positive
// so 0 stays reserved for "never stamped".
function stampOf(parts) {
  const h = require('crypto').createHash('sha1').update(parts.join('\x00')).digest();
  return (h.readUInt32BE(0) & 0x7fffffff) || 1;
}

// Each stamp covers ONLY what its own file contains. Adding a migration means
// adding it to the matching list here, or an existing database never runs it.
let _appStamp = null;
function appSchemaStamp() {
  if (_appStamp === null) {
    _appStamp = stampOf([
      String(SCHEMA_EPOCH), APP_DDL_SQL,
      String(initAppDB), String(migratePluginV42),
    ]);
  }
  return _appStamp;
}

let _vaultStamp = null;
function vaultSchemaStamp() {
  if (_vaultStamp === null) {
    _vaultStamp = stampOf([
      String(SCHEMA_EPOCH), String(VAULT_SCHEMA_VERSION), VAULT_DDL_SQL, INDEX_SQL, SEED_SYMBOLS.join('\x01'),
      String(initVaultDB), String(migrateInlineColumns), String(migrateNexusV28),
      String(migrateMapV3), String(migrateTimelineV3), String(migrateWriterV27),
      String(migrateHeroV26), String(migrateDesignNodeShapes), String(ensureIndexes),
    ]);
  }
  return _vaultStamp;
}

// The single-file stamp: a database holding BOTH halves (which is every
// database until the vault split migration runs) must invalidate when either
// half changes.
let _schemaStamp = null;
function schemaStamp() {
  if (_schemaStamp === null) {
    _schemaStamp = stampOf([String(appSchemaStamp()), String(vaultSchemaStamp()), String(initDB)]);
  }
  return _schemaStamp;
}

// ─── app.ddx ────────────────────────────────────────────────────────────────
// Preferences, credentials and installed plugins. Deliberately tiny: no
// indexes (verified — indexes.js has none for app_setting/plugin/plugin_table)
// and no seed beyond use_color's sixteen base colours.
//
// ensureIndexes() must NEVER run here: INDEX_SQL is entirely vault-scoped and
// `CREATE INDEX IF NOT EXISTS` still throws on a table that doesn't exist.
function initAppDB(db) {
  const want = appSchemaStamp();
  const have = Number(db.prepare(`PRAGMA user_version`).get()?.user_version || 0);
  if (have === want) { _t('initAppDB (skipped, stamp match)', _now()); return; }

  // Must precede the DDL: it renames the pre-v4.2.0 `extension`/`extension_table`
  // pair into `plugin`/`plugin_table`, and CREATE TABLE IF NOT EXISTS would
  // otherwise create an empty `plugin` alongside the old data instead.
  const tPlugin = _now();
  migratePluginV42(db);
  _t('plugin v4.2 rename', tPlugin);

  const tDDL = _now();
  db.exec(APP_DDL_SQL);
  _t('app DDL exec', tDDL);

  db.exec(`PRAGMA user_version = ${appSchemaStamp() | 0}`);
}

// ─── one vault .ddx ─────────────────────────────────────────────────────────
// Everything a Nexus owns. Takes the open connection as an argument — every
// migration already took its connection this way.
function initVaultDB(db) {
  // Fast path: schema already matches this build. Everything below is idempotent,
  // so the only cost of a false miss is doing the work we'd have done anyway.
  const want = vaultSchemaStamp();
  const have = Number(db.prepare(`PRAGMA user_version`).get()?.user_version || 0);
  if (have === want) { _t('initVaultDB (skipped, stamp match)', _now()); return; }

  const tLegacyProbe = _now();
  const hadWikiLinkTable = hasTable(db, 'wiki_link');
  // One-time migration: clean-replace the legacy Navigator (v2.2) schema with
  // the new v2.5.2 "World" schema. Detected by the legacy `world_cat_object`
  // table / the old `world_project.color_ref` column (now `color`). Old
  // navigator data is intentionally dropped; the new tables are recreated by
  // the CREATE IF NOT EXISTS block below.
  try {
    const legacyNav =
      hasTable(db, 'world_cat_object') ||
      (hasColumn(db, 'world_project', 'color_ref') && !hasColumn(db, 'world_project', 'codename')) ||
      hasAnyMissingColumns(db, [
        ['world_project', ['codename', 'name', 'memo', 'color']],
        ['world_novel', ['world_ref', 'project_ref']],
        ['world_character', ['world_ref', 'name', 'symbol', 'color']],
        ['world_character_category', ['world_ref', 'category_ref']],
        ['world_character_link', ['character_ref', 'object_ref']],
        ['world_category', ['world_ref', 'category_ref']],
        ['world_object', ['category_ref', 'object_ref', 'symbol']],
        ['world_map', ['world_ref', 'map_ref']],
        ['world_map_area', ['world_map_ref', 'area_ref', 'color']],
        ['world_map_point', ['world_map_area_ref', 'point_ref']],
        ['world_timeline', ['world_ref', 'name', 'world_map_ref']],
        ['world_timeline_date', ['day', 'month', 'years', 'hour', 'minute']],
        ['world_timeline_event', ['timeline_ref', 'date_ref']],
        ['world_timeline_point', ['x', 'y']],
        ['world_timeline_object', ['event_ref', 'world_object_ref', 'world_character_ref', 'point_ref']],
      ]);
    if (legacyNav) {
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(`
        DROP TABLE IF EXISTS library_world_link;
        DROP TABLE IF EXISTS world_timeline_object;
        DROP TABLE IF EXISTS world_timeline_point;
        DROP TABLE IF EXISTS world_timeline_event;
        DROP TABLE IF EXISTS world_timeline_date;
        DROP TABLE IF EXISTS world_timeline;
        DROP TABLE IF EXISTS world_map_point;
        DROP TABLE IF EXISTS world_map_area;
        DROP TABLE IF EXISTS world_object;
        DROP TABLE IF EXISTS world_character_link;
        DROP TABLE IF EXISTS world_character_category;
        DROP TABLE IF EXISTS world_novel;
        DROP TABLE IF EXISTS world_maptl_obj;
        DROP TABLE IF EXISTS world_maptl_event;
        DROP TABLE IF EXISTS world_map_timeline;
        DROP TABLE IF EXISTS world_map_link;
        DROP TABLE IF EXISTS world_cat_object;
        DROP TABLE IF EXISTS world_cat_link;
        DROP TABLE IF EXISTS world_obj_hashtag;
        DROP TABLE IF EXISTS world_char_hashtag;
        DROP TABLE IF EXISTS world_char_link;
        DROP TABLE IF EXISTS world_character;
        DROP TABLE IF EXISTS world_category;
        DROP TABLE IF EXISTS world_novel_link;
        DROP TABLE IF EXISTS world_description;
        DROP TABLE IF EXISTS world_project_hashtag;
        DROP TABLE IF EXISTS world_map;
        DROP TABLE IF EXISTS world_project;
      `);
      db.exec(`PRAGMA foreign_keys = ON`);
    }
  } catch (_) {}
  _t('legacy-nav probe', tLegacyProbe);

  const tDDL = _now();
  db.exec(VAULT_DDL_SQL);
  _t('vault DDL exec', tDDL);

  const tMigrations = _now();
  migrateInlineColumns(db);
  _t('migrations + seed', tMigrations);

  const tIndexes = _now();
  ensureIndexes(db);
  _t('ensureIndexes', tIndexes);
  // One-time backfill: index [[wikilinks]] already sitting in old content.
  // Lazy require avoids the core↔wiki module cycle (initDB runs after load).
  if (!hadWikiLinkTable) {
    const tBackfill = _now();
    try { require('../wiki').rebuildWikiIndex(); } catch (e) { console.error('wiki backfill error:', e); }
    _t('wiki backfill', tBackfill);
  }

  // Stamped LAST, and deliberately not inside a transaction: if anything above
  // throws or the process is killed mid-upgrade, the stamp is never written and
  // the whole (idempotent) path simply re-runs on the next launch. Wrapping
  // this in a transaction would also silently break migrateMapV3 /
  // migrateTimelineV3 / the legacy-nav drop, because PRAGMA foreign_keys is a
  // no-op inside a transaction.
  db.exec(`PRAGMA user_version = ${vaultSchemaStamp() | 0}`);
}

// ─── the single-file path ───────────────────────────────────────────────────
// Every database today still holds both halves, so getDB() calls this and it
// runs both inits against the one connection. Each writes user_version as it
// finishes, so this re-stamps with the combined value afterwards — otherwise
// the next launch would see the vault stamp, miss, and redo the work forever.
//
// This function disappears once the vault split migration lands and getAppDB()
// / getVaultDB() call initAppDB / initVaultDB directly.
function initDB(db) {
  const want = schemaStamp();
  const have = Number(db.prepare(`PRAGMA user_version`).get()?.user_version || 0);
  if (have === want) { _t('initDB (skipped, stamp match)', _now()); return; }

  // Zero the stamp first so neither sub-init can take its own fast path: each
  // writes its stamp when it finishes, and the second would otherwise be
  // comparing against the first's value. (A hash collision between the two is
  // vanishingly unlikely, but "vanishingly unlikely" here means silently
  // skipping every vault migration, so it is not worth leaving to chance.)
  db.exec(`PRAGMA user_version = 0`);
  initAppDB(db);
  initVaultDB(db);
  db.exec(`PRAGMA user_version = ${schemaStamp() | 0}`);
}

module.exports = { SCHEMA_EPOCH, schemaStamp, appSchemaStamp, vaultSchemaStamp, initDB, initAppDB, initVaultDB };
