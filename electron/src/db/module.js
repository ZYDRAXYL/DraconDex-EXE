'use strict';
const { getDB } = require('./core');
const { assertCollectorParent, takeParentNormalizeReport } = require('./module-parents');
const wiki = require('./wiki');
const versions = require('./versions');
const { attachUndoAction } = require('./undo');

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

// anyParent: only db/migrate_v3.js, which builds the v3 tree (children under
// a Manager "project") and normalizes it into collectors when it finishes.
function createModule(data, { logHistory = true, anyParent = false } = {}) {
  const d = getDB();
  const { nexus_ref, parent_id = null, name, kind, icon = null, icon_color = null, color = null, cat_type = null } = data;
  if (!anyParent) assertCollectorParent(d, parent_id); // V5.md §8.8
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
  // logHistory is false from callers that log one event for a whole batch
  // themselves (bundle.js, importdock.js folder import) — every other caller
  // (the Hub's create menu, Artisan's wizard, module import) is a genuine
  // create and logs here, once, at the one path they all share.
  if (logHistory) versions.recordNexusHistory(nexus_ref, 'create', id, name, null);
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
// context-menu "Duplicate"), as a sibling of the source (same parent_id).
//
// The copy goes through the snapshot pair the trash and module export
// already use — sync.serializeVault scoped to the subtree, then
// importModuleSnapshot — so it carries every kind's content (classifier
// fields/objects/values/levels, timelines + events, chapters, dialogues,
// maps, sketches, diviner tables, Designer/Exhibitor scenes, page blocks
// parents-first, module_ui, labels…) with every row and key inside the
// subtree remapped to the copy. A hand-written per-table clone is what this
// replaced: it copied the module rows only, and every Duplicate came out empty.
//   - References OUT of the subtree (a block borrowing another module, a pin
//     on someone else's object, an asset's file_<id>) stay pointed where they
//     were — sameVault — so an asset is shared, never its bytes copied.
//   - Relations: a scoped snapshot carries none, so the subtree's own ones
//     (from one of its keys, in one of its modules, or of one of its relation
//     fields) are copied here; an end inside the subtree is remapped to the
//     copy, an end outside is kept. A relation another module holds INTO the
//     subtree is that module's content and is not duplicated.
//   - Not copied: version history (never in a snapshot), pinned (a copy
//     should not clutter the pinned rail) and handle (unique per vault).
//   - [[wikilinks]] are text and come along verbatim; the importer rebuilds
//     the link index. The Locate mirror writes the copy's own files on its
//     next sync (main.js marks every module:* write dirty).
function copyModuleSubtree(srcId) {
  const sync = require('./sync');
  const { keysOwnedBy } = require('./entity-kinds');
  const d = getDB();
  const src = d.prepare(`SELECT id, parent_id, nexus_ref, name FROM module WHERE id=?`).get(srcId);
  if (!src) return null;
  const nx = src.nexus_ref;
  const ids = sync.collectModuleSubtreeIds(nx, srcId);
  const payload = sync.serializeVault(nx, ids);
  if (!payload) return null;
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(display_order),-1) AS m FROM module WHERE nexus_ref=? AND parent_id IS ?`)
    .get(nx, src.parent_id).m;
  for (const m of payload.modules) {
    m.pinned = 0;
    m.handle = null;
    m.createAt = null; // a copy is new — "now", not the source's dates
    m.updateAt = null;
    if (m.id === srcId) { m.name = `${src.name} (Copy)`; m.displayOrder = maxOrder + 1; }
  }
  const r = sync.importModuleSnapshot(nx, src.parent_id, payload, { withKeyMaps: true, sameVault: true });
  if (!r?.ok) throw new Error(`duplicate failed: ${r?.code || 'import'}`);
  const newId = r.keyMaps.module.get(srcId);

  const inMods = new Set(ids);
  const inside = keysOwnedBy(d, ids);
  const remap = (k) => {
    if (!inside.has(k)) return k;
    const m = /^([a-z]+)_(\d+)$/.exec(k);
    const to = m && r.keyMaps[m[1]]?.get(Number(m[2]));
    return to == null ? null : `${m[1]}_${to}`;
  };
  const rows = d.prepare(`SELECT * FROM entity_relation WHERE nexus_ref=? ORDER BY id`).all(nx)
    .filter((x) => inside.has(x.from_key) || inside.has(x.rel_type) || inMods.has(x.module_ref));
  const ins = d.prepare(`INSERT OR IGNORE INTO entity_relation (nexus_ref, from_key, to_key, label, color, rel_type, directed, module_ref, valid_from, valid_to)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const relIds = [];
  for (const x of rows) {
    const fk = remap(x.from_key), tk = remap(x.to_key);
    const rt = x.rel_type == null ? null : remap(x.rel_type);
    if (!fk || !tk || (x.rel_type != null && rt == null)) continue;
    const mr = x.module_ref == null ? null : (r.keyMaps.module.get(x.module_ref) ?? x.module_ref);
    const res = ins.run(nx, fk, tk, x.label, x.color, rt, x.directed, mr, x.valid_from, x.valid_to);
    if (res.changes) relIds.push(res.lastInsertRowid);
  }
  return { newId, relIds, nexusRef: nx, name: `${src.name} (Copy)` };
}

