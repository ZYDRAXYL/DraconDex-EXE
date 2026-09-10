'use strict';
// TimeMap "Wanderer" (progress.md Phase 9) — MapEvent Link pins. Each row is
// a pin on the wanderer's referenced Locator map, bound to a Chronicler
// event whose start date/time the pin displays, and (Plan part5 W4) a
// linker_key referencing any vault entity (module, classifier object,
// character, chapter, note, …) — same convention as sketch_pin/import_file/
// design_node, resolved renderer-side via api.wiki.resolveKeys. The joined
// date parts mirror timeline.js's getEvents() shape so the renderer can
// reuse fmtDate().
const { getDB } = require('./core');

const getMapEvents = (moduleRef) => getDB().prepare(`
  SELECT me.*, te.event_name, te.timeline_id, uc.color_code AS event_color_code,
    s.day s_day, s.month s_month, s.years s_years, s.hour s_hour, s.minute s_minute
  FROM map_event me
  LEFT JOIN timeline_event te ON me.event_ref = te.id
  LEFT JOIN use_color uc ON te.color = uc.id
  LEFT JOIN timeline_date s ON te.start_at = s.id
  WHERE me.module_ref = ?
  ORDER BY me.id
`).all(moduleRef);

const createMapEvent = (moduleRef, eventRef, linkerKey, xPos, yPos, areaRef) =>
  getDB().prepare(`INSERT INTO map_event (module_ref,event_ref,linker_key,x,y,area_ref) VALUES (?,?,?,?,?,?)`)
    .run(moduleRef, eventRef || null, linkerKey || null, Number(xPos) || 0, Number(yPos) || 0, areaRef || null).lastInsertRowid;

const updateMapEvent = (id, eventRef, linkerKey, xPos, yPos, areaRef) =>
  getDB().prepare(`UPDATE map_event SET event_ref=?, linker_key=?, x=?, y=?, area_ref=?, update_at=datetime('now') WHERE id=?`)
    .run(eventRef || null, linkerKey || null, Number(xPos) || 0, Number(yPos) || 0, areaRef || null, id);

const deleteMapEvent = (id) =>
  getDB().prepare(`DELETE FROM map_event WHERE id=?`).run(id);

module.exports = { getMapEvents, createMapEvent, updateMapEvent, deleteMapEvent };
