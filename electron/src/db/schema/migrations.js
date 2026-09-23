'use strict';
const { normalizeModuleParents } = require('../module-parents');
// Additive column migrations and one-time data fixes, plus ensureIndexes().
// Every one takes the open connection as an argument, is idempotent, and is
// order-dependent — and each is hashed by schemaStamp() (schema/init.js), so
// editing one here is what tells an existing database to run the path again.
const { hasTable, hasColumn } = require('../conn');
const { INDEX_SQL } = require('./indexes');
const { SEED_SYMBOLS } = require('./seed');

// Additive column migrations + one-time data seeds that predate the schema
// stamp, kept as a named function purely so schemaStamp() can hash its source
// — an inline block inside initDB() would be invisible to the fingerprint, so
// adding a guard here would not invalidate the stamp and the new column would
// silently never be created. Every step is idempotent and order-dependent.
function migrateInlineColumns(db) {
  if (!hasColumn(db, 'module', 'cat_type')) {
    try { db.prepare(`ALTER TABLE module ADD COLUMN cat_type TEXT CHECK(cat_type IN ('object','element','character'))`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'module', 'pinned')) {
    try { db.prepare(`ALTER TABLE module ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}
  }
  // Process 8 part 1: optional per-module handle, unique per vault when set.
  // The index is partial (WHERE handle IS NOT NULL) so the many NULL rows an
  // existing vault starts with don't collide with each other, and it lives
  // here rather than in INDEX_SQL because that block is db.exec'd unguarded —
  // a UNIQUE index rejected by pre-existing data would abort the whole index
  // pass. Same try/catch reasoning as idx_game_novel_link_project below.
  if (!hasColumn(db, 'module', 'handle')) {
    try { db.prepare(`ALTER TABLE module ADD COLUMN handle TEXT`).run(); } catch (_) {}
  }
  // v5: rebuild module for its kind CHECK BEFORE idx_module_handle is made —
  // a rebuild drops every index on the table, and this one is not in INDEX_SQL.
  migrateModuleKindV5(db);
  try { db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_module_handle ON module(nexus_ref, handle COLLATE NOCASE) WHERE handle IS NOT NULL`).run(); } catch (_) {}
  migrateClassifierLevels(db);
  migrateDesignNodeShapes(db);
  migrateMapV3(db);
  migrateTimelineV3(db);

  if (!hasColumn(db, 'relation_type', 'color')) {
    try { db.prepare(`ALTER TABLE relation_type ADD COLUMN color INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'classifier_object', 'icon')) {
    try { db.prepare(`ALTER TABLE classifier_object ADD COLUMN icon TEXT`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'timeline_event', 'icon')) {
    try { db.prepare(`ALTER TABLE timeline_event ADD COLUMN icon TEXT`).run(); } catch (_) {}
  }
  // Wanderer link redesign (Plan part5 W4): a pin now references any vault
  // entity (module, classifier object, character, chapter, note, …) via the
  // same linker_key convention as sketch_pin/import_file/design_node,
  // instead of a free-text label. `label` stays for old rows but is no
  // longer read/written by the renderer.
  if (!hasColumn(db, 'map_event', 'linker_key')) {
    try { db.prepare(`ALTER TABLE map_event ADD COLUMN linker_key TEXT`).run(); } catch (_) {}
  }
  // Scribe chat bubble color + left/right side (Plan part5 Scribe #1).
  if (!hasColumn(db, 'chat_message', 'color')) {
    try { db.prepare(`ALTER TABLE chat_message ADD COLUMN color INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'chat_message', 'side')) {
    try { db.prepare(`ALTER TABLE chat_message ADD COLUMN side TEXT DEFAULT 'r'`).run(); } catch (_) {}
  }
  // Narrator per-talk-line vault-entity link + per-dialogue description (Plan part5 Narrator #2/#4).
  if (!hasColumn(db, 'story_talk', 'linker_key')) {
    try { db.prepare(`ALTER TABLE story_talk ADD COLUMN linker_key TEXT`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'story_dialogue', 'description')) {
    try { db.prepare(`ALTER TABLE story_dialogue ADD COLUMN description TEXT`).run(); } catch (_) {}
  }
  // Process 8 part 2: a dialogue row is now either a spoken line or a choice.
  // Existing rows are all lines, which the DEFAULT gives them for free. No
  // CHECK — ALTER TABLE ADD COLUMN cannot carry one, and a constraint that
  // existed only in fresh vaults would be worse than none (src/db/narrator.js
  // is the one place that writes this column).
  if (!hasColumn(db, 'story_talk', 'row_type')) {
    try { db.prepare(`ALTER TABLE story_talk ADD COLUMN row_type TEXT NOT NULL DEFAULT 'talk'`).run(); } catch (_) {}
  }
  // Author custom chapter label, e.g. "1.5" (Plan part5 Author #4).
  if (!hasColumn(db, 'book_chapter', 'chapter_label')) {
    try { db.prepare(`ALTER TABLE book_chapter ADD COLUMN chapter_label TEXT`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'classifier_template', 'level_steps')) {
    try { db.prepare(`ALTER TABLE classifier_template ADD COLUMN level_steps TEXT`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'classifier_attribute', 'condition_value')) {
    try { db.prepare(`ALTER TABLE classifier_attribute ADD COLUMN condition_value TEXT`).run(); } catch (_) {}
  }
  if (!hasColumn(db, 'entity_relation', 'color')) {
    try { db.prepare(`ALTER TABLE entity_relation ADD COLUMN color INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
  }
  // v5 Asset Nest (APP docs/V5.md §2.2) — plain ADD COLUMNs on import_file,
  // mirroring SDB's vault.sql. Every NOT NULL one carries a DEFAULT (SQLite
  // refuses it otherwise); module_ref's REFERENCES is legal under
  // foreign_keys=ON only because its default is NULL. Existing rows backfill
  // to source_kind='file', missing=0.
  for (const [col, ddl] of [
    ['module_ref',   `INTEGER REFERENCES module(id) ON DELETE SET NULL`],
    ['source_kind',  `TEXT CHECK(source_kind IN ('file','url')) NOT NULL DEFAULT 'file'`],
    ['sha256',       `TEXT`],
    ['proxy',        `BLOB`],
    ['proxy_type',   `TEXT`],
    ['missing',      `INTEGER NOT NULL DEFAULT 0`],
    ['last_seen_at', `TEXT`],
  ]) {
    if (!hasColumn(db, 'import_file', col)) {
      try { db.prepare(`ALTER TABLE import_file ADD COLUMN ${col} ${ddl}`).run(); } catch (_) {}
    }
  }
  // v5 Part 7 (APP docs/V5.md §11.3–§11.6): every new column is nullable (or
  // carries a DEFAULT), so each is one idempotent ADD COLUMN; the REFERENCES
  // on entity_relation.valid_from/valid_to are legal under foreign_keys=ON
  // only because their default is NULL.
  for (const [table, col, ddl] of [
    ['classifier_template', 'options', 'TEXT'],
    ['story_choice_option', 'condition', 'TEXT'],
    ['story_choice_option', 'set_ops', 'TEXT'],
    ['book_chapter', 'synopsis', 'TEXT'],
    ['book_chapter', 'status', 'TEXT'],
    ['book_chapter', 'pov_key', 'TEXT'],
    ['design_node', 'w', 'REAL'],
    ['design_node', 'h', 'REAL'],
    ['design_node', 'read_order', 'INTEGER'],
    ['entity_relation', 'valid_from', 'INTEGER REFERENCES timeline_date(id)'],
    ['entity_relation', 'valid_to', 'INTEGER REFERENCES timeline_date(id)'],
  ]) {
    if (hasTable(db, table) && !hasColumn(db, table, col)) {
      try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`).run(); } catch (_) {}
    }
  }
  // v5 Part 6 (APP docs/V5.md §10.4): which just-in-time tips this Nexus has
  // shown. NOT NULL with a DEFAULT, so existing rows backfill to '{}'.
  if (hasTable(db, 'nexus') && !hasColumn(db, 'nexus', 'taught')) {
    try { db.prepare(`ALTER TABLE nexus ADD COLUMN taught TEXT NOT NULL DEFAULT '{}'`).run(); } catch (_) {}
  }
  if (hasTable(db, 'world_project') && !hasColumn(db, 'world_project', 'color')) {
    try {
      db.prepare(`ALTER TABLE world_project ADD COLUMN color INTEGER REFERENCES use_color(id)`).run();
      if (hasColumn(db, 'world_project', 'color_ref')) {
        db.prepare(`UPDATE world_project SET color=color_ref WHERE color IS NULL`).run();
      }
    } catch (_) {}
  }
  // Legacy → v3 migration (src/db/migrate_v3.js) flags the source project
  // once migrated so it stops reappearing in the Legacy Import list —
  // non-destructive (the original row/data stays, only this flag changes).
  // 'note' joins this list for Plan.md part 2 §2 — Scribe notes get the
  // same flag (bulk-set per nexus rather than per single id, since Scribe
  // has no legacy "project" row to flag — see migrate_v3.js's scribe target).
  for (const t of ['project', 'world_project', 'game_project', 'write_project', 'note']) {
    if (hasTable(db, t) && !hasColumn(db, t, 'migrated_v3')) {
      try { db.prepare(`ALTER TABLE ${t} ADD COLUMN migrated_v3 INTEGER NOT NULL DEFAULT 0`).run(); } catch (_) {}
    }
  }
  if (hasTable(db, 'world_novel') && !hasColumn(db, 'world_novel', 'char_category_ref')) {
    try { db.prepare(`ALTER TABLE world_novel ADD COLUMN char_category_ref INTEGER REFERENCES object_category(id) ON DELETE SET NULL`).run(); } catch (_) {}
  }
  if (hasTable(db, 'world_object') && !hasColumn(db, 'world_object', 'symbol_ref')) {
    try { db.prepare(`ALTER TABLE world_object ADD COLUMN symbol_ref INTEGER REFERENCES symbol_collection(id) ON DELETE SET NULL`).run(); } catch (_) {}
  }
  if (hasTable(db, 'symbol_collection')) {
    // 48 unwrapped INSERT OR IGNOREs were 48 separate write transactions under
    // journal_mode=DELETE — a create/fsync/unlink cycle each, every launch, for
    // rows that already exist after the first run.
    db.transaction(() => {
      const ins = db.prepare(`INSERT OR IGNORE INTO symbol_collection (glyph,label) VALUES (?,?)`);
      for (const s of SEED_SYMBOLS) {
        const [glyph, ...rest] = s.split(' ');
        ins.run(glyph, rest.join(' '));
      }
    })();
  }
  const hasStory = db.prepare(`PRAGMA table_info(timeline_event)`).all().some(c => c.name === 'story');
  if (!hasStory) db.prepare(`ALTER TABLE timeline_event ADD COLUMN story TEXT`).run();
  const hasNote = db.prepare(`PRAGMA table_info(object)`).all().some(c => c.name === 'note');
  if (!hasNote) { try { db.prepare(`ALTER TABLE object ADD COLUMN note TEXT`).run(); } catch (_) {} }
  migrateHeroV26(db);
  migrateWriterV27(db);
  migrateNexusV28(db);
  // Needs entity_relation.color (added above) to already exist so the
  // rebuild can carry it.
  migrateEntityRelationV5(db);
  // v5 Part 4 (§8.8): a module's parent must be a collector. Wrap the
  // children an old vault keeps under any other kind — move, never delete.
  normalizeModuleParents(db);
}

// ── v5 table rebuilds (APP docs/V5.md §4.2) ────────────────────────────────
// SQLite cannot ALTER a CHECK or a table-level UNIQUE, so both follow the
// standard 12-step rebuild: foreign_keys OFF (outside any transaction — the
// pragma is a no-op inside one, see init.js), create <t>_new from the
// VENDORED DDL, copy with ids preserved (every FK pointing at the table stays
// valid), drop, rename, foreign_keys ON, then foreign_key_check.

// The CREATE TABLE body for `name` out of the vendored vault DDL, with its
// SQL comments stripped (they contain unbalanced-looking parens) and the
// name swapped. Using the vendored text rather than a copy here means the
// rebuilt table is byte-for-byte what a fresh vault gets.
function vendoredTableDdl(name, newName) {
  const { VAULT_DDL_SQL } = require('./ddl');
  const head = `CREATE TABLE IF NOT EXISTS ${name} (`;
  const at = VAULT_DDL_SQL.indexOf(head);
  if (at < 0) throw new Error(`vendored DDL has no table ${name}`);
  const src = VAULT_DDL_SQL.slice(at).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
  let depth = 0;
  for (let i = head.length - 1; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) {
      return `CREATE TABLE ${newName} (` + src.slice(head.length, i + 1);
    }
  }
  throw new Error(`unbalanced DDL for ${name}`);
}

const tableSql = (db, name) =>
  db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name)?.sql || '';
const columnsOf = (db, name) => db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);

// 'exhibitor' replaces 'viewer' + 'connector' (§3.1), 'diviner' rides along
// (§11.5). Existing viewer/connector rows become exhibitors; their saved
// view carries over (a Connector's graph opens as the Scene, its edge list
// as Edges) and a former Connector is flagged seedScene so the renderer lays
// its current filter results out as saved scene nodes on first open (§4.3) —
// the filter engine lives in the renderer, not here.
function migrateModuleKindV5(db) {
  // Match the CHECK list itself, not the table text: the stored DDL keeps its
  // comments, and the vendored comment above kind mentions 'exhibitor'.
  if (!hasTable(db, 'module') || /kind\s+IN\s*\([^)]*'exhibitor'/i.test(tableSql(db, 'module'))) return;
  try {
    const cols = columnsOf(db, 'module');
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(vendoredTableDdl('module', 'module_new'));
    const keep = columnsOf(db, 'module_new').filter((c) => cols.includes(c));
    const sel = keep.map((c) => (c === 'kind'
      ? `CASE WHEN kind IN ('viewer','connector') THEN 'exhibitor' ELSE kind END` : c)).join(', ');
    const setUi = db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)
      ON CONFLICT(module_ref, ui_key) DO UPDATE SET ui_value=excluded.ui_value`);
    const viewOf = db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='activeView'`);
    for (const m of db.prepare(`SELECT id, kind FROM module WHERE kind IN ('viewer','connector')`).all()) {
      const v = viewOf.get(m.id)?.ui_value;
      if (m.kind === 'connector') {
        setUi.run(m.id, 'activeView', v === 'edgelist' ? 'edges' : 'scene');
        setUi.run(m.id, 'seedScene', '1');
      } else {
        setUi.run(m.id, 'activeView', ['table', 'cards', 'board'].includes(v) ? v : 'table');
      }
    }
    db.exec(`INSERT INTO module_new (${keep.join(', ')}) SELECT ${sel} FROM module`);
    db.exec(`DROP TABLE module`);
    db.exec(`ALTER TABLE module_new RENAME TO module`);
  } catch (e) {
    console.error('module kind v5 migration error:', e);
    try { db.exec(`DROP TABLE IF EXISTS module_new`); } catch (_) {}
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
  const bad = db.prepare(`PRAGMA foreign_key_check`).all();
  if (bad.length) console.error(`module kind v5 migration: ${bad.length} foreign-key violation(s)`, bad.slice(0, 5));
}

// Rows removed as duplicates by the last entity_relation rebuild, reported
// once to the renderer (takeRelationDedupeReport) so the user sees it (§4.2).
let _relationDedupe = 0;
const takeRelationDedupeReport = () => { const n = _relationDedupe; _relationDedupe = 0; return n; };

// module_ref / rel_type / directed + the 4-column UNIQUE (§3.5). Order is the
// point (§4.2.2): rebuild, THEN dedupe, THEN create the NULL-safe expression
// index — building the index first aborts on any duplicate an old vault
// already carries (the old UNIQUE never deduped NULL labels, §4.2.1).
function migrateEntityRelationV5(db) {
  if (hasTable(db, 'entity_relation') && !hasColumn(db, 'entity_relation', 'rel_type')) {
    try {
      const cols = columnsOf(db, 'entity_relation');
      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(vendoredTableDdl('entity_relation', 'entity_relation_new'));
      const keep = columnsOf(db, 'entity_relation_new').filter((c) => cols.includes(c));
      db.exec(`INSERT INTO entity_relation_new (${keep.join(', ')}) SELECT ${keep.join(', ')} FROM entity_relation`);
      db.exec(`DROP TABLE entity_relation`);
      db.exec(`ALTER TABLE entity_relation_new RENAME TO entity_relation`);
    } catch (e) {
      console.error('entity_relation v5 rebuild error:', e);
      try { db.exec(`DROP TABLE IF EXISTS entity_relation_new`); } catch (_) {}
    } finally {
      db.exec(`PRAGMA foreign_keys = ON`);
    }
    const bad = db.prepare(`PRAGMA foreign_key_check`).all();
    if (bad.length) console.error(`entity_relation v5 rebuild: ${bad.length} foreign-key violation(s)`, bad.slice(0, 5));
  }
  if (!hasColumn(db, 'entity_relation', 'rel_type')) return; // rebuild failed; leave the old table working
  try {
    const before = db.prepare(`SELECT COUNT(*) AS n FROM entity_relation`).get().n;
    db.prepare(`DELETE FROM entity_relation WHERE id NOT IN (
      SELECT MIN(id) FROM entity_relation
      GROUP BY from_key, to_key, COALESCE(label,''), COALESCE(rel_type,''))`).run();
    const removed = before - db.prepare(`SELECT COUNT(*) AS n FROM entity_relation`).get().n;
    if (removed) {
      _relationDedupe += removed;
      console.warn(`entity_relation v5: removed ${removed} duplicate relation row(s)`);
    }
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_relation_v5 ON entity_relation
      (from_key, to_key, COALESCE(label,''), COALESCE(rel_type,''))`).run();
  } catch (e) {
    console.error('entity_relation v5 index error:', e);
  }
}

// v2.8 introduces the Nexus vault: every module's project root gains a
// nexus_ref. Pre-existing rows are adopted into an auto-created default vault
// so nothing disappears from the UI after upgrading.
const NEXUS_PROJECT_TABLES = ['project', 'world_project', 'game_project', 'write_project'];
function migrateNexusV28(db) {
  try {
    for (const t of NEXUS_PROJECT_TABLES) {
      if (hasTable(db, t) && !hasColumn(db, t, 'nexus_ref')) {
        try { db.prepare(`ALTER TABLE ${t} ADD COLUMN nexus_ref INTEGER REFERENCES nexus(id) ON DELETE SET NULL`).run(); } catch (_) {}
      }
    }
    const orphan = NEXUS_PROJECT_TABLES.some(t =>
      hasTable(db, t) && db.prepare(`SELECT 1 FROM ${t} WHERE nexus_ref IS NULL LIMIT 1`).get());
    if (orphan) {
      let nx = db.prepare(`SELECT id FROM nexus ORDER BY id LIMIT 1`).get();
      if (!nx) {
        const rid = db.prepare(`INSERT INTO nexus (name) VALUES ('Nexus')`).run().lastInsertRowid;
        nx = { id: rid };
      }
      for (const t of NEXUS_PROJECT_TABLES) {
        if (hasTable(db, t)) db.prepare(`UPDATE ${t} SET nexus_ref=? WHERE nexus_ref IS NULL`).run(nx.id);
      }
    }
  } catch (e) {
    console.error('Nexus v2.8 migration error:', e);
  }
}

// v2.7 replaced the entire Writer module schema (library/series/document) with
// the write_* tables. The old library data has no v2.7 equivalent and is
// dropped; the new tables are created by the CREATE IF NOT EXISTS block above.
// v3 (Phase 7): Locator reuses `map`/`map_area`/`map_point` instead of a
// parallel schema like Classifier's — unlike object_category, nothing joins
// `map` to `project` through an assumption every map has one (no wiki.js
// resolver exists for maps at all yet, and Navigator's own map queries
// already filter to matching project ids before ever reaching a JOIN), so
// relaxing `project_id` and adding `module_ref` is safe here. SQLite can't
// drop a NOT NULL with ALTER, so this rebuilds the table — ids are
// preserved so map_area's FK and world_map.map_ref stay valid untouched.
// Process 8 part 1: levels moved from one shared comma string on the template
// (classifier_template.level_steps) to per-element rows in classifier_level.
// Carries each element's existing single value across so nothing a user typed
// disappears — one seed row per (object, template) that has a value today, for
// templates flagged levelable or has_condition. Idempotent via the NOT EXISTS
// guard, so a re-run after the user has edited their levels adds nothing.
// level_steps itself is left in place, unread, rather than dropped: SQLite
// can't drop a column without a table rebuild, and keeping it means a vault
// opened by an older build still finds what it expects.
function migrateClassifierLevels(db) {
  if (!hasTable(db, 'classifier_level') || !hasTable(db, 'classifier_attribute')) return;
  try {
    db.prepare(`
      INSERT INTO classifier_level (object_ref, template_ref, level_label, condition_value, info_value, display_order)
      SELECT ca.object_ref, ca.template_ref, ca.attribute_value, ca.condition_value, NULL, 0
      FROM classifier_attribute ca
      JOIN classifier_template ct ON ct.id = ca.template_ref
      WHERE (ct.levelable = 1 OR ct.has_condition = 1)
        AND (COALESCE(ca.attribute_value,'') <> '' OR COALESCE(ca.condition_value,'') <> '')
        AND NOT EXISTS (
          SELECT 1 FROM classifier_level cl
          WHERE cl.object_ref = ca.object_ref AND cl.template_ref = ca.template_ref
        )
    `).run();
  } catch (e) {
    console.error('Classifier level migration error:', e);
  }
}

// Process 8 part 2: design_node.shape used to carry
// CHECK(shape IN ('box','circle','diamond','text')). SQLite cannot ALTER a
// CHECK, and CREATE TABLE IF NOT EXISTS is a no-op on a table that exists, so
// an existing vault would reject every shape added since. Rebuilds the table
// without the constraint; the shape vocabulary is the renderer's DG_SHAPES now.
// Detected by reading the stored DDL rather than by a column probe — the
// column has been there all along, only its constraint changes.
function migrateDesignNodeShapes(db) {
  if (!hasTable(db, 'design_node')) return;
  try {
    const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='design_node'`).get();
    if (!row || !/CHECK\s*\(\s*shape/i.test(row.sql || '')) return;
    // design_edge references design_node with ON DELETE CASCADE, so the DROP
    // has to happen with foreign_keys off or it takes every edge with it.
    // Ids are copied verbatim, which is what keeps those edges valid.
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
      CREATE TABLE design_node_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_ref INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
        shape TEXT NOT NULL DEFAULT 'box',
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        node_text TEXT,
        color TEXT,
        linker_key TEXT,
        create_at TEXT NOT NULL DEFAULT (datetime('now')),
        update_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO design_node_new (id, module_ref, shape, x, y, node_text, color, linker_key, create_at, update_at)
        SELECT id, module_ref, shape, x, y, node_text, color, linker_key, create_at, update_at FROM design_node;
      DROP TABLE design_node;
      ALTER TABLE design_node_new RENAME TO design_node;
    `);
    db.exec(`PRAGMA foreign_keys = ON`);
  } catch (e) {
    console.error('design_node shape migration error:', e);
  }
}

function migrateMapV3(db) {
  if (!hasTable(db, 'map') || hasColumn(db, 'map', 'module_ref')) return;
  try {
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
      CREATE TABLE map_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        map_name TEXT,
        project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
        module_ref INTEGER REFERENCES module(id) ON DELETE CASCADE,
        color INTEGER REFERENCES use_color(id),
        update_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO map_new (id, map_name, project_id, color, update_at)
        SELECT id, map_name, project_id, color, update_at FROM map;
      DROP TABLE map;
      ALTER TABLE map_new RENAME TO map;
    `);
    db.exec(`PRAGMA foreign_keys = ON`);
  } catch (e) {
    console.error('Map v3 migration error:', e);
  }
}

