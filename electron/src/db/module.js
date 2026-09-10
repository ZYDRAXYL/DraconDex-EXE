'use strict';
const { getDB } = require('./core');
const wiki = require('./wiki');
const versions = require('./versions');

const nexusOfModule = (id) => getDB().prepare(`SELECT nexus_ref FROM module WHERE id=?`).get(id)?.nexus_ref ?? null;

const SEL = `
  SELECT m.*, c.color_code, ic.color_code AS icon_color_code
  FROM module m
  LEFT JOIN use_color c  ON c.id  = m.color
  LEFT JOIN use_color ic ON ic.id = m.icon_color
`;

// Root modules (parent_id NULL) each carrying their descendants, recursively,
// at any depth (Plan part1 #4/#4-2 — a module can be nested arbitrarily deep,
// not just the old fixed Major/Minor two levels), ordered by display_order
// then id within each parent.
function getTree(nexusRef) {
  const rows = getDB().prepare(`${SEL} WHERE m.nexus_ref = ? ORDER BY m.parent_id IS NOT NULL, m.display_order, m.id`).all(nexusRef);
  const childrenByParent = new Map();
  for (const r of rows) {
    const key = r.parent_id ?? null;
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(r);
  }
  const attach = (m) => ({ ...m, children: (childrenByParent.get(m.id) || []).map(attach) });
  return (childrenByParent.get(null) || []).map(attach);
}

const getModule = (id) => getDB().prepare(`${SEL} WHERE m.id = ?`).get(id);

// Process 8 part 1. A handle is optional, so '' and whitespace normalize to
// NULL rather than to an empty string — the partial unique index only covers
// non-NULL rows, which is exactly what lets any number of modules stay
// handle-less. Charset is deliberately narrow (what a user could type after an
// @ without ambiguity); anything else throws rather than being silently
// rewritten, so the renderer can say which of the two rules was broken.
function normalizeHandle(handle) {
  const h = String(handle ?? '').trim();
  if (!h) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(h)) throw new Error('handle invalid');
  return h;
}

// Thrown rather than returned because the renderer's submitModuleForm already
// turns a throw into the handleTaken toast — same contract as nexus.js's
// assertNameFree. NOCASE so 'Hero' and 'hero' collide, matching the index.
function assertHandleFree(handle, nexusRef, exceptId = null) {
  if (handle == null) return;
  const clash = getDB()
    .prepare(`SELECT id FROM module WHERE nexus_ref=? AND handle=? COLLATE NOCASE AND id IS NOT ?`)
    .get(nexusRef, handle, exceptId);
  if (clash) throw new Error('handle already in use');
}

function createModule(data) {
  const d = getDB();
  const { nexus_ref, parent_id = null, name, kind, icon = null, icon_color = null, color = null, cat_type = null } = data;
  const handle = normalizeHandle(data.handle);
  assertHandleFree(handle, nexus_ref);
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM module WHERE nexus_ref=? AND parent_id IS ?`)
    .get(nexus_ref, parent_id).m;
  const id = d.prepare(`
    INSERT INTO module (nexus_ref, parent_id, name, kind, icon, icon_color, color, cat_type, handle, display_order)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(nexus_ref, parent_id, name, kind, icon, icon_color, color, cat_type, handle, maxOrder + 1).lastInsertRowid;
  // Process 8 part 1: 1 chronicler module = 1 timeline, so the line the user
  // would otherwise have to create by hand is seeded here rather than in
  // quickCreateModule — this is the one path every caller shares (the hub's
  // create menu, Artisan's wizard, subtree clone, module import), so none of
  // them can produce a chronicler stuck on the "no timeline yet" empty state.
  if (kind === 'chronicler') {
    try {
      d.prepare(`INSERT INTO timeline (line_name, module_ref, color) VALUES (?,?,?)`).run(name, id, color);
    } catch (e) {
      console.error('chronicler timeline seed error:', e);
    }
  }
  return id;
}

