'use strict';
const { getDB } = require('./core');
const wiki = require('./wiki');
const versions = require('./versions');

// ═══ Category "Classifier" (Phase 5) ══════════════════════════════════
// A 'classifier'-kind module row IS the category; classifier_object rows
// are its members. See core.js's schema comment for why this is a
// parallel schema rather than a reuse of Director's object_category/
// object_template/object/object_attribute.

const setCatType = (moduleId, catType) =>
  getDB().prepare(`UPDATE module SET cat_type=?, update_at=datetime('now') WHERE id=?`).run(catType, moduleId);

// ── Objects ─────────────────────────────────────────────────────────────
const getObjects = (moduleRef) => getDB().prepare(`
  SELECT o.*, uc.color_code FROM classifier_object o
  LEFT JOIN use_color uc ON uc.id = o.color
  WHERE o.module_ref=? ORDER BY o.display_order, o.id
`).all(moduleRef);

// Objects are wikilink targets/sources under the cobj_<id> key kind
// (added in Phase 14 — [[Name]] typed before this resolved to nothing).
const nexusOfObjectRow = (id) => getDB().prepare(`
  SELECT m.nexus_ref FROM classifier_object o JOIN module m ON o.module_ref=m.id WHERE o.id=?
`).get(id)?.nexus_ref ?? null;

function createObject(moduleRef, name, colorId, icon) {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_object WHERE module_ref=?`).get(moduleRef).m;
  const id = d.prepare(`INSERT INTO classifier_object (module_ref, name, color, icon, display_order) VALUES (?,?,?,?,?)`)
    .run(moduleRef, name, colorId || null, icon || null, maxOrder + 1).lastInsertRowid;
  wiki.resolveDanglingLinks(name, nexusOfObjectRow(id));
  versions.recordVersion(moduleRef, 'object', `+ ${name}`,
    { op: 'classifierObjectDelete', args: { objectId: id } });
  return id;
}

const updateObject = (id, name, colorId, icon) => {
  const cur = getDB().prepare(`SELECT name, color, icon, module_ref FROM classifier_object WHERE id=?`).get(id);
  const r = getDB().prepare(`UPDATE classifier_object SET name=?, color=?, icon=?, update_at=datetime('now') WHERE id=?`).run(name, colorId || null, icon || null, id);
  if (cur && cur.name !== name) wiki.renameWikiTarget(`cobj_${id}`, cur.name, name);
  if (cur && (cur.name !== name || (cur.color || null) !== (colorId || null) || (cur.icon || null) !== (icon || null))) {
    versions.recordVersion(cur.module_ref, 'objectEdit', `${cur.name}${cur.name !== name ? ` → ${name}` : ''}`,
      { op: 'classifierObject', args: { objectId: id, name: cur.name, colorId: cur.color, icon: cur.icon } });
  }
  return r;
};

// Not reachable from the renderer (V5.md §7.4 retired the IPC) — the note
// column has no UI. Kept for the two data-layer callers that still write it:
// migrate_v3 carrying a legacy object's note across, and version restore.
const updateObjectNote = (id, note) => {
  const r = getDB().prepare(`UPDATE classifier_object SET note=?, update_at=datetime('now') WHERE id=?`).run(note, id);
  wiki.reindexSource('cobj', id); // note + text field values, db/wiki-sources.js
  return r;
};

const deleteObject = (id) => {
  const prev = getDB().prepare(`SELECT * FROM classifier_object WHERE id=?`).get(id);
  const r = getDB().prepare(`DELETE FROM classifier_object WHERE id=?`).run(id);
  getDB().prepare(`DELETE FROM wiki_link WHERE src_key=?`).run(`cobj_${id}`);
  if (prev) versions.recordVersion(prev.module_ref, 'objectDel', prev.name,
    { op: 'classifierObjectInsert', args: { moduleRef: prev.module_ref, name: prev.name, colorId: prev.color, icon: prev.icon, note: prev.note } });
  return r;
};

// Duplicate (V5.md §7.4 object menu): the row, every attribute value, every
// level row, and its private fields — one transaction, placed right after the
// original.
function duplicateObject(id, copyName) {
  const d = getDB();
  const o = d.prepare(`SELECT * FROM classifier_object WHERE id=?`).get(id);
  if (!o) return null;
  return d.transaction(() => {
    d.prepare(`UPDATE classifier_object SET display_order=display_order+1 WHERE module_ref=? AND display_order>?`).run(o.module_ref, o.display_order);
    const name = copyName || `${o.name} (2)`;
    const nid = d.prepare(`INSERT INTO classifier_object (module_ref, name, color, icon, display_order) VALUES (?,?,?,?,?)`)
      .run(o.module_ref, name, o.color, o.icon, o.display_order + 1).lastInsertRowid;
    const tplMap = new Map();
    for (const tp of d.prepare(`SELECT * FROM classifier_template WHERE object_ref=?`).all(id)) {
      tplMap.set(tp.id, d.prepare(`INSERT INTO classifier_template (module_ref, object_ref, description, attribute_type, levelable, has_condition, display_order)
        VALUES (?,?,?,?,?,?,?)`).run(tp.module_ref, nid, tp.description, tp.attribute_type, tp.levelable, tp.has_condition, tp.display_order).lastInsertRowid);
    }
    const tpl = (tid) => tplMap.get(tid) ?? tid;
    for (const a of d.prepare(`SELECT * FROM classifier_attribute WHERE object_ref=?`).all(id)) {
      d.prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value, condition_value) VALUES (?,?,?,?)`)
        .run(nid, tpl(a.template_ref), a.attribute_value, a.condition_value);
    }
    for (const l of d.prepare(`SELECT * FROM classifier_level WHERE object_ref=?`).all(id)) {
      d.prepare(`INSERT INTO classifier_level (object_ref, template_ref, level_label, condition_value, info_value, display_order) VALUES (?,?,?,?,?,?)`)
        .run(nid, tpl(l.template_ref), l.level_label, l.condition_value, l.info_value, l.display_order);
    }
    wiki.resolveDanglingLinks(name, nexusOfObjectRow(nid));
    versions.recordVersion(o.module_ref, 'object', `+ ${name}`, { op: 'classifierObjectDelete', args: { objectId: nid } });
    wiki.reindexSource('cobj', nid); // the copied values carry their [[links]] too
    return nid;
  })();
}

