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
  getDesignEdges, createDesignEdge, updateDesignEdgeLabel, deleteDesignEdge,
};
