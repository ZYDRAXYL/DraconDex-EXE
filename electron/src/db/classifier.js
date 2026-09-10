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

const getObject = (id) => getDB().prepare(`
  SELECT o.*, uc.color_code FROM classifier_object o LEFT JOIN use_color uc ON uc.id = o.color WHERE o.id=?
`).get(id);

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

const updateObjectNote = (id, note) => {
  const r = getDB().prepare(`UPDATE classifier_object SET note=?, update_at=datetime('now') WHERE id=?`).run(note, id);
  wiki.reindexWikiLinks(`cobj_${id}`, note, nexusOfObjectRow(id));
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

// ── Templates ───────────────────────────────────────────────────────────
// Shared (object_ref NULL) — every object in the category gets these.
const getTemplates = (moduleRef) => getDB().prepare(`
  SELECT * FROM classifier_template WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id
`).all(moduleRef);

// Shared + this object's own private template (Character type only).
const getObjectTemplates = (moduleRef, objectRef) => getDB().prepare(`
  SELECT * FROM classifier_template WHERE module_ref=? AND (object_ref IS NULL OR object_ref=?) ORDER BY display_order, id
`).all(moduleRef, objectRef);

function createTemplate(moduleRef, description, attributeType, levelable, hasCondition, objectRef, levelSteps) {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_template WHERE module_ref=?`).get(moduleRef).m;
  return d.prepare(`
    INSERT INTO classifier_template (module_ref, object_ref, description, attribute_type, levelable, has_condition, level_steps, display_order)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(moduleRef, objectRef || null, description, attributeType || 'text', levelable ? 1 : 0, hasCondition ? 1 : 0, levelSteps || null, maxOrder + 1).lastInsertRowid;
}

const updateTemplate = (id, description, attributeType, levelable, hasCondition, levelSteps) => {
  const prev = getDB().prepare(`SELECT * FROM classifier_template WHERE id=?`).get(id);
  const r = getDB().prepare(`
    UPDATE classifier_template SET description=?, attribute_type=?, levelable=?, has_condition=?, level_steps=?, update_at=datetime('now') WHERE id=?
  `).run(description, attributeType || 'text', levelable ? 1 : 0, hasCondition ? 1 : 0, levelSteps || null, id);
  if (prev) versions.recordVersion(prev.module_ref, 'template', `${prev.description} → ${description}`,
    { op: 'classifierTemplate', args: { templateId: id, description: prev.description, attributeType: prev.attribute_type, levelable: prev.levelable, hasCondition: prev.has_condition, levelSteps: prev.level_steps } });
  return r;
};

const deleteTemplate = (id) => getDB().prepare(`DELETE FROM classifier_template WHERE id=?`).run(id);

// A Character-type object may hold exactly one private template — enforced
// here (not a DB constraint) since it's cheap and keeps the schema simple.
const countObjectTemplates = (objectRef) =>
  getDB().prepare(`SELECT COUNT(*) AS c FROM classifier_template WHERE object_ref=?`).get(objectRef).c;

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
      o.attrMap = {}; o.conditionMap = {};
      o.levelMap = lvlByObj.get(o.id) || {};
      for (const a of (attrsByObj.get(o.id) || [])) {
        o.attrMap[a.template_ref] = a.attribute_value;
        o.conditionMap[a.template_ref] = a.condition_value;
      }
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
  return r;
};

// Condition is metadata about an attribute's value, not the value itself —
// kept in its own column/upsert so every existing attribute_value consumer
// (Table view, saveClassifierAttrCell) stays untouched.
const upsertAttrCondition = (objectId, templateId, value) => getDB().prepare(`
  INSERT INTO classifier_attribute (object_ref, template_ref, condition_value) VALUES (?,?,?)
  ON CONFLICT(object_ref, template_ref) DO UPDATE SET condition_value=excluded.condition_value, update_at=datetime('now')
`).run(objectId, templateId, value);

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
  getObjects, getObject, createObject, updateObject, updateObjectNote, deleteObject,
  getTemplates, getObjectTemplates, createTemplate, updateTemplate, deleteTemplate, countObjectTemplates,
  getAttrs, getObjectsFull, upsertAttr, upsertAttrCondition,
  getLevels, getLevelsForModule, createLevel, updateLevelField, deleteLevel, moveLevels,
};
