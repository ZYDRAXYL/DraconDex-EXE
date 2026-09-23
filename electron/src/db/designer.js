'use strict';
// Graph "Designer" (progress.md Phase 16) — free-form diagram nodes/edges.
const { getDB } = require('./core');

const getDesignNodes = (moduleRef) => getDB().prepare(`
  SELECT * FROM design_node WHERE module_ref=? ORDER BY id
`).all(moduleRef);

const createDesignNode = (moduleRef, shape, xPos, yPos, text, color, linkerKey) => getDB().prepare(`
  INSERT INTO design_node (module_ref,shape,x,y,node_text,color,linker_key) VALUES (?,?,?,?,?,?,?)
`).run(moduleRef, shape || 'box', xPos, yPos, text || null, color || null, linkerKey || null).lastInsertRowid;

const updateDesignNode = (id, shape, text, color) => getDB().prepare(`
  UPDATE design_node SET shape=?, node_text=?, color=?, update_at=datetime('now') WHERE id=?
`).run(shape, text || null, color || null, id);

const moveDesignNode = (id, xPos, yPos) => getDB().prepare(`
  UPDATE design_node SET x=?, y=?, update_at=datetime('now') WHERE id=?
`).run(xPos, yPos, id);

// v5 Part 7 (§11.6) — comic pages: a panel/balloon's size, its place in the
// reading order, and what it shows (a Sketcher page or an asset in a panel,
// the speaker in a balloon — both are the node's linker_key).
const resizeDesignNode = (id, w, h) => getDB().prepare(`
  UPDATE design_node SET w=?, h=?, update_at=datetime('now') WHERE id=?
`).run(Math.max(40, Math.round(w)), Math.max(30, Math.round(h)), id);

const setDesignNodeComic = (id, linkerKey, readOrder) => getDB().prepare(`
  UPDATE design_node SET linker_key=?, read_order=?, update_at=datetime('now') WHERE id=?
`).run(linkerKey || null, Number.isFinite(Number(readOrder)) && readOrder !== '' && readOrder != null ? Math.trunc(Number(readOrder)) : null, id);

// Number every panel and balloon in reading order: rows top to bottom (a
// row takes anything whose top is above the middle of the row's first item),
// left to right inside a row — the order a Western comic page reads in.
function renumberDesignReadOrder(moduleRef, rtl = false) {
  const d = getDB();
  const rows = d.prepare(`SELECT id, x, y, COALESCE(h, 120) AS h FROM design_node WHERE module_ref=? AND shape IN ('panel','balloon')`).all(moduleRef);
  rows.sort((a, b) => a.y - b.y);
  const bands = [];
  for (const r of rows) {
    const band = bands.find((b) => r.y < b.y + b.h / 2); // sorted by y, so r.y >= b.y
    if (band) band.items.push(r); else bands.push({ y: r.y, h: r.h, items: [r] });
  }
  let n = 0;
  d.transaction(() => {
    for (const b of bands) {
      b.items.sort((a, c) => (rtl ? c.x - a.x : a.x - c.x));
      for (const r of b.items) d.prepare(`UPDATE design_node SET read_order=? WHERE id=?`).run(++n, r.id);
    }
  })();
  return { ok: true, count: n };
}

const deleteDesignNode = (id) => getDB().prepare(`DELETE FROM design_node WHERE id=?`).run(id);

const getDesignEdges = (moduleRef) => getDB().prepare(`
  SELECT * FROM design_edge WHERE module_ref=? ORDER BY id
`).all(moduleRef);

const createDesignEdge = (moduleRef, fromRef, toRef, label) => getDB().prepare(`
  INSERT INTO design_edge (module_ref,from_ref,to_ref,label) VALUES (?,?,?,?)
  ON CONFLICT(from_ref,to_ref) DO UPDATE SET label=excluded.label
`).run(moduleRef, fromRef, toRef, label || null).lastInsertRowid;

const updateDesignEdgeLabel = (id, label) =>
  getDB().prepare(`UPDATE design_edge SET label=? WHERE id=?`).run(label || null, id);

const deleteDesignEdge = (id) => getDB().prepare(`DELETE FROM design_edge WHERE id=?`).run(id);

module.exports = {
  getDesignNodes, createDesignNode, updateDesignNode, moveDesignNode, deleteDesignNode,
  resizeDesignNode, setDesignNodeComic, renumberDesignReadOrder,
  getDesignEdges, createDesignEdge, updateDesignEdgeLabel, deleteDesignEdge,
};