function updateModule(id, data) {
  const cur = getDB().prepare(`SELECT * FROM module WHERE id=?`).get(id);
  if (!cur) return;
  const { name = cur.name, icon = cur.icon, icon_color = cur.icon_color, color = cur.color, pinned = cur.pinned } = data;
  // 'handle' in data distinguishes "clear it" (explicit null/'') from "leave it
  // alone" — the partial-update callers (toggleModulePin, saveModuleIconLive,
  // saveModuleRename) pass neither and must not have their handle wiped.
  const handle = ('handle' in data) ? normalizeHandle(data.handle) : cur.handle;
  assertHandleFree(handle, cur.nexus_ref, id);
  getDB().prepare(`UPDATE module SET name=?, icon=?, icon_color=?, color=?, pinned=?, handle=?, update_at=datetime('now') WHERE id=?`)
    .run(name, icon, icon_color, color, pinned, handle, id);
  if (name !== cur.name) wiki.renameWikiTarget(`module_${id}`, cur.name, name);
}

// Duplicate a module and its whole descendant subtree (Plan part2 #1 —
// context-menu "Duplicate"). The clone is inserted as a sibling (same
// parent_id as the source), recursing through children/grandchildren/etc.
// so no data is silently dropped. Reuses createModule for column
// population rather than a second raw INSERT. pinned is always reset to 0
// on every cloned row — ponytail: a duplicate shouldn't clutter the pinned
// rail; clone-pinned-too can be added if a later request asks for it.
// handle is deliberately not copied either, for a harder reason than pinned:
// it is unique per vault, so a clone that carried it would throw in
// createModule and take the whole duplicate transaction down with it.
function cloneModuleSubtree(srcId, newParentId, isRoot) {
  const d = getDB();
  const src = d.prepare(`SELECT * FROM module WHERE id=?`).get(srcId);
  if (!src) return null;
  const newId = createModule({
    nexus_ref: src.nexus_ref,
    parent_id: newParentId,
    name: isRoot ? `${src.name} (Copy)` : src.name,
    kind: src.kind,
    icon: src.icon,
    icon_color: src.icon_color,
    color: src.color,
    cat_type: src.cat_type,
  });
  if (src.description) updateModuleDescription(newId, src.description);
  const children = d.prepare(`SELECT id FROM module WHERE parent_id=? ORDER BY display_order, id`).all(srcId);
  for (const c of children) cloneModuleSubtree(c.id, newId, false);
  return newId;
}

function duplicateModule(id) {
  const d = getDB();
  const src = d.prepare(`SELECT parent_id FROM module WHERE id=?`).get(id);
  if (!src) return null;
  let newId;
  const tx = d.transaction(() => { newId = cloneModuleSubtree(id, src.parent_id, true); });
  tx();
  return newId;
}

// Free text with [[wikilinks]] — reindexed on every save, same as object
// notes / Scribe notes (src/db/director.js updateObjectNote, src/db/scribe.js).
function updateModuleDescription(id, description) {
  const prev = getDB().prepare(`SELECT description FROM module WHERE id=?`).get(id)?.description ?? '';
  getDB().prepare(`UPDATE module SET description=?, update_at=datetime('now') WHERE id=?`).run(description, id);
  wiki.reindexWikiLinks(`module_${id}`, description, nexusOfModule(id));
  if (prev !== (description ?? '')) {
    versions.recordVersion(id, 'note', String(prev).slice(0, 60),
      { op: 'moduleDescription', args: { id, value: prev } });
  }
}

const deleteModule = (id) => getDB().prepare(`DELETE FROM module WHERE id=?`).run(id);

// Move a module to (possibly the same) parent and write display_order for
// every child of that parent in the given final order — one call covers
// both plain sibling reordering (newParentId unchanged) and reparenting
// (Plan part1 #4: a top-level module dropped onto another module becomes
// its child). Which moves are legal (top-level modules can go anywhere,
// nested ones are locked to their current parent) is enforced by the
// renderer before this is ever called — see hub.js's onNestDrop.
function moveModule(nexusRef, moduleId, newParentId, orderedSiblingIds) {
  const d = getDB();
  const tx = d.transaction(() => {
    d.prepare(`UPDATE module SET parent_id=? WHERE id=? AND nexus_ref=?`).run(newParentId, moduleId, nexusRef);
    orderedSiblingIds.forEach((id, idx) => {
      d.prepare(`UPDATE module SET display_order=? WHERE id=? AND nexus_ref=?`).run(idx, id, nexusRef);
    });
  });
  tx();
}

