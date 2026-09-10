'use strict';
// Book "Author" (progress.md Phase 11) — chapters of a book module.
// Content is markdown with [[wikilinks]], indexed under the bchp_<id> key
// kind on every save (same flow as Writer chapters / Scribe notes).
const { getDB } = require('./core');
const wiki = require('./wiki');
const versions = require('./versions');

const nexusOfChapter = (id) => getDB().prepare(`
  SELECT m.nexus_ref FROM book_chapter ch JOIN module m ON ch.module_ref = m.id WHERE ch.id = ?
`).get(id)?.nexus_ref ?? null;

// List carries content too — Author's Outline/Reading views need every
// chapter's text and book-sized rows are cheap enough to ship whole.
const getBookChapters = (moduleRef) => getDB().prepare(`
  SELECT * FROM book_chapter WHERE module_ref = ? ORDER BY chapter_order, id
`).all(moduleRef);

// Default label seed: floor(previous chapter's numeric prefix) + 1, falling
// back to the new row's 1-based position when the previous label isn't
// numeric (or there is none yet). Only a starting suggestion — the column
// stays free text so the user can overwrite it with anything afterward.
const createBookChapter = (moduleRef, name) => {
  const d = getDB();
  const last = d.prepare(`SELECT chapter_order, chapter_label FROM book_chapter WHERE module_ref=? ORDER BY chapter_order DESC LIMIT 1`).get(moduleRef);
  const maxOrder = last?.chapter_order ?? -1;
  const prevNum = last ? parseFloat(last.chapter_label) : NaN;
  const label = String(Number.isFinite(prevNum) ? Math.floor(prevNum) + 1 : maxOrder + 2);
  return d.prepare(`INSERT INTO book_chapter (module_ref,name,chapter_order,chapter_label) VALUES (?,?,?,?)`)
    .run(moduleRef, name, maxOrder + 1, label).lastInsertRowid;
};

const renameBookChapter = (id, name) => {
  const cur = getDB().prepare(`SELECT name, module_ref FROM book_chapter WHERE id=?`).get(id);
  const r = getDB().prepare(`UPDATE book_chapter SET name=?, update_at=datetime('now') WHERE id=?`).run(name, id);
  if (cur && cur.name !== name) {
    wiki.renameWikiTarget(`bchp_${id}`, cur.name, name);
    versions.recordVersion(cur.module_ref, 'chapterName', `${cur.name} → ${name}`,
      { op: 'authorChapterName', args: { chapterId: id, name: cur.name } });
  }
  return r;
};

const setBookChapterLabel = (id, label) =>
  getDB().prepare(`UPDATE book_chapter SET chapter_label=?, update_at=datetime('now') WHERE id=?`).run(label || null, id);

const updateBookChapterContent = (id, content) => {
  const cur = getDB().prepare(`SELECT name, module_ref, chapter_content FROM book_chapter WHERE id=?`).get(id);
  const r = getDB().prepare(`UPDATE book_chapter SET chapter_content=?, update_at=datetime('now') WHERE id=?`)
    .run(content, id);
  wiki.reindexWikiLinks(`bchp_${id}`, content, nexusOfChapter(id));
  if (cur && (cur.chapter_content ?? '') !== (content ?? '')) {
    versions.recordVersion(cur.module_ref, 'chapter', cur.name,
      { op: 'authorChapterContent', args: { chapterId: id, content: cur.chapter_content ?? '' } });
  }
  return r;
};

const deleteBookChapter = (id) =>
  getDB().prepare(`DELETE FROM book_chapter WHERE id=?`).run(id);

// Free chapter reordering (Plan part5 Author #3) — modeled on
// src/db/module.js's moveModule, simpler since chapters don't nest.
const moveBookChapter = (moduleRef, orderedIds) => {
  const d = getDB();
  const tx = d.transaction(() => {
    orderedIds.forEach((id, idx) =>
      d.prepare(`UPDATE book_chapter SET chapter_order=? WHERE id=? AND module_ref=?`).run(idx, id, moduleRef));
  });
  tx();
};

module.exports = {
  getBookChapters, createBookChapter, renameBookChapter, setBookChapterLabel,
  updateBookChapterContent, deleteBookChapter, moveBookChapter,
};
