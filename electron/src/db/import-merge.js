'use strict';
// "Import as Import DB" — merge an external .ddx/.db into the live database by
// natural key, plus the export-a-copy path. One responsibility, one very long
// function: importDatabaseMerge walks every table in dependency order, and its
// PRAGMA foreign_keys / transaction ordering is load-bearing (see the comment
// at the bottom) — do not restructure it casually.
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { getDB, getVaultDB, getAppDB, adaptDb, forceLegacyJournalMode, hasTable, hasColumn, dataDir } = require('./conn');
const { NEXUS_PROJECT_TABLES } = require('./schema/migrations');

// v4.9.0: "the database" is no longer one file. app.ddx holds preferences,
// credentials and plugins; each Nexus is its own .ddx. Callers have to say
// which they mean.
const getAppDatabasePath = () => path.join(dataDir(), 'app.ddx');
const getVaultPath = (nexusId) =>
  getAppDB().prepare(`SELECT file_path FROM nexus_file WHERE id=?`).get(nexusId)?.file_path ?? null;

// Exports the OPEN VAULT. VACUUM INTO rather than fs.copyFileSync: the source
// is a live connection, and copying a SQLite file that may be mid-transaction
// produces a torn snapshot. VACUUM INTO writes a consistent, already-compacted
// database and needs no lock dance.
const exportDatabaseTo = async (targetPath) => {
  try { fs.rmSync(targetPath, { force: true }); } catch (_) {}
  getDB().prepare(`VACUUM INTO ?`).run(targetPath);
};

