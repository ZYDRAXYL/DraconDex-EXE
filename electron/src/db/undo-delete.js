'use strict';
// ═══ Delete now, Undo in the toast (Procress 17 I3) ═════════════════════
// Deleting a module goes to the trash with an Undo toast; a page block comes
// back from its toast too. An object or a field still asked "are you sure?",
// because the database's own cascades (an object's values, levels and
// private fields; a field's values in every object) take rows the session
// undo never sees. So the renderer asks for exactly the rows a delete will
// take — cascades included — deletes, and hands them back to restoreRows if
// Undo is pressed. Same ids, so links and relations point at them again.
const { getDB } = require('./core');
const wiki = require('./wiki');

// Parents first: that is the order a restore inserts in.
const ORDER = ['classifier_object', 'classifier_template', 'classifier_attribute', 'classifier_level', 'page_block', 'entity_relation'];

function captureRows(kind, id) {
  const d = getDB();
  const all = (sql, ...a) => d.prepare(sql).all(...a);
  if (kind === 'object') {
    const key = `cobj_${id}`;
    return {
      kind, id,
      classifier_object: all(`SELECT * FROM classifier_object WHERE id=?`, id),
      classifier_template: all(`SELECT * FROM classifier_template WHERE object_ref=?`, id), // its private fields
      classifier_attribute: all(`SELECT * FROM classifier_attribute WHERE object_ref=?`, id),
      classifier_level: all(`SELECT * FROM classifier_level WHERE object_ref=?`, id),
      page_block: all(`SELECT * FROM page_block WHERE item_key=?`, key),
      entity_relation: all(`SELECT * FROM entity_relation WHERE from_key=? OR to_key=?`, key, key),
    };
  }
  if (kind === 'field') {
    return {
      kind, id,
      classifier_template: all(`SELECT * FROM classifier_template WHERE id=?`, id),
      classifier_attribute: all(`SELECT * FROM classifier_attribute WHERE template_ref=?`, id),
      classifier_level: all(`SELECT * FROM classifier_level WHERE template_ref=?`, id),
      entity_relation: all(`SELECT * FROM entity_relation WHERE rel_type=?`, `ctpl_${id}`), // a relation field's rows
    };
  }
  throw new Error(`nothing to capture for ${kind}`);
}

function restoreRows(snap) {
  const d = getDB();
  d.transaction(() => {
    for (const table of ORDER) {
      for (const row of Array.isArray(snap?.[table]) ? snap[table] : []) {
        const cols = Object.keys(row);
        d.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
      }
    }
  })();
  if (snap?.kind === 'object') wiki.reindexSource('cobj', snap.id);
  return { ok: true };
}

module.exports = { captureRows, restoreRows, UNDO_DELETE_TABLES: ORDER };
