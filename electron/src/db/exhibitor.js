'use strict';
// Exhibitor scene (v5 Part 2, APP docs/V5.md §3.4) — the one canvas in the
// app whose node positions are real rows. exhibit_node is the design_node
// shape widened (linker_key -> any entity or file_<id> asset, parent_id for
// the Hierarchy, props JSON per node_type); exhibit_view is one camera per
// Exhibitor module. Relations are NOT here: they stay vault-wide in
// entity_relation (db/viewer.js), which seven other readers depend on.
const { getDB } = require('./core');

// Columns a renderer patch may touch. Everything else (module_ref, ids,
// timestamps) is fixed by the row's own history.
const NODE_FIELDS = ['parent_id', 'node_type', 'linker_key', 'label', 'x', 'y', 'w', 'h', 'z',
  'rotation', 'scale', 'locked', 'hidden', 'color', 'props'];
const VIEW_FIELDS = ['scale', 'tx', 'ty', 'bg_linker_key', 'grid', 'snap'];

function getExhibitScene(moduleId) {
  const d = getDB();
  return d.readTx(() => ({
    nodes: d.prepare(`SELECT * FROM exhibit_node WHERE module_ref=? ORDER BY z, id`).all(moduleId),
    view: d.prepare(`SELECT scale, tx, ty, bg_linker_key, grid, snap FROM exhibit_view WHERE module_ref=?`).get(moduleId)
      || { scale: 1, tx: 0, ty: 0, bg_linker_key: null, grid: 1, snap: 0 },
  }))();
}

// Batch insert — seeding a former Connector's scene or dropping a whole
// selection onto the canvas is one transaction, not N file-lock cycles.
// A key already placed in this scene is skipped, so re-seeding and double
// drops are harmless. Returns the ids of the rows actually created.
function addExhibitNodes(moduleId, nodes) {
  const d = getDB();
  return d.transaction(() => {
    const has = d.prepare(`SELECT id FROM exhibit_node WHERE module_ref=? AND linker_key=?`);
    const top = d.prepare(`SELECT COALESCE(MAX(z),0) AS z FROM exhibit_node WHERE module_ref=?`).get(moduleId).z;
    const ins = d.prepare(`
      INSERT INTO exhibit_node (module_ref, parent_id, node_type, linker_key, label, x, y, w, h, z, color, props)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ids = [];
    let z = top;
    for (const n of nodes || []) {
      if (n.linker_key && has.get(moduleId, n.linker_key)) continue;
      ids.push(ins.run(moduleId, n.parent_id ?? null, n.node_type || 'entity', n.linker_key ?? null,
        n.label ?? null, Number(n.x) || 0, Number(n.y) || 0, n.w ?? null, n.h ?? null, ++z,
        n.color ?? null, n.props == null ? null : String(n.props)).lastInsertRowid);
    }
    return ids;
  })();
}

function updateExhibitNode(id, patch) {
  const keys = Object.keys(patch || {}).filter((k) => NODE_FIELDS.includes(k));
  if (!keys.length) return;
  const vals = keys.map((k) => (k === 'locked' || k === 'hidden' ? (patch[k] ? 1 : 0) : patch[k] ?? null));
  getDB().prepare(`UPDATE exhibit_node SET ${keys.map((k) => `${k}=?`).join(', ')}, update_at=datetime('now') WHERE id=?`)
    .run(...vals, id);
}

// Drag-end writes every moved node at once (a multi-select drag is one save).
function moveExhibitNodes(moves) {
  const d = getDB();
  d.transaction(() => {
    const st = d.prepare(`UPDATE exhibit_node SET x=?, y=?, update_at=datetime('now') WHERE id=?`);
    for (const m of moves || []) st.run(Number(m.x) || 0, Number(m.y) || 0, m.id);
  })();
}

// Children go with their group (parent_id ON DELETE CASCADE).
const deleteExhibitNode = (id) => getDB().prepare(`DELETE FROM exhibit_node WHERE id=?`).run(id);

function setExhibitView(moduleId, patch) {
  const keys = Object.keys(patch || {}).filter((k) => VIEW_FIELDS.includes(k));
  if (!keys.length) return;
  const d = getDB();
  d.prepare(`INSERT OR IGNORE INTO exhibit_view (module_ref) VALUES (?)`).run(moduleId);
  d.prepare(`UPDATE exhibit_view SET ${keys.map((k) => `${k}=?`).join(', ')}, update_at=datetime('now') WHERE module_ref=?`)
    .run(...keys.map((k) => patch[k] ?? null), moduleId);
}

// The Exhibitor that "belongs" to a module — the one "Open in Exhibitor"
// lands on (§3.5). Found by the module_ui key it was created with, so a
// user renaming or moving it does not orphan the link.
const findExhibitorFor = (moduleId) => getDB().prepare(`
  SELECT m.id FROM module m JOIN module_ui u ON u.module_ref=m.id
  WHERE m.kind='exhibitor' AND u.ui_key='exhibitorFor' AND u.ui_value=? ORDER BY m.id LIMIT 1
`).get(String(moduleId))?.id ?? null;

// Duplicate relations removed by the v5 entity_relation rebuild (§4.2) —
// counted in migrations.js at vault open, surfaced once by the renderer.
const { takeRelationDedupeReport } = require('./schema/migrations');

module.exports = {
  takeRelationDedupeReport,
  getExhibitScene, addExhibitNodes, updateExhibitNode, moveExhibitNodes, deleteExhibitNode,
  setExhibitView, findExhibitorFor,
};
