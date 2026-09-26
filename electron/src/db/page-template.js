'use strict';
// ═══ Page templates (Procress 14, APP docs/TEMPLATES.md §3) ══════════════
// templates/pages.json is VENDORED from DraconDex-SDB (templates/pages/,
// components.json) — do not hand-edit it; `npm run sdb:vendor` replaces it.
// A template is a module's page (and, for a kind with elements, the page
// its elements share) plus, for a Classifier, the fields it starts with.
//
// Blocks in a template are { type?, component?, config?, content?,
// children?, borrow? } — `columns` holds children as columns of blocks. A
// field is named by its `key` (config.field / config.fields); the key rides
// in the Classifier field's options, so a component finds it by key in any
// language. A `borrow` is a module ref inside a bundle (resolved by the
// caller's `refs`), or `true` in a standalone template — unbound, so it is
// left out and counted (the renderer says so).
//
// Applying replaces a page in one transaction and returns the rows it
// removed, so an Undo puts the old page back exactly (restorePageLayout).
const fs = require('fs');
const path = require('path');
const { getDB } = require('./core');
const { resolve } = require('./bundle-catalog');

const FILE = path.join(__dirname, '..', '..', 'templates', 'pages.json');
let _cache = null;
function load() {
  if (!_cache) {
    try { _cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { _cache = { components: [], templates: [], strings: {} }; }
  }
  return _cache;
}

// → { components, templates } with every string in `locale`.
function pageCatalog(locale = 'en') {
  const { components, templates, strings } = load();
  return { components, templates: templates.map((t) => resolve(t, strings, locale)) };
}
const findTemplate = (id, locale = 'en') => pageCatalog(locale).templates.find((t) => t.id === id) || null;

// A kind's ★ — for a Classifier, the ★ of its catType (TEMPLATES.md §3.2).
function defaultTemplate(kind, catType, locale = 'en') {
  const ts = pageCatalog(locale).templates.filter((t) => t.kind === kind && t.default);
  if (kind !== 'classifier') return ts[0] || null;
  return ts.find((t) => (t.for || []).includes(catType || 'object')) || ts.find((t) => (t.for || []).includes('object')) || null;
}

// A field's key rides in its options JSON (no schema change).
function optionsWithKey(options, key) {
  if (!key) return options ?? null;
  let o = {};
  if (typeof options === 'string') { try { o = JSON.parse(options || '{}') || {}; } catch (_) { o = {}; } }
  else if (options && typeof options === 'object') o = { ...options };
  return JSON.stringify({ ...o, key });
}

// Template blocks → a tree of rows to insert. refs: Map(ref → moduleId).
function layoutRows(blocks, refs = null) {
  let dropped = 0;
  const walk = (list) => (Array.isArray(list) ? list : []).map((b) => {
    if (!b || typeof b !== 'object') return null;
    const type = b.type || 'component';
    let sourceKey = null;
    if (b.borrow !== undefined) {
      const id = typeof b.borrow === 'string' && refs ? refs.get(b.borrow) : null;
      if (!id) { dropped++; return null; }
      sourceKey = `module_${id}`;
    }
    const row = { type, component: b.component || null, config: b.config ? { ...b.config } : null, content: b.content ?? null, sourceKey };
    if (type === 'columns' || Array.isArray(b.children)) {
      const cols = (b.children || []).map((col) => walk(col).filter(Boolean));
      row.children = cols;
      if (type === 'columns') row.config = { ...(row.config || {}), n: Math.min(3, Math.max(2, cols.length)) };
    }
    return row;
  }).filter(Boolean);
  const rows = walk(blocks);
  return { rows, dropped };
}

const pageWhere = (itemKey) => (itemKey == null ? 'item_key IS NULL' : 'item_key=?');
const pageArgs = (moduleId, itemKey) => (itemKey == null ? [moduleId] : [moduleId, itemKey]);
const INIT_KEY = (itemKey) => (itemKey == null ? 'pageInit' : 'itemPageInit');

// Insert a row tree onto a page (in the caller's transaction).
function insertRows(d, moduleId, itemKey, rows) {
  const ins = d.prepare(`INSERT INTO page_block (module_ref, item_key, parent_id, block_type, component, source_key, config, content, block_order)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const put = (list, parentId, col) => list.forEach((r, i) => {
    const config = col == null ? r.config : { ...(r.config || {}), col };
    const id = ins.run(moduleId, itemKey, parentId, r.type, r.component, r.sourceKey,
      config && Object.keys(config).length ? JSON.stringify(config) : null, r.content, i).lastInsertRowid;
    (r.children || []).forEach((kids, c) => put(kids, id, c));
  });
  put(rows, null, null);
}

// Replace one page (NULL = the module's, '*' = its elements') — its stacked
// blocks only; properties are the page's data, not its layout. → old rows.
function replacePage(d, moduleId, itemKey, rows) {
  const old = d.prepare(`SELECT * FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_type<>'property'`)
    .all(...pageArgs(moduleId, itemKey));
  d.prepare(`DELETE FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_type<>'property'`).run(...pageArgs(moduleId, itemKey));
  insertRows(d, moduleId, itemKey, rows);
  d.prepare(`INSERT OR IGNORE INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,'1')`).run(moduleId, INIT_KEY(itemKey));
  return old;
}

// Fields from a template's preset, onto a Classifier that has none yet —
// never onto one the user already shaped.
function addPresetFields(d, moduleId, preset) {
  const fields = Array.isArray(preset?.fields) ? preset.fields : [];
  if (!fields.length) return 0;
  const have = d.prepare(`SELECT COUNT(*) AS n FROM classifier_template WHERE module_ref=? AND object_ref IS NULL`).get(moduleId).n;
  if (have) return 0;
  const ins = d.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, levelable, has_condition, display_order, options) VALUES (?,?,?,?,?,?,?)`);
  fields.forEach((f, i) => ins.run(moduleId, String(f.name || f.key).slice(0, 200), f.type || 'text', f.levelable ? 1 : 0,
    f.hasCondition ? 1 : 0, i, optionsWithKey(f.options, f.key)));
  return fields.length;
}

