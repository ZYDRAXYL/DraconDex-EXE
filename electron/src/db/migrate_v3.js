'use strict';
// ═══ Legacy → v3 migration (progress.md Phase 24, rewritten for Plan.md
// part 2 §2, rewritten again for Plan.md part 4) ═══════════════════════════
// Lazy, NON-DESTRUCTIVE: one transaction maps a legacy project tree
// (Director project / Navigator world / Hero game / Writer project / Scribe
// notes) onto a fresh top-level collector + real child module rows in the
// Nexus nest. Original rows/data are never touched or deleted — the source
// is only flagged (migrated_v3=1) so it stops being offered again. Triggered
// either from the legacy-data boot prompt (src/renderer/hub/legacy-migrate.js)
// or from the Import DB nav button's file-merge flow finding legacy-shaped
// data (core/views.js's importDatabaseFile()) — both funnel into the same
// comparison-list-preview-then-run flow in legacy-migrate.js.
//
// Every legacy object/event/map-area becomes a REAL typed content row
// (classifier_object/classifier_template/classifier_attribute,
// timeline_event/timeline_date, map_area/map_point) in its owning module's
// own native table, matching Plan.md part 4's mapping table literally.
// This supersedes the previous "Decision #4" trade-off (every legacy
// object/event/area flattened into a plain 'inspector' module's markdown
// description) — that was a deliberate simplification at the time, but
// part 4 asks for real typed, searchable content instead, so this version
// reverses it. Legacy colors need no conversion: `use_color` is a single
// shared table referenced by both the legacy and v3 schemas, so a legacy
// color id is already a valid v3 color id.
const { app } = require('electron');
const { getDB } = require('./core');
const { getAppSetting, setAppSetting } = require('./versions');

const LEGACY_TABLE = { director: 'project', navigator: 'world_project', hero: 'game_project', writer: 'write_project', scribe: 'note' };
const LEGACY_PROMPT_SEEN_PREFIX = 'legacyPrompt:seen:';

