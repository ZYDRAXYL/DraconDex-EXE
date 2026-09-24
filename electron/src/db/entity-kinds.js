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
// Now each family is one entry, and every one of the four facets is a VALUE —
// an omission is written down with its reason, never an absent line:
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
// knows everything it must remap — and a new one is added here, not guessed.

const modRow = (r) => ({ color: r.color_code ?? null, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind });

const ENTITY_KINDS = {
  note: {
    table: 'note',
    owner: false, // nexus-level, not inside any module
    lookup: { sql: `SELECT id, title AS name FROM note WHERE id=?`, type: 'note', module: 'scribe' },
    // v5 Part 8 (§12): every note is converted to a module on open, and a
    // converted note resolves to nothing — its name resolves to the module
    // it became, further down the resolver list.
    wiki: { sql: `SELECT id FROM note WHERE (? IS NULL OR nexus_ref=?) AND migrated_v3=0 AND title=? COLLATE NOCASE` },
    sync: 'noteMap',
    index: false, // legacy Scribe notes: linkable, but not v3 content a filter or Exhibitor lists
    search: false, // the module it became is what a search finds
  },
  module: {
    table: 'module',
    owner: `SELECT id FROM module WHERE id=?`,
    lookup: { sql: `SELECT id, name FROM module WHERE id=?`, type: 'module', module: 'hub' },
    wiki: { sql: `SELECT id FROM module WHERE (? IS NULL OR nexus_ref=?) AND name=? COLLATE NOCASE` },
    sync: 'modMap',
    index: {
      kind: 'module',
      sql: `SELECT m.id, m.name, m.kind, m.handle, uc.color_code, pm.id mid, pm.name mname, pm.kind mkind
        FROM module m LEFT JOIN module pm ON m.parent_id=pm.id
        LEFT JOIN use_color uc ON uc.id=m.color WHERE (? IS NULL OR m.nexus_ref=?)`,
      // moduleKind is the PARENT's kind (the "module the row belongs to",
      // like every other row); ownKind is the module's own — what a Manager
      // selects on (v5 Part 4, §8.10).
      row: (r) => ({ key: `module_${r.id}`, name: r.name, handle: r.handle, color: r.color_code,
        moduleId: r.mid ?? r.id, moduleName: r.mname ?? r.name, moduleKind: r.mkind ?? r.kind, ownKind: r.kind, id: r.id }),
    },
    search: ['name', 'description'],
  },
  bchp: {
    table: 'book_chapter',
    owner: `SELECT id FROM book_chapter WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM book_chapter WHERE id=?`, type: 'chapter', module: 'author' },
    wiki: { sql: `SELECT ch.id FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?) AND ch.name=? COLLATE NOCASE` },
    sync: 'bchpMap',
    index: {
      kind: 'chapter',
      sql: `SELECT ch.id, ch.name, m.id mid, m.name mname, m.kind mkind
        FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `bchp_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name', 'chapter_content'],
  },
  chss: {
    table: 'chat_session',
    owner: `SELECT id FROM chat_session WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM chat_session WHERE id=?`, type: 'chat', module: 'scribe' },
    wiki: { sql: `SELECT s.id FROM chat_session s JOIN module m ON s.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?) AND s.name=? COLLATE NOCASE` },
    sync: 'chssMap',
    index: {
      kind: 'chat',
      sql: `SELECT s.id, s.name, m.id mid, m.name mname, m.kind mkind
        FROM chat_session s JOIN module m ON s.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `chss_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name'],
  },
  cobj: {
    table: 'classifier_object',
    owner: `SELECT id FROM classifier_object WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM classifier_object WHERE id=?`, type: 'object', module: 'classifier' },
    wiki: { sql: `SELECT o.id FROM classifier_object o JOIN module m ON o.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?) AND o.name=? COLLATE NOCASE` },
    sync: 'cobjMap',
    index: {
      kind: 'object',
      sql: `SELECT o.id, o.name, uc.color_code, m.id mid, m.name mname, m.kind mkind
        FROM classifier_object o JOIN module m ON o.module_ref=m.id
        LEFT JOIN use_color uc ON uc.id=o.color WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `cobj_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name', 'note'],
  },
  tlev: {
    table: 'timeline_event',
    owner: `SELECT te.id FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id WHERE tl.module_ref=?`,
    lookup: { sql: `SELECT id, event_name AS name FROM timeline_event WHERE id=?`, type: 'event', module: 'chronicler' },
    // Intended: [[Name]] never resolves to an event — a click opens its
    // source module instead (mod/exhibitor.js). Event names repeat freely
    // across timelines ("Battle"), so a name is not an identity for them.
    wiki: false,
    sync: 'evtMap',
    index: {
      kind: 'event',
      sql: `SELECT te.id, te.event_name AS name, uc.color_code, m.id mid, m.name mname, m.kind mkind,
          s.day, s.month, s.years, s.hour, s.minute
        FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id
        JOIN module m ON tl.module_ref=m.id
        LEFT JOIN use_color uc ON uc.id=te.color
        LEFT JOIN timeline_date s ON te.start_at=s.id WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `tlev_${r.id}`, name: r.name, ...modRow(r),
        time: { day: r.day, month: r.month, years: r.years, hour: r.hour, minute: r.minute } }),
    },
    search: ['event_name', 'story'],
  },
  sdlg: {
    table: 'story_dialogue',
    owner: `SELECT id FROM story_dialogue WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM story_dialogue WHERE id=?`, type: 'dialogue', module: 'narrator' },
    wiki: false, // intended, for the same reason as tlev
    sync: 'dlgMap',
    index: {
      kind: 'dialogue',
      sql: `SELECT sd.id, sd.name, uc.color_code, m.id mid, m.name mname, m.kind mkind
        FROM story_dialogue sd JOIN module m ON sd.module_ref=m.id
        LEFT JOIN use_color uc ON uc.id=sd.color WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `sdlg_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name', 'description'],
  },
  // v5 Part 7 (§11.6): a Sketcher page can be linked to — a Designer comic
  // panel shows it, a relation can point at it.
  skpg: {
    table: 'sketch_page',
    owner: `SELECT id FROM sketch_page WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM sketch_page WHERE id=?`, type: 'page', module: 'sketcher' },
    wiki: { sql: `SELECT p.id FROM sketch_page p JOIN module m ON p.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?) AND p.name=? COLLATE NOCASE` },
    sync: 'pageMap',
    index: {
      kind: 'page',
      sql: `SELECT p.id, p.name, m.id mid, m.name mname, m.kind mkind
        FROM sketch_page p JOIN module m ON p.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `skpg_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name'],
  },
  // v5 Part 7 (§11.5): a Diviner table. An entry's linker_key divt_<id> rolls
  // it in place — the nesting that makes the name generator (§11.5).
  divt: {
    table: 'diviner_table',
    owner: `SELECT id FROM diviner_table WHERE module_ref=?`,
    lookup: { sql: `SELECT id, name FROM diviner_table WHERE id=?`, type: 'table', module: 'diviner' },
    wiki: { sql: `SELECT t.id FROM diviner_table t JOIN module m ON t.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?) AND t.name=? COLLATE NOCASE` },
    sync: 'divtMap',
    index: {
      kind: 'table',
      sql: `SELECT t.id, t.name, m.id mid, m.name mname, m.kind mkind
        FROM diviner_table t JOIN module m ON t.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
      row: (r) => ({ key: `divt_${r.id}`, name: r.name, ...modRow(r) }),
    },
    search: ['name'],
  },
  // v5 Part 7 (§11.3): a Classifier field. Never an endpoint — it appears
  // only as entity_relation.rel_type 'ctpl_<id>', naming the relation FIELD
  // that owns the row, and must be remapped like any key when imported.
  ctpl: {
    table: 'classifier_template',
    owner: `SELECT id FROM classifier_template WHERE module_ref=?`,
    lookup: { sql: `SELECT id, description AS name FROM classifier_template WHERE id=?`, type: 'field', module: 'classifier' },
    wiki: false,  // a field is not something a text links to
    sync: 'ctplMap',
    index: false, // not content: filters and the Exhibitor list its rows, not the field
    search: false,
  },
  exn: {
    table: 'exhibit_node',
    owner: `SELECT id FROM exhibit_node WHERE module_ref=?`,
    // A note node can hold [[links]] (db/wiki-sources.js), so it can be a
    // backlink's source — named by its (truncated) text.
    lookup: { sql: `SELECT id, substr(COALESCE(label,''),1,40) AS name FROM exhibit_node WHERE id=?`, type: 'note', module: 'exhibitor' },
    wiki: false, // a note has no name to link TO
    sync: false, // scene-local: a relation never ends at a note node, and the importer rebuilds nodes itself
    index: false,
    search: ['label'],
  },
  file: {
    table: 'import_file',
    owner: false, // an asset outlives its module (module_ref ON DELETE SET NULL)
    lookup: { sql: `SELECT id, file_name AS name FROM import_file WHERE id=?`, type: 'file', module: 'dock' },
    // v5 Asset Nest (§2.7): [[cover.png]] / [[file:cover.png]] reach an
    // asset. Last in the resolver order on purpose (see db/wiki.js).
    wiki: { sql: `SELECT id FROM import_file WHERE (? IS NULL OR nexus_ref=?) AND file_name=? COLLATE NOCASE` },
    // import_file is excluded from snapshots (it points at paths on ONE
    // machine), so a relation or pin to an asset cannot travel — the
    // importer counts it as dropped rather than pretending it came across.
    sync: false,
    index: {
      kind: 'file',
      sql: `SELECT f.id, f.file_name, f.file_type, f.source_kind, f.missing, m.id mid, m.name mname, m.kind mkind
        FROM import_file f LEFT JOIN module m ON f.module_ref=m.id WHERE (? IS NULL OR f.nexus_ref=?)`,
      row: (r) => ({ key: `file_${r.id}`, name: r.file_name, color: null, moduleId: r.mid ?? null,
        moduleName: r.mname ?? null, moduleKind: r.mkind ?? null,
        fileType: r.file_type, sourceKind: r.source_kind, missing: !!r.missing }),
    },
    search: ['file_name'],
  },
};

// Every column that stores an entity key — what an importer must remap.
//   json: true  the column holds a JSON list of {key, …}, not one key
//   only: re    only values matching re are keys (rel_type is free text too)
const KEY_COLUMNS = [
  { table: 'entity_relation', cols: ['from_key', 'to_key'] },
  { table: 'entity_relation', cols: ['rel_type'], only: /^ctpl_\d+$/ },
  { table: 'sketch_pin', cols: ['linker_key'] },
  { table: 'design_node', cols: ['linker_key'] },
  { table: 'exhibit_node', cols: ['linker_key'] },
  { table: 'exhibit_view', cols: ['bg_linker_key'] },
  { table: 'book_chapter', cols: ['pov_key'] },
  { table: 'story_choice_option', cols: ['condition', 'set_ops'], json: true },
  { table: 'diviner_entry', cols: ['linker_key'] },
  // v5 Part 8 (§12): an element page's key, and what a borrowed component
  // shows. item_key '*' is the shared layout, not a key.
  { table: 'page_block', cols: ['item_key'], only: /^[a-z]+_\d+$/ },
  { table: 'page_block', cols: ['source_key'] },
];

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
