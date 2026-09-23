'use strict';
// Every text field that can hold [[wikilinks]] — ONE entry per source-key
// prefix (v5 Part 4, APP docs/V5.md §8.4). An entry says three things:
//   content(d, id)          the field's current text, as indexed
//   rewrite(d, id, apply)   run apply() over the stored text, write back what
//                           changed, return the new indexed content (or null
//                           when nothing changed) — how a rename of a link's
//                           TARGET reaches back into this field
//   rebuild                 SELECT id, content, nexus_ref for every row worth
//                           indexing — the whole-vault backfill
// wiki.js's rename rewrite and full rebuild both walk this table, so a field
// that is indexed but missing here is impossible to add by accident: the
// regression test (electron/test/wiki-sources.test.mjs) renames a target
// under every prefix listed here and checks each one was rewritten.
//
// Fields that must NOT hold wikilinks (§8.4) are not here on purpose: names
// and handles (module, object, field, chapter, session, event, dialogue) are
// link TARGETS, and numbers / dates / colours / dropdowns are not free text.

// A single text column on a table.
function column(table, col, rebuild) {
  return {
    content: (d, id) => d.prepare(`SELECT ${col} AS c FROM ${table} WHERE id=?`).get(id)?.c ?? '',
    rewrite: (d, id, apply) => {
      const cur = d.prepare(`SELECT ${col} AS c FROM ${table} WHERE id=?`).get(id)?.c;
      if (!cur) return null;
      const next = apply(cur);
      if (next === cur) return null;
      d.prepare(`UPDATE ${table} SET ${col}=?, update_at=datetime('now') WHERE id=?`).run(next, id);
      return next;
    },
    rebuild,
  };
}

// A Classifier element's indexed text is its note plus the value of every
// free-text field it has — shared or private, text or textarea (not date).
// One source key (cobj_<id>) for all of them, so the element is the link
// source a backlink names, whichever of its fields holds the [[link]].
const CLS_TEXT_ATTRS = `
  SELECT ca.id, ca.attribute_value AS v FROM classifier_attribute ca
  JOIN classifier_template ct ON ct.id=ca.template_ref
  WHERE ca.object_ref=? AND COALESCE(ct.attribute_type,'text') <> 'date'
  ORDER BY ct.display_order, ct.id`;

function classifierObjectContent(d, id) {
  const note = d.prepare(`SELECT note FROM classifier_object WHERE id=?`).get(id)?.note || '';
  const vals = d.prepare(CLS_TEXT_ATTRS).all(id).map((r) => r.v || '').filter(Boolean);
  return [note, ...vals].filter(Boolean).join('\n');
}