const countModules = (nexusRef) => getDB().prepare(`SELECT COUNT(*) AS c FROM module WHERE nexus_ref=?`).get(nexusRef).c;

// ═══ Nest content-item rows (Plan part2 #2.5) ═════════════════════════
// The Nest tree used to lazily fetch each expanded content module's items
// through that kind's own list-getter — 1 IPC per module, and chronicler
// was 1+M since it walked its timelines — with a full re-render firing
// per resolved fetch. This returns every content module's items for a
// whole nexus in one call, over the five content tables, so the tree loads
// together with the module tree and renders once. It also replaces the old
// module:getItemCounts chevron gate — the count is just the array length.
//
// Deliberately LIGHT rows: only the columns ITEM_KIND[kind].nameOf reads
// (src/renderer/mod/item.js), never SELECT * — book_chapter.chapter_content,
// timeline_event.story and chat_session.last_message would otherwise cross
// IPC for an entire vault. Opening an actual item still goes through the
// per-kind list-getter, which returns the full row.
// Ordering matches each kind's own list-getter exactly, since these rows
// are what the tree renders.
function getNestItems(nexusRef) {
  const d = getDB();
  return d.readTx(() => {
    const items = {};
    const add = (rows) => {
      for (const r of rows) {
        const { module_ref, ...item } = r;
        (items[module_ref] || (items[module_ref] = [])).push(item);
      }
    };
    add(d.prepare(`
      SELECT o.module_ref, o.id, o.name FROM classifier_object o
      JOIN module m ON o.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY o.module_ref, o.display_order, o.id
    `).all(nexusRef));
    // Flattened the way ITEM_KIND.chronicler.list does it: timelines by
    // line_name, then each timeline's events by start date. __parentId is
    // the timeline id, which the event inspector needs.
    add(d.prepare(`
      SELECT tl.module_ref, te.id, te.event_name, tl.id AS __parentId FROM timeline_event te
      JOIN timeline tl ON te.timeline_id=tl.id
      JOIN module m ON tl.module_ref=m.id
      LEFT JOIN timeline_date s ON te.start_at=s.id
      WHERE m.nexus_ref=?
      ORDER BY tl.module_ref, tl.line_name, s.years, s.month, s.day, s.hour, s.minute
    `).all(nexusRef));
    add(d.prepare(`
      SELECT ch.module_ref, ch.id, ch.name FROM book_chapter ch
      JOIN module m ON ch.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY ch.module_ref, ch.chapter_order, ch.id
    `).all(nexusRef));
    add(d.prepare(`
      SELECT s.module_ref, s.id, s.name FROM chat_session s
      JOIN module m ON s.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY s.module_ref, s.session_order, s.id
    `).all(nexusRef));
    // design_node has no name column — nameOf() derives a label from
    // node_text (truncated at 24) or a shape glyph, and stays the authority
    // on that formatting. Capped at 64 chars here purely to bound payload;
    // the renderer's own 24-char slice is unaffected.
    add(d.prepare(`
      SELECT n.module_ref, n.id, SUBSTR(n.node_text,1,64) AS node_text, n.shape FROM design_node n
      JOIN module m ON n.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY n.module_ref, n.id
    `).all(nexusRef));
    return items;
  })();
}

// ═══ Module Inspector (Phase 4) ═══════════════════════════════════════
const getModuleAttrs = (moduleId) =>
  getDB().prepare(`SELECT * FROM module_attribute WHERE module_ref=? ORDER BY display_order, id`).all(moduleId);

