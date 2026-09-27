'use strict';
// ═══ Pages made of blocks (v5 Part 8, APP docs/V5.md §12) ═══════════════
// A page is an ordered stack of page_block rows (schema in SDB's vault.sql).
// Which page a row belongs to is (module_ref, item_key):
//   item_key NULL        the module's own page
//   item_key '*'         the layout every element page of the module shares
//   item_key '<key>'     one element's own page, split off the shared one
// Property blocks (what module_attribute was) are rows too, but the page
// never stacks them one by one: the Properties component shows them as one
// list, so listBlocks leaves them out and listProps returns them.
//
// This file knows nothing about which components exist. The renderer owns
// that registry and hands ensurePage the default layout for a kind; a page
// is laid out once (module_ui 'pageInit'), so a user who removed every
// block does not get them back on the next open.
const { getDB } = require('./core');
const versions = require('./versions');
const wiki = require('./wiki');
const { normalizeAssetUrl } = require('./asset-media');

const STACK_TYPES = `block_type<>'property'`;
// '' is not a page: treat it as the module's own page (NULL).
const ik = (k) => (k === '' || k === undefined ? null : k);
const pageWhere = (itemKey) => (itemKey == null ? 'item_key IS NULL' : 'item_key=?');
const pageArgs = (moduleId, itemKey) => (itemKey == null ? [moduleId] : [moduleId, itemKey]);
const INIT_KEY = (itemKey) => (itemKey == null ? 'pageInit' : itemKey === '*' ? 'itemPageInit' : null);

const parseConfig = (b) => {
  if (!b) return b;
  let config = {};
  try { config = b.config ? JSON.parse(b.config) : {}; } catch (_) {}
  return { ...b, config };
};

const stackRows = (d, moduleId, itemKey) => d.prepare(`
  SELECT * FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)} AND ${STACK_TYPES}
  ORDER BY block_order, id`).all(...pageArgs(moduleId, itemKey));

// The page (module or element) whose text a block's content indexes under.
function reindexFor(moduleId, itemKey) {
  try {
    if (itemKey == null) wiki.reindexSource('module', moduleId);
    else if (/^cobj_\d+$/.test(itemKey)) wiki.reindexSource('cobj', Number(itemKey.slice(5)));
  } catch (_) { /* a source this build does not index */ }
}

// { blocks, from } — from: 'own' | 'shared' (an element page on the '*'
// layout) | 'none'. An element page falls back to the shared layout until
// it is split.
function listBlocks(moduleId, itemKey = null) {
  itemKey = ik(itemKey);
  const d = getDB();
  return d.readTx(() => {
    let rows = stackRows(d, moduleId, itemKey);
    let from = rows.length ? 'own' : 'none';
    if (!rows.length && itemKey != null && itemKey !== '*') {
      rows = stackRows(d, moduleId, '*');
      if (rows.length) from = 'shared';
    }
    return { blocks: rows.map(parseConfig), from };
  })();
}

const listProps = (moduleId, itemKey = null) => (itemKey = ik(itemKey), getDB()).prepare(`
  SELECT id, prop_name, prop_type, content, block_order FROM page_block
  WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_type='property'
  ORDER BY block_order, id`).all(...pageArgs(moduleId, itemKey));

// Lay a page out the first time it opens. `defaults` is [{type, component,
// config}] from the renderer's registry. Returns true when it laid one out.
function ensurePage(moduleId, itemKey, defaults) {
  itemKey = ik(itemKey);
  const key = INIT_KEY(itemKey);
  if (!key) return false;
  const d = getDB();
  return d.transaction(() => {
    const seen = d.prepare(`SELECT 1 FROM module_ui WHERE module_ref=? AND ui_key=?`).get(moduleId, key);
    if (seen) return false;
    if (!stackRows(d, moduleId, itemKey).length) {
      const ins = d.prepare(`INSERT INTO page_block (module_ref, item_key, block_type, component, config, content, block_order) VALUES (?,?,?,?,?,?,?)`);
      (defaults || []).forEach((b, i) => ins.run(moduleId, itemKey, b.type || 'component', b.component || null,
        b.config ? JSON.stringify(b.config) : null, b.content ?? null, i));
    }
    d.prepare(`INSERT OR IGNORE INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,'1')`).run(moduleId, key);
    return true;
  })();
}

function nextOrder(d, moduleId, itemKey) {
  return d.prepare(`SELECT COALESCE(MAX(block_order),-1)+1 AS n FROM page_block WHERE module_ref=? AND ${pageWhere(itemKey)}`)
    .get(...pageArgs(moduleId, itemKey)).n;
}

