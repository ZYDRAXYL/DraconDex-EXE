'use strict';
// A module's parent must be a collector (v5 Part 4, APP docs/V5.md §8.8).
// module.parent_id stays in the schema, unchanged — what changed is the rule
// for what a parent may be. SQLite rejects the subquery a CHECK would need
// ("subqueries prohibited in CHECK constraints"), so it is enforced here, in
// JS, at the two places a parent is set: db/module.js createModule and
// moveModule — the same "cheaper here, and the schema stays simple" call
// db/classifier.js makes for its own per-row rules.
//
// This file takes the db handle as an argument rather than calling getDB():
// normalizeModuleParents runs inside migrateInlineColumns, before the vault
// is registered as the current connection.

function assertCollectorParent(db, parentId) {
  if (parentId == null) return;
  const p = db.prepare(`SELECT kind FROM module WHERE id=?`).get(parentId);
  if (!p) throw new Error('parent module not found');
  if (p.kind !== 'collector') throw new Error('parent must be a collector');
}

// An old vault (or an older app's snapshot) can have modules sitting under a
// module that is not a collector. Each such parent's children are wrapped in
// a collector named after that parent, placed right after it — moved, never
// deleted, and the module count before and after is checked to be equal.
//
// Shallowest parent first: once a parent's own place is valid (a collector
// or the top level), the collector made beside it is valid too, so one pass
// per offending parent settles the whole tree.
//
// A former Manager is the common case (a v3 "project" held its content as
// children). Its children leave with the rest, and the Manager is pointed at
// the new collector through its own filter, so it still shows exactly what
// it showed before (§8.9: Manager reads a selection, not children).
let _normalized = 0;
const takeParentNormalizeReport = () => { const n = _normalized; _normalized = 0; return n; };

function normalizeModuleParents(db) {
  const offenders = () => db.prepare(`
    SELECT DISTINCT p.id, p.nexus_ref, p.parent_id, p.name, p.kind, p.display_order
    FROM module c JOIN module p ON c.parent_id=p.id WHERE p.kind <> 'collector'`).all();
  const depthOf = (id) => {
    let n = 0;
    for (let cur = id; cur != null && n < 10000; n++) cur = db.prepare(`SELECT parent_id FROM module WHERE id=?`).get(cur)?.parent_id ?? null;
    return n;
  };
  const before = db.prepare(`SELECT COUNT(*) AS n FROM module`).get().n;
  let moved = 0, made = 0;
  for (let rows = offenders(), guard = 0; rows.length && guard < 100000; rows = offenders(), guard++) {
    rows.sort((a, b) => depthOf(a.id) - depthOf(b.id));
    const p = rows[0];
    let cid = db.prepare(`SELECT id FROM module WHERE nexus_ref=? AND parent_id IS ? AND kind='collector' AND name=?`)
      .get(p.nexus_ref, p.parent_id, p.name)?.id;
    if (cid == null) {
      db.prepare(`UPDATE module SET display_order=display_order+1 WHERE nexus_ref=? AND parent_id IS ? AND display_order>?`)
        .run(p.nexus_ref, p.parent_id, p.display_order ?? 0);
      cid = db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind, display_order) VALUES (?,?,?,?,?)`)
        .run(p.nexus_ref, p.parent_id, p.name, 'collector', (p.display_order ?? 0) + 1).lastInsertRowid;
      made++;
    }
    moved += db.prepare(`UPDATE module SET parent_id=? WHERE parent_id=?`).run(cid, p.id).changes;
    if (p.kind === 'manager') {
      const has = db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(p.id)?.ui_value;
      let groups = [];
      try { groups = JSON.parse(has || '{}').groups || []; } catch (_) {}
      if (!groups.length) {
        const def = JSON.stringify({ groups: [{ rules: [{ field: 'childOf', moduleId: Number(cid) }] }] });
        db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?, 'filterDef', ?)
          ON CONFLICT(module_ref, ui_key) DO UPDATE SET ui_value=excluded.ui_value`).run(p.id, def);
      }
    }
  }
  const after = db.prepare(`SELECT COUNT(*) AS n FROM module`).get().n;
  if (after !== before + made) throw new Error(`module parent normalize: count ${before}+${made} != ${after}`);
  _normalized += moved;
  return { moved, collectors: made };
}

module.exports = { assertCollectorParent, normalizeModuleParents, takeParentNormalizeReport };
