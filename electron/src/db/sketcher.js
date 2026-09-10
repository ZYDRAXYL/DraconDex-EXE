'use strict';
// Drawing "Sketcher" (progress.md Phase 15) — freehand canvas pages.
// Strokes are whole polylines; erasing deletes stroke rows, never pixels.
const { getDB } = require('./core');

const getSketchPages = (moduleRef) => getDB().prepare(`
  SELECT p.*,
    (SELECT COUNT(*) FROM sketch_stroke s WHERE s.page_ref = p.id) AS stroke_count
  FROM sketch_page p WHERE p.module_ref = ? ORDER BY p.page_order, p.id
`).all(moduleRef);

const createSketchPage = (moduleRef, name) => {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(page_order),-1) AS m FROM sketch_page WHERE module_ref=?`).get(moduleRef).m;
  return d.prepare(`INSERT INTO sketch_page (module_ref,name,page_order) VALUES (?,?,?)`)
    .run(moduleRef, name, maxOrder + 1).lastInsertRowid;
};

const renameSketchPage = (id, name) =>
  getDB().prepare(`UPDATE sketch_page SET name=?, update_at=datetime('now') WHERE id=?`).run(name, id);

const moveSketchPage = (id, dir) => {
  const d = getDB();
  const cur = d.prepare(`SELECT * FROM sketch_page WHERE id=?`).get(id);
  if (!cur) return;
  const other = d.prepare(`
    SELECT * FROM sketch_page WHERE module_ref=? AND page_order ${dir < 0 ? '<' : '>'} ?
    ORDER BY page_order ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1
  `).get(cur.module_ref, cur.page_order);
  if (!other) return;
  d.prepare(`UPDATE sketch_page SET page_order=? WHERE id=?`).run(other.page_order, cur.id);
  d.prepare(`UPDATE sketch_page SET page_order=? WHERE id=?`).run(cur.page_order, other.id);
};

const deleteSketchPage = (id) => getDB().prepare(`DELETE FROM sketch_page WHERE id=?`).run(id);

const getSketchStrokes = (pageRef) => getDB().prepare(`
  SELECT * FROM sketch_stroke WHERE page_ref=? ORDER BY id
`).all(pageRef);

const createSketchStroke = (pageRef, color, width, points) => {
  const d = getDB();
  const id = d.prepare(`INSERT INTO sketch_stroke (page_ref,color,width,points) VALUES (?,?,?,?)`)
    .run(pageRef, color, width, JSON.stringify(points)).lastInsertRowid;
  d.prepare(`UPDATE sketch_page SET update_at=datetime('now') WHERE id=?`).run(pageRef);
  return id;
};

const deleteSketchStroke = (id) => getDB().prepare(`DELETE FROM sketch_stroke WHERE id=?`).run(id);

const getSketchPins = (pageRef) => getDB().prepare(`
  SELECT * FROM sketch_pin WHERE page_ref=? ORDER BY id
`).all(pageRef);

const createSketchPin = (pageRef, linkerKey, xPos, yPos) => getDB().prepare(`
  INSERT INTO sketch_pin (page_ref,linker_key,x,y) VALUES (?,?,?,?)
`).run(pageRef, linkerKey, xPos, yPos).lastInsertRowid;

const moveSketchPin = (id, xPos, yPos) =>
  getDB().prepare(`UPDATE sketch_pin SET x=?, y=? WHERE id=?`).run(xPos, yPos, id);

const deleteSketchPin = (id) => getDB().prepare(`DELETE FROM sketch_pin WHERE id=?`).run(id);

module.exports = {
  getSketchPages, createSketchPage, renameSketchPage, moveSketchPage, deleteSketchPage,
  getSketchStrokes, createSketchStroke, deleteSketchStroke,
  getSketchPins, createSketchPin, moveSketchPin, deleteSketchPin,
};
