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
  classifierTemplate: (a) => require('./classifier').updateTemplate(a.templateId, a.description, a.attributeType, a.levelable, a.hasCondition, a.levelSteps),
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

module.exports = { recordVersion, listVersions, restoreVersion, getAppSetting, setAppSetting };
