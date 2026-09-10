'use strict';
const { getDB } = require('./core');

// Scribe module (v2.8) — markdown notes scoped to a Nexus vault.

// ---- Folders --------------------------------------------------------------
const getNoteFolders = (nexusId) => getDB().prepare(`
  SELECT nf.*, uc.color_code FROM note_folder nf
  LEFT JOIN use_color uc ON uc.id = nf.color
  WHERE nf.nexus_ref=? ORDER BY nf.name COLLATE NOCASE
`).all(nexusId);

const createNoteFolder = (nexusId, name, parentId, colorId) =>
  getDB().prepare(`INSERT INTO note_folder (nexus_ref,parent_ref,name,color) VALUES (?,?,?,?)`)
    .run(nexusId, parentId || null, name, colorId || null).lastInsertRowid;

const updateNoteFolder = (id, name, parentId, colorId) =>
  getDB().prepare(`UPDATE note_folder SET name=?,parent_ref=?,color=?,update_at=datetime('now') WHERE id=?`)
    .run(name, parentId || null, colorId || null, id);

const deleteNoteFolder = (id) =>
  getDB().prepare(`DELETE FROM note_folder WHERE id=?`).run(id);

// ---- Notes ----------------------------------------------------------------
const getNotes = (nexusId) => getDB().prepare(`
  SELECT n.id, n.nexus_ref, n.folder_ref, n.title, n.color, n.pinned, n.update_at, uc.color_code
  FROM note n LEFT JOIN use_color uc ON uc.id = n.color
  WHERE n.nexus_ref=? ORDER BY n.pinned DESC, n.title COLLATE NOCASE
`).all(nexusId);

const getNote = (id) => getDB().prepare(`
  SELECT n.*, uc.color_code FROM note n LEFT JOIN use_color uc ON uc.id = n.color WHERE n.id=?
`).get(id);

// Titles are unique per vault so [[Title]] resolves unambiguously; collisions
// auto-suffix ("Name 2", "Name 3", …) instead of failing the create.
const createNote = (nexusId, title, folderId, colorId) => {
  const d = getDB();
  const base = (title || 'Untitled').trim() || 'Untitled';
  for (let i = 1; i <= 200; i++) {
    const candidate = i === 1 ? base : `${base} ${i}`;
    try {
      const newId = d.prepare(`INSERT INTO note (nexus_ref,folder_ref,title,color) VALUES (?,?,?,?)`)
        .run(nexusId, folderId || null, candidate, colorId || null).lastInsertRowid;
      // [[links]] typed before this note existed now resolve to it
      require('./wiki').resolveDanglingLinks(candidate, nexusId);
      return newId;
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
    }
  }
  throw new Error('could not find a free note title');
};

// Rename throws on a duplicate title (no silent suffix — the user typed it).
const updateNote = (id, title, folderId, colorId, pinned) => {
  const r = getDB().prepare(`UPDATE note SET title=?,folder_ref=?,color=?,pinned=?,update_at=datetime('now') WHERE id=?`)
    .run(title, folderId || null, colorId || null, pinned ? 1 : 0, id);
  const wiki = require('./wiki');
  wiki.resolveDanglingLinks(title, wiki.nexusOfNote(id));
  return r;
};

const updateNoteContent = (id, content) => {
  const r = getDB().prepare(`UPDATE note SET content=?,update_at=datetime('now') WHERE id=?`)
    .run(content ?? '', id);
  const wiki = require('./wiki'); // lazy: avoids module cycle
  wiki.reindexWikiLinks(`note_${id}`, content, wiki.nexusOfNote(id));
  return r;
};

const deleteNote = (id) =>
  getDB().prepare(`DELETE FROM note WHERE id=?`).run(id);

module.exports = {
  getNoteFolders, createNoteFolder, updateNoteFolder, deleteNoteFolder,
  getNotes, getNote, createNote, updateNote, updateNoteContent, deleteNote,
};