function upsertModuleAttr(moduleId, attrId, name, value) {
  const d = getDB();
  if (attrId) {
    const prev = d.prepare(`SELECT * FROM module_attribute WHERE id=?`).get(attrId);
    d.prepare(`UPDATE module_attribute SET attr_name=?, attr_value=?, update_at=datetime('now') WHERE id=?`).run(name, value, attrId);
    if (prev) versions.recordVersion(moduleId, 'attr', `${prev.attr_name}: ${prev.attr_value ?? ''} → ${value ?? ''}`,
      { op: 'moduleAttr', args: { moduleId, attrId, name: prev.attr_name, value: prev.attr_value } });
    return attrId;
  }
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM module_attribute WHERE module_ref=?`).get(moduleId).m;
  const newId = d.prepare(`INSERT INTO module_attribute (module_ref, attr_name, attr_value, display_order) VALUES (?,?,?,?)`)
    .run(moduleId, name, value, maxOrder + 1).lastInsertRowid;
  versions.recordVersion(moduleId, 'attr', `+ ${name}`,
    { op: 'moduleAttrDelete', args: { attrId: newId } });
  return newId;
}

function deleteModuleAttr(id) {
  const prev = getDB().prepare(`SELECT * FROM module_attribute WHERE id=?`).get(id);
  const r = getDB().prepare(`DELETE FROM module_attribute WHERE id=?`).run(id);
  if (prev) versions.recordVersion(prev.module_ref, 'attrDel', prev.attr_name,
    { op: 'moduleAttr', args: { moduleId: prev.module_ref, attrId: null, name: prev.attr_name, value: prev.attr_value } });
  return r;
}

function getModuleUi(moduleId) {
  const rows = getDB().prepare(`SELECT ui_key, ui_value FROM module_ui WHERE module_ref=?`).all(moduleId);
  return rows.reduce((m, r) => (m[r.ui_key] = r.ui_value, m), {});
}

const setModuleUi = (moduleId, key, value) => getDB().prepare(`
  INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)
  ON CONFLICT(module_ref, ui_key) DO UPDATE SET ui_value=excluded.ui_value, update_at=datetime('now')
`).run(moduleId, key, value);

const getModuleTags = (moduleId) => getDB().prepare(`
  SELECT h.*, uc.color_code FROM hashtag h
  LEFT JOIN use_color uc ON h.tag_color = uc.id
  JOIN module_hashtag mh ON h.id = mh.hashtag_id WHERE mh.module_ref=? ORDER BY h.tag_name
