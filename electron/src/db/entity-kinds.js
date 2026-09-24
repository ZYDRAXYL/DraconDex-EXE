'use strict';
// ═══ ENTITY_KINDS — every v3+ key family, declared once (v5 Part 7, §11.2) ═
// An entity key is `<prefix>_<id>` (cobj_12, tlev_7, …). Before this file a
// family had to be registered by hand in four places that each knew a
// different subset — the [[wiki]] resolvers, the key lookups, the snapshot
// importer's keyMaps and viewerIndex — and "left out on purpose" looked
// exactly like "forgotten". The importer's copy forgot tlev/sdlg, which is
// the §11.1 bug: every Token Sync pull dropped relations, sketch pins and
// Designer links that pointed at an event or a dialogue.
//
// Now each family is one entry, and every facet is a VALUE — an omission is
// written down with its reason, never an absent line:
//
//   lookup   { sql, type, module }   key → name (backlinks, pins, Sage).
//            sql must end in `WHERE id=?` (db/wiki.js batches it).
//   wiki     { sql } | false         [[Name]] → id. sql takes (nx, nx, name).
//   sync     '<mapName>' | false     the id map applySnapshotCore fills for
//            this family; entityKeyMaps() looks it up and throws if missing.
//   index    { kind, sql, row } | false   viewerIndex rows. sql takes (nx, nx).
//   search   [columns] | false       text a search index covers (§11.4)
//   owner    sql | false             this family's ids inside one module
//            (sql takes the module id) — what the trash (§11.4) collects the
//            relations of before a module is deleted
//
// Legacy prefixes (obj, wchar, wchp, …) stay in db/wiki.js: they are read-
// only history, not in snapshots, and not indexed.
//
// KEY_COLUMNS lists every column that STORES an entity key, so the importer
// knows everything it must remap — and a new one is added in SDB, not guessed.

// The declaration itself is DATA, vendored from DraconDex-SDB
// (schema/entity-kinds.json → src/schema/generated/entity-kinds.json): the
// Flutter app's importer remaps keys from the same file, so the two apps can
// no longer disagree about which families exist (APP docs/APK-V3.md §9.1).
// Every facet is there, and a facet left out on purpose carries its reason
// under `why`. Only the index ROW mappers are code, so they live here, keyed
// by prefix; a family with an index and no mapper fails at load.
const DECL = require('../../../src/schema/generated/entity-kinds.json');

const modRow = (r) => ({ color: r.color_code ?? null, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind });

const INDEX_ROWS = {
  // moduleKind is the PARENT's kind (the "module the row belongs to", like
  // every other row); ownKind is the module's own — what a Manager selects
  // on (v5 Part 4, §8.10).
  module: (r) => ({ key: `module_${r.id}`, name: r.name, handle: r.handle, color: r.color_code,
    moduleId: r.mid ?? r.id, moduleName: r.mname ?? r.name, moduleKind: r.mkind ?? r.kind, ownKind: r.kind, id: r.id }),
  bchp: (r) => ({ key: `bchp_${r.id}`, name: r.name, ...modRow(r) }),
  chss: (r) => ({ key: `chss_${r.id}`, name: r.name, ...modRow(r) }),
  cobj: (r) => ({ key: `cobj_${r.id}`, name: r.name, ...modRow(r) }),
  tlev: (r) => ({ key: `tlev_${r.id}`, name: r.name, ...modRow(r),
    time: { day: r.day, month: r.month, years: r.years, hour: r.hour, minute: r.minute } }),
  sdlg: (r) => ({ key: `sdlg_${r.id}`, name: r.name, ...modRow(r) }),
  skpg: (r) => ({ key: `skpg_${r.id}`, name: r.name, ...modRow(r) }),
  divt: (r) => ({ key: `divt_${r.id}`, name: r.name, ...modRow(r) }),
  file: (r) => ({ key: `file_${r.id}`, name: r.file_name, color: null, moduleId: r.mid ?? null,
    moduleName: r.mname ?? null, moduleKind: r.mkind ?? null,
    fileType: r.file_type, sourceKind: r.source_kind, missing: !!r.missing }),
};

// The shape the rest of the app has always read: a facet is a value or false.
const ENTITY_KINDS = Object.fromEntries(DECL.families.map((f) => {
  if (f.index && !INDEX_ROWS[f.prefix]) throw new Error(`entity-kinds: no index row mapper for ${f.prefix}_`);
  return [f.prefix, {
    table: f.table,
    owner: f.owner || false,
    lookup: f.lookup,
    wiki: f.wiki ? { sql: f.wiki } : false,
    sync: f.sync || false,
    index: f.index ? { kind: f.index.kind, sql: f.index.sql, row: INDEX_ROWS[f.prefix] } : false,
    search: f.search || false,
  }];
}));

// Every column that stores an entity key — what an importer must remap.
//   json: true  the column holds a JSON list of {key, …}, not one key
//   only: re    only values matching re are keys (rel_type is free text too)
const KEY_COLUMNS = DECL.keyColumns.map((k) => ({
  table: k.table, cols: k.cols, ...(k.json ? { json: true } : {}), ...(k.only ? { only: new RegExp(k.only) } : {}),
}));

// The importer's key maps, from the local id maps it built — by the names
// declared above. A family that says it syncs but whose map was not passed
// is a programming error, reported loudly instead of dropping rows.
function entityKeyMaps(localMaps) {
  const out = {};
  for (const [prefix, k] of Object.entries(ENTITY_KINDS)) {
    if (!k.sync) continue;
    const m = localMaps[k.sync];
    if (!(m instanceof Map)) throw new Error(`entityKeyMaps: no ${k.sync} for ${prefix}_ keys`);
    out[prefix] = m;
  }
  return out;
}

// Every entity key that lives inside these modules, by the `owner` facet.
function keysOwnedBy(db, moduleIds) {
  const out = new Set();
  for (const [prefix, k] of Object.entries(ENTITY_KINDS)) {
    if (!k.owner) continue;
    const st = db.prepare(k.owner);
    for (const mid of moduleIds) for (const r of st.all(mid)) out.add(`${prefix}_${r.id}`);
  }
  return out;
}

module.exports = { ENTITY_KINDS, KEY_COLUMNS, entityKeyMaps, keysOwnedBy };