// Same table-rebuild pattern as migrateMapV3: timeline.project_id was
// NOT NULL, Chronicler timelines need it nullable (module_ref set instead).
function migrateTimelineV3(db) {
  if (!hasTable(db, 'timeline') || hasColumn(db, 'timeline', 'module_ref')) return;
  try {
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
      CREATE TABLE timeline_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        line_name TEXT,
        project_id INTEGER REFERENCES project(id) ON DELETE CASCADE,
        module_ref INTEGER REFERENCES module(id) ON DELETE CASCADE,
        color INTEGER REFERENCES use_color(id),
        update_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO timeline_new (id, line_name, project_id, color, update_at)
        SELECT id, line_name, project_id, color, update_at FROM timeline;
      DROP TABLE timeline;
      ALTER TABLE timeline_new RENAME TO timeline;
    `);
    db.exec(`PRAGMA foreign_keys = ON`);
  } catch (e) {
    console.error('Timeline v3 migration error:', e);
  }
}

function migrateWriterV27(db) {
  try {
    if (!hasTable(db, 'library_project')) return;
    db.exec(`PRAGMA foreign_keys = OFF`);
    db.exec(`
      DROP TABLE IF EXISTS document_hashtag;
      DROP TABLE IF EXISTS library_document;
      DROP TABLE IF EXISTS series_hashtag;
      DROP TABLE IF EXISTS series_object_link;
      DROP TABLE IF EXISTS series_char_link;
      DROP TABLE IF EXISTS series_novel_link;
      DROP TABLE IF EXISTS series_description;
      DROP TABLE IF EXISTS library_series;
      DROP TABLE IF EXISTS library_world_link;
      DROP TABLE IF EXISTS library_description;
      DROP TABLE IF EXISTS library_project;
    `);
    db.exec(`PRAGMA foreign_keys = ON`);
  } catch (_) {}
}

// Foreign keys are ON with CASCADE deletes throughout, but SQLite does not
// index the child side of a FK automatically — every parent DELETE and every
// `WHERE <fk> = ?` list query was a full scan. Indexes are only created for FK
// columns not already covered as the leading column of a UNIQUE constraint.
// Runs after migrations so reshaped tables (Hero v2.6 etc.) are final.
function ensureIndexes(db) {
  db.exec(INDEX_SQL);
}

// v2.6 replaced the entire Hero module schema. Reshape the surviving tables
// (created by an older build with the v2.3 columns), copy what maps cleanly
// (items -> collections, dial lines -> conversations, dial edges -> storyline),
// and drop the v2.3-only tables. Old stat/function/link data has no v2.6
// equivalent and is dropped with them.
function migrateHeroV26(db) {
  try {
    if (!hasColumn(db, 'game_project', 'codename')) {
      try { db.prepare(`ALTER TABLE game_project ADD COLUMN codename TEXT`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_character', 'object_link')) {
      try { db.prepare(`ALTER TABLE game_character ADD COLUMN object_link INTEGER REFERENCES game_cat_object(id) ON DELETE SET NULL`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_character', 'color_ref')) {
      try { db.prepare(`ALTER TABLE game_character ADD COLUMN color_ref INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_story', 'color_ref')) {
      try { db.prepare(`ALTER TABLE game_story ADD COLUMN color_ref INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_dialogue', 'color_ref')) {
      try { db.prepare(`ALTER TABLE game_dialogue ADD COLUMN color_ref INTEGER REFERENCES use_color(id)`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_storyline', 'symbol_ref')) {
      try { db.prepare(`ALTER TABLE game_storyline ADD COLUMN symbol_ref INTEGER REFERENCES symbol_collection(id) ON DELETE SET NULL`).run(); } catch (_) {}
    }
    if (!hasColumn(db, 'game_storyline', 'symbol')) {
      try { db.prepare(`ALTER TABLE game_storyline ADD COLUMN symbol TEXT`).run(); } catch (_) {}
    }
    // Plan v2.6: a novel can belong to at most one game. Skipped silently if
    // existing data already violates it.
    try { db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_game_novel_link_project ON game_novel_link(project_ref)`).run(); } catch (_) {}

    if (hasTable(db, 'game_item_category')) {
      db.prepare(`INSERT OR IGNORE INTO game_collection (id,game_ref,name) SELECT id,game_ref,name FROM game_item_category`).run();
      db.prepare(`INSERT OR IGNORE INTO game_col_template (id,collection_ref,attribute_name,attribute_type) SELECT id,item_cat_ref,attr_name,CASE WHEN attr_type='number' THEN 'num' ELSE 'text' END FROM game_item_template`).run();
      db.prepare(`INSERT OR IGNORE INTO game_col_element (id,collection_ref,name) SELECT id,item_cat_ref,name FROM game_item`).run();
      db.prepare(`INSERT OR IGNORE INTO game_col_attribute (element_ref,template_ref,attribute_text,level) SELECT item_ref,template_ref,value,0 FROM game_item_attr`).run();
      db.prepare(`INSERT OR IGNORE INTO game_element_hashtag (element_id,hashtag_id) SELECT item_id,hashtag_id FROM game_item_hashtag`).run();
    }
    if (hasTable(db, 'game_dial_line')) {
      db.prepare(`INSERT OR IGNORE INTO game_conversation (dialogue_ref,char_ref,talk_sentence,talk_order)
        SELECT dial_ref, speaker_ref, text, ROW_NUMBER() OVER (PARTITION BY dial_ref ORDER BY order_index, id)-1 FROM game_dial_line`).run();
    }
    if (hasTable(db, 'game_dial_next')) {
      db.prepare(`INSERT OR IGNORE INTO game_storyline (story_ref,from_ref,to_ref)
        SELECT gd.story_ref, gdn.from_ref, gdn.to_ref FROM game_dial_next gdn JOIN game_dialogue gd ON gd.id=gdn.from_ref`).run();
    }
    // Children first so FK references never dangle mid-drop.
    for (const t of ['game_dial_line','game_dial_next','game_item_attr','game_item_hashtag','game_item','game_item_template',
                     'game_item_category','game_stat_levelup','game_stat_template','game_char_link',
                     'game_function','game_func_category','game_description']) {
      if (hasTable(db, t)) { try { db.prepare(`DROP TABLE ${t}`).run(); } catch (_) {} }
    }
  } catch (e) {
    console.error('Hero v2.6 migration error:', e);
  }
}