// b: {type, component, config, content, sourceKey, parentId, propName,
// propType, at}. `at` inserts before that index; default is the end.
function addBlock(moduleId, itemKey, b = {}) {
  itemKey = ik(itemKey);
  const d = getDB();
  return d.transaction(() => {
    let order = nextOrder(d, moduleId, itemKey);
    if (Number.isInteger(b.at)) {
      order = b.at;
      d.prepare(`UPDATE page_block SET block_order=block_order+1 WHERE module_ref=? AND ${pageWhere(itemKey)} AND block_order>=?`)
        .run(...pageArgs(moduleId, itemKey), order);
    }
    const id = d.prepare(`INSERT INTO page_block (module_ref, item_key, parent_id, block_type, component, source_key, config, content, prop_name, prop_type, block_order)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(moduleId, itemKey ?? null, b.parentId ?? null, b.type || 'component',
      b.component ?? null, b.sourceKey ?? null, b.config ? JSON.stringify(b.config) : null, b.content ?? null,
      b.propName ?? null, b.propType ?? null, order).lastInsertRowid;
    versions.recordVersion(moduleId, 'block', b.propName || b.component || b.type || 'text',
      { op: 'blockRemove', args: { id } });
    if (b.content) reindexFor(moduleId, itemKey);
    return id;
  })();
}

const getBlock = (id) => parseConfig(getDB().prepare(`SELECT * FROM page_block WHERE id=?`).get(id));

// patch: any of {content, config, propName, propType, sourceKey, parentId}.
function updateBlock(id, patch = {}) {
  const d = getDB();
  const prev = d.prepare(`SELECT * FROM page_block WHERE id=?`).get(id);
  if (!prev) return false;
  const cols = { content: 'content', propName: 'prop_name', propType: 'prop_type', sourceKey: 'source_key', parentId: 'parent_id' };
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(cols)) if (k in patch) { sets.push(`${col}=?`); vals.push(patch[k] ?? null); }
  if ('config' in patch) { sets.push('config=?'); vals.push(patch.config == null ? null : JSON.stringify(patch.config)); }
  if (!sets.length) return true;
  d.prepare(`UPDATE page_block SET ${sets.join(', ')}, update_at=datetime('now') WHERE id=?`).run(...vals, id);
  if ('content' in patch || 'propName' in patch) {
    if ((prev.content ?? '') !== (patch.content ?? prev.content ?? '') || 'propName' in patch) {
      versions.recordVersion(prev.module_ref, prev.block_type === 'property' ? 'attr' : 'block',
        `${prev.prop_name ? `${prev.prop_name}: ` : ''}${String(prev.content ?? '').slice(0, 60)}`,
        { op: 'blockUpdate', args: { id, content: prev.content, propName: prev.prop_name } });
    }
    reindexFor(prev.module_ref, prev.item_key);
  }
  return true;
}

// Move to index `to` within its page (0 = top).
function moveBlock(id, to) {
  const d = getDB();
  const b = d.prepare(`SELECT module_ref, item_key, block_type FROM page_block WHERE id=?`).get(id);
  if (!b) return false;
  return d.transaction(() => {
    const kinds = b.block_type === 'property' ? `block_type='property'` : STACK_TYPES;
    const ids = d.prepare(`SELECT id FROM page_block WHERE module_ref=? AND ${pageWhere(b.item_key)} AND ${kinds} ORDER BY block_order, id`)
      .all(...pageArgs(b.module_ref, b.item_key)).map((r) => r.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
    const up = d.prepare(`UPDATE page_block SET block_order=? WHERE id=?`);
    ids.forEach((x, i) => up.run(i, x));
    return true;
  })();
}

function deleteBlock(id) {
  const d = getDB();
  const prev = d.prepare(`SELECT * FROM page_block WHERE id=?`).get(id);
  if (!prev) return false;
  const kids = d.prepare(`SELECT * FROM page_block WHERE parent_id=?`).all(id);
  d.prepare(`DELETE FROM page_block WHERE id=?`).run(id);
  versions.recordVersion(prev.module_ref, prev.block_type === 'property' ? 'attrDel' : 'blockDel',
    prev.prop_name || prev.component || prev.block_type, { op: 'blockRestore', args: { rows: [prev, ...kids] } });
  if (prev.content) reindexFor(prev.module_ref, prev.item_key);
  return { ok: true, rows: [prev, ...kids] }; // what an Undo hands to restoreBlocks
}

// Put rows back exactly (ids included) — the undo of a delete.
function restoreBlocks(rows) {
  const d = getDB();
  const ins = d.prepare(`INSERT OR REPLACE INTO page_block (id, module_ref, item_key, parent_id, block_type, component, source_key, config, content, prop_name, prop_type, block_order, create_at, update_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  d.transaction(() => {
    for (const r of rows || []) {
      if (!d.prepare(`SELECT 1 FROM module WHERE id=?`).get(r.module_ref)) continue;
      ins.run(r.id, r.module_ref, r.item_key, r.parent_id, r.block_type, r.component, r.source_key, r.config,
        r.content, r.prop_name, r.prop_type, r.block_order, r.create_at, r.update_at);
    }
  })();
  const first = rows?.[0];
  if (first) reindexFor(first.module_ref, first.item_key);
  return true;
}

// Give one element its own copy of the shared layout, to change freely.
function splitItemPage(moduleId, itemKey) {
  if (!itemKey || itemKey === '*') return false;
  const d = getDB();
  return d.transaction(() => {
    if (stackRows(d, moduleId, itemKey).length) return false;
    const map = new Map();
    for (const r of stackRows(d, moduleId, '*')) {
      const id = d.prepare(`INSERT INTO page_block (module_ref, item_key, parent_id, block_type, component, source_key, config, content, prop_name, prop_type, block_order)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(moduleId, itemKey, r.parent_id == null ? null : (map.get(r.parent_id) ?? null),
        r.block_type, r.component, r.source_key, r.config, r.content, r.prop_name, r.prop_type, r.block_order).lastInsertRowid;
      map.set(r.id, id);
    }
    return true;
  })();
}

// Back to the shared layout: the element's own stack goes (its properties
// stay — they are the element's data, not its layout).
function revertItemPage(moduleId, itemKey) {
  if (!itemKey || itemKey === '*') return false;
  const d = getDB();
  const rows = stackRows(d, moduleId, itemKey);
  if (!rows.length) return false;
  d.prepare(`DELETE FROM page_block WHERE module_ref=? AND item_key=? AND ${STACK_TYPES}`).run(moduleId, itemKey);
  versions.recordVersion(moduleId, 'blockDel', itemKey, { op: 'blockRestore', args: { rows } });
  reindexFor(moduleId, itemKey);
  return true;
}

// An element was deleted: its page (override stack and properties) goes
// with it, and a borrowed component that showed it shows nothing.
function clearItemBlocks(key) {
  if (!key || key === '*') return;
  const d = getDB();
  d.prepare(`DELETE FROM page_block WHERE item_key=?`).run(key);
  d.prepare(`UPDATE page_block SET source_key=NULL WHERE source_key=?`).run(key);
}

// ── properties (module_attribute's replacement) ─────────────────────────
function setProp(moduleId, itemKey, id, name, value, type = 'text') {
  itemKey = ik(itemKey);
  if (id) {
    updateBlock(id, { propName: name, content: value, propType: type });
    return id;
  }
  return addBlock(moduleId, itemKey, { type: 'property', propName: name, propType: type, content: value });
}

// The Properties component's data in one round trip.
function getPageProps(moduleId, itemKey = null) {
  itemKey = ik(itemKey);
  const module = require('./module');
  return getDB().readTx(() => ({
    props: listProps(moduleId, itemKey),
    tags: itemKey == null ? module.getModuleTags(moduleId) : [],
    links: itemKey == null ? module.getModuleLinks(moduleId)
      : { outgoing: wiki.getOutgoingLinks(itemKey), backlinks: wiki.getBacklinks(itemKey) },
    ui: module.getModuleUi(moduleId),
  }))();
}

// The external address a page link points at (Procress 14, APP
// docs/TEMPLATES.md §7.2): read from the block's STORED config by a path
// (['links', 2], ['links', 0] …), never from a URL the renderer sends, and
// re-checked — http/https only — on the way out. A path into config.opts
// first, then config itself (a template written before options kept the
// same keys at the top). → the URL, or null.
const LINK_PATH_KEY = /^[a-z][a-zA-Z0-9]{0,30}$/;
function blockLinkUrl(blockId, path) {
  if (!Array.isArray(path) || !path.length || path.length > 6) return null;
  if (!path.every((p) => (typeof p === 'string' && LINK_PATH_KEY.test(p)) || (Number.isInteger(p) && p >= 0 && p < 1000))) return null;
  const b = getBlock(Number(blockId));
  if (!b?.config || typeof b.config !== 'object') return null;
  const walk = (o) => path.reduce((v, k) => (v != null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined), o);
  const link = walk(b.config.opts) ?? walk(b.config);
  const to = typeof link?.to === 'string' ? link.to : null;
  if (!to || !to.startsWith('url:')) return null;
  return normalizeAssetUrl(to.slice(4));
}

module.exports = {
  blockLinkUrl,
  listBlocks, listProps, ensurePage, addBlock, getBlock, updateBlock, moveBlock, deleteBlock,
  restoreBlocks, splitItemPage, revertItemPage, clearItemBlocks, setProp, getPageProps,
};