// targetNexusId (Plan process5 part2, optional): merge into a SPECIFIC vault
// instead of the calling window's currently-open one — used by the "create a
// new Nexus" import-target choice (core/views.js importIntoTargetNexus()),
// which creates an empty nexus first and then needs to merge into THAT one
// regardless of what the window itself has open. getVaultDB(id) resolves any
// nexus explicitly, same as sync.js's serializeVault/applySnapshotCore do —
// it does not depend on the AsyncLocalStorage vault context h() sets per
// window (see src/db/vault-context.js), so this is safe to call for a nexus
// that isn't the window's active one.
function importDatabaseMerge(sourcePath, targetNexusId) {
  const target = targetNexusId != null ? getVaultDB(targetNexusId) : getDB();

  // Read from a scratch copy, never the picked file itself — the user's own
  // file must come out untouched. WAL sidecars (if any) are copied along so
  // not-yet-checkpointed rows in them are still visible; otherwise the copy's
  // header is patched the same way getDB() patches its own file above, since
  // node-sqlite3-wasm aborts hard on a WAL-declared header with no sidecar.
  const tmpPath = path.join(os.tmpdir(), `dracondex-import-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  fs.copyFileSync(sourcePath, tmpPath);
  if (fs.existsSync(sourcePath + '-wal')) {
    try { fs.copyFileSync(sourcePath + '-wal', tmpPath + '-wal'); } catch (_) {}
    try { fs.copyFileSync(sourcePath + '-shm', tmpPath + '-shm'); } catch (_) {}
  } else {
    forceLegacyJournalMode(tmpPath);
  }
  const cleanupTmp = () => { for (const suf of ['', '-wal', '-shm']) { try { fs.rmSync(tmpPath + suf, { force: true }); } catch (_) {} } };

  let source;
  try {
    source = adaptDb(new _RawDatabase(tmpPath, { readOnly: true }));
  } catch (e) {
    cleanupTmp();
    throw e;
  }

  const summary = {
    colors: 0, folders: 0, projects: 0, categories: 0, templates: 0,
    objects: 0, timelines: 0, events: 0, hashtags: 0, descriptions: 0,
    relationTypes: 0, relations: 0, mappings: 0,
    nexuses: 0, noteFolders: 0, notes: 0,
    world_projects: 0, game_projects: 0, write_projects: 0, chapters: 0, dialogues: 0,
  };

  const tx = target.transaction(() => {
    if (hasTable(source, 'use_color')) {
      const rows = source.prepare(`SELECT color_code FROM use_color WHERE color_code IS NOT NULL`).all();
      const ins = target.prepare(`INSERT OR IGNORE INTO use_color (color_code) VALUES (?)`);
      for (const r of rows) summary.colors += ins.run(r.color_code).changes;
    }

    // Nexus vaults + Scribe notes (v2.8), matched by name/title.
    //
    // v4.9.0: the target is ONE vault file holding exactly one `nexus` row, so
    // this no longer creates vaults. A source file may still hold several (a
    // pre-split .ddx, or a whole-app backup), and every one of them folds into
    // the vault the user chose to merge into — inserting a second `nexus` row
    // here would break the one-row-per-file invariant the whole split rests on.
    // To keep source vaults separate, import them as new Nexuses instead
    // (Setting -> App Data -> Database).
    if (hasTable(source, 'nexus')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const srcNexus = source.prepare(`SELECT id, name, memo, color FROM nexus`).all();
      const targetNexusId = target.prepare(`SELECT id FROM nexus ORDER BY id LIMIT 1`).get()?.id ?? null;
      summary.nexuses = 0;      // nothing is created any more
      summary.nexusesFolded = targetNexusId ? srcNexus.length : 0;
      const targetNexusByName = new Map(srcNexus.map((n) => [n.name, targetNexusId]));
      const srcNexusName = new Map(srcNexus.map(n => [n.id, n.name]));

      if (hasTable(source, 'note_folder')) {
        // flat match by (target nexus, name); nesting is not reconstructed
        for (const f of source.prepare(`SELECT nexus_ref, name, color FROM note_folder`).all()) {
          const nx = targetNexusByName.get(srcNexusName.get(f.nexus_ref));
          if (!nx) continue;
          const exists = target.prepare(`SELECT 1 FROM note_folder WHERE nexus_ref=? AND name=?`).get(nx, f.name);
          if (exists) continue;
          summary.noteFolders += target.prepare(`INSERT INTO note_folder (nexus_ref, name, color) VALUES (?, ?, (SELECT id FROM use_color WHERE color_code=?))`)
            .run(nx, f.name, colorById.get(f.color) || null).changes;
        }
      }
      if (hasTable(source, 'note')) {
        const srcFolderName = hasTable(source, 'note_folder') ? source.prepare(`SELECT id, name FROM note_folder`).all().reduce((m, r) => (m.set(r.id, r.name), m), new Map()) : new Map();
        for (const n of source.prepare(`SELECT nexus_ref, folder_ref, title, content, color, pinned FROM note`).all()) {
          const nx = targetNexusByName.get(srcNexusName.get(n.nexus_ref));
          if (!nx) continue;
          const folder = n.folder_ref ? target.prepare(`SELECT id FROM note_folder WHERE nexus_ref=? AND name=?`).get(nx, srcFolderName.get(n.folder_ref))?.id : null;
          summary.notes += target.prepare(`INSERT OR IGNORE INTO note (nexus_ref, folder_ref, title, content, color, pinned) VALUES (?, ?, ?, ?, (SELECT id FROM use_color WHERE color_code=?), ?)`)
            .run(nx, folder || null, n.title, n.content || '', colorById.get(n.color) || null, n.pinned ? 1 : 0).changes;
        }
      }
    }

    if (hasTable(source, 'project_folder')) {
      const rows = source.prepare(`SELECT name, folder_memo, folder_color FROM project_folder WHERE name IS NOT NULL`).all();
      const colorById = source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map());
      const ins = target.prepare(`INSERT OR IGNORE INTO project_folder (name, folder_memo, folder_color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
      for (const r of rows) summary.folders += ins.run(r.name, r.folder_memo || null, colorById.get(r.folder_color) || null).changes;
    }

    if (hasTable(source, 'project')) {
      const rows = source.prepare(`SELECT codename, name, project_memo, folder_id, project_color FROM project WHERE name IS NOT NULL`).all();
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const folderById = hasTable(source, 'project_folder') ? source.prepare(`SELECT id, name FROM project_folder`).all().reduce((m, r) => (m.set(r.id, r.name), m), new Map()) : new Map();
      const findByCode = target.prepare(`SELECT id FROM project WHERE codename = ?`);
      const findByNameNoCode = target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name = ?`);
      const ins = target.prepare(`INSERT INTO project (codename, name, project_memo, folder_id, project_color) VALUES (?,?,?,(SELECT id FROM project_folder WHERE name=?),(SELECT id FROM use_color WHERE color_code=?))`);
      for (const r of rows) {
        const exists = r.codename ? findByCode.get(r.codename) : findByNameNoCode.get(r.name);
        if (exists) continue;
        summary.projects += ins.run(r.codename || null, r.name, r.project_memo || null, folderById.get(r.folder_id) || null, colorById.get(r.project_color) || null).changes;
      }
    }

    if (hasTable(source, 'project_description')) {
      const projectById = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all() : [];
      const projKey = new Map(projectById.map((p) => [p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`]));
      const rows = source.prepare(`SELECT project_id, attribute_name, attribute_text FROM project_description`).all();
      for (const r of rows) {
        const key = projKey.get(r.project_id);
        if (!key) continue;
        const p = key.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(key.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(key.slice(5));
        if (!p) continue;
        const exists = target.prepare(`SELECT 1 FROM project_description WHERE project_id=? AND attribute_name IS ? AND attribute_text IS ?`).get(p.id, r.attribute_name || null, r.attribute_text || null);
        if (exists) continue;
        summary.descriptions += target.prepare(`INSERT INTO project_description (project_id, attribute_name, attribute_text) VALUES (?,?,?)`).run(p.id, r.attribute_name || null, r.attribute_text || null).changes;
      }
    }

    if (hasTable(source, 'object_category')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const srcProjects = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map()) : new Map();
      const rows = source.prepare(`SELECT category_name, project_id, color FROM object_category`).all();
      for (const r of rows) {
        const pKey = srcProjects.get(r.project_id);
        if (!pKey) continue;
        const p = pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(pKey.slice(5));
        if (!p) continue;
        summary.categories += target.prepare(`INSERT OR IGNORE INTO object_category (category_name, project_id, color) VALUES (?, ?, (SELECT id FROM use_color WHERE color_code=?))`).run(r.category_name, p.id, colorById.get(r.color) || null).changes;
      }
    }

    if (hasTable(source, 'object_template') && hasTable(source, 'object_category')) {
      const srcCats = source.prepare(`SELECT id, category_name, project_id FROM object_category`).all();
      const srcProjects = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map()) : new Map();
      const catKey = new Map(srcCats.map((c) => [c.id, `${srcProjects.get(c.project_id)}::${c.category_name}`]));
      const hasType = hasColumn(source, 'object_template', 'attribute_type');
      const rows = hasType ? source.prepare(`SELECT category_id, description, attribute_type FROM object_template`).all() : source.prepare(`SELECT category_id, description, 'text' AS attribute_type FROM object_template`).all();
      for (const r of rows) {
        const key = catKey.get(r.category_id);
        if (!key) continue;
        const [pKey, catName] = key.split('::');
        const p = pKey?.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get((pKey || '').slice(5));
        if (!p) continue;
        const c = target.prepare(`SELECT id FROM object_category WHERE project_id=? AND category_name=?`).get(p.id, catName);
        if (!c) continue;
        const exists = target.prepare(`SELECT 1 FROM object_template WHERE category_id=? AND description=? AND COALESCE(attribute_type,'text')=COALESCE(?,'text')`).get(c.id, r.description, r.attribute_type || 'text');
        if (exists) continue;
        summary.templates += target.prepare(`INSERT INTO object_template (category_id, description, attribute_type) VALUES (?,?,?)`).run(c.id, r.description, r.attribute_type || 'text').changes;
      }
    }

    if (hasTable(source, 'object') && hasTable(source, 'object_category')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const srcProjects = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map()) : new Map();
      const srcCats = source.prepare(`SELECT id, category_name, project_id FROM object_category`).all();
      const catKey = new Map(srcCats.map((c) => [c.id, `${srcProjects.get(c.project_id)}::${c.category_name}`]));
      const rows = source.prepare(`SELECT name, project_id, category_id, color FROM object`).all();
      for (const r of rows) {
        const pKey = srcProjects.get(r.project_id);
        const cKey = catKey.get(r.category_id);
        if (!pKey || !cKey) continue;
        const p = pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(pKey.slice(5));
        if (!p) continue;
        const catName = cKey.split('::')[1];
        const c = target.prepare(`SELECT id FROM object_category WHERE project_id=? AND category_name=?`).get(p.id, catName);
        if (!c) continue;
        const exists = target.prepare(`SELECT 1 FROM object WHERE name=? AND project_id=? AND category_id=?`).get(r.name, p.id, c.id);
        if (exists) continue;
        summary.objects += target.prepare(`INSERT INTO object (name, project_id, category_id, color) VALUES (?, ?, ?, (SELECT id FROM use_color WHERE color_code=?))`).run(r.name, p.id, c.id, colorById.get(r.color) || null).changes;
      }
    }

    if (hasTable(source, 'timeline')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const srcProjects = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map()) : new Map();
      const rows = source.prepare(`SELECT line_name, project_id, color FROM timeline`).all();
      for (const r of rows) {
        const pKey = srcProjects.get(r.project_id);
        if (!pKey) continue;
        const p = pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(pKey.slice(5));
        if (!p) continue;
        const exists = target.prepare(`SELECT 1 FROM timeline WHERE project_id=? AND line_name=?`).get(p.id, r.line_name || null);
        if (exists) continue;
        summary.timelines += target.prepare(`INSERT INTO timeline (line_name, project_id, color) VALUES (?, ?, (SELECT id FROM use_color WHERE color_code=?))`).run(r.line_name || null, p.id, colorById.get(r.color) || null).changes;
      }
    }

    if (hasTable(source, 'timeline_date')) {
      const rows = source.prepare(`SELECT day, month, years, COALESCE(hour,0) AS hour, COALESCE(minute,0) AS minute FROM timeline_date`).all();
      const ins = target.prepare(`INSERT OR IGNORE INTO timeline_date (day,month,years,hour,minute) VALUES (?,?,?,?,?)`);
      for (const r of rows) ins.run(r.day, r.month, r.years, r.hour, r.minute);
    }

    if (hasTable(source, 'timeline_event') && hasTable(source, 'timeline_date') && hasTable(source, 'timeline')) {
      const hasStory = hasColumn(source, 'timeline_event', 'story');
      const hasEnd = hasColumn(source, 'timeline_event', 'end_at');
      const dateRows = source.prepare(`SELECT id, day, month, years, COALESCE(hour,0) AS hour, COALESCE(minute,0) AS minute FROM timeline_date`).all().reduce((m, d) => (m.set(d.id, d), m), new Map());
      const srcProjects = hasTable(source, 'project') ? source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map()) : new Map();
      const srcTl = source.prepare(`SELECT id, line_name, project_id FROM timeline`).all().reduce((m, t) => (m.set(t.id, { line_name: t.line_name, pKey: srcProjects.get(t.project_id) }), m), new Map());
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const sql = `SELECT id, timeline_id, event_name, start_at, ${hasEnd ? 'end_at' : 'NULL AS end_at'}, color, ${hasStory ? 'story' : 'NULL AS story'} FROM timeline_event`;
      const rows = source.prepare(sql).all();

      const getOrCreateDateLocal = (day, month, years, hour, minute) => {
        target.prepare(`INSERT OR IGNORE INTO timeline_date (day,month,years,hour,minute) VALUES (?,?,?,?,?)`).run(day, month, years, hour||0, minute||0);
        return target.prepare(`SELECT id FROM timeline_date WHERE day=? AND month=? AND years=? AND hour=? AND minute=?`).get(day, month, years, hour||0, minute||0).id;
      };

      for (const r of rows) {
        const tlSrc = srcTl.get(r.timeline_id);
        const sDate = dateRows.get(r.start_at);
        if (!tlSrc || !sDate) continue;
        const p = tlSrc.pKey?.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(tlSrc.pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get((tlSrc.pKey || '').slice(5));
        if (!p) continue;
        const t = target.prepare(`SELECT id FROM timeline WHERE project_id=? AND line_name=?`).get(p.id, tlSrc.line_name);
        if (!t) continue;
        const sId = getOrCreateDateLocal(sDate.day, sDate.month, sDate.years, sDate.hour, sDate.minute);
        let eId = null;
        if (r.end_at && dateRows.has(r.end_at)) {
          const ed = dateRows.get(r.end_at);
          eId = getOrCreateDateLocal(ed.day, ed.month, ed.years, ed.hour, ed.minute);
        }
        const exists = target.prepare(`SELECT 1 FROM timeline_event WHERE timeline_id=? AND COALESCE(event_name,'')=COALESCE(?,'') AND start_at=? AND COALESCE(end_at,0)=COALESCE(?,0)`).get(t.id, r.event_name || null, sId, eId || null);
        if (exists) continue;
        summary.events += target.prepare(`INSERT INTO timeline_event (timeline_id,event_name,start_at,end_at,color,story) VALUES (?,?,?,?,(SELECT id FROM use_color WHERE color_code=?),?)`).run(t.id, r.event_name || null, sId, eId, colorById.get(r.color) || null, r.story || null).changes;
      }
    }

    if (hasTable(source, 'hashtag')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const hasTagColor = hasColumn(source, 'hashtag', 'tag_color');
      const rows = hasTagColor ? source.prepare(`SELECT tag_name, tag_color FROM hashtag`).all() : source.prepare(`SELECT tag_name, NULL AS tag_color FROM hashtag`).all();
      for (const r of rows) summary.hashtags += target.prepare(`INSERT OR IGNORE INTO hashtag (tag_name, tag_color) VALUES (?, (SELECT id FROM use_color WHERE color_code=?))`).run(r.tag_name, colorById.get(r.tag_color) || null).changes;
    }

    if (hasTable(source, 'object_attribute') && hasTable(source, 'object') && hasTable(source, 'object_template') && hasTable(source, 'object_category') && hasTable(source, 'project')) {
      const srcProjects = source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map());
      const srcCats = source.prepare(`SELECT id, category_name, project_id FROM object_category`).all().reduce((m, c) => (m.set(c.id, { category_name: c.category_name, pKey: srcProjects.get(c.project_id) }), m), new Map());
      const srcObjs = source.prepare(`SELECT id, name, project_id, category_id FROM object`).all().reduce((m, o) => (m.set(o.id, { name: o.name, pKey: srcProjects.get(o.project_id), cat: srcCats.get(o.category_id)?.category_name }), m), new Map());
      const srcTpl = source.prepare(`SELECT ot.id, ot.description, COALESCE(ot.attribute_type,'text') AS attribute_type, oc.category_name, oc.project_id FROM object_template ot JOIN object_category oc ON ot.category_id=oc.id`).all().reduce((m, t) => (m.set(t.id, { description: t.description, attribute_type: t.attribute_type, category_name: t.category_name, pKey: srcProjects.get(t.project_id) }), m), new Map());
      const rows = source.prepare(`SELECT object_id, template_id, attribute_value FROM object_attribute`).all();
      for (const r of rows) {
        const so = srcObjs.get(r.object_id);
        const st = srcTpl.get(r.template_id);
        if (!so || !st || so.pKey !== st.pKey || so.cat !== st.category_name) continue;
        const p = so.pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(so.pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(so.pKey.slice(5));
        if (!p) continue;
        const c = target.prepare(`SELECT id FROM object_category WHERE project_id=? AND category_name=?`).get(p.id, so.cat);
        if (!c) continue;
        const o = target.prepare(`SELECT id FROM object WHERE name=? AND project_id=? AND category_id=?`).get(so.name, p.id, c.id);
        const tpl = target.prepare(`SELECT id FROM object_template WHERE category_id=? AND description=? AND COALESCE(attribute_type,'text')=?`).get(c.id, st.description, st.attribute_type);
        if (!o || !tpl) continue;
        summary.mappings += target.prepare(`INSERT OR IGNORE INTO object_attribute (object_id, template_id, attribute_value) VALUES (?,?,?)`).run(o.id, tpl.id, r.attribute_value || null).changes;
      }
    }

    if (hasTable(source, 'project_hashtag') && hasTable(source, 'project') && hasTable(source, 'hashtag')) {
      const srcProjects = source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map());
      const srcTags = source.prepare(`SELECT id, tag_name FROM hashtag`).all().reduce((m, t) => (m.set(t.id, t.tag_name), m), new Map());
      const rows = source.prepare(`SELECT project_id, hashtag_id FROM project_hashtag`).all();
      for (const r of rows) {
        const pKey = srcProjects.get(r.project_id);
        const tagName = srcTags.get(r.hashtag_id);
        if (!pKey || !tagName) continue;
        const p = pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(pKey.slice(5));
        const tg = target.prepare(`SELECT id FROM hashtag WHERE tag_name=?`).get(tagName);
        if (!p || !tg) continue;
        summary.mappings += target.prepare(`INSERT OR IGNORE INTO project_hashtag (project_id, hashtag_id) VALUES (?,?)`).run(p.id, tg.id).changes;
      }
    }

    if (hasTable(source, 'object_hashtag') && hasTable(source, 'object') && hasTable(source, 'object_category') && hasTable(source, 'project') && hasTable(source, 'hashtag')) {
      const srcProjects = source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map());
      const srcCats = source.prepare(`SELECT id, category_name, project_id FROM object_category`).all().reduce((m, c) => (m.set(c.id, { category_name: c.category_name, pKey: srcProjects.get(c.project_id) }), m), new Map());
      const srcObjs = source.prepare(`SELECT id, name, project_id, category_id FROM object`).all().reduce((m, o) => (m.set(o.id, { name: o.name, pKey: srcProjects.get(o.project_id), cat: srcCats.get(o.category_id)?.category_name }), m), new Map());
      const srcTags = source.prepare(`SELECT id, tag_name FROM hashtag`).all().reduce((m, t) => (m.set(t.id, t.tag_name), m), new Map());
      const rows = source.prepare(`SELECT object_id, hashtag_id FROM object_hashtag`).all();
      for (const r of rows) {
        const so = srcObjs.get(r.object_id);
        const tagName = srcTags.get(r.hashtag_id);
        if (!so || !tagName) continue;
        const p = so.pKey.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(so.pKey.slice(5)) : target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(so.pKey.slice(5));
        if (!p) continue;
        const c = target.prepare(`SELECT id FROM object_category WHERE project_id=? AND category_name=?`).get(p.id, so.cat);
        const o = c ? target.prepare(`SELECT id FROM object WHERE name=? AND project_id=? AND category_id=?`).get(so.name, p.id, c.id) : null;
        const tg = target.prepare(`SELECT id FROM hashtag WHERE tag_name=?`).get(tagName);
        if (!o || !tg) continue;
        summary.mappings += target.prepare(`INSERT OR IGNORE INTO object_hashtag (object_id, hashtag_id) VALUES (?,?)`).run(o.id, tg.id).changes;
      }
    }

    if (hasTable(source, 'relation_type')) {
      const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
      const hasColor = hasColumn(source, 'relation_type', 'color');
      const rows = source.prepare(`SELECT relation_name, ${hasColor ? 'color' : 'NULL AS color'} FROM relation_type`).all();
      for (const r of rows) summary.relationTypes += target.prepare(`INSERT OR IGNORE INTO relation_type (relation_name, color) VALUES (?, (SELECT id FROM use_color WHERE color_code=?))`).run(r.relation_name, colorById.get(r.color) || null).changes;
    }

    // Navigator/Hero/Writer + relation-instance merge (Part 2 of Plan.md's
    // Hub rewrite): the blocks above only ever covered Director-shaped data
    // (project/object_category/.../map). These mirror that same natural-key
    // matching idiom for the other three legacy sources so the new "import
    // as Nexus Nest / Import DB" modal has real data to act on regardless of
    // which legacy module the source file came from. Deeply-nested pure
    // cross-link tables with no independent identity of their own (Navigator's
    // world_map/world_character_link/world_timeline_object, Hero's
    // game_cat_object/game_char_element, Writer's write_wiki_link/
    // write_word_link/write_novel_link) are intentionally left unmerged —
    // they only borrow references into Director data that's already merged
    // above, and skipping them doesn't block the core object/timeline/
    // relation flow this feature is verified against.
    const colorById = hasTable(source, 'use_color') ? source.prepare(`SELECT id, color_code FROM use_color`).all().reduce((m, r) => (m.set(r.id, r.color_code), m), new Map()) : new Map();
    const colorOf = (id) => colorById.get(id) || null;

    // ---- Navigator (world_project) ----------------------------------------
    if (hasTable(source, 'world_project')) {
      const findByCode = target.prepare(`SELECT id FROM world_project WHERE codename = ?`);
      const findByNameNoCode = target.prepare(`SELECT id FROM world_project WHERE codename IS NULL AND name = ?`);
      const insWorld = target.prepare(`INSERT INTO world_project (codename, name, memo, color) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
      const worldIdMap = new Map();
      for (const w of source.prepare(`SELECT id, codename, name, memo, color FROM world_project`).all()) {
        let row = w.codename ? findByCode.get(w.codename) : findByNameNoCode.get(w.name);
        if (!row) { const newId = insWorld.run(w.codename || null, w.name, w.memo || null, colorOf(w.color)).lastInsertRowid; summary.world_projects++; row = { id: newId }; }
        worldIdMap.set(w.id, row.id);
      }

      if (hasTable(source, 'world_character')) {
        const findChar = target.prepare(`SELECT 1 FROM world_character WHERE world_ref=? AND name=?`);
        const insChar = target.prepare(`INSERT INTO world_character (world_ref, name, symbol, color) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const c of source.prepare(`SELECT world_ref, name, symbol, color FROM world_character`).all()) {
          const wid = worldIdMap.get(c.world_ref);
          if (!wid || findChar.get(wid, c.name)) continue;
          insChar.run(wid, c.name, c.symbol || null, colorOf(c.color));
        }
      }

      const worldCatIdMap = new Map();
      if (hasTable(source, 'world_orig_category')) {
        const findCat = target.prepare(`SELECT id FROM world_orig_category WHERE world_ref=? AND category_name=?`);
        const insCat = target.prepare(`INSERT INTO world_orig_category (world_ref, category_name, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const c of source.prepare(`SELECT id, world_ref, category_name, color FROM world_orig_category`).all()) {
          const wid = worldIdMap.get(c.world_ref);
          if (!wid) continue;
          let row = findCat.get(wid, c.category_name);
          if (!row) { const newId = insCat.run(wid, c.category_name, colorOf(c.color)).lastInsertRowid; row = { id: newId }; }
          worldCatIdMap.set(c.id, row.id);
        }
      }

      const worldTplIdMap = new Map();
      if (hasTable(source, 'world_orig_template')) {
        const findTpl = target.prepare(`SELECT id FROM world_orig_template WHERE category_id=? AND description=? AND COALESCE(attribute_type,'text')=COALESCE(?,'text')`);
        const insTpl = target.prepare(`INSERT INTO world_orig_template (category_id, description, attribute_type, display_order) VALUES (?,?,?,?)`);
        for (const t of source.prepare(`SELECT id, category_id, description, attribute_type, display_order FROM world_orig_template`).all()) {
          const cid = worldCatIdMap.get(t.category_id);
          if (!cid) continue;
          let row = findTpl.get(cid, t.description, t.attribute_type || 'text');
          if (!row) { const newId = insTpl.run(cid, t.description, t.attribute_type || 'text', t.display_order || 0).lastInsertRowid; row = { id: newId }; }
          worldTplIdMap.set(t.id, row.id);
        }
      }

      const worldObjIdMap = new Map();
      if (hasTable(source, 'world_orig_object')) {
        const findObj = target.prepare(`SELECT id FROM world_orig_object WHERE world_ref=? AND category_id=? AND name=?`);
        const insObj = target.prepare(`INSERT INTO world_orig_object (name, world_ref, category_id, color, note) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?),?)`);
        for (const o of source.prepare(`SELECT id, name, world_ref, category_id, color, note FROM world_orig_object`).all()) {
          const wid = worldIdMap.get(o.world_ref);
          const cid = worldCatIdMap.get(o.category_id);
          if (!wid || !cid) continue;
          let row = findObj.get(wid, cid, o.name);
          if (!row) { const newId = insObj.run(o.name, wid, cid, colorOf(o.color), o.note || null).lastInsertRowid; row = { id: newId }; }
          worldObjIdMap.set(o.id, row.id);
        }
      }

      if (hasTable(source, 'world_orig_attribute')) {
        const insAttr = target.prepare(`INSERT OR IGNORE INTO world_orig_attribute (object_id, template_id, attribute_value) VALUES (?,?,?)`);
        for (const a of source.prepare(`SELECT object_id, template_id, attribute_value FROM world_orig_attribute`).all()) {
          const oid = worldObjIdMap.get(a.object_id);
          const tid = worldTplIdMap.get(a.template_id);
          if (!oid || !tid) continue;
          summary.mappings += insAttr.run(oid, tid, a.attribute_value || null).changes;
        }
      }

      const worldTlIdMap = new Map();
      if (hasTable(source, 'world_timeline')) {
        const findTl = target.prepare(`SELECT id FROM world_timeline WHERE world_ref=? AND name=?`);
        const insTl = target.prepare(`INSERT INTO world_timeline (world_ref, name) VALUES (?,?)`);
        for (const tl of source.prepare(`SELECT id, world_ref, name FROM world_timeline`).all()) {
          const wid = worldIdMap.get(tl.world_ref);
          if (!wid) continue;
          let row = findTl.get(wid, tl.name);
          if (!row) { const newId = insTl.run(wid, tl.name).lastInsertRowid; row = { id: newId }; }
          worldTlIdMap.set(tl.id, row.id);
        }
      }

      if (hasTable(source, 'world_timeline_event') && hasTable(source, 'world_timeline_date')) {
        const dateRows = source.prepare(`SELECT id, day, month, years, COALESCE(hour,0) AS hour, COALESCE(minute,0) AS minute FROM world_timeline_date`).all().reduce((m, d) => (m.set(d.id, d), m), new Map());
        const getOrCreateWorldDate = (day, month, years, hour, minute) => {
          target.prepare(`INSERT OR IGNORE INTO world_timeline_date (day,month,years,hour,minute) VALUES (?,?,?,?,?)`).run(day, month, years, hour || 0, minute || 0);
          return target.prepare(`SELECT id FROM world_timeline_date WHERE day=? AND month=? AND years=? AND hour=? AND minute=?`).get(day, month, years, hour || 0, minute || 0).id;
        };
        const findEv = target.prepare(`SELECT 1 FROM world_timeline_event WHERE timeline_ref=? AND date_ref=?`);
        const insEv = target.prepare(`INSERT INTO world_timeline_event (timeline_ref, date_ref) VALUES (?,?)`);
        for (const e of source.prepare(`SELECT timeline_ref, date_ref FROM world_timeline_event`).all()) {
          const tid = worldTlIdMap.get(e.timeline_ref);
          const d = dateRows.get(e.date_ref);
          if (!tid || !d) continue;
          const did = getOrCreateWorldDate(d.day, d.month, d.years, d.hour, d.minute);
          if (findEv.get(tid, did)) continue;
          summary.events += insEv.run(tid, did).changes;
        }
      }

      if (hasTable(source, 'world_description')) {
        const findDesc = target.prepare(`SELECT 1 FROM world_description WHERE world_ref=? AND COALESCE(attribute_name,'')=COALESCE(?,'') AND COALESCE(attribute_text,'')=COALESCE(?,'')`);
        const insDesc = target.prepare(`INSERT INTO world_description (world_ref, attribute_name, attribute_text) VALUES (?,?,?)`);
        for (const d of source.prepare(`SELECT world_ref, attribute_name, attribute_text FROM world_description`).all()) {
          const wid = worldIdMap.get(d.world_ref);
          if (!wid || findDesc.get(wid, d.attribute_name || null, d.attribute_text || null)) continue;
          summary.descriptions += insDesc.run(wid, d.attribute_name || null, d.attribute_text || null).changes;
        }
      }
    }

    // ---- Hero (game_project) -----------------------------------------------
    if (hasTable(source, 'game_project')) {
      const findByCode = target.prepare(`SELECT id FROM game_project WHERE codename = ?`);
      const findByNameNoCode = target.prepare(`SELECT id FROM game_project WHERE codename IS NULL AND name = ?`);
      const insGame = target.prepare(`INSERT INTO game_project (codename, name, memo, color_ref) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
      const gameIdMap = new Map();
      for (const g of source.prepare(`SELECT id, codename, name, memo, color_ref FROM game_project`).all()) {
        let row = g.codename ? findByCode.get(g.codename) : findByNameNoCode.get(g.name);
        if (!row) { const newId = insGame.run(g.codename || null, g.name, g.memo || null, colorOf(g.color_ref)).lastInsertRowid; summary.game_projects++; row = { id: newId }; }
        gameIdMap.set(g.id, row.id);
      }

      const gameTplIdMap = new Map();
      if (hasTable(source, 'game_char_template')) {
        const findTpl = target.prepare(`SELECT id FROM game_char_template WHERE game_ref=? AND attribute_name=?`);
        const insTpl = target.prepare(`INSERT INTO game_char_template (game_ref, attribute_name, attribute_type, levelable) VALUES (?,?,?,?)`);
        for (const t of source.prepare(`SELECT id, game_ref, attribute_name, attribute_type, levelable FROM game_char_template`).all()) {
          const gid = gameIdMap.get(t.game_ref);
          if (!gid) continue;
          let row = findTpl.get(gid, t.attribute_name);
          if (!row) { const newId = insTpl.run(gid, t.attribute_name, t.attribute_type || 'text', t.levelable ? 1 : 0).lastInsertRowid; row = { id: newId }; }
          gameTplIdMap.set(t.id, row.id);
        }
      }

      const gameCharIdMap = new Map();
      if (hasTable(source, 'game_character')) {
        const findChar = target.prepare(`SELECT id FROM game_character WHERE game_ref=? AND name=?`);
        const insChar = target.prepare(`INSERT INTO game_character (game_ref, name, memo, color_ref) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const c of source.prepare(`SELECT id, game_ref, name, memo, color_ref FROM game_character`).all()) {
          const gid = gameIdMap.get(c.game_ref);
          if (!gid) continue;
          let row = findChar.get(gid, c.name);
          if (!row) { const newId = insChar.run(gid, c.name, c.memo || null, colorOf(c.color_ref)).lastInsertRowid; row = { id: newId }; }
          gameCharIdMap.set(c.id, row.id);
        }
      }

      if (hasTable(source, 'game_char_attribute')) {
        const insAttr = target.prepare(`INSERT OR IGNORE INTO game_char_attribute (char_ref, template_ref, attribute_text, level) VALUES (?,?,?,?)`);
        for (const a of source.prepare(`SELECT char_ref, template_ref, attribute_text, level FROM game_char_attribute`).all()) {
          const cid = gameCharIdMap.get(a.char_ref);
          const tid = gameTplIdMap.get(a.template_ref);
          if (!cid || !tid) continue;
          summary.mappings += insAttr.run(cid, tid, a.attribute_text || null, a.level || 0).changes;
        }
      }

      const gameColIdMap = new Map();
      if (hasTable(source, 'game_collection')) {
        const findCol = target.prepare(`SELECT id FROM game_collection WHERE game_ref=? AND name=?`);
        const insCol = target.prepare(`INSERT INTO game_collection (game_ref, name, color_ref) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const c of source.prepare(`SELECT id, game_ref, name, color_ref FROM game_collection`).all()) {
          const gid = gameIdMap.get(c.game_ref);
          if (!gid) continue;
          let row = findCol.get(gid, c.name);
          if (!row) { const newId = insCol.run(gid, c.name, colorOf(c.color_ref)).lastInsertRowid; row = { id: newId }; }
          gameColIdMap.set(c.id, row.id);
        }
      }

      const gameColTplIdMap = new Map();
      if (hasTable(source, 'game_col_template')) {
        const findTpl = target.prepare(`SELECT id FROM game_col_template WHERE collection_ref=? AND attribute_name=?`);
        const insTpl = target.prepare(`INSERT INTO game_col_template (collection_ref, attribute_name, attribute_type, levelable) VALUES (?,?,?,?)`);
        for (const t of source.prepare(`SELECT id, collection_ref, attribute_name, attribute_type, levelable FROM game_col_template`).all()) {
          const colid = gameColIdMap.get(t.collection_ref);
          if (!colid) continue;
          let row = findTpl.get(colid, t.attribute_name);
          if (!row) { const newId = insTpl.run(colid, t.attribute_name, t.attribute_type || 'text', t.levelable ? 1 : 0).lastInsertRowid; row = { id: newId }; }
          gameColTplIdMap.set(t.id, row.id);
        }
      }

      const gameElIdMap = new Map();
      if (hasTable(source, 'game_col_element')) {
        const findEl = target.prepare(`SELECT id FROM game_col_element WHERE collection_ref=? AND name=?`);
        const insEl = target.prepare(`INSERT INTO game_col_element (collection_ref, name, color_ref) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const e of source.prepare(`SELECT id, collection_ref, name, color_ref FROM game_col_element`).all()) {
          const colid = gameColIdMap.get(e.collection_ref);
          if (!colid) continue;
          let row = findEl.get(colid, e.name);
          if (!row) { const newId = insEl.run(colid, e.name, colorOf(e.color_ref)).lastInsertRowid; row = { id: newId }; }
          gameElIdMap.set(e.id, row.id);
        }
      }

      if (hasTable(source, 'game_col_attribute')) {
        const insAttr = target.prepare(`INSERT OR IGNORE INTO game_col_attribute (element_ref, template_ref, attribute_text, level) VALUES (?,?,?,?)`);
        for (const a of source.prepare(`SELECT element_ref, template_ref, attribute_text, level FROM game_col_attribute`).all()) {
          const eid = gameElIdMap.get(a.element_ref);
          const tid = gameColTplIdMap.get(a.template_ref);
          if (!eid || !tid) continue;
          summary.mappings += insAttr.run(eid, tid, a.attribute_text || null, a.level || 0).changes;
        }
      }

      const gameStoryIdMap = new Map();
      if (hasTable(source, 'game_story')) {
        const findStory = target.prepare(`SELECT id FROM game_story WHERE game_ref=? AND name=?`);
        const insStory = target.prepare(`INSERT INTO game_story (game_ref, name, memo, color_ref) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const s of source.prepare(`SELECT id, game_ref, name, memo, color_ref FROM game_story`).all()) {
          const gid = gameIdMap.get(s.game_ref);
          if (!gid) continue;
          let row = findStory.get(gid, s.name);
          if (!row) { const newId = insStory.run(gid, s.name, s.memo || null, colorOf(s.color_ref)).lastInsertRowid; row = { id: newId }; }
          gameStoryIdMap.set(s.id, row.id);
        }
      }

      const gameDlgIdMap = new Map();
      if (hasTable(source, 'game_dialogue')) {
        const findDlg = target.prepare(`SELECT id FROM game_dialogue WHERE story_ref=? AND name=?`);
        const insDlg = target.prepare(`INSERT INTO game_dialogue (story_ref, name, memo, color_ref, pos_x, pos_y) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?),?,?)`);
        for (const d of source.prepare(`SELECT id, story_ref, name, memo, color_ref, pos_x, pos_y FROM game_dialogue`).all()) {
          const sid = gameStoryIdMap.get(d.story_ref);
          if (!sid) continue;
          let row = findDlg.get(sid, d.name);
          if (!row) { const newId = insDlg.run(sid, d.name, d.memo || null, colorOf(d.color_ref), d.pos_x || 0, d.pos_y || 0).lastInsertRowid; row = { id: newId }; }
          gameDlgIdMap.set(d.id, row.id);
        }
      }

      if (hasTable(source, 'game_conversation')) {
        const findConv = target.prepare(`SELECT 1 FROM game_conversation WHERE dialogue_ref=? AND talk_order=?`);
        const insConv = target.prepare(`INSERT INTO game_conversation (dialogue_ref, char_ref, talk_sentence, talk_order) VALUES (?,?,?,?)`);
        for (const c of source.prepare(`SELECT dialogue_ref, char_ref, talk_sentence, talk_order FROM game_conversation`).all()) {
          const did = gameDlgIdMap.get(c.dialogue_ref);
          if (!did || findConv.get(did, c.talk_order)) continue;
          const cid = c.char_ref ? gameCharIdMap.get(c.char_ref) : null;
          summary.dialogues += insConv.run(did, cid || null, c.talk_sentence || null, c.talk_order || 0).changes;
        }
      }

      if (hasTable(source, 'game_storyline')) {
        const insLine = target.prepare(`INSERT OR IGNORE INTO game_storyline (story_ref, from_ref, to_ref, color_ref) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const l of source.prepare(`SELECT story_ref, from_ref, to_ref, color_ref FROM game_storyline`).all()) {
          const sid = gameStoryIdMap.get(l.story_ref);
          const fid = gameDlgIdMap.get(l.from_ref);
          const toid = gameDlgIdMap.get(l.to_ref);
          if (!sid || !fid || !toid) continue;
          insLine.run(sid, fid, toid, colorOf(l.color_ref));
        }
      }
    }

    // ---- Writer (write_project) --------------------------------------------
    if (hasTable(source, 'write_project')) {
      const findByCode = target.prepare(`SELECT id FROM write_project WHERE codename = ?`);
      const findByNameNoCode = target.prepare(`SELECT id FROM write_project WHERE codename IS NULL AND project_name = ?`);
      const insWrite = target.prepare(`INSERT INTO write_project (project_name, codename, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
      const writeIdMap = new Map();
      for (const w of source.prepare(`SELECT id, project_name, codename, color FROM write_project`).all()) {
        let row = w.codename ? findByCode.get(w.codename) : findByNameNoCode.get(w.project_name);
        if (!row) { const newId = insWrite.run(w.project_name, w.codename || null, colorOf(w.color)).lastInsertRowid; summary.write_projects++; row = { id: newId }; }
        writeIdMap.set(w.id, row.id);
      }

      const seriesIdMap = new Map();
      if (hasTable(source, 'write_series')) {
        const findSeries = target.prepare(`SELECT id FROM write_series WHERE project_id=? AND name=?`);
        const insSeries = target.prepare(`INSERT INTO write_series (project_id, name, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const s of source.prepare(`SELECT id, project_id, name, color FROM write_series`).all()) {
          const pid = writeIdMap.get(s.project_id);
          if (!pid) continue;
          let row = findSeries.get(pid, s.name);
          if (!row) { const newId = insSeries.run(pid, s.name, colorOf(s.color)).lastInsertRowid; row = { id: newId }; }
          seriesIdMap.set(s.id, row.id);
        }
      }

      const bookIdMap = new Map();
      if (hasTable(source, 'write_book')) {
        const findBook = target.prepare(`SELECT id FROM write_book WHERE series_id=? AND name=?`);
        const insBook = target.prepare(`INSERT INTO write_book (series_id, name, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const b of source.prepare(`SELECT id, series_id, name, color FROM write_book`).all()) {
          const sid = seriesIdMap.get(b.series_id);
          if (!sid) continue;
          let row = findBook.get(sid, b.name);
          if (!row) { const newId = insBook.run(sid, b.name, colorOf(b.color)).lastInsertRowid; row = { id: newId }; }
          bookIdMap.set(b.id, row.id);
        }
      }

      if (hasTable(source, 'write_chapter')) {
        const findCh = target.prepare(`SELECT 1 FROM write_chapter WHERE book_id=? AND chapter_order=?`);
        const insCh = target.prepare(`INSERT INTO write_chapter (book_id, name, chapter_order, color, chapter_content) VALUES (?,?,?,(SELECT id FROM use_color WHERE color_code=?),?)`);
        for (const c of source.prepare(`SELECT book_id, name, chapter_order, color, chapter_content FROM write_chapter`).all()) {
          const bid = bookIdMap.get(c.book_id);
          if (!bid || findCh.get(bid, c.chapter_order)) continue;
          summary.chapters += insCh.run(bid, c.name, c.chapter_order || 0, colorOf(c.color), c.chapter_content || null).changes;
        }
      }

      const noteIdMap = new Map();
      if (hasTable(source, 'write_note')) {
        const findNote = target.prepare(`SELECT id FROM write_note WHERE project_id=? AND notename=?`);
        const insNote = target.prepare(`INSERT INTO write_note (project_id, notename, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
        for (const n of source.prepare(`SELECT id, project_id, notename, color FROM write_note`).all()) {
          const pid = writeIdMap.get(n.project_id);
          if (!pid) continue;
          let row = findNote.get(pid, n.notename);
          if (!row) { const newId = insNote.run(pid, n.notename, colorOf(n.color)).lastInsertRowid; row = { id: newId }; }
          noteIdMap.set(n.id, row.id);
        }
      }

      if (hasTable(source, 'write_chat')) {
        const findChat = target.prepare(`SELECT 1 FROM write_chat WHERE note_id=? AND chat_order=?`);
        const insChat = target.prepare(`INSERT INTO write_chat (note_id, chat, chat_order) VALUES (?,?,?)`);
        for (const c of source.prepare(`SELECT note_id, chat, chat_order FROM write_chat`).all()) {
          const nid = noteIdMap.get(c.note_id);
          if (!nid || findChat.get(nid, c.chat_order)) continue;
          insChat.run(nid, c.chat, c.chat_order || 0);
        }
      }
    }

    // ---- Relation instances (Director-only tables) -------------------------
    // Re-resolves object/timeline_event ids independently from the Director
    // blocks above (which don't retain oldId->newId maps) via the same
    // natural-key lookups object_attribute's merge block already uses.
    if (hasTable(source, 'relation') && hasTable(source, 'object') && hasTable(source, 'object_category') && hasTable(source, 'project')) {
      const srcProjects = source.prepare(`SELECT id, codename, name FROM project`).all().reduce((m, p) => (m.set(p.id, p.codename ? `code:${p.codename}` : `name:${p.name}`), m), new Map());
      const srcCats = source.prepare(`SELECT id, category_name, project_id FROM object_category`).all().reduce((m, c) => (m.set(c.id, { category_name: c.category_name, pKey: srcProjects.get(c.project_id) }), m), new Map());
      const srcObjs = source.prepare(`SELECT id, name, project_id, category_id FROM object`).all().reduce((m, o) => (m.set(o.id, { name: o.name, pKey: srcProjects.get(o.project_id), cat: srcCats.get(o.category_id)?.category_name }), m), new Map());
      const resolveProject = (pKey) => pKey?.startsWith('code:') ? target.prepare(`SELECT id FROM project WHERE codename=?`).get(pKey.slice(5)) : (pKey ? target.prepare(`SELECT id FROM project WHERE codename IS NULL AND name=?`).get(pKey.slice(5)) : null);
      const resolveObject = (srcObjId) => {
        const so = srcObjs.get(srcObjId);
        if (!so || !so.pKey || !so.cat) return null;
        const p = resolveProject(so.pKey);
        if (!p) return null;
        const c = target.prepare(`SELECT id FROM object_category WHERE project_id=? AND category_name=?`).get(p.id, so.cat);
        if (!c) return null;
        return target.prepare(`SELECT id FROM object WHERE name=? AND project_id=? AND category_id=?`).get(so.name, p.id, c.id)?.id || null;
      };

      let srcEvents = new Map();
      if (hasTable(source, 'timeline_event') && hasTable(source, 'timeline') && hasTable(source, 'timeline_date')) {
        const dateRows = source.prepare(`SELECT id, day, month, years, COALESCE(hour,0) AS hour, COALESCE(minute,0) AS minute FROM timeline_date`).all().reduce((m, d) => (m.set(d.id, d), m), new Map());
        const srcTl = source.prepare(`SELECT id, line_name, project_id FROM timeline`).all().reduce((m, t) => (m.set(t.id, { line_name: t.line_name, pKey: srcProjects.get(t.project_id) }), m), new Map());
        srcEvents = source.prepare(`SELECT id, timeline_id, event_name, start_at FROM timeline_event`).all().reduce((m, e) => (m.set(e.id, { event_name: e.event_name, tl: srcTl.get(e.timeline_id), sDate: dateRows.get(e.start_at) }), m), new Map());
      }
      const resolveEvent = (srcEvId) => {
        const se = srcEvents.get(srcEvId);
        if (!se || !se.tl || !se.sDate) return null;
        const p = resolveProject(se.tl.pKey);
        if (!p) return null;
        const t = target.prepare(`SELECT id FROM timeline WHERE project_id=? AND line_name=?`).get(p.id, se.tl.line_name);
        if (!t) return null;
        const d = target.prepare(`SELECT id FROM timeline_date WHERE day=? AND month=? AND years=? AND hour=? AND minute=?`).get(se.sDate.day, se.sDate.month, se.sDate.years, se.sDate.hour, se.sDate.minute);
        if (!d) return null;
        return target.prepare(`SELECT id FROM timeline_event WHERE timeline_id=? AND COALESCE(event_name,'')=COALESCE(?,'') AND start_at=?`).get(t.id, se.event_name || null, d.id)?.id || null;
      };

      const srcRelTypes = hasTable(source, 'relation_type') ? source.prepare(`SELECT id, relation_name FROM relation_type`).all().reduce((m, r) => (m.set(r.id, r.relation_name), m), new Map()) : new Map();
      const relIdMap = new Map();
      const findRelation = target.prepare(`SELECT id FROM relation WHERE project_id=? AND relation_type IS ?`);
      const insRelation = target.prepare(`INSERT INTO relation (project_id, relation_type, color) VALUES (?,?,(SELECT id FROM use_color WHERE color_code=?))`);
      for (const r of source.prepare(`SELECT id, project_id, relation_type, color FROM relation`).all()) {
        const p = resolveProject(srcProjects.get(r.project_id));
        if (!p) continue;
        const typeName = srcRelTypes.get(r.relation_type);
        const typeId = typeName ? target.prepare(`SELECT id FROM relation_type WHERE relation_name=?`).get(typeName)?.id : null;
        let row = findRelation.get(p.id, typeId ?? null);
        if (!row) { const newId = insRelation.run(p.id, typeId || null, colorOf(r.color)).lastInsertRowid; row = { id: newId }; }
        relIdMap.set(r.id, row.id);
      }

      if (hasTable(source, 'relation_obob')) {
        const insEdge = target.prepare(`INSERT OR IGNORE INTO relation_obob (relation_id, object_from, object_to) VALUES (?,?,?)`);
        for (const e of source.prepare(`SELECT relation_id, object_from, object_to FROM relation_obob`).all()) {
          const rid = relIdMap.get(e.relation_id), fromId = resolveObject(e.object_from), toId = resolveObject(e.object_to);
          if (!rid || !fromId || !toId) continue;
          summary.relations += insEdge.run(rid, fromId, toId).changes;
        }
      }
      if (hasTable(source, 'relation_obtl')) {
        const insEdge = target.prepare(`INSERT OR IGNORE INTO relation_obtl (relation_id, object_from, timeline_to) VALUES (?,?,?)`);
        for (const e of source.prepare(`SELECT relation_id, object_from, timeline_to FROM relation_obtl`).all()) {
          const rid = relIdMap.get(e.relation_id), fromId = resolveObject(e.object_from), toId = resolveEvent(e.timeline_to);
          if (!rid || !fromId || !toId) continue;
          summary.relations += insEdge.run(rid, fromId, toId).changes;
        }
      }
      if (hasTable(source, 'relation_tltl')) {
        const insEdge = target.prepare(`INSERT OR IGNORE INTO relation_tltl (relation_id, timeline_from, timeline_to) VALUES (?,?,?)`);
        for (const e of source.prepare(`SELECT relation_id, timeline_from, timeline_to FROM relation_tltl`).all()) {
          const rid = relIdMap.get(e.relation_id), fromId = resolveEvent(e.timeline_from), toId = resolveEvent(e.timeline_to);
          if (!rid || !fromId || !toId) continue;
          summary.relations += insEdge.run(rid, fromId, toId).changes;
        }
      }
    }

    // Merged projects arrive without nexus_ref; adopt them into this vault's
    // own row so they don't vanish until restart. No longer creates a `nexus`
    // row when there isn't one: a vault file always has exactly one, and a
    // target without it is not a vault, so there is nothing to adopt into.
    const nx = target.prepare(`SELECT id FROM nexus ORDER BY id LIMIT 1`).get();
    if (nx) {
      for (const t of NEXUS_PROJECT_TABLES) {
        target.prepare(`UPDATE ${t} SET nexus_ref=? WHERE nexus_ref IS NULL`).run(nx.id);
      }
    }

  });
  // PRAGMA foreign_keys is a documented NO-OP inside a transaction. Both of
  // these used to sit inside tx(), so FK enforcement was never actually
  // disabled for the merge despite the code saying so. Issuing them around the
  // transaction is what the original intent required. Restored in `finally` so
  // a failed merge can't leave the connection with FKs off.
  target.exec("PRAGMA foreign_keys = OFF");
  try {
    tx();
  } finally {
    try { target.exec("PRAGMA foreign_keys = ON"); } catch (_) {}
    try { source.close(); } catch (_) {}
    cleanupTmp();
  }
  // Imported content may carry [[wikilinks]]; rebuild the whole index.
  try { require('./wiki').rebuildWikiIndex(); } catch (e) { console.error('wiki reindex after merge:', e); }
  return summary;
}

module.exports = { getAppDatabasePath, getVaultPath, exportDatabaseTo, importDatabaseMerge };
