'use strict';
// Version control (progress.md Phase 21). recordVersion is called from the
// mutation hooks in src/db/module.js / classifier.js / author.js with the
// BEFORE-state as a restore payload; restoreVersion re-applies that state
// through the whitelisted ops below and records a new 'restore' version —
// an existing version is never overwritten. Retention is app_setting
// 'versionLimit' (default 50 per module), oldest rows pruned beyond it.
// Two connections in one file, deliberately: app_setting belongs to the
// INSTALL (getAppDB) while module_version belongs to whichever Nexus is open
// (getDB). Mixing them up would put a vault's edit history in app.ddx, or a
// user's preferences inside a vault file they then hand to someone else.
const { getDB, getAppDB } = require('./core');

const getAppSetting = (key) => getAppDB().prepare(`SELECT value FROM app_setting WHERE key=?`).get(key)?.value ?? null;
const setAppSetting = (key, value) => getAppDB().prepare(`
  INSERT INTO app_setting (key, value) VALUES (?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`).run(key, String(value));

const versionLimit = () => {
  const v = Number(getAppSetting('versionLimit'));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 50;
};

// While a restore re-applies state through the hooked db functions, their
// own recordVersion calls are suppressed so only the 'restore' row lands.
let _suppress = false;

function recordVersion(moduleRef, action, detail, restore) {
  if (_suppress) return;
  _recordVersion(moduleRef, action, detail, restore);
}

function _recordVersion(moduleRef, action, detail, restore) {
  try {
    const d = getDB();
    // One transaction for the whole record-then-prune: this runs on EVERY edit
    // (every 800ms autosave included), and unwrapped it was a separate implicit
    // transaction / file-lock cycle per statement. Also makes the pair atomic —
    // a failure between them can no longer leave the row in without its prune.
    d.transaction(() => {
      const seq = (d.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM module_version WHERE module_ref=?`).get(moduleRef).m) + 1;
      d.prepare(`INSERT INTO module_version (module_ref, seq, action, detail, payload) VALUES (?,?,?,?,?)`)
        .run(moduleRef, seq, action, detail || null, restore ? JSON.stringify(restore) : null);
      const limit = versionLimit();
      d.prepare(`
        DELETE FROM module_version WHERE module_ref=? AND id NOT IN (
          SELECT id FROM module_version WHERE module_ref=? ORDER BY seq DESC LIMIT ?)
      `).run(moduleRef, moduleRef, limit);
    })();
  } catch (_) { /* versioning must never break the edit itself */ }
}

const listVersions = (moduleRef) => getDB().prepare(`
  SELECT id, module_ref, seq, action, detail, create_at FROM module_version
  WHERE module_ref=? ORDER BY seq DESC
`).all(moduleRef);

// Nexus history (Procress 10 part 1) — structural Hub events (create/move/
// delete/copy), separate from module_version's per-module content edits
// above. Its own app_setting key rather than reusing 'versionLimit': the two
// are independently sized (Plan.md asks for two separate limit numbers on
// the Database settings page), and 'versionLimit' keeps its existing key so
// installs upgrading in place don't have their module-history limit reset.
const nexusHistoryLimit = () => {
  const v = Number(getAppSetting('nexusHistoryLimit'));
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 50;
};

// No restore payload (unlike module_version) — Plan.md asks for a log and a
// byte-usage/clear UI, not an undo-a-hub-op feature; adding one later only
// means adding a payload column, not touching this shape. moduleRef/
// moduleName are best-effort context for display, not identity: moduleRef
// is not a foreign key (see schema/vault.sql's nexus_history comment), so a
// 'delete' row outlives the module it names.
function recordNexusHistory(nexusRef, action, moduleRef, moduleName, detail) {
  try {
    const d = getDB();
    d.transaction(() => {
      const seq = (d.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM nexus_history WHERE nexus_ref=?`).get(nexusRef).m) + 1;
      d.prepare(`INSERT INTO nexus_history (nexus_ref, seq, action, module_ref, module_name, detail) VALUES (?,?,?,?,?,?)`)
        .run(nexusRef, seq, action, moduleRef ?? null, moduleName ?? null, detail || null);
      const limit = nexusHistoryLimit();
      d.prepare(`
        DELETE FROM nexus_history WHERE nexus_ref=? AND id NOT IN (
          SELECT id FROM nexus_history WHERE nexus_ref=? ORDER BY seq DESC LIMIT ?)
      `).run(nexusRef, nexusRef, limit);
    })();
  } catch (_) { /* history logging must never break the hub operation itself */ }
}