const CONTENT_SOURCES = {
  note: column('note', 'content',
    `SELECT id, content AS c, nexus_ref FROM note WHERE content LIKE '%[[%'`),
  obj: column('object', 'note',
    `SELECT o.id, o.note AS c, p.nexus_ref FROM object o JOIN project p ON o.project_id=p.id WHERE o.note LIKE '%[[%'`),
  wchp: column('write_chapter', 'chapter_content', `
    SELECT ch.id, ch.chapter_content AS c, p.nexus_ref FROM write_chapter ch
    JOIN write_book b ON ch.book_id=b.id JOIN write_series s ON b.series_id=s.id
    JOIN write_project p ON s.project_id=p.id WHERE ch.chapter_content LIKE '%[[%'`),
  module: column('module', 'description',
    `SELECT id, description AS c, nexus_ref FROM module WHERE description LIKE '%[[%'`),
  bchp: column('book_chapter', 'chapter_content',
    `SELECT ch.id, ch.chapter_content AS c, m.nexus_ref FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE ch.chapter_content LIKE '%[[%'`),
  // Chat "Scribe" sessions: the indexed content is the concatenation of the
  // session's chat_message rows, so the rewrite runs per message row.
  chss: {
    content: (d, id) => d.prepare(`SELECT COALESCE(GROUP_CONCAT(message, char(10)), '') AS c FROM chat_message WHERE session_ref=?`).get(id)?.c ?? '',
    rewrite: (d, sessionId, apply) => {
      let any = false;
      for (const g of d.prepare(`SELECT id, message FROM chat_message WHERE session_ref=?`).all(sessionId)) {
        const next = apply(g.message);
        if (next === g.message) continue;
        d.prepare(`UPDATE chat_message SET message=? WHERE id=?`).run(next, g.id);
        any = true;
      }
      return any ? CONTENT_SOURCES.chss.content(d, sessionId) : null;
    },
    rebuild: `
      SELECT s.id, m.nexus_ref, COALESCE(GROUP_CONCAT(g.message, char(10)), '') AS c
      FROM chat_session s JOIN module m ON s.module_ref=m.id
      JOIN chat_message g ON g.session_ref=s.id
      GROUP BY s.id HAVING c LIKE '%[[%'`,
  },
  cobj: {
    content: classifierObjectContent,
    rewrite: (d, id, apply) => {
      let any = false;
      const o = d.prepare(`SELECT note FROM classifier_object WHERE id=?`).get(id);
      if (o?.note) {
        const next = apply(o.note);
        if (next !== o.note) { d.prepare(`UPDATE classifier_object SET note=?, update_at=datetime('now') WHERE id=?`).run(next, id); any = true; }
      }
      for (const a of d.prepare(CLS_TEXT_ATTRS).all(id)) {
        if (!a.v) continue;
        const next = apply(a.v);
        if (next === a.v) continue;
        d.prepare(`UPDATE classifier_attribute SET attribute_value=?, update_at=datetime('now') WHERE id=?`).run(next, a.id);
        any = true;
      }
      return any ? classifierObjectContent(d, id) : null;
    },
    rebuild: `
      SELECT o.id, m.nexus_ref, '' AS c FROM classifier_object o JOIN module m ON o.module_ref=m.id
      WHERE o.note LIKE '%[[%' OR EXISTS (
        SELECT 1 FROM classifier_attribute ca WHERE ca.object_ref=o.id AND ca.attribute_value LIKE '%[[%')`,
    rebuildContent: classifierObjectContent,
  },
  // v5 Part 4 (§8.4) — the fields opened this round.
  tlev: column('timeline_event', 'story', `
    SELECT te.id, te.story AS c, m.nexus_ref FROM timeline_event te
    JOIN timeline tl ON te.timeline_id=tl.id JOIN module m ON tl.module_ref=m.id WHERE te.story LIKE '%[[%'`),
  sdlg: column('story_dialogue', 'description',
    `SELECT sd.id, sd.description AS c, m.nexus_ref FROM story_dialogue sd JOIN module m ON sd.module_ref=m.id WHERE sd.description LIKE '%[[%'`),
  // An Exhibitor note node: its label IS its text (§3.4 node_type 'note').
  exn: column('exhibit_node', 'label',
    `SELECT n.id, n.label AS c, m.nexus_ref FROM exhibit_node n JOIN module m ON n.module_ref=m.id WHERE n.node_type='note' AND n.label LIKE '%[[%'`),
};

// Vault of a source row, for the save-time reindex hooks of the fields above.
const NEXUS_OF = {
  tlev: `SELECT m.nexus_ref AS n FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id JOIN module m ON tl.module_ref=m.id WHERE te.id=?`,
  sdlg: `SELECT m.nexus_ref AS n FROM story_dialogue sd JOIN module m ON sd.module_ref=m.id WHERE sd.id=?`,
  exn: `SELECT m.nexus_ref AS n FROM exhibit_node x JOIN module m ON x.module_ref=m.id WHERE x.id=?`,
  cobj: `SELECT m.nexus_ref AS n FROM classifier_object o JOIN module m ON o.module_ref=m.id WHERE o.id=?`,
};

module.exports = { CONTENT_SOURCES, NEXUS_OF };
