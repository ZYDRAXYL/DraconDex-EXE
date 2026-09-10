'use strict';
// Analys "Viewer" / Relation "Connector" (progress.md Phase 14).
// Both kinds are read-only lenses over a saved filter (module_ui key
// 'filterDef'); this module supplies the two data feeds:
//  - viewerIndex: one flat list of every filterable content item in the
//    vault (classifier objects, timeline events, story dialogues, book
//    chapters, chat sessions, modules), each tagged with its source
//    module and that module's hashtags, so filters evaluate live on open.
//  - entity_relation CRUD: the Connector's own labeled key->key edges.
const { getDB } = require('./core');
const { scopedAll } = require('./sqlscope');

// One read transaction around the 6 vault-wide scans + the hashtag roll-up —
// outside one, each statement pays its own file-lock cycle (~2.5ms vs ~6µs).
function viewerIndex(nexusId) {
  return getDB().readTx(() => _viewerIndex(nexusId))();
}
function _viewerIndex(nexusId) {
  const d = getDB();
  const nx = nexusId ?? null;
  const out = [];
  const push = (sql, kind, fn) => {
    try {
      for (const r of scopedAll(d, sql, nx)) out.push({ kind, ...fn(r) });
    } catch (_) {}
  };
  push(`SELECT o.id, o.name, uc.color_code, m.id mid, m.name mname, m.kind mkind
    FROM classifier_object o JOIN module m ON o.module_ref=m.id
    LEFT JOIN use_color uc ON uc.id=o.color WHERE (? IS NULL OR m.nexus_ref=?)`,
    'object', r => ({ key: `cobj_${r.id}`, name: r.name, color: r.color_code, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind }));
  push(`SELECT te.id, te.event_name AS name, uc.color_code, m.id mid, m.name mname, m.kind mkind,
      s.day, s.month, s.years, s.hour, s.minute
    FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id
    JOIN module m ON tl.module_ref=m.id
    LEFT JOIN use_color uc ON uc.id=te.color
    LEFT JOIN timeline_date s ON te.start_at=s.id WHERE (? IS NULL OR m.nexus_ref=?)`,
    'event', r => ({ key: `tlev_${r.id}`, name: r.name, color: r.color_code, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind,
      time: { day: r.day, month: r.month, years: r.years, hour: r.hour, minute: r.minute } }));
  push(`SELECT sd.id, sd.name, uc.color_code, m.id mid, m.name mname, m.kind mkind
    FROM story_dialogue sd JOIN module m ON sd.module_ref=m.id
    LEFT JOIN use_color uc ON uc.id=sd.color WHERE (? IS NULL OR m.nexus_ref=?)`,
    'dialogue', r => ({ key: `sdlg_${r.id}`, name: r.name, color: r.color_code, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind }));
  push(`SELECT ch.id, ch.name, ch.chapter_order, m.id mid, m.name mname, m.kind mkind
    FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
    'chapter', r => ({ key: `bchp_${r.id}`, name: r.name, color: null, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind }));
  push(`SELECT s.id, s.name, m.id mid, m.name mname, m.kind mkind
    FROM chat_session s JOIN module m ON s.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`,
    'chat', r => ({ key: `chss_${r.id}`, name: r.name, color: null, moduleId: r.mid, moduleName: r.mname, moduleKind: r.mkind }));
  push(`SELECT m.id, m.name, m.kind, m.handle, uc.color_code, pm.id mid, pm.name mname, pm.kind mkind
    FROM module m LEFT JOIN module pm ON m.parent_id=pm.id
    LEFT JOIN use_color uc ON uc.id=m.color WHERE (? IS NULL OR m.nexus_ref=?)`,
    'module', r => ({ key: `module_${r.id}`, name: r.name, handle: r.handle, color: r.color_code,
      moduleId: r.mid ?? r.id, moduleName: r.mname ?? r.name, moduleKind: r.mkind ?? r.kind }));

  // Source-module hashtags apply to every item of that module — the
  // filter's tag facet works on these.
  const tagRows = (() => {
    try {
      return d.prepare(`
        SELECT mh.module_ref, h.tag_name FROM module_hashtag mh
        JOIN hashtag h ON h.id=mh.hashtag_id
        JOIN module m ON m.id=mh.module_ref WHERE (? IS NULL OR m.nexus_ref=?)
      `).all(nx, nx);
    } catch (_) { return []; }
  })();
  const tagsByModule = new Map();
  for (const r of tagRows) {
    if (!tagsByModule.has(r.module_ref)) tagsByModule.set(r.module_ref, []);
    tagsByModule.get(r.module_ref).push(r.tag_name);
  }
  for (const it of out) {
    it.tags = tagsByModule.get(it.kind === 'module' ? Number(it.key.slice(7)) : it.moduleId) || [];
  }
  return out;
}

// ── Connector relations ─────────────────────────────────────────────────
// Also the data source for Classifier's relation view (Plan part5 #6) —
// entity_relation is a generic key->key table, not Connector-specific.
const getEntityRelations = (nexusId) => getDB().prepare(`
  SELECT er.*, uc.color_code FROM entity_relation er
  LEFT JOIN use_color uc ON uc.id = er.color
  WHERE er.nexus_ref=? ORDER BY er.id
`).all(nexusId);

const createEntityRelation = (nexusId, fromKey, toKey, label, colorId) => getDB().prepare(`
  INSERT INTO entity_relation (nexus_ref, from_key, to_key, label, color) VALUES (?,?,?,?,?)
  ON CONFLICT(from_key, to_key, label) DO NOTHING
`).run(nexusId, fromKey, toKey, label || null, colorId || null).lastInsertRowid;

// colorId===undefined (Connector's existing 2-arg call site) preserves the
// current color instead of wiping it — Connector never sets a color, so a
// plain label edit there must not clear one Classifier's modal set.
const updateEntityRelation = (id, label, colorId) => colorId === undefined
  ? getDB().prepare(`UPDATE entity_relation SET label=? WHERE id=?`).run(label || null, id)
  : getDB().prepare(`UPDATE entity_relation SET label=?, color=? WHERE id=?`).run(label || null, colorId || null, id);

const deleteEntityRelation = (id) =>
  getDB().prepare(`DELETE FROM entity_relation WHERE id=?`).run(id);

module.exports = {
  viewerIndex,
  getEntityRelations, createEntityRelation, updateEntityRelation, deleteEntityRelation,
};