`).all(moduleId);

function setModuleTags(moduleId, tags) {
  const d = getDB();
  // One transaction for the whole operation, not one per sub-step: the prev-tag
  // read, recordVersion's own write, and the delete/insert would otherwise be
  // three separate implicit-transaction / file-lock cycles. db.transaction is
  // reentrant, so recordVersion's inner transaction joins this one instead of
  // opening its own.
  return d.transaction(() => {
    const prev = d.prepare(`SELECT hashtag_id FROM module_hashtag WHERE module_ref=?`).all(moduleId).map(r => r.hashtag_id);
    versions.recordVersion(moduleId, 'tags', null,
      { op: 'moduleTags', args: { moduleId, tagIds: prev } });
    d.prepare(`DELETE FROM module_hashtag WHERE module_ref=?`).run(moduleId);
    const ins = d.prepare(`INSERT INTO module_hashtag (module_ref, hashtag_id) VALUES (?,?)`);
    for (const t of (tags || [])) ins.run(moduleId, t);
    return true;
  })();
}

// Outgoing/backlinks reuse the generic wiki_link index (src/db/wiki.js) keyed
// by `module_<id>` — see resolveWikiName/KEY_LOOKUPS there.
const getModuleLinks = (moduleId) => ({
  outgoing: wiki.getOutgoingLinks(`module_${moduleId}`),
  backlinks: wiki.getBacklinks(`module_${moduleId}`),
});

// Everything inspector.js's loadInspectorData needs, in one round-trip
// instead of four (Plan part2 #2.1). Key names are load-bearing — hub.js,
// mod/classifier.js and mod/manager.js all read S.inspectorData.{attrs,
// tags,links,ui} directly, and two of them patch .ui in place.
const getModuleInspector = (moduleId) => getDB().readTx(() => ({
  attrs: getModuleAttrs(moduleId),
  tags: getModuleTags(moduleId),
  links: getModuleLinks(moduleId),
  ui: getModuleUi(moduleId),
}))();

// Process 8 part 2: Manager's Table/Cards used to show each child's
// module_attribute count — a field almost nobody fills in, so the column read
// as "0" everywhere and said nothing about the tree. It is replaced by two
// counts that describe the tree itself, per direct child:
//   majors — every module BELOW that child, at any depth (itself excluded)
//   minors — that child's OWN minor elements
// Returns {childModuleId: {majors, minors}}, both defaulting to 0.
//
// The element tables are the wider 9-table set from db/sage.js, not
// getNestItems' 5: a Narrator or Locator child reporting 0 elements when it
// plainly holds some would read as a bug, not as "that kind has no items".
const CHILD_ELEMENT_COUNT_SQL = [
  `SELECT o.module_ref AS mid, COUNT(*) AS c FROM classifier_object o
     JOIN module m ON o.module_ref=m.id WHERE m.parent_id=? GROUP BY o.module_ref`,
  `SELECT tl.module_ref AS mid, COUNT(*) AS c FROM timeline_event te
     JOIN timeline tl ON te.timeline_id=tl.id JOIN module m ON tl.module_ref=m.id
     WHERE m.parent_id=? GROUP BY tl.module_ref`,
  `SELECT sd.module_ref AS mid, COUNT(*) AS c FROM story_dialogue sd
     JOIN module m ON sd.module_ref=m.id WHERE m.parent_id=? GROUP BY sd.module_ref`,
  `SELECT ch.module_ref AS mid, COUNT(*) AS c FROM book_chapter ch
     JOIN module m ON ch.module_ref=m.id WHERE m.parent_id=? GROUP BY ch.module_ref`,
  `SELECT s.module_ref AS mid, COUNT(*) AS c FROM chat_session s
     JOIN module m ON s.module_ref=m.id WHERE m.parent_id=? GROUP BY s.module_ref`,
  `SELECT sp.module_ref AS mid, COUNT(*) AS c FROM sketch_page sp
     JOIN module m ON sp.module_ref=m.id WHERE m.parent_id=? GROUP BY sp.module_ref`,
  `SELECT dn.module_ref AS mid, COUNT(*) AS c FROM design_node dn
     JOIN module m ON dn.module_ref=m.id WHERE m.parent_id=? GROUP BY dn.module_ref`,
  `SELECT me.module_ref AS mid, COUNT(*) AS c FROM map_event me
     JOIN module m ON me.module_ref=m.id WHERE m.parent_id=? GROUP BY me.module_ref`,
  `SELECT mp.module_ref AS mid, COUNT(*) AS c FROM map_point mp
     JOIN module m ON mp.module_ref=m.id WHERE m.parent_id=? GROUP BY mp.module_ref`,
];

function getChildModuleStats(parentId) {
  const d = getDB();
  return d.readTx(() => {
    const out = {};
    const row = (id) => (out[id] || (out[id] = { majors: 0, minors: 0 }));
    for (const c of d.prepare(`SELECT id FROM module WHERE parent_id=?`).all(parentId)) row(c.id);
    // One walk down from each direct child; the child seeds its own group, so
    // COUNT(*)-1 is "everything below it".
    for (const r of d.prepare(`
      WITH RECURSIVE sub(id, root) AS (
        SELECT id, id FROM module WHERE parent_id=?
        UNION ALL
        SELECT m.id, s.root FROM module m JOIN sub s ON m.parent_id=s.id
      )
      SELECT root, COUNT(*) - 1 AS majors FROM sub GROUP BY root
    `).all(parentId)) row(r.root).majors = r.majors;
    for (const sql of CHILD_ELEMENT_COUNT_SQL) {
      // A vault whose schema predates one of these tables must not take the
      // whole panel down over it — same tolerance db/sage.js's roll-up has.
      try {
        for (const r of d.prepare(sql).all(parentId)) row(r.mid).minors += r.c;
      } catch (_) {}
    }
    return out;
  })();
}

module.exports = {
  getTree, getModule, createModule, updateModule, updateModuleDescription, deleteModule,
  duplicateModule, moveModule, countModules, nexusOfModule, getNestItems,
  getModuleAttrs, upsertModuleAttr, deleteModuleAttr,
  getModuleUi, setModuleUi,
  getModuleTags, setModuleTags,
  getModuleLinks, getModuleInspector, getChildModuleStats,
};