// Move to another Classifier (§7.4). Values live under the SOURCE's shared
// fields, so each one is re-pointed at the target's field of the same name —
// created there if missing — rather than dropped. Private fields travel with
// the object. The cobj_<id> key is unchanged, so links and relations follow.
function moveObject(id, targetModuleRef) {
  const d = getDB();
  const o = d.prepare(`SELECT * FROM classifier_object WHERE id=?`).get(id);
  if (!o || o.module_ref === targetModuleRef) return false;
  const target = d.prepare(`SELECT id, kind FROM module WHERE id=?`).get(targetModuleRef);
  if (!target || target.kind !== 'classifier') return false;
  d.transaction(() => {
    const byName = new Map(getTemplates(targetModuleRef).map((tp) => [tp.description.toLowerCase(), tp.id]));
    const remap = new Map();
    for (const tp of getTemplates(o.module_ref)) {
      let tid = byName.get(tp.description.toLowerCase());
      if (tid == null) {
        tid = createTemplate(targetModuleRef, tp.description, tp.attribute_type, tp.levelable, tp.has_condition, null);
        byName.set(tp.description.toLowerCase(), tid);
      }
      remap.set(tp.id, tid);
    }
    for (const [from, to] of remap) {
      // OR IGNORE: two source fields with the same name land on one target
      // field; the first value wins and the leftover row is cleared below.
      d.prepare(`UPDATE OR IGNORE classifier_attribute SET template_ref=? WHERE object_ref=? AND template_ref=?`).run(to, id, from);
      d.prepare(`DELETE FROM classifier_attribute WHERE object_ref=? AND template_ref=?`).run(id, from);
      d.prepare(`UPDATE classifier_level SET template_ref=? WHERE object_ref=? AND template_ref=?`).run(to, id, from);
    }
    d.prepare(`UPDATE classifier_template SET module_ref=? WHERE object_ref=?`).run(targetModuleRef, id);
    const top = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_object WHERE module_ref=?`).get(targetModuleRef).m;
    d.prepare(`UPDATE classifier_object SET module_ref=?, display_order=?, update_at=datetime('now') WHERE id=?`).run(targetModuleRef, top + 1, id);
  })();
  wiki.reindexSource('cobj', id); // a value dropped by a same-name merge takes its links with it
  return true;
}

// ── Templates ───────────────────────────────────────────────────────────
// Shared (object_ref NULL) — every object in the category gets these.
const getTemplates = (moduleRef) => getDB().prepare(`
  SELECT * FROM classifier_template WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id
`).all(moduleRef);

// Shared + this object's own private fields (any number, any category —
// V5.md §7.4; this used to be one field, Character type only).
const getObjectTemplates = (moduleRef, objectRef) => getDB().prepare(`
  SELECT * FROM classifier_template WHERE module_ref=? AND (object_ref IS NULL OR object_ref=?) ORDER BY display_order, id
`).all(moduleRef, objectRef);

// level_steps is no longer written (V5.md §7.4: stages are classifier_level
// rows per element since Process 8); the column stays in vault.sql, unread,
// until a breaking SDB release drops it.
function createTemplate(moduleRef, description, attributeType, levelable, hasCondition, objectRef) {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_template WHERE module_ref=?`).get(moduleRef).m;
  return d.prepare(`
    INSERT INTO classifier_template (module_ref, object_ref, description, attribute_type, levelable, has_condition, display_order)
    VALUES (?,?,?,?,?,?,?)
  `).run(moduleRef, objectRef || null, description, attributeType || 'text', levelable ? 1 : 0, hasCondition ? 1 : 0, maxOrder + 1).lastInsertRowid;
}

const updateTemplate = (id, description, attributeType, levelable, hasCondition) => {
  const prev = getDB().prepare(`SELECT * FROM classifier_template WHERE id=?`).get(id);
  const r = getDB().prepare(`
    UPDATE classifier_template SET description=?, attribute_type=?, levelable=?, has_condition=?, update_at=datetime('now') WHERE id=?
  `).run(description, attributeType || 'text', levelable ? 1 : 0, hasCondition ? 1 : 0, id);
  // A date field is not free text, so switching the type moves its values
  // in or out of the object's indexed text.
  if (prev && (prev.attribute_type || 'text') !== (attributeType || 'text')) {
    for (const oid of objectsWithValuesOf(id)) wiki.reindexSource('cobj', oid);
  }
  if (prev) versions.recordVersion(prev.module_ref, 'template', `${prev.description} → ${description}`,
    { op: 'classifierTemplate', args: { templateId: id, description: prev.description, attributeType: prev.attribute_type, levelable: prev.levelable, hasCondition: prev.has_condition } });
  return r;
};

// A field's values leave every object's indexed text with it (v5 Part 4 —
// field values hold [[links]], db/wiki-sources.js 'cobj').
const objectsWithValuesOf = (templateId) => getDB()
  .prepare(`SELECT DISTINCT object_ref AS id FROM classifier_attribute WHERE template_ref=? AND attribute_value LIKE '%[[%'`)
  .all(templateId).map((r) => r.id);

const deleteTemplate = (id) => {
  const touched = objectsWithValuesOf(id);
  const r = getDB().prepare(`DELETE FROM classifier_template WHERE id=?`).run(id);
  for (const oid of touched) wiki.reindexSource('cobj', oid);
  return r;
};

// ── Attribute values ───────────────────────────────────────────────────
const getAttrs = (objectId) => getDB().prepare(`
  SELECT ca.*, ct.description, ct.attribute_type, ct.levelable, ct.has_condition, ct.object_ref AS template_object_ref
  FROM classifier_attribute ca JOIN classifier_template ct ON ca.template_ref = ct.id
  WHERE ca.object_ref=?
`).all(objectId);

// ── Composite read (Plan part2 #2.1) ───────────────────────────────────
// Everything mod/classifier.js's loadClassifierData needs, in one call.
// It used to issue 4 + 2N IPC round-trips (getObjects + getTemplates +
// getUi, then getAttrs + getObjectTemplates PER OBJECT); the two per-object
// queries are the same two tables scoped to the module instead of the row,
// so they collapse into one pass each and the attrMap/privateTemplates
// hydration moves here. The single-object case (ITEM_KIND.classifier's
// renderBody in src/renderer/mod/item.js) deliberately keeps its own
// getAttrs + getObjectTemplates pair — 1 object is not a fan-out — so it
// still builds the same shape by hand; keep the two in step.
function getObjectsFull(moduleRef) {
  const d = getDB();
  return d.readTx(() => {
    const objects = getObjects(moduleRef);
    const templates = getTemplates(moduleRef);
    // getAttrs's SQL, scoped to the module rather than one object.
    const attrs = d.prepare(`
      SELECT ca.*, ct.description, ct.attribute_type, ct.levelable, ct.has_condition, ct.object_ref AS template_object_ref
      FROM classifier_attribute ca
      JOIN classifier_template ct ON ca.template_ref = ct.id
      JOIN classifier_object o ON ca.object_ref = o.id
      WHERE o.module_ref=?
    `).all(moduleRef);
    // Private (per-object) templates for every object at once. Shared ones
    // are already in `templates`, so this only needs object_ref NOT NULL.
    const privTpls = d.prepare(`
      SELECT * FROM classifier_template
      WHERE module_ref=? AND object_ref IS NOT NULL ORDER BY display_order, id
    `).all(moduleRef);
    const attrsByObj = new Map();
    for (const a of attrs) {
      if (!attrsByObj.has(a.object_ref)) attrsByObj.set(a.object_ref, []);
      attrsByObj.get(a.object_ref).push(a);
    }
    const privByObj = new Map();
    for (const tp of privTpls) {
      if (!privByObj.has(tp.object_ref)) privByObj.set(tp.object_ref, []);
      privByObj.get(tp.object_ref).push(tp);
    }
    // Level rows for the whole module in one pass, same fan-out reasoning as
    // attrs above — keyed object -> template -> rows so a detail row can pull
    // its own table without filtering the module's whole set every render.
    const lvlByObj = new Map();
    for (const l of getLevelsForModule(moduleRef)) {
      if (!lvlByObj.has(l.object_ref)) lvlByObj.set(l.object_ref, {});
      const byTpl = lvlByObj.get(l.object_ref);
      (byTpl[l.template_ref] ||= []).push(l);
    }
    for (const o of objects) {
      o.attrMap = {};
      o.levelMap = lvlByObj.get(o.id) || {};
      for (const a of (attrsByObj.get(o.id) || [])) o.attrMap[a.template_ref] = a.attribute_value;
      o.privateTemplates = (privByObj.get(o.id) || [])
        .map(tp => ({ id: tp.id, description: tp.description, value: o.attrMap[tp.id] || '' }));
    }
    return { objects, templates };
  })();
}

const upsertAttr = (objectId, templateId, value) => {
  const d = getDB();
  const obj = d.prepare(`SELECT name, module_ref FROM classifier_object WHERE id=?`).get(objectId);
  const tpl = d.prepare(`SELECT description FROM classifier_template WHERE id=?`).get(templateId);
  const prev = d.prepare(`SELECT attribute_value FROM classifier_attribute WHERE object_ref=? AND template_ref=?`).get(objectId, templateId);
  const r = d.prepare(`
    INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)
    ON CONFLICT(object_ref, template_ref) DO UPDATE SET attribute_value=excluded.attribute_value, update_at=datetime('now')
  `).run(objectId, templateId, value);
  if (obj && (prev?.attribute_value ?? '') !== (value ?? '')) {
    versions.recordVersion(obj.module_ref, 'attr',
      `${obj.name} · ${tpl?.description ?? ''}: ${prev?.attribute_value ?? '—'} → ${value ?? ''}`,
      { op: 'classifierAttr', args: { objectId, templateId, value: prev?.attribute_value ?? '' } });
  }
  // Field values hold [[links]] (v5 Part 4) — reindex when a link could
  // have appeared or disappeared, not on every keystroke-save of plain text.
  if (/\[\[/.test(prev?.attribute_value ?? '') || /\[\[/.test(value ?? '')) wiki.reindexSource('cobj', objectId);
  return r;
};

// ── Level rows (Process 8 part 1) ──────────────────────────────────────
// One row per level stage, per (object, template). Supersedes the template's
// level_steps string: stages belong to the element, not the category, and
// level_label is free text so a user can write "Novice"/"II"/"9,000" rather
// than only a number. Which of the three value columns the UI shows is decided
// by the template's levelable/has_condition flags, but all three live here so
// a template that gains a flag later keeps whatever was already typed.
const getLevels = (objectId) => getDB().prepare(`
  SELECT * FROM classifier_level WHERE object_ref=? ORDER BY display_order, id
`).all(objectId);

// Module-scoped variant, for getObjectsFull's single-pass hydration.
const getLevelsForModule = (moduleRef) => getDB().prepare(`
  SELECT cl.* FROM classifier_level cl
  JOIN classifier_object o ON cl.object_ref = o.id
  WHERE o.module_ref=? ORDER BY cl.display_order, cl.id
`).all(moduleRef);

function createLevel(objectId, templateId) {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_level WHERE object_ref=? AND template_ref=?`)
    .get(objectId, templateId).m;
  return d.prepare(`INSERT INTO classifier_level (object_ref, template_ref, display_order) VALUES (?,?,?)`)
    .run(objectId, templateId, maxOrder + 1).lastInsertRowid;
}

// One cell at a time — each input saves on blur independently, so a whole-row
// update would clobber whatever the user is still typing in a sibling cell.
const updateLevelField = (id, field, value) => {
  if (!['level_label', 'condition_value', 'info_value'].includes(field)) throw new Error('bad level field');
  return getDB().prepare(`UPDATE classifier_level SET ${field}=?, update_at=datetime('now') WHERE id=?`).run(value, id);
};

const deleteLevel = (id) => getDB().prepare(`DELETE FROM classifier_level WHERE id=?`).run(id);

// Rewrites the whole order in one transaction from the list the UI dragged
// into shape — same shape as narrator.js's moveTalks. object_ref AND
// template_ref are both asserted in the UPDATE so a stale id, or one from a
// different attribute's row set, cannot be renumbered into this one.
function moveLevels(objectId, templateId, orderedIds) {
  const d = getDB();
  const st = d.prepare(`UPDATE classifier_level SET display_order=?, update_at=datetime('now')
    WHERE id=? AND object_ref=? AND template_ref=?`);
  d.transaction(() => {
    (orderedIds || []).forEach((id, idx) => st.run(idx, id, objectId, templateId));
  })();
}

module.exports = {
  setCatType,
  getObjects, createObject, updateObject, updateObjectNote, deleteObject, duplicateObject, moveObject,
  getTemplates, getObjectTemplates, createTemplate, updateTemplate, deleteTemplate,
  getAttrs, getObjectsFull, upsertAttr,
  getLevels, getLevelsForModule, createLevel, updateLevelField, deleteLevel, moveLevels,
};
