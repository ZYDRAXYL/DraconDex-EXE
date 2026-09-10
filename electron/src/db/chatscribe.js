'use strict';
// Chat "Scribe" (progress.md Phase 12) — chat sessions of a Scribe module.
// A session is a stream of timestamped bubble messages ("1 session = 1
// note"). [[wikilinks]] typed inside messages are indexed against the
// session's chss_<id> key: the index treats the concatenated message text
// as the session's content, so backlinks land on the session.
const { getDB } = require('./core');
const wiki = require('./wiki');

const nexusOfSession = (id) => getDB().prepare(`
  SELECT m.nexus_ref FROM chat_session s JOIN module m ON s.module_ref = m.id WHERE s.id = ?
`).get(id)?.nexus_ref ?? null;

const sessionContent = (id) => getDB().prepare(`
  SELECT COALESCE(GROUP_CONCAT(message, char(10)), '') AS c FROM chat_message WHERE session_ref=?
`).get(id)?.c ?? '';

const reindexChatSession = (id) =>
  wiki.reindexWikiLinks(`chss_${id}`, sessionContent(id), nexusOfSession(id));

const getChatSessions = (moduleRef) => getDB().prepare(`
  SELECT s.*,
    (SELECT COUNT(*) FROM chat_message g WHERE g.session_ref = s.id) AS message_count,
    (SELECT g.message FROM chat_message g WHERE g.session_ref = s.id ORDER BY g.id DESC LIMIT 1) AS last_message
  FROM chat_session s WHERE s.module_ref = ? ORDER BY s.session_order, s.id
`).all(moduleRef);

const createChatSession = (moduleRef, name) => {
  const d = getDB();
  const maxOrder = d.prepare(`SELECT COALESCE(MAX(session_order),-1) AS m FROM chat_session WHERE module_ref=?`).get(moduleRef).m;
  const id = d.prepare(`INSERT INTO chat_session (module_ref,name,session_order) VALUES (?,?,?)`)
    .run(moduleRef, name, maxOrder + 1).lastInsertRowid;
  wiki.resolveDanglingLinks(name, nexusOfSession(id));
  return id;
};

const renameChatSession = (id, name) => {
  const cur = getDB().prepare(`SELECT name FROM chat_session WHERE id=?`).get(id);
  const r = getDB().prepare(`UPDATE chat_session SET name=?, update_at=datetime('now') WHERE id=?`).run(name, id);
  if (cur && cur.name !== name) wiki.renameWikiTarget(`chss_${id}`, cur.name, name);
  return r;
};

const deleteChatSession = (id) => {
  const r = getDB().prepare(`DELETE FROM chat_session WHERE id=?`).run(id);
  getDB().prepare(`DELETE FROM wiki_link WHERE src_key=?`).run(`chss_${id}`);
  return r;
};

const getChatMessages = (sessionRef) => getDB().prepare(`
  SELECT g.*, uc.color_code FROM chat_message g LEFT JOIN use_color uc ON g.color=uc.id
  WHERE g.session_ref = ? ORDER BY g.id
`).all(sessionRef);

const createChatMessage = (sessionRef, message) => {
  const d = getDB();
  const id = d.prepare(`INSERT INTO chat_message (session_ref,message) VALUES (?,?)`)
    .run(sessionRef, message).lastInsertRowid;
  d.prepare(`UPDATE chat_session SET update_at=datetime('now') WHERE id=?`).run(sessionRef);
  reindexChatSession(sessionRef);
  return id;
};

const updateChatMessage = (id, message) => {
  const d = getDB();
  const cur = d.prepare(`SELECT session_ref FROM chat_message WHERE id=?`).get(id);
  const r = d.prepare(`UPDATE chat_message SET message=? WHERE id=?`).run(message, id);
  if (cur) reindexChatSession(cur.session_ref);
  return r;
};

const deleteChatMessage = (id) => {
  const d = getDB();
  const cur = d.prepare(`SELECT session_ref FROM chat_message WHERE id=?`).get(id);
  const r = d.prepare(`DELETE FROM chat_message WHERE id=?`).run(id);
  if (cur) reindexChatSession(cur.session_ref);
  return r;
};

const updateMessageStyle = (id, color, side) =>
  getDB().prepare(`UPDATE chat_message SET color=?, side=? WHERE id=?`).run(color || null, side || 'r', id);

module.exports = {
  getChatSessions, createChatSession, renameChatSession, deleteChatSession,
  getChatMessages, createChatMessage, updateChatMessage, deleteChatMessage, updateMessageStyle,
};