// v4.2.0 renames the whole "Github extension" system to "plugin". Unlike every
// other migration here this one runs BEFORE the DDL block (schema/init.js), so
// `CREATE TABLE IF NOT EXISTS plugin` finds the renamed table already in place
// instead of creating an empty one next to the old data.
//
// The dynamic per-plugin tables are renamed too (ext_<id>_<name> ->
// plg_<id>_<name>) because src/db/plugin.js's FULL_TABLE_RE only accepts the
// new prefix — a table left as ext_* would be silently unreachable. Both the
// old and the new name are re-checked against a regex before being spliced
// into the ALTER, same rule as everywhere else in this system: an identifier
// read back out of the DB is still validated before it reaches SQL.
const PLG_LEGACY_TABLE_RE = /^ext_[a-z0-9_]{1,41}$/;
const PLG_TABLE_RE = /^plg_[a-z0-9_]{1,41}$/;
function migratePluginV42(db) {
  try {
    if (hasTable(db, 'extension') && !hasTable(db, 'plugin')) {
      db.prepare(`ALTER TABLE extension RENAME TO plugin`).run();
      db.prepare(`ALTER TABLE plugin RENAME COLUMN ext_key TO plugin_key`).run();
      if (hasTable(db, 'extension_table')) {
        db.prepare(`ALTER TABLE extension_table RENAME TO plugin_table`).run();
        db.prepare(`ALTER TABLE plugin_table RENAME COLUMN extension_ref TO plugin_ref`).run();
      }
    }
    if (hasTable(db, 'plugin') && !hasColumn(db, 'plugin', 'repo_host')) {
      db.prepare(`ALTER TABLE plugin ADD COLUMN repo_host TEXT NOT NULL DEFAULT 'github'`).run();
    }
    if (hasTable(db, 'plugin_table')) {
      const rows = db.prepare(`SELECT id, table_name FROM plugin_table WHERE table_name LIKE 'ext\\_%' ESCAPE '\\'`).all();
      for (const row of rows) {
        const oldName = String(row.table_name || '');
        const newName = `plg_${oldName.slice(4)}`;
        if (!PLG_LEGACY_TABLE_RE.test(oldName) || !PLG_TABLE_RE.test(newName)) continue;
        if (!hasTable(db, oldName) || hasTable(db, newName)) continue;
        db.prepare(`ALTER TABLE ${oldName} RENAME TO ${newName}`).run();
        db.prepare(`UPDATE plugin_table SET table_name=? WHERE id=?`).run(newName, row.id);
      }
    }
  } catch (e) {
    console.error('plugin v4.2 migration error:', e);
  }
}

module.exports = {
  migrateModuleKindV5, migrateEntityRelationV5, takeRelationDedupeReport, vendoredTableDdl,
  migrateInlineColumns, NEXUS_PROJECT_TABLES, migrateNexusV28, migrateMapV3,
  migrateTimelineV3, migrateWriterV27, ensureIndexes, migrateHeroV26,
  migratePluginV42, migrateClassifierLevels, migrateDesignNodeShapes,
};