function migrateLegacy(nexusId, target, legacyId, batchCtx) {
  const d = getDB();
  const module_ = require('./module');
  const viewer = require('./viewer');
  const author = require('./author');
  const classifier = require('./classifier');
  const timeline = require('./timeline');
  const map = require('./map');
  const wanderer = require('./wanderer');
  const chatscribe = require('./chatscribe');
  const counts = { modules: 0, objects: 0, events: 0, areas: 0, chapters: 0, dialogues: 0, relations: 0, wandererPins: 0, chatMessages: 0 };

  // Plan process2 part2 #1.1: find-or-create keyed on (nexus_ref, parent_id,
  // kind, name) — every module this migration creates now dedupes against
  // whatever already exists in the Nexus (from an earlier migration batch,
  // OR hand-built by the user before ever running one), not just the 3
  // top-level wrapper cases a separate findOrCreateChild used to handle.
  // Matching an existing module reuses its id and does NOT touch its own
  // cat_type/color; only content rows (classifier_object, timeline_event,
  // etc.), inserted by each call site after mkModule returns, actually add
  // anything — so folding into an existing module only ever adds content,
  // never overwrites the module's own fields.
  const mkModule = (parentId, name, kind, catType, color) => {
    const existing = d.prepare(
      `SELECT id FROM module WHERE nexus_ref=? AND parent_id IS ? AND kind=? AND name=?`
    ).get(nexusId, parentId, kind, name);
    if (existing) return existing.id;
    counts.modules++;
    return module_.createModule({ nexus_ref: nexusId, parent_id: parentId, name, kind, cat_type: catType || null, color: color || null });
  };
  // findOrCreateChild is now just mkModule under its old, narrower name —
  // kept as an alias so the wrapper/series/folder call sites below don't
  // need touching, since mkModule already does find-or-create for everyone.
  const findOrCreateChild = (parentId, name, kind) => mkModule(parentId, name, kind);

  // category: {name, color}; templates: [{id, description, attribute_type}];
  // objects: [{legacyId, name, color, note, values: [[legacyTemplateId, value], ...]}]
  // Shared by Director/Navigator/Hero — only the source table names differ
  // per branch below, the target shape is identical real classifier content.
  const mkClassifierWithContent = (parentId, category, catType, templates, objects) => {
    const cid = mkModule(parentId, category.name, 'classifier', catType, category.color);
    const tplMap = new Map(); // legacy template id -> new classifier_template id
    for (const tp of templates) {
      const newTplId = classifier.createTemplate(cid, tp.description, tp.attribute_type, false, false, null);
      tplMap.set(tp.id, newTplId);
    }
    const objMap = new Map(); // legacy object id -> new classifier_object id
    for (const o of objects) {
      const oid = classifier.createObject(cid, o.name, o.color);
      if (o.note) classifier.updateObjectNote(oid, o.note);
      for (const [legacyTplId, value] of o.values) {
        if (value == null || value === '') continue;
        const newTplId = tplMap.get(legacyTplId);
        if (newTplId) classifier.upsertAttr(oid, newTplId, value);
      }
      if (o.legacyId != null) objMap.set(o.legacyId, oid);
      counts.objects++;
    }
    return { cid, objMap };
  };

  const mkChroniclerEvent = (timelineId, ev) => {
    const dateId = timeline.getOrCreateDate(ev.day, ev.month, ev.years, ev.hour, ev.minute);
    const id = d.prepare(`INSERT INTO timeline_event (timeline_id,event_name,start_at,color,story) VALUES (?,?,?,?,?)`)
      .run(timelineId, ev.name, dateId, ev.color || null, ev.story || null).lastInsertRowid;
    counts.events++;
    return id;
  };

  const mkLocatorArea = (mapId, area) => {
    const aid = map.createMapArea(mapId, area.name, area.color).lastInsertRowid;
    const ins = d.prepare(`INSERT INTO map_point (area_id,point_order,x,y) VALUES (?,?,?,?)`);
    (area.points || []).forEach((p, i) => ins.run(aid, i, p.x, p.y));
    counts.areas++;
    return aid;
  };

  // Decision #5 (unchanged): descriptions stay combined into one 'inspector'
  // module per project — free-text notes have no typed home to go to.
  const mkDescriptionNote = (parentId, name, rows) => {
    const body = rows.map(r => `## ${r.attribute_name || '—'}\n\n${r.attribute_text || ''}`).join('\n\n');
    if (!body.trim()) return null;
    const mid = mkModule(parentId, name, 'inspector');
    module_.updateModuleDescription(mid, body);
    return mid;
  };

  // Director's relation/relation_obob/relation_obtl/relation_tltl tables
  // (the only legacy source with a dedicated relation-instance schema) →
  // one 'connector' module whose saved filter scopes to this project's own
  // classifier/chronicler modules, with real entity_relation edges between
  // the migrated classifier_object/timeline_event rows — using the same
  // entity-key scheme viewer.js's own index already uses for those tables
  // (cobj_<id> / tlev_<id>), now that objects/events are real content rows
  // rather than 'inspector' modules (which used module_<id> keys).
  const mkRelationConnector = (parentId, name, legacyProjectId, moduleIds, objModMap, eventModMap) => {
    const relRows = d.prepare(`SELECT * FROM relation WHERE project_id=?`).all(legacyProjectId);
    if (!relRows.length || !moduleIds.length) return null;
    const connId = mkModule(parentId, name, 'connector');
    module_.setModuleUi(connId, 'filterDef', JSON.stringify({ query: '', kinds: [], moduleIds, tag: '' }));
    for (const r of relRows) {
      const typeName = r.relation_type ? d.prepare(`SELECT relation_name FROM relation_type WHERE id=?`).get(r.relation_type)?.relation_name : null;
      for (const e of d.prepare(`SELECT * FROM relation_obob WHERE relation_id=?`).all(r.id)) {
        const from = objModMap.get(e.object_from), to = objModMap.get(e.object_to);
        if (from && to) { viewer.createEntityRelation(nexusId, `cobj_${from}`, `cobj_${to}`, typeName); counts.relations++; }
      }
      for (const e of d.prepare(`SELECT * FROM relation_obtl WHERE relation_id=?`).all(r.id)) {
        const from = objModMap.get(e.object_from), to = eventModMap.get(e.timeline_to);
        if (from && to) { viewer.createEntityRelation(nexusId, `cobj_${from}`, `tlev_${to}`, typeName); counts.relations++; }
      }
      for (const e of d.prepare(`SELECT * FROM relation_tltl WHERE relation_id=?`).all(r.id)) {
        const from = eventModMap.get(e.timeline_from), to = eventModMap.get(e.timeline_to);
        if (from && to) { viewer.createEntityRelation(nexusId, `tlev_${from}`, `tlev_${to}`, typeName); counts.relations++; }
      }
    }
    return connId;
  };

  const tx = d.transaction(() => {
    let majorId = null;

    if (target === 'director') {
      const p = d.prepare(`SELECT * FROM project WHERE id=?`).get(legacyId);
      if (!p) throw new Error('project not found');
      const directorId = findOrCreateChild(null, 'Director', 'collector');
      let parentId = directorId;
      if (p.folder_id) {
        const folder = d.prepare(`SELECT * FROM project_folder WHERE id=?`).get(p.folder_id);
        if (folder) parentId = findOrCreateChild(directorId, folder.name, 'collector');
      }
      majorId = mkModule(parentId, p.name, 'manager', null, p.project_color);
      const scopeIds = [];
      const objModMap = new Map();
      const eventModMap = new Map();

      for (const cat of d.prepare(`SELECT * FROM object_category WHERE project_id=?`).all(legacyId)) {
        const tpls = d.prepare(`SELECT * FROM object_template WHERE category_id=? ORDER BY display_order, id`).all(cat.id);
        const objs = d.prepare(`SELECT * FROM object WHERE category_id=?`).all(cat.id).map(o => ({
          legacyId: o.id, name: o.name, color: o.color, note: o.note,
          values: tpls.map(tp => [tp.id, d.prepare(`SELECT attribute_value FROM object_attribute WHERE object_id=? AND template_id=?`).get(o.id, tp.id)?.attribute_value]),
        }));
        const { cid, objMap } = mkClassifierWithContent(majorId, { name: cat.category_name, color: cat.color }, 'object', tpls, objs);
        scopeIds.push(cid);
        for (const [k, v] of objMap) objModMap.set(k, v);
      }

      for (const tl of d.prepare(`SELECT * FROM timeline WHERE project_id=?`).all(legacyId)) {
        const cid = mkModule(majorId, tl.line_name || p.name, 'chronicler');
        const newTlId = d.prepare(`INSERT INTO timeline (line_name, module_ref, color) VALUES (?,?,?)`).run(tl.line_name || p.name, cid, tl.color || null).lastInsertRowid;
        scopeIds.push(cid);
        const evs = d.prepare(`
          SELECT te.id, te.event_name, te.story, te.color, td.day, td.month, td.years, td.hour, td.minute
          FROM timeline_event te JOIN timeline_date td ON te.start_at=td.id WHERE te.timeline_id=?
        `).all(tl.id);
        for (const ev of evs) eventModMap.set(ev.id, mkChroniclerEvent(newTlId, { name: ev.event_name || '—', story: ev.story, color: ev.color, ...ev }));
      }

      for (const mp of d.prepare(`SELECT * FROM map WHERE project_id=?`).all(legacyId)) {
        const lid = mkModule(majorId, mp.map_name || p.name, 'locator');
        const newMapId = d.prepare(`INSERT INTO map (map_name, module_ref, color) VALUES (?,?,?)`).run(mp.map_name || p.name, lid, mp.color || null).lastInsertRowid;
        for (const a of d.prepare(`SELECT * FROM map_area WHERE map_id=?`).all(mp.id)) {
          const points = d.prepare(`SELECT x, y FROM map_point WHERE area_id=? ORDER BY point_order`).all(a.id);
          mkLocatorArea(newMapId, { name: a.area_name || '—', color: a.color, points });
        }
      }

      const descs = d.prepare(`SELECT * FROM project_description WHERE project_id=?`).all(legacyId);
      if (descs.length) mkDescriptionNote(majorId, p.name, descs);

      const connId = mkRelationConnector(majorId, `${p.name} Relations`, legacyId, scopeIds, objModMap, eventModMap);
      if (connId && batchCtx) {
        batchCtx.directorConnectors ||= [];
        batchCtx.directorConnectors.push({ id: connId, moduleIds: scopeIds });
      }
    }

    else if (target === 'navigator') {
      const w = d.prepare(`SELECT * FROM world_project WHERE id=?`).get(legacyId);
      if (!w) throw new Error('world not found');
      const navigatorId = findOrCreateChild(null, 'Navigator', 'collector');
      majorId = mkModule(navigatorId, w.name, 'manager', null, w.color);
      const scopeIds = [];

      const chars = d.prepare(`SELECT * FROM world_character WHERE world_ref=?`).all(legacyId).map(c => ({ legacyId: c.id, name: c.name, color: c.color, note: null, values: [] }));
      if (chars.length) {
        const { cid } = mkClassifierWithContent(majorId, { name: 'Characters', color: null }, 'character', [], chars);
        scopeIds.push(cid);
      }

      for (const cat of d.prepare(`SELECT * FROM world_orig_category WHERE world_ref=?`).all(legacyId)) {
        const tpls = d.prepare(`SELECT * FROM world_orig_template WHERE category_id=? ORDER BY display_order, id`).all(cat.id);
        const objs = d.prepare(`SELECT * FROM world_orig_object WHERE category_id=?`).all(cat.id).map(o => ({
          legacyId: o.id, name: o.name, color: o.color, note: o.note,
          values: tpls.map(tp => [tp.id, d.prepare(`SELECT attribute_value FROM world_orig_attribute WHERE object_id=? AND template_id=?`).get(o.id, tp.id)?.attribute_value]),
        }));
        const { cid } = mkClassifierWithContent(majorId, { name: cat.category_name, color: cat.color }, 'object', tpls, objs);
        scopeIds.push(cid);
      }

      // Locator + Chronicler containers, keyed so the new wanderer support
      // below can point at whichever migrated map/timeline they came from.
      const locatorByMapId = new Map(); // legacy map.id -> new locator module id
      for (const wm of d.prepare(`
        SELECT wm.id AS wmid, m.id AS map_id, m.map_name FROM world_map wm JOIN map m ON wm.map_ref=m.id
        WHERE wm.world_ref=?`).all(legacyId)) {
        const lid = mkModule(majorId, wm.map_name || w.name, 'locator');
        const newMapId = d.prepare(`INSERT INTO map (map_name, module_ref) VALUES (?,?)`).run(wm.map_name || w.name, lid).lastInsertRowid;
        locatorByMapId.set(wm.map_id, lid);
        for (const a of d.prepare(`SELECT * FROM map_area WHERE map_id=?`).all(wm.map_id)) {
          const points = d.prepare(`SELECT x, y FROM map_point WHERE area_id=? ORDER BY point_order`).all(a.id);
          mkLocatorArea(newMapId, { name: a.area_name || '—', color: a.color, points });
        }
      }

      const chroniclerByTimelineId = new Map(); // legacy world_timeline.id -> {moduleId, eventMap}
      for (const tl of d.prepare(`SELECT * FROM world_timeline WHERE world_ref=?`).all(legacyId)) {
        const cid = mkModule(majorId, tl.name, 'chronicler');
        const newTlId = d.prepare(`INSERT INTO timeline (line_name, module_ref) VALUES (?,?)`).run(tl.name, cid).lastInsertRowid;
        scopeIds.push(cid);
        const evs = d.prepare(`
          SELECT wte.id, td.day, td.month, td.years, td.hour, td.minute
          FROM world_timeline_event wte JOIN world_timeline_date td ON wte.date_ref=td.id WHERE wte.timeline_ref=?
        `).all(tl.id);
        const eventMap = new Map(); // legacy world_timeline_event.id -> new timeline_event.id
        for (const r of evs) eventMap.set(r.id, mkChroniclerEvent(newTlId, { name: `${r.day}/${r.month}/${r.years}`, ...r }));
        chroniclerByTimelineId.set(tl.id, { moduleId: cid, eventMap, worldMapRef: tl.world_map_ref });
      }

      // New: wanderer. Each world_timeline plotted on a world_map becomes a
      // 'wanderer' module pointing at the matching migrated locator +
      // chronicler (via module_ui, the same key convention wanderer.js's own
      // renderer reads), with one map_event pin per timeline object-link.
      for (const [tlId, info] of chroniclerByTimelineId) {
        if (!info.worldMapRef) continue;
        const wm = d.prepare(`SELECT map_ref FROM world_map WHERE id=?`).get(info.worldMapRef);
        const locatorId = wm ? locatorByMapId.get(wm.map_ref) : null;
        const tl = d.prepare(`SELECT name FROM world_timeline WHERE id=?`).get(tlId);
        const wandererId = mkModule(majorId, tl?.name || 'Wanderer', 'wanderer');
        if (locatorId) module_.setModuleUi(wandererId, 'mapModule', String(locatorId));
        module_.setModuleUi(wandererId, 'timelineModule', String(info.moduleId));
        for (const [legacyEventId, newEventId] of info.eventMap) {
          for (const link of d.prepare(`SELECT * FROM world_timeline_object WHERE event_ref=?`).all(legacyEventId)) {
            const point = link.point_ref ? d.prepare(`SELECT x, y FROM world_timeline_point WHERE id=?`).get(link.point_ref) : null;
            const entityName = link.world_object_ref
              ? d.prepare(`SELECT ob.name FROM world_object wo JOIN object ob ON wo.object_ref=ob.id WHERE wo.id=?`).get(link.world_object_ref)?.name
              : link.world_character_ref
                ? d.prepare(`SELECT name FROM world_character WHERE id=?`).get(link.world_character_ref)?.name
                : null;
            wanderer.createMapEvent(wandererId, newEventId, entityName || null, point?.x || 0, point?.y || 0, null);
            counts.wandererPins++;
          }
        }
      }

      const descs = d.prepare(`SELECT * FROM world_description WHERE world_ref=?`).all(legacyId);
      if (descs.length) mkDescriptionNote(majorId, w.name, descs);

      // Decision #6 (unchanged): Navigator has no relation-instance table of
      // its own — fold its new classifier/chronicler modules into whichever
      // Director connector(s) were created earlier in this same import batch.
      if (scopeIds.length && batchCtx?.directorConnectors?.length) {
        for (const dc of batchCtx.directorConnectors) {
          const cur = JSON.parse(module_.getModuleUi(dc.id).filterDef || '{}');
          const merged = Array.from(new Set([...(cur.moduleIds || []), ...scopeIds]));
          module_.setModuleUi(dc.id, 'filterDef', JSON.stringify({ ...cur, moduleIds: merged }));
        }
      }
    }

    else if (target === 'hero') {
      const g = d.prepare(`SELECT * FROM game_project WHERE id=?`).get(legacyId);
      if (!g) throw new Error('game not found');
      const heroId = findOrCreateChild(null, 'Hero', 'collector');
      majorId = mkModule(heroId, g.name, 'manager', null, g.color_ref);

      const ctpls = d.prepare(`SELECT * FROM game_char_template WHERE game_ref=?`).all(legacyId);
      const chars = d.prepare(`SELECT * FROM game_character WHERE game_ref=?`).all(legacyId);
      if (chars.length || ctpls.length) {
        const objs = chars.map(c => ({
          legacyId: c.id, name: c.name, color: c.color_ref, note: c.memo,
          values: ctpls.map(tp => [tp.id, d.prepare(`
            SELECT attribute_text FROM game_char_attribute WHERE char_ref=? AND template_ref=? ORDER BY level DESC LIMIT 1
          `).get(c.id, tp.id)?.attribute_text]),
        }));
        const tpls = ctpls.map(tp => ({ id: tp.id, description: tp.attribute_name, attribute_type: tp.attribute_type }));
        mkClassifierWithContent(majorId, { name: 'Characters', color: null }, 'character', tpls, objs);
      }

      for (const col of d.prepare(`SELECT * FROM game_collection WHERE game_ref=?`).all(legacyId)) {
        const tpls = d.prepare(`SELECT * FROM game_col_template WHERE collection_ref=?`).all(col.id);
        const objs = d.prepare(`SELECT * FROM game_col_element WHERE collection_ref=?`).all(col.id).map(e => ({
          legacyId: e.id, name: e.name, color: e.color_ref, note: null,
          values: tpls.map(tp => [tp.id, d.prepare(`
            SELECT attribute_text FROM game_col_attribute WHERE element_ref=? AND template_ref=? ORDER BY level DESC LIMIT 1
          `).get(e.id, tp.id)?.attribute_text]),
        }));
        const tplRows = tpls.map(tp => ({ id: tp.id, description: tp.attribute_name, attribute_type: tp.attribute_type }));
        mkClassifierWithContent(majorId, { name: col.name, color: col.color_ref }, 'element', tplRows, objs);
      }

      // game_story's dialogue graph already lands as real, module-tree-native
      // rows (story_dialogue/story_talk/story_edge) — unchanged, no
      // flattening was ever done here.
      const charName = new Map(d.prepare(`SELECT id, name FROM game_character WHERE game_ref=?`).all(legacyId).map(c => [c.id, c.name]));
      for (const st of d.prepare(`SELECT * FROM game_story WHERE game_ref=?`).all(legacyId)) {
        const mid = mkModule(majorId, st.name, 'narrator');
        const dlgMap = new Map();
        for (const dl of d.prepare(`SELECT * FROM game_dialogue WHERE story_ref=?`).all(st.id)) {
          const nid = d.prepare(`INSERT INTO story_dialogue (module_ref, name, pos_x, pos_y) VALUES (?,?,?,?)`)
            .run(mid, dl.name, dl.pos_x || 0, dl.pos_y || 0).lastInsertRowid;
          dlgMap.set(dl.id, nid);
          counts.dialogues++;
          for (const cv of d.prepare(`SELECT * FROM game_conversation WHERE dialogue_ref=? ORDER BY talk_order`).all(dl.id)) {
            d.prepare(`INSERT INTO story_talk (dialogue_ref, speaker, talk_sentence, talk_order) VALUES (?,?,?,?)`)
              .run(nid, cv.char_ref ? (charName.get(cv.char_ref) || null) : null, cv.talk_sentence, cv.talk_order);
          }
        }
        for (const ln of d.prepare(`SELECT * FROM game_storyline WHERE story_ref=?`).all(st.id)) {
          const fromId = dlgMap.get(ln.from_ref), toId = dlgMap.get(ln.to_ref);
          if (fromId && toId) {
            d.prepare(`INSERT INTO story_edge (module_ref, from_ref, to_ref, label) VALUES (?,?,?,?)
              ON CONFLICT(from_ref, to_ref) DO NOTHING`).run(mid, fromId, toId, ln.symbol || null);
          }
        }
      }
    }

    else if (target === 'writer') {
      const wp = d.prepare(`SELECT * FROM write_project WHERE id=?`).get(legacyId);
      if (!wp) throw new Error('write project not found');
      const writerId = findOrCreateChild(null, 'Writer', 'collector');
      majorId = mkModule(writerId, wp.project_name, 'manager', null, wp.color);

      // New: series -> collector, between the Writer wrapper and each book.
      for (const se of d.prepare(`SELECT * FROM write_series WHERE project_id=?`).all(legacyId)) {
        const seriesId = findOrCreateChild(majorId, se.name, 'collector');
        for (const bk of d.prepare(`SELECT * FROM write_book WHERE series_id=?`).all(se.id)) {
          const mid = mkModule(seriesId, bk.name, 'author', null, bk.color);
          for (const ch of d.prepare(`SELECT * FROM write_chapter WHERE book_id=? ORDER BY chapter_order, id`).all(bk.id)) {
            const chId = author.createBookChapter(mid, ch.name);
            if (ch.chapter_content) author.updateBookChapterContent(chId, ch.chapter_content);
            counts.chapters++;
          }
        }
      }

      // New: chat session -> real ChatScribe session, replacing the old
      // inspector-flatten. write_note has no content column itself — the
      // text lives in child write_chat rows, ordered by chat_order, and
      // becomes one chat_message per row instead of one joined blob.
      const notes = d.prepare(`SELECT * FROM write_note WHERE project_id=?`).all(legacyId);
      if (notes.length) {
        const scribeId = findOrCreateChild(majorId, 'Chat', 'scribe');
        for (const nt of notes) {
          const sessionId = chatscribe.createChatSession(scribeId, nt.notename);
          const chatRows = d.prepare(`SELECT chat FROM write_chat WHERE note_id=? ORDER BY chat_order`).all(nt.id);
          for (const row of chatRows) {
            if (!row.chat) continue;
            chatscribe.createChatMessage(sessionId, row.chat);
            counts.chatMessages++;
          }
        }
      }
    }

    else if (target === 'scribe') {
      // No legacy "project" concept — legacyId is the nexusId itself
      // (listLegacyProjects returns one pseudo-row per nexus). One root
      // collector (no manager wrapper — there's no legacy project to
      // manage) holds the migrated note_folder tree 1:1, plus notes.
      majorId = mkModule(null, 'Scribe', 'collector');
      const folders = d.prepare(`SELECT * FROM note_folder WHERE nexus_ref=?`).all(nexusId);
      const folderModMap = new Map(); // note_folder.id -> new collector module id
      const byParent = new Map();
      for (const f of folders) {
        const key = f.parent_ref ?? null;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(f);
      }
      const walk = (parentFolderRef, parentModuleId) => {
        for (const f of byParent.get(parentFolderRef) || []) {
          const cid = mkModule(parentModuleId, f.name, 'collector');
          folderModMap.set(f.id, cid);
          walk(f.id, cid);
        }
      };
      walk(null, majorId);

      const notes = d.prepare(`SELECT * FROM note WHERE nexus_ref=? AND migrated_v3=0`).all(nexusId);
      for (const n of notes) {
        const parentId = n.folder_ref ? (folderModMap.get(n.folder_ref) || majorId) : majorId;
        const mid = mkModule(parentId, n.title, 'inspector');
        if (n.content) module_.updateModuleDescription(mid, n.content);
      }

      d.prepare(`UPDATE note SET migrated_v3=1 WHERE nexus_ref=? AND migrated_v3=0`).run(nexusId);
      return majorId;
    }

    else throw new Error(`unknown target ${target}`);

    d.prepare(`UPDATE ${LEGACY_TABLE[target]} SET migrated_v3=1 WHERE id=?`).run(legacyId);
    return majorId;
  });

  const id = tx();
  // batchCtx is mutated in place (director connectors recorded, navigator
  // folds into them) — handed back so the IPC caller can pass the updated
  // copy into the next migrateLegacy call in the same import batch, since
  // IPC args are serialized by value and won't share a live reference.
  return { id, counts, batchCtx: batchCtx || null };
}

