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
    lookup: { sql: `SELECT id, title AS name FROM note WHERE id=?`, type: 'note', module: 'scribe' },
    wiki: { sql: `SELECT id FROM note WHERE (? IS NULL OR nexus_ref=?) AND title=? COLLATE NOCASE` },
    sync: 'noteMap',
    index: false, // legacy Scribe notes: linkable, but not v3 content a filter or Exhibitor lists
    search: ['title', 'content'],
  },
  module: {
    table: 'module',
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
  exn: {
    table: 'exhibit_node',
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
const KEY_COLUMNS = [
  { table: 'entity_relation', cols: ['from_key', 'to_key'] },
  { table: 'sketch_pin', cols: ['linker_key'] },
  { table: 'design_node', cols: ['linker_key'] },
  { table: 'exhibit_node', cols: ['linker_key'] },
  { table: 'exhibit_view', cols: ['bg_linker_key'] },
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

module.exports = { ENTITY_KINDS, KEY_COLUMNS, entityKeyMaps };