function duplicateModule(id) {
  const d = getDB();
  const step = d.transaction(() => {
    const c = copyModuleSubtree(id);
    if (!c) return null;
    // ONE undo step whose inverse is "delete the copy": the module's FK
    // cascade takes every content row with it, and the copied relations (no
    // cascade) are removed by id. Redo copies the source again.
    attachUndoAction({
      undo() {
        const g = getDB();
        const del = g.prepare(`DELETE FROM entity_relation WHERE id=?`);
        for (const rid of c.relIds) del.run(rid);
        g.prepare(`DELETE FROM module WHERE id=?`).run(c.newId);
        return { ok: true };
      },
      redo() {
        const again = getDB().transaction(() => copyModuleSubtree(id))();
        if (!again) return { ok: false, reason: 'irreversible' }; // the source is gone
        Object.assign(c, again);
        return { ok: true };
      },
    });
    return c;
  })();
  if (!step) return null;
  versions.recordNexusHistory(step.nexusRef, 'copy', step.newId, step.name, null);
  return step.newId;
}

// Free text with [[wikilinks]] — reindexed on every save, same as object
// notes / Scribe notes (src/db/director.js updateObjectNote, src/db/scribe.js).
function updateModuleDescription(id, description) {
  const prev = getDB().prepare(`SELECT description FROM module WHERE id=?`).get(id)?.description ?? '';
  getDB().prepare(`UPDATE module SET description=?, update_at=datetime('now') WHERE id=?`).run(description, id);
  // The whole page's text — description plus text/property blocks (§12).
  wiki.reindexSource('module', id);
  if (prev !== (description ?? '')) {
    versions.recordVersion(id, 'note', String(prev).slice(0, 60),
      { op: 'moduleDescription', args: { id, value: prev } });
  }
}

function deleteModule(id) {
  const d = getDB();
  // Read the row BEFORE deleting — module_ref in nexus_history is not a
  // foreign key precisely so this record survives the delete (see
  // schema/vault.sql), but the name/nexus still have to be captured now.
  const row = d.prepare(`SELECT nexus_ref, name FROM module WHERE id=?`).get(id);
  const result = d.prepare(`DELETE FROM module WHERE id=?`).run(id);
  if (row) versions.recordNexusHistory(row.nexus_ref, 'delete', id, row.name, null);
  return result;
}