// Legacy project lists for the import-choice modal's "Nexus Nest" path —
// excludes anything already flagged migrated_v3 (see migrateLegacy above).
// Scribe has no legacy "project" — it returns a single pseudo-row
// representing "this nexus's un-migrated notes" when any exist.
function listLegacyProjects(target, nexusId) {
  const d = getDB();
  if (target === 'scribe') {
    if (!nexusId) return [];
    try {
      const row = d.prepare(`SELECT COUNT(*) AS n FROM note WHERE nexus_ref=? AND migrated_v3=0`).get(nexusId);
      return row?.n ? [{ id: nexusId, name: `Scribe (${row.n})` }] : [];
    } catch (_) { return []; }
  }
  const sqls = {
    director: `SELECT id, name FROM project WHERE migrated_v3=0 ORDER BY name COLLATE NOCASE`,
    navigator: `SELECT id, name FROM world_project WHERE migrated_v3=0 ORDER BY name COLLATE NOCASE`,
    hero: `SELECT id, name FROM game_project WHERE migrated_v3=0 ORDER BY name COLLATE NOCASE`,
    writer: `SELECT id, project_name AS name FROM write_project WHERE migrated_v3=0 ORDER BY project_name COLLATE NOCASE`,
  };
  try { return d.prepare(sqls[target]).all(); } catch (_) { return []; }
}

