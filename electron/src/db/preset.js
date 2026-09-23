'use strict';
// ═══ Module presets (v5 Part 6, APP docs/V5.md §10.8) ════════════════════
// A preset is a starting point for ONE module of one kind: what it looks
// like and, for a Classifier, the fields it starts with. Built-in presets
// live in the renderer (hub/presets.js); this file stores the user's own in
// the vault's module_preset table — so a preset travels with its .ddx — and
// applies either kind to a freshly created module.
//
// spec (JSON), every field optional:
//   icon, color, iconColor   colour CODES, resolved to this vault's ids on apply
//   description
//   catType                  Classifier only: object | character | element
//   ui                       view settings from PRESET_UI_KEYS
//   fields                   Classifier only: [{ name, type, levelable, hasCondition }]
//
// Only settings that are about the module's shape are captured. filterDef,
// managerPicks, exhibitorFor and seedScene name other rows by id, so they
// would point at the wrong thing — or nothing — in the module a preset makes.
const { getDB } = require('./core');

const PRESET_UI_KEYS = ['activeView', 'view', 'boardGroupBy', 'calendarConfig'];
const CAT_TYPES = new Set(['object', 'character', 'element']);
const FIELD_TYPES = new Set(['text', 'textarea', 'date']);
const MAX_FIELDS = 40;

const colorCode = (d, id) => (id == null ? null : d.prepare(`SELECT color_code FROM use_color WHERE id=?`).get(id)?.color_code ?? null);
function colorId(d, code) {
  if (!code || !/^#[0-9a-fA-F]{3,8}$/.test(code)) return null;
  const hit = d.prepare(`SELECT id FROM use_color WHERE color_code=?`).get(code);
  return hit ? hit.id : d.prepare(`INSERT INTO use_color (color_code) VALUES (?)`).run(code).lastInsertRowid;
}

// Anything that did not come from capturePreset — a hand-edited row, a
// preset from an older app — is narrowed to the shape above here, once.
function cleanSpec(raw) {
  let s = raw;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = {}; } }
  if (!s || typeof s !== 'object' || Array.isArray(s)) s = {};
  const str = (v, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const out = {};
  if (str(s.icon)) out.icon = str(s.icon);
  for (const k of ['color', 'iconColor']) if (str(s[k], 16)) out[k] = str(s[k], 16);
  if (str(s.description, 4000)) out.description = str(s.description, 4000);
  if (CAT_TYPES.has(s.catType)) out.catType = s.catType;
  if (s.ui && typeof s.ui === 'object') {
    const ui = {};
    for (const k of PRESET_UI_KEYS) if (typeof s.ui[k] === 'string') ui[k] = s.ui[k].slice(0, 4000);
    if (Object.keys(ui).length) out.ui = ui;
  }
  if (Array.isArray(s.fields)) {
    out.fields = s.fields.slice(0, MAX_FIELDS).filter((f) => str(f?.name)).map((f) => ({
      name: str(f.name), type: FIELD_TYPES.has(f.type) ? f.type : 'text',
      levelable: !!f.levelable, hasCondition: !!f.hasCondition,
    }));
  }
  return out;
}

function capturePreset(moduleId) {
  const d = getDB();
  const m = d.prepare(`SELECT id, kind, icon, color, icon_color, description, cat_type FROM module WHERE id=?`).get(moduleId);
  if (!m) throw new Error('module not found');
  const spec = {
    icon: m.icon, color: colorCode(d, m.color), iconColor: colorCode(d, m.icon_color),
    description: m.description, catType: m.kind === 'classifier' ? m.cat_type : null,
    ui: Object.fromEntries(d.prepare(`SELECT ui_key, ui_value FROM module_ui WHERE module_ref=?`).all(moduleId)
      .filter((r) => PRESET_UI_KEYS.includes(r.ui_key)).map((r) => [r.ui_key, r.ui_value])),
  };
  if (m.kind === 'classifier') {
    // Shared fields only: a private field (object_ref set) belongs to one
    // element of THIS category, not to the shape of a new one.
    spec.fields = d.prepare(`
      SELECT description AS name, attribute_type AS type, levelable, has_condition AS hasCondition
      FROM classifier_template WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id`).all(moduleId);
  }
  return { kind: m.kind, spec: cleanSpec(spec) };
}

// Onto a module that was just created. Fields are appended after any the
// module already has, skipping names it already carries.
function applyPreset(moduleId, rawSpec) {
  const d = getDB();
  const m = d.prepare(`SELECT id, kind FROM module WHERE id=?`).get(moduleId);
  if (!m) throw new Error('module not found');
  const s = cleanSpec(rawSpec);
  const run = d.transaction(() => {
    const set = [], args = [];
    if (s.icon) { set.push('icon=?'); args.push(s.icon); }
    if (s.color) { set.push('color=?'); args.push(colorId(d, s.color)); }
    if (s.iconColor) { set.push('icon_color=?'); args.push(colorId(d, s.iconColor)); }
    if (s.description) { set.push('description=?'); args.push(s.description); }
    if (m.kind === 'classifier' && s.catType) { set.push('cat_type=?'); args.push(s.catType); }
    if (set.length) d.prepare(`UPDATE module SET ${set.join(', ')}, update_at=datetime('now') WHERE id=?`).run(...args, moduleId);
    for (const [k, v] of Object.entries(s.ui || {})) {
      d.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)
        ON CONFLICT(module_ref, ui_key) DO UPDATE SET ui_value=excluded.ui_value`).run(moduleId, k, v);
    }
    let added = 0;
    if (m.kind === 'classifier' && s.fields?.length) {
      const have = new Set(d.prepare(`SELECT description FROM classifier_template WHERE module_ref=? AND object_ref IS NULL`).all(moduleId).map((r) => r.description));
      let order = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM classifier_template WHERE module_ref=?`).get(moduleId).m;
      const ins = d.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, levelable, has_condition, display_order) VALUES (?,?,?,?,?,?)`);
      for (const f of s.fields) {
        if (have.has(f.name)) continue;
        ins.run(moduleId, f.name, f.type, f.levelable ? 1 : 0, f.hasCondition ? 1 : 0, ++order);
        have.add(f.name);
        added++;
      }
    }
    return { fields: added };
  });
  return run();
}

const listPresets = (nexusId, kind) => getDB().prepare(`
  SELECT id, kind, name, spec FROM module_preset WHERE nexus_ref=? AND (? IS NULL OR kind=?) ORDER BY kind, name COLLATE NOCASE`)
  .all(nexusId, kind ?? null, kind ?? null).map((r) => ({ ...r, spec: cleanSpec(r.spec) }));

// Same name for the same kind replaces — "save as preset" twice under one
// name is an update, not a duplicate.
function savePreset(nexusId, moduleId, name) {
  const n = String(name || '').trim().slice(0, 120);
  if (!n) throw new Error('name required');
  const { kind, spec } = capturePreset(moduleId);
  getDB().prepare(`
    INSERT INTO module_preset (nexus_ref, kind, name, spec) VALUES (?,?,?,?)
    ON CONFLICT(nexus_ref, kind, name) DO UPDATE SET spec=excluded.spec, update_at=datetime('now')`)
    .run(nexusId, kind, n, JSON.stringify(spec));
  return { kind, name: n };
}

const deletePreset = (id) => getDB().prepare(`DELETE FROM module_preset WHERE id=?`).run(id).changes;

module.exports = { PRESET_UI_KEYS, cleanSpec, capturePreset, applyPreset, listPresets, savePreset, deletePreset };