// Move a module to (possibly the same) parent and write display_order for
// every child of that parent in the given final order — one call covers
// both plain sibling reordering (newParentId unchanged) and reparenting
// (Plan part1 #4: a top-level module dropped onto another module becomes
// its child). Which moves are legal (top-level modules can go anywhere,
// nested ones are locked to their current parent) is enforced by the
// renderer before this is ever called — see hub.js's onNestDrop.
function moveModule(nexusRef, moduleId, newParentId, orderedSiblingIds) {
  const d = getDB();
  assertCollectorParent(d, newParentId); // V5.md §8.8 — only a collector holds modules
  const prev = d.prepare(`SELECT parent_id, name FROM module WHERE id=?`).get(moduleId);
  const tx = d.transaction(() => {
    d.prepare(`UPDATE module SET parent_id=? WHERE id=? AND nexus_ref=?`).run(newParentId, moduleId, nexusRef);
    orderedSiblingIds.forEach((id, idx) => {
      d.prepare(`UPDATE module SET display_order=? WHERE id=? AND nexus_ref=?`).run(idx, id, nexusRef);
    });
  });
  tx();
  // Plain sibling reordering (newParentId === the module's own current
  // parent) isn't a reparent — logging it would turn every drag-to-reorder
  // in the Nest tree into a history row, drowning out actual moves.
  if (prev && newParentId !== prev.parent_id) {
    versions.recordNexusHistory(nexusRef, 'move', moduleId, prev.name, null);
  }
}

const countModules = (nexusRef) => getDB().prepare(`SELECT COUNT(*) AS c FROM module WHERE nexus_ref=?`).get(nexusRef).c;

// ═══ Nest content-item rows (Plan part2 #2.5) ═════════════════════════
// The Nest tree used to lazily fetch each expanded content module's items
// through that kind's own list-getter — 1 IPC per module, and chronicler
// was 1+M since it walked its timelines — with a full re-render firing
// per resolved fetch. This returns every content module's items for a
// whole nexus in one call, over the content tables, so the tree loads
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
    // The four element families that got pages in Procress 11's last item
    // (V5.md §12.4): dialogues, Diviner tables, Sketcher pages, map pins.
    add(d.prepare(`
      SELECT sd.module_ref, sd.id, sd.name FROM story_dialogue sd
      JOIN module m ON sd.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY sd.module_ref, sd.id
    `).all(nexusRef));
    add(d.prepare(`
      SELECT t.module_ref, t.id, t.name FROM diviner_table t
      JOIN module m ON t.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY t.module_ref, t.display_order, t.id
    `).all(nexusRef));
    add(d.prepare(`
      SELECT p.module_ref, p.id, p.name FROM sketch_page p
      JOIN module m ON p.module_ref=m.id WHERE m.nexus_ref=?
      ORDER BY p.module_ref, p.page_order, p.id
    `).all(nexusRef));
    add(d.prepare(`
      SELECT me.module_ref, me.id, me.label, me.linker_key, te.event_name FROM map_event me
      JOIN module m ON me.module_ref=m.id LEFT JOIN timeline_event te ON te.id=me.event_ref
      WHERE m.nexus_ref=? ORDER BY me.module_ref, me.id
    `).all(nexusRef));
    return items;
  })();
}

// ═══ Module UI spec, tags, links ══════════════════════════════════════
// (module_attribute is gone — v5 Part 8 made its rows property blocks;
// db/page-block.js owns them now.)
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

// Procress 16 part 2: every module ↔ label pair of a Nexus, for the Nest filter's l: token.
const moduleTagIndex = (nexusId) => getDB().prepare(`
  SELECT mh.module_ref AS moduleId, h.tag_name AS tag FROM module_hashtag mh
  JOIN hashtag h ON h.id = mh.hashtag_id JOIN module m ON m.id = mh.module_ref WHERE m.nexus_ref=?
`).all(nexusId);

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

// Procress 17 B1: several modules, one transaction — all or none.
const createModules = (list = []) => getDB().transaction(() => list.map((data) => createModule(data)))();

module.exports = {
  getTree, getModule, createModule, createModules, updateModule, updateModuleDescription, deleteModule,
  duplicateModule, moveModule, countModules, nexusOfModule, getNestItems,
  getModuleUi, setModuleUi,
  getModuleTags, setModuleTags, moduleTagIndex,
  getModuleLinks,
  takeParentNormalizeReport,
};