// Plan process2 part2 #1.1/#2.1: read-only, cheap-query preview of what
// running migrateLegacy would do for every currently un-migrated legacy
// project in this nexus — the "two-sided comparison list" shown before the
// real conversion runs. Mirrors mkModule's own find-or-create lookup (one
// level: the top-level wrapper collector, and one level deeper for the
// project's own manager module) so "merges into existing" here is truthful
// to what the real run will do — simulating the FULL recursive subtree the
// way migrateLegacy itself builds it isn't practical without actually
// running it, so nested content is summarized with COUNT(*) queries instead
// of enumerated row-by-row.
const WRAPPER_NAME = { director: 'Director', navigator: 'Navigator', hero: 'Hero', writer: 'Writer' };

function summarizeLegacyProject(d, target, legacyId) {
  const parts = [];
  const add = (label, sql) => {
    const n = d.prepare(sql).get(legacyId)?.n || 0;
    if (n) parts.push(`${n} ${label}`);
  };
  if (target === 'director') {
    add('categories', `SELECT COUNT(*) AS n FROM object_category WHERE project_id=?`);
    add('timelines', `SELECT COUNT(*) AS n FROM timeline WHERE project_id=?`);
    add('maps', `SELECT COUNT(*) AS n FROM map WHERE project_id=?`);
  } else if (target === 'navigator') {
    add('characters', `SELECT COUNT(*) AS n FROM world_character WHERE world_ref=?`);
    add('categories', `SELECT COUNT(*) AS n FROM world_orig_category WHERE world_ref=?`);
    add('timelines', `SELECT COUNT(*) AS n FROM world_timeline WHERE world_ref=?`);
    add('maps', `SELECT COUNT(*) AS n FROM world_map WHERE world_ref=?`);
  } else if (target === 'hero') {
    add('characters', `SELECT COUNT(*) AS n FROM game_character WHERE game_ref=?`);
    add('collections', `SELECT COUNT(*) AS n FROM game_collection WHERE game_ref=?`);
    add('stories', `SELECT COUNT(*) AS n FROM game_story WHERE game_ref=?`);
  } else if (target === 'writer') {
    add('series', `SELECT COUNT(*) AS n FROM write_series WHERE project_id=?`);
    add('notes', `SELECT COUNT(*) AS n FROM write_note WHERE project_id=?`);
  }
  return parts.join(' · ');
}

