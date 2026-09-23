'use strict';
// Data feeds behind the Exhibitor (v5; formerly the Viewer and Connector
// kinds, progress.md Phase 14). The file keeps its name because the IPC
// namespace (api.viewer.*) is read by half the renderer.
//  - viewerIndex: one flat list of every filterable content item in the
//    vault (classifier objects, timeline events, story dialogues, book
//    chapters, chat sessions, modules, assets), each tagged with its source
//    module and that module's hashtags, so filters evaluate live on open.
//  - entity_relation CRUD: labeled key->key edges, authored in an Exhibitor.
const { getDB } = require('./core');
const { scopedAll } = require('./sqlscope');
const { ENTITY_KINDS } = require('./entity-kinds');

// One read transaction around the 7 vault-wide scans + the hashtag roll-up —
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
  // v5 Part 7 (§11.2): one scan per family that declares an `index` in
  // db/entity-kinds.js — a family with `index: false` (note, exn) is left
  // out on purpose, and says why there.
  for (const k of Object.values(ENTITY_KINDS)) {
    if (k.index) push(k.index.sql, k.index.kind, k.index.row);
  }

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

// ── Relations (entity_relation) ─────────────────────────────────────────
// Vault-wide on purpose: Classifier, Chronicler, Narrator, Manager and the
// Exhibitor all read it. v5 (APP docs/V5.md §3.5): an Exhibitor is where
// relations are authored; module_ref records which one (provenance only).
const getEntityRelations = (nexusId) => getDB().prepare(`
  SELECT er.*, uc.color_code FROM entity_relation er
  LEFT JOIN use_color uc ON uc.id = er.color
  WHERE er.nexus_ref=? ORDER BY er.id
`).all(nexusId);

// INSERT OR IGNORE rather than ON CONFLICT(...): the v5 duplicate guard is
// the expression index idx_entity_relation_v5 (NULL-safe on label/rel_type),
// which no ON CONFLICT column list can name. On a duplicate the existing
// row's id comes back, so callers can treat create as idempotent.
function createEntityRelation(nexusId, fromKey, toKey, label, colorId, opts = {}) {
  const d = getDB();
  const relType = opts.relType ? String(opts.relType).trim() || null : null;
  const r = d.prepare(`
    INSERT OR IGNORE INTO entity_relation (nexus_ref, from_key, to_key, label, color, rel_type, directed, module_ref)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(nexusId, fromKey, toKey, label || null, colorId || null, relType,
         opts.directed === false || opts.directed === 0 ? 0 : 1, opts.moduleRef ?? null);
  if (r.changes) return r.lastInsertRowid;
  return d.prepare(`
    SELECT id FROM entity_relation WHERE from_key=? AND to_key=?
      AND COALESCE(label,'')=COALESCE(?,'') AND COALESCE(rel_type,'')=COALESCE(?,'')
  `).get(fromKey, toKey, label || null, relType)?.id ?? null;
}

// colorId===undefined preserves the current color instead of wiping it, and
// opts (rel_type / directed) are only written when the caller passes them —
// so a plain label edit from any older call site changes nothing else.
function updateEntityRelation(id, label, colorId, opts) {
  const d = getDB();
  if (colorId === undefined) d.prepare(`UPDATE entity_relation SET label=? WHERE id=?`).run(label || null, id);
  else d.prepare(`UPDATE entity_relation SET label=?, color=? WHERE id=?`).run(label || null, colorId || null, id);
  if (opts && 'relType' in opts) {
    d.prepare(`UPDATE entity_relation SET rel_type=? WHERE id=?`).run(opts.relType ? String(opts.relType).trim() || null : null, id);
  }
  if (opts && 'directed' in opts) {
    d.prepare(`UPDATE entity_relation SET directed=? WHERE id=?`).run(opts.directed ? 1 : 0, id);
  }
}

const deleteEntityRelation = (id) =>
  getDB().prepare(`DELETE FROM entity_relation WHERE id=?`).run(id);

// Distinct rel_type values in use, for the Exhibitor's relation form.
const getRelationTypes = (nexusId) => getDB().prepare(`
  SELECT DISTINCT rel_type FROM entity_relation WHERE nexus_ref=? AND rel_type IS NOT NULL ORDER BY rel_type COLLATE NOCASE
`).all(nexusId).map((r) => r.rel_type);

module.exports = {
  viewerIndex,
  getEntityRelations, createEntityRelation, getRelationTypes, updateEntityRelation, deleteEntityRelation,
};
