'use strict';
const { getDB } = require('./core');

const getTimelines = (pid) =>
  getDB().prepare(`SELECT t.*, uc.color_code FROM timeline t LEFT JOIN use_color uc ON t.color=uc.id WHERE t.project_id=? ORDER BY t.line_name`).all(pid);
const createTimeline = (pid, n, c) =>
  getDB().prepare(`INSERT INTO timeline (line_name,project_id,color) VALUES (?,?,?)`).run(n, pid, c || null);

// Chronicler (progress.md Phase 8): a module owns any number of timeline
// "lines" directly, the same shape as a Director project owning several
// timelines — module_ref generalizes the table rather than nesting a new
// container row, mirroring how map/map_area/map_point already separate
// their own container (map) from its children.
const getModuleTimelines = (moduleRef) =>
  getDB().prepare(`SELECT t.*, uc.color_code FROM timeline t LEFT JOIN use_color uc ON t.color=uc.id WHERE t.module_ref=? ORDER BY t.line_name`).all(moduleRef);
const createModuleTimeline = (moduleRef, n, c) =>
  getDB().prepare(`INSERT INTO timeline (line_name,module_ref,color) VALUES (?,?,?)`).run(n, moduleRef, c || null);
const updateTimeline = (id, n, c) =>
  getDB().prepare(`UPDATE timeline SET line_name=?,color=?,update_at=datetime('now') WHERE id=?`).run(n, c || null, id);
const deleteTimeline = (id) =>
  getDB().prepare(`DELETE FROM timeline WHERE id=?`).run(id);

const getOrCreateDate = (day, month, years, hour, minute) => {
  const d = getDB();
  d.prepare(`INSERT OR IGNORE INTO timeline_date (day,month,years,hour,minute) VALUES (?,?,?,?,?)`).run(day, month, years, hour || 0, minute || 0);
  return d.prepare(`SELECT id FROM timeline_date WHERE day=? AND month=? AND years=? AND hour=? AND minute=?`).get(day, month, years, hour || 0, minute || 0).id;
};

const getEvents = (tlid) =>
  getDB().prepare(`
    SELECT te.*, te.story, uc.color_code,
      s.day s_day, s.month s_month, s.years s_years, s.hour s_hour, s.minute s_minute,
      e.day e_day, e.month e_month, e.years e_years, e.hour e_hour, e.minute e_minute
    FROM timeline_event te
    LEFT JOIN use_color uc ON te.color=uc.id
    LEFT JOIN timeline_date s ON te.start_at=s.id
    LEFT JOIN timeline_date e ON te.end_at=e.id
    WHERE te.timeline_id=?
    ORDER BY s.years,s.month,s.day,s.hour,s.minute
  `).all(tlid);
const createEvent = (tlid, n, sid, eid, c, story) =>
  getDB().prepare(`INSERT INTO timeline_event (timeline_id,event_name,start_at,end_at,color,story) VALUES (?,?,?,?,?,?)`).run(tlid, n, sid, eid || null, c || null, story || null);
const updateEvent = (id, n, sid, eid, c, story) =>
  getDB().prepare(`UPDATE timeline_event SET event_name=?,start_at=?,end_at=?,color=?,story=?,update_at=datetime('now') WHERE id=?`).run(n, sid, eid || null, c || null, story || null, id);
const updateEventStory = (id, story) =>
  getDB().prepare(`UPDATE timeline_event SET story=?, update_at=datetime('now') WHERE id=?`).run(story || null, id);
const updateEventIcon = (id, icon, color) =>
  getDB().prepare(`UPDATE timeline_event SET icon=?, color=?, update_at=datetime('now') WHERE id=?`).run(icon || null, color || null, id);
const deleteEvent = (id) =>
  getDB().prepare(`DELETE FROM timeline_event WHERE id=?`).run(id);

// ── Hashtag junctions for events ────────────────────
const getEventTags = (eventId) =>
  getDB().prepare(`SELECT h.*, uc.color_code FROM hashtag h LEFT JOIN use_color uc ON h.tag_color=uc.id JOIN event_hashtag eh ON h.id=eh.hashtag_id WHERE eh.event_id=? ORDER BY h.tag_name`).all(eventId);
const setEventTags = (eventId, tags) => {
  const d = getDB();
  d.transaction(() => {
    d.prepare(`DELETE FROM event_hashtag WHERE event_id=?`).run(eventId);
    const ins = d.prepare(`INSERT INTO event_hashtag (event_id,hashtag_id) VALUES (?,?)`);
    for (const t of (tags || [])) ins.run(eventId, t);
  })();
  return true;
};
const addEventTag = (eventId, tagId) =>
  getDB().prepare(`INSERT OR IGNORE INTO event_hashtag (event_id,hashtag_id) VALUES (?,?)`).run(eventId, tagId);
const removeEventTag = (eventId, tagId) =>
  getDB().prepare(`DELETE FROM event_hashtag WHERE event_id=? AND hashtag_id=?`).run(eventId, tagId);

const getEventsByHashtag = (tagId, projectId) =>
  getDB().prepare(`
    SELECT te.id, te.event_name, tl.line_name, uc.color_code
    FROM timeline_event te JOIN event_hashtag eh ON eh.event_id = te.id
    JOIN timeline tl ON te.timeline_id = tl.id LEFT JOIN use_color uc ON te.color = uc.id
    WHERE eh.hashtag_id = ? AND tl.project_id = ? ORDER BY tl.line_name, te.event_name
  `).all(tagId, projectId);

module.exports = {
  getTimelines, createTimeline, updateTimeline, deleteTimeline,
  getModuleTimelines, createModuleTimeline,
  getOrCreateDate,
  getEvents, createEvent, updateEvent, updateEventStory, updateEventIcon, deleteEvent,
  getEventTags, setEventTags, addEventTag, removeEventTag, getEventsByHashtag,
};