function previewLegacyMigration(nexusId) {
  const d = getDB();
  const out = [];
  for (const target of ['director', 'navigator', 'hero', 'writer', 'scribe']) {
    for (const row of listLegacyProjects(target, nexusId)) {
      if (target === 'scribe') {
        const existing = d.prepare(`SELECT id FROM module WHERE nexus_ref=? AND parent_id IS NULL AND kind='collector' AND name=?`).get(nexusId, 'Scribe');
        out.push({ target, legacyId: row.id, legacyName: row.name, kind: 'collector', willMergeInto: existing ? 'Scribe' : null, willCreateNew: !existing, summary: '' });
        continue;
      }
      const wrapperName = WRAPPER_NAME[target];
      const wrapper = d.prepare(`SELECT id FROM module WHERE nexus_ref=? AND parent_id IS NULL AND kind='collector' AND name=?`).get(nexusId, wrapperName);
      const manager = wrapper
        ? d.prepare(`SELECT id FROM module WHERE nexus_ref=? AND parent_id=? AND kind='manager' AND name=?`).get(nexusId, wrapper.id, row.name)
        : null;
      out.push({
        target, legacyId: row.id, legacyName: row.name, kind: 'manager',
        willMergeInto: manager ? row.name : null, willCreateNew: !manager,
        summary: summarizeLegacyProject(d, target, row.id),
      });
    }
  }
  return out;
}

// Plan process2 part2 #2: one-time-per-vault "have we already shown the
// legacy-data prompt since upgrading to this version" gate, same shape as
// src/db/update.js's SEEN_KEY/dismissUpdate but parameterized per-nexus
// instead of global (app_setting lives in app.ddx, install-level — see
// docs/VAULTS.md — so this correctly persists across which vault is open).
function getLegacyPromptSeen(nexusId) {
  return getAppSetting(`${LEGACY_PROMPT_SEEN_PREFIX}${nexusId}`) === app.getVersion();
}
function setLegacyPromptSeen(nexusId) {
  setAppSetting(`${LEGACY_PROMPT_SEEN_PREFIX}${nexusId}`, app.getVersion());
  return { ok: true };
}

module.exports = { migrateLegacy, listLegacyProjects, previewLegacyMigration, getLegacyPromptSeen, setLegacyPromptSeen };
