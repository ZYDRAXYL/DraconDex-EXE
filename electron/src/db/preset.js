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
//   fields                   Classifier only: [{ name, type, options, levelable, hasCondition }]
//   tables                   Diviner only (v5 Part 7, §11.5): [{ name, dice, mode,
//                            entries: [{ text, weight, lo, hi, table }] }] — an
//                            entry's `table` is the INDEX of another table in the
//                            same preset, rolled in its place (the name generator)
//   page, itemPage           the module's page and its elements' shared page, as
//                            template blocks (Procress 14, TEMPLATES.md §3.3) — a
//                            preset IS a user's page template ("Mine" in the gallery)
//
// Only settings that are about the module's shape are captured. filterDef,
// managerPicks, exhibitorFor and seedScene name other rows by id, so they
// would point at the wrong thing — or nothing — in the module a preset makes.
const { getDB } = require('./core');

const PRESET_UI_KEYS = ['activeView', 'view', 'boardGroupBy', 'calendarConfig'];
const CAT_TYPES = new Set(['object', 'character', 'element']);
// Every Classifier field type (§11.3) — a preset of a Number or Relation
// field must stay one, not come back as Text.
const FIELD_TYPES = new Set(['text', 'textarea', 'date', 'number', 'select', 'multi', 'checkbox', 'url', 'relation', 'formula']);
const MAX_FIELDS = 40;
const MAX_TABLES = 20, MAX_ENTRIES = 200;
const MAX_BLOCKS = 60, MAX_BLOCK_JSON = 200000;

// Template blocks as stored: plain JSON, bounded. The renderer skips a
// component it does not know, so nothing here needs to know the registry.
function cleanBlocks(v) {
  if (!Array.isArray(v) || !v.length) return null;
  const walk = (list, depth) => (Array.isArray(list) ? list : []).slice(0, MAX_BLOCKS).filter((b) => b && typeof b === 'object').map((b) => {
    const o = {};
    if (typeof b.type === 'string') o.type = b.type.slice(0, 20);
    if (typeof b.component === 'string') o.component = b.component.slice(0, 60);
    if (b.config && typeof b.config === 'object' && !Array.isArray(b.config)) o.config = b.config;
    if (typeof b.content === 'string') o.content = b.content.slice(0, 20000);
    if (b.borrow === true || typeof b.borrow === 'string') o.borrow = b.borrow;
    if (Array.isArray(b.children) && depth < 2) o.children = b.children.slice(0, 3).map((c) => walk(c, depth + 1));
    return o;
  });
  const out = walk(v, 0);
  return JSON.stringify(out).length <= MAX_BLOCK_JSON ? out : null;
}

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
      ...(typeof f.key === 'string' && /^[a-z][a-zA-Z0-9]*$/.test(f.key) ? { key: f.key } : {}),
      ...(str(f.options, 4000) ? { options: str(f.options, 4000) } : {}),
      levelable: !!f.levelable, hasCondition: !!f.hasCondition,
    }));
  }
  if (Array.isArray(s.tables)) {
    const tabs = s.tables.slice(0, MAX_TABLES);
    const int = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));
    out.tables = tabs.filter((tb) => str(tb?.name)).map((tb) => ({
      name: str(tb.name), dice: str(tb.dice, 20), mode: tb.mode === 'join' ? 'join' : 'pick',
      entries: (Array.isArray(tb.entries) ? tb.entries : []).slice(0, MAX_ENTRIES).map((e) => ({
        text: str(e?.text, 1000) || '', weight: Math.max(0, int(e?.weight) ?? 1), lo: int(e?.lo), hi: int(e?.hi),
        table: Number.isInteger(e?.table) && e.table >= 0 && e.table < tabs.length ? e.table : null,
      })),
    }));
  }
  for (const k of ['page', 'itemPage']) { const b = cleanBlocks(s[k]); if (b) out[k] = b; }
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
      SELECT description AS name, attribute_type AS type, options, levelable, has_condition AS hasCondition
      FROM classifier_template WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id`).all(moduleId)
      .map((f) => { let key; try { key = JSON.parse(f.options || '{}')?.key; } catch (_) {} return key ? { ...f, key } : f; });
  }
  if (m.kind === 'diviner') {
    // Links between this module's own tables become indexes; a link to
    // anything else would name a row the new module cannot have, so it goes.
    const tabs = d.prepare(`SELECT id, name, dice, mode FROM diviner_table WHERE module_ref=? ORDER BY display_order, id`).all(moduleId);
    const idx = new Map(tabs.map((tb, i) => [`divt_${tb.id}`, i]));
    spec.tables = tabs.map((tb) => ({
      name: tb.name, dice: tb.dice, mode: tb.mode,
      entries: d.prepare(`SELECT entry_text, weight, range_lo, range_hi, linker_key FROM diviner_entry WHERE table_ref=? ORDER BY display_order, id`).all(tb.id)
        .map((e) => ({ text: e.entry_text || '', weight: e.weight, lo: e.range_lo, hi: e.range_hi, table: idx.get(e.linker_key) ?? null })),
    }));
  }
  Object.assign(spec, require('./page-template').captureTemplate(moduleId));
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
      const ins = d.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, levelable, has_condition, display_order, options) VALUES (?,?,?,?,?,?,?)`);
      const { optionsWithKey } = require('./page-template');
      for (const f of s.fields) {
        if (have.has(f.name)) continue;
        ins.run(moduleId, f.name, f.type, f.levelable ? 1 : 0, f.hasCondition ? 1 : 0, ++order, optionsWithKey(f.options, f.key));
        have.add(f.name);
        added++;
      }
    }
    let tables = 0;
    if (m.kind === 'diviner' && s.tables?.length) {
      let order = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM diviner_table WHERE module_ref=?`).get(moduleId).m;
      const ids = s.tables.map((tb) => d.prepare(`INSERT INTO diviner_table (module_ref, name, dice, mode, display_order) VALUES (?,?,?,?,?)`)
        .run(moduleId, tb.name, tb.dice, tb.mode, ++order).lastInsertRowid);
      s.tables.forEach((tb, i) => tb.entries.forEach((e, k) => d.prepare(`
        INSERT INTO diviner_entry (table_ref, weight, range_lo, range_hi, entry_text, linker_key, display_order) VALUES (?,?,?,?,?,?,?)`)
        .run(ids[i], e.weight, e.lo, e.hi, e.text, e.table != null ? `divt_${ids[e.table]}` : null, k)));
      tables = ids.length;
    }
    // The preset's page, last — its blocks may name the fields just added.
    let page = null;
    if (s.page || s.itemPage) {
      page = require('./page-template').applyTemplate(moduleId, { page: s.page, itemPage: s.itemPage }, { fields: false });
    }
    return { fields: added, tables, ...(page ? { page } : {}) };
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
