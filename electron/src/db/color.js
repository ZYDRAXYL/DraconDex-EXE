'use strict';
// The colour palette. Every vault file carries its own use_color table —
// every vault table has `color INTEGER REFERENCES use_color(id)`, so the ids a
// vault stores have to resolve inside that same file. app.ddx carries an
// identically-seeded copy for one reason: the Welcome window has no vault open
// and still has to run colorPicker() when creating one.
//
// Hence the rule below. Inside a vault, the palette IS that vault's — which is
// what keeps every stored colour id valid within its own file. With no vault
// (the Welcome window), it is app.ddx's. Crossing between the two is done by
// COLOUR CODE, never by id: see vaultColorId() in nexus.js.
const { getDB, getAppDB } = require('./core');
const { currentNexusId } = require('./vault-context');

const colorDB = () => (currentNexusId() ? getDB() : getAppDB());

const getColors = () => colorDB().prepare(`SELECT * FROM use_color ORDER BY id`).all();
const addColor = (code) => colorDB().prepare(`INSERT OR IGNORE INTO use_color (color_code) VALUES (?)`).run(code);
const markColorUsed = (id) => colorDB().prepare(`UPDATE use_color SET update_at=datetime('now') WHERE id=?`).run(id);
const getRecentColors = () => colorDB().prepare(`SELECT * FROM use_color ORDER BY update_at DESC LIMIT 10`).all();
const deleteColor = (id) => {
  const d = colorDB();
  // The "is this colour still in use" check reads VAULT tables, which app.ddx
  // does not have. With no vault open there is nothing in that file that can
  // reference a colour, so there is nothing to protect.
  if (!currentNexusId()) {
    d.prepare(`DELETE FROM use_color WHERE id=?`).run(id);
    return true;
  }
  const used = d.prepare(`
    SELECT 1 FROM (
      SELECT project_color FROM project WHERE project_color=?
      UNION ALL SELECT folder_color FROM project_folder WHERE folder_color=?
      UNION ALL SELECT color FROM object_category WHERE color=?
      UNION ALL SELECT color FROM object WHERE color=?
      UNION ALL SELECT color FROM timeline WHERE color=?
      UNION ALL SELECT color FROM timeline_event WHERE color=?
      UNION ALL SELECT color FROM relation WHERE color=?
      UNION ALL SELECT tag_color FROM hashtag WHERE tag_color=?
    ) LIMIT 1
  `).get(id, id, id, id, id, id, id, id);
  if (used) return false;
  d.prepare(`DELETE FROM use_color WHERE id=?`).run(id);
  return true;
};

// The Symbols tab of iconpicker.js's module-icon picker — a small, generic,
// user-extendable glyph collection (not owned by any one module kind).
// Read-only here: nothing currently offers UI to add/edit symbols after
// Navigator (its original owner) was deleted, Process 2 Part 2.
const getSymbolCollection = () =>
  getDB().prepare(`SELECT id, glyph, label FROM symbol_collection ORDER BY id`).all();

module.exports = { getColors, addColor, markColorUsed, getRecentColors, deleteColor, getSymbolCollection };
