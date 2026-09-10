'use strict';
const { getDB } = require('./core');

// ═══ Calendar templates (Process 8 part 1) ═════════════════════════════
// Nexus-scoped, so a calendar authored in one Chronicler can be applied to
// every other one in the same vault — the reason this is a real table and
// not another module_ui key. `spec` is the same JSON string a module keeps
// in module_ui.calendarConfig; nothing here parses it, exactly as the db
// layer never parses filterDef or calendarConfig either.

const listCalendarTemplates = (nexusId) => getDB().prepare(`
  SELECT * FROM calendar_template WHERE nexus_ref=? ORDER BY builtin DESC, name COLLATE NOCASE
`).all(nexusId);

// Upsert by name rather than erroring: "save as template" with an existing
// name reads as overwrite, and the UNIQUE(nexus_ref, name) constraint would
// otherwise reject it. The builtin flag is never changed by a user save, so
// re-saving over the seeded international calendar cannot un-mark it.
const saveCalendarTemplate = (nexusId, name, spec) => getDB().prepare(`
  INSERT INTO calendar_template (nexus_ref, name, spec) VALUES (?,?,?)
  ON CONFLICT(nexus_ref, name) DO UPDATE SET spec=excluded.spec, update_at=datetime('now')
`).run(nexusId, name, spec).lastInsertRowid;

const deleteCalendarTemplate = (id) =>
  getDB().prepare(`DELETE FROM calendar_template WHERE id=? AND builtin=0`).run(id);

// The international calendar every Nexus starts with. Seeded on first read
// rather than in the DDL so its name can come from the caller's locale —
// DDL runs before any renderer exists to translate it.
function ensureBuiltinCalendarTemplate(nexusId, name, spec) {
  const d = getDB();
  const existing = d.prepare(`SELECT id FROM calendar_template WHERE nexus_ref=? AND builtin=1`).get(nexusId);
  if (existing) return existing.id;
  return d.prepare(`INSERT INTO calendar_template (nexus_ref, name, spec, builtin) VALUES (?,?,?,1)`)
    .run(nexusId, name, spec).lastInsertRowid;
}

module.exports = {
  listCalendarTemplates, saveCalendarTemplate, deleteCalendarTemplate,
  ensureBuiltinCalendarTemplate,
};