// Byte usage + clear, both for the Database setting page's "history limit"
// section. Neither takes a nexusId: getDB() is already the one vault file
// this call's window has open (v4.9.0 one-.ddx-per-Nexus), and Plan.md scopes
// this display to "the currently open Nexus" specifically — not an arbitrary
// one by id, which is what getVaultDB(id) is for elsewhere in this file's
// siblings (sync.js) and would be the wrong tool here.
function historyBytesUsed() {
  const d = getDB();
  const moduleBytes = d.prepare(`
    SELECT COALESCE(SUM(LENGTH(action) + LENGTH(COALESCE(detail,'')) + LENGTH(COALESCE(payload,''))), 0) AS b
    FROM module_version
  `).get().b;
  const nexusBytes = d.prepare(`
    SELECT COALESCE(SUM(LENGTH(action) + LENGTH(COALESCE(module_name,'')) + LENGTH(COALESCE(detail,''))), 0) AS b
    FROM nexus_history
  `).get().b;
  return { moduleBytes, nexusBytes };
}
const clearModuleHistory = () => getDB().prepare(`DELETE FROM module_version`).run();
const clearNexusHistory = () => getDB().prepare(`DELETE FROM nexus_history`).run();
function clearAllHistory() { clearModuleHistory(); clearNexusHistory(); }

// Whitelisted restore ops — each re-applies a recorded before-state through
// the owning db module (required lazily to avoid import cycles).
const RESTORE_OPS = {
  moduleDescription: (a) => require('./module').updateModuleDescription(a.id, a.value),
  moduleAttr: (a) => {
    const d = getDB();
    const row = a.attrId ? d.prepare(`SELECT id FROM module_attribute WHERE id=?`).get(a.attrId) : null;
    require('./module').upsertModuleAttr(a.moduleId, row ? a.attrId : null, a.name, a.value);
  },
  moduleAttrDelete: (a) => require('./module').deleteModuleAttr(a.attrId),
  moduleTags: (a) => require('./module').setModuleTags(a.moduleId, a.tagIds),
  classifierAttr: (a) => require('./classifier').upsertAttr(a.objectId, a.templateId, a.value),
  classifierObject: (a) => require('./classifier').updateObject(a.objectId, a.name, a.colorId, a.icon),
  classifierObjectInsert: (a) => {
    const cls = require('./classifier');
    const id = cls.createObject(a.moduleRef, a.name, a.colorId, a.icon);
    if (a.note) cls.updateObjectNote(id, a.note);
  },
  classifierObjectDelete: (a) => require('./classifier').deleteObject(a.objectId),
  classifierTemplate: (a) => require('./classifier').updateTemplate(a.templateId, a.description, a.attributeType, a.levelable, a.hasCondition),
  authorChapterContent: (a) => require('./author').updateBookChapterContent(a.chapterId, a.content),
  authorChapterName: (a) => require('./author').renameBookChapter(a.chapterId, a.name),
};

function restoreVersion(id) {
  const d = getDB();
  const v = d.prepare(`SELECT * FROM module_version WHERE id=?`).get(id);
  if (!v || !v.payload) return { ok: false };
  let restore;
  try { restore = JSON.parse(v.payload); } catch (_) { return { ok: false }; }
  const op = RESTORE_OPS[restore.op];
  if (!op) return { ok: false };
  _suppress = true;
  try { op(restore.args || {}); }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { _suppress = false; }
  _recordVersion(v.module_ref, 'restore', `v${v.seq}`, null);
  return { ok: true };
}

module.exports = {
  recordVersion, listVersions, restoreVersion, getAppSetting, setAppSetting,
  recordNexusHistory, historyBytesUsed, clearModuleHistory, clearNexusHistory, clearAllHistory,
};
