'use strict';
const { getDB } = require('./core');

const getHashtags = () =>
  getDB().prepare(`SELECT h.*, uc.color_code FROM hashtag h LEFT JOIN use_color uc ON h.tag_color=uc.id ORDER BY h.tag_name`).all();
const createHashtag = (n, c) =>
  getDB().prepare(`INSERT INTO hashtag (tag_name,tag_color) VALUES (?,?)`).run(n, c || null);
const updateHashtag = (id, n, c) =>
  getDB().prepare(`UPDATE hashtag SET tag_name=?,tag_color=?,update_at=datetime('now') WHERE id=?`).run(n, c || null, id);
const deleteHashtag = (id) =>
  getDB().prepare(`DELETE FROM hashtag WHERE id=?`).run(id);

const getObjectsByHashtag = (tagId, projectId) =>
  getDB().prepare(`
    SELECT o.*, oc.category_name, uc.color_code
    FROM object o JOIN object_hashtag oh ON oh.object_id = o.id
    JOIN object_category oc ON o.category_id = oc.id LEFT JOIN use_color uc ON o.color = uc.id
    WHERE oh.hashtag_id = ? AND o.project_id = ? ORDER BY oc.category_name, o.name
  `).all(tagId, projectId);

module.exports = {
  getHashtags, createHashtag, updateHashtag, deleteHashtag,
  getObjectsByHashtag,
};
