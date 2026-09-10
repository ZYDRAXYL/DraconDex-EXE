'use strict';
const { getDB } = require('./core');

const getMaps = (pid) =>
  getDB().prepare(`SELECT m.*, uc.color_code FROM map m LEFT JOIN use_color uc ON m.color=uc.id WHERE m.project_id=? ORDER BY m.map_name`).all(pid);
const createMap = (pid, n, c) =>
  getDB().prepare(`INSERT INTO map (map_name,project_id,color) VALUES (?,?,?)`).run(n, pid, c || null);
const updateMap = (id, n, c) =>
  getDB().prepare(`UPDATE map SET map_name=?,color=?,update_at=datetime('now') WHERE id=?`).run(n, c || null, id);
const deleteMap = (id) =>
  getDB().prepare(`DELETE FROM map WHERE id=?`).run(id);

const getMapAreas = (mapId) =>
  getDB().prepare(`SELECT a.*, uc.color_code FROM map_area a LEFT JOIN use_color uc ON a.color=uc.id WHERE a.map_id=? ORDER BY a.area_name`).all(mapId);
const createMapArea = (mapId, n, c) =>
  getDB().prepare(`INSERT INTO map_area (map_id,area_name,color) VALUES (?,?,?)`).run(mapId, n, c || null);
const updateMapArea = (id, n, c) =>
  getDB().prepare(`UPDATE map_area SET area_name=?,color=?,update_at=datetime('now') WHERE id=?`).run(n, c || null, id);
const deleteMapArea = (id) =>
  getDB().prepare(`DELETE FROM map_area WHERE id=?`).run(id);

const getMapAreaPoints = (areaId) =>
  getDB().prepare(`SELECT id, area_id, point_order, x, y FROM map_point WHERE area_id=? ORDER BY point_order, id`).all(areaId);
const setMapAreaPoints = (areaId, points = []) => {
  const d = getDB();
  const tx = d.transaction((aid, list) => {
    d.prepare(`DELETE FROM map_point WHERE area_id=?`).run(aid);
    const ins = d.prepare(`INSERT INTO map_point (area_id,point_order,x,y) VALUES (?,?,?,?)`);
    list.forEach((p, idx) => ins.run(aid, idx, Number(p.x) || 0, Number(p.y) || 0));
  });
  tx(areaId, Array.isArray(points) ? points : []);
};

// Locator (v3 Phase 7): a Locator module IS its map — one row, auto-created
// on first open rather than picked from a list. See core.js's migrateMapV3
// comment for why `map` was generalized (module_ref) instead of a parallel
// schema, unlike Classifier.
const getModuleMap = (moduleRef) =>
  getDB().prepare(`SELECT m.*, uc.color_code FROM map m LEFT JOIN use_color uc ON m.color=uc.id WHERE m.module_ref=?`).get(moduleRef);

function getOrCreateModuleMap(moduleRef) {
  const existing = getModuleMap(moduleRef);
  if (existing) return existing;
  getDB().prepare(`INSERT INTO map (module_ref) VALUES (?)`).run(moduleRef);
  return getModuleMap(moduleRef);
}

module.exports = {
  getMaps, createMap, updateMap, deleteMap, getMapAreas, createMapArea, updateMapArea, deleteMapArea, getMapAreaPoints, setMapAreaPoints,
  getModuleMap, getOrCreateModuleMap,
};