// Apply a template (an id from pages.json, or a user's { page, itemPage,
// preset } from module_preset) to a module. opts: { locale, refs, fields }
// — fields: add the template's preset fields when the module has none.
function applyTemplate(moduleId, tplOrId, opts = {}) {
  const d = getDB();
  const m = d.prepare(`SELECT id, kind FROM module WHERE id=?`).get(moduleId);
  if (!m) throw new Error('module not found');
  const tpl = typeof tplOrId === 'string' ? findTemplate(tplOrId, opts.locale) : tplOrId;
  if (!tpl) return { ok: false, code: 'no_template' };
  return d.transaction(() => {
    const out = { ok: true, old: {}, dropped: 0, fields: 0 };
    if (m.kind === 'classifier' && opts.fields !== false) out.fields = addPresetFields(d, moduleId, tpl.preset);
    if (tpl.page) {
      const { rows, dropped } = layoutRows(tpl.page, opts.refs);
      out.old.page = replacePage(d, moduleId, null, rows);
      out.dropped += dropped;
    }
    if (tpl.itemPage) {
      const { rows, dropped } = layoutRows(tpl.itemPage, opts.refs);
      out.old.itemPage = replacePage(d, moduleId, '*', rows);
      out.dropped += dropped;
    }
    return out;
  })();
}

// Undo of applyTemplate: the pages it touched go back to their old rows.
function restorePageLayout(moduleId, old = {}) {
  const d = getDB();
  d.transaction(() => {
    for (const [which, rows] of Object.entries(old || {})) {
      const itemKey = which === 'itemPage' ? '*' : null;
      d.prepare(`DELETE FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_type<>'property'`).run(...pageArgs(moduleId, itemKey));
      const ins = d.prepare(`INSERT OR REPLACE INTO page_block (id, module_ref, item_key, parent_id, block_type, component, source_key, config, content, prop_name, prop_type, block_order, create_at, update_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const r of rows || []) ins.run(r.id, r.module_ref, r.item_key, r.parent_id, r.block_type, r.component, r.source_key,
        r.config, r.content, r.prop_name, r.prop_type, r.block_order, r.create_at, r.update_at);
    }
  })();
  return true;
}

// A page as template blocks — "Save this page as template…" (§3.3). A
// borrowed block becomes an unbound borrow: the module it showed is this
// vault's, not the template's. borrowRef(source_key) → a ref to keep it
// bound (a bundle capture), or null to leave the block out.
function capturePage(moduleId, itemKey, borrowRef = () => true) {
  const d = getDB();
  const rows = d.prepare(`SELECT * FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_type<>'property' ORDER BY block_order, id`)
    .all(...pageArgs(moduleId, itemKey));
  const kids = new Map();
  for (const r of rows) if (r.parent_id != null) (kids.get(r.parent_id) || kids.set(r.parent_id, []).get(r.parent_id)).push(r);
  const block = (r) => {
    let config = null;
    try { config = r.config ? JSON.parse(r.config) : null; } catch (_) {}
    if (config) delete config.col;
    const b = {};
    if (r.block_type !== 'component') b.type = r.block_type;
    if (r.component) b.component = r.component;
    if (r.source_key) {
      const to = borrowRef(r.source_key);
      if (to == null) return null;
      b.borrow = to;
    }
    if (r.content != null) b.content = r.content;
    if (r.block_type === 'columns') {
      const n = Math.min(3, Math.max(2, Number(config?.n) || 2));
      const cols = Array.from({ length: n }, () => []);
      for (const k of kids.get(r.id) || []) {
        let kc = {};
        try { kc = k.config ? JSON.parse(k.config) : {}; } catch (_) {}
        const kb = block(k);
        if (kb) cols[Math.min(n - 1, Math.max(0, Number(kc.col) || 0))].push(kb);
      }
      b.children = cols;
      if (config) delete config.n;
    }
    if (config && Object.keys(config).length) b.config = config;
    return b;
  };
  return rows.filter((r) => r.parent_id == null).map(block).filter(Boolean);
}

function captureTemplate(moduleId) {
  const page = capturePage(moduleId, null);
  const itemPage = capturePage(moduleId, '*');
  return { ...(page.length ? { page } : {}), ...(itemPage.length ? { itemPage } : {}) };
}

module.exports = {
  pageCatalog, findTemplate, defaultTemplate, optionsWithKey, layoutRows, insertRows,
  replacePage, applyTemplate, restorePageLayout, capturePage, captureTemplate,
};
