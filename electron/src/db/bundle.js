'use strict';
// ═══ Bundles — Artisan as the one template system (v5 Part 7, V5.md §11.7) ══
// A bundle is a whole project in one step: a Collector named after it, the
// modules inside it, and (optionally) a Manager that selects the Collector
// (§8.9–§8.10) — never a Manager holding children (§8.8). The spec is DATA:
// the four genre bundles (hub/bundles.js), a user's saved one, a guide from
// electron/guide/ or a PKG `guide` package all arrive as the same JSON, and
// createBundle builds it in ONE transaction, so a failure leaves nothing
// half-made (the old wizard committed a module per step).
//
// spec = { name, icon?, color?, manager?: bool, folder?: bool, modules: [ {
//   (folder: false — the modules go straight under parentId, with no folder
//   and no Manager: one Classifier from a CSV file, §11.10)
//   ref           a name for this module inside the spec
//   kind, name, icon?, description?, catType?
//   fields        Classifier: [{ name, type, options, levelable, hasCondition, relTo }]
//                 relTo = another module's ref: the relation field targets it
//   objects       Classifier: [{ ref, name, note, values: {field: value},
//                 links: {field: [objectRef]} }]  — refs are bundle-wide
//   chapters      Author: [{ name, content, synopsis, status }]
//   tables        Diviner: the preset shape (db/preset.js)
//   events        Chronicler: [{ name, story, date: [year, month, day] }]
//   dialogues     Narrator: [{ name, description, talks: [{ speaker, text }] }]
//   sessions      Scribe: [{ name, messages: [text] }]
//   nodes         Designer: [{ shape, text, x, y }]
//   pages         Sketcher: [name]
//   selects       Exhibitor / Manager: [moduleRef] — its filter is "inside these"
// } ] }
// Text may hold [[links]] to anything else in the bundle by name; they are
// indexed as the rows land.
const { getDB } = require('./core');
const moduleDb = require('./module');
const cls = require('./classifier');
const preset = require('./preset');
const timeline = require('./timeline');
const wiki = require('./wiki');

const MAX_MODULES = 60;
const KINDS = new Set(['manager', 'inspector', 'classifier', 'locator', 'chronicler', 'wanderer', 'narrator',
  'author', 'scribe', 'drafter', 'exhibitor', 'sketcher', 'designer', 'diviner']);
const str = (v, n = 4000) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : String(v).slice(0, n));
const arr = (v) => (Array.isArray(v) ? v : []);

function colorId(d, code) {
  if (!code || !/^#[0-9a-fA-F]{3,8}$/.test(code)) return null;
  const hit = d.prepare(`SELECT id FROM use_color WHERE color_code=?`).get(code);
  return hit ? hit.id : d.prepare(`INSERT INTO use_color (color_code) VALUES (?)`).run(code).lastInsertRowid;
}

// v5 Part 8 (§12.13): a bundle's Manager page is the PROJECT page — its
// selection, then the bundle's modules as borrowed views (§12.12, a
// component whose source_key is another module), laid out here so the
// first open finds it instead of the kind's default layout. The renderer
// owns the component registry; these are its `<kind>.view` ids, for the
// kinds whose view reads well on another page (not a Manager in a Manager,
// not Wanderer's full-page map).
const PROJECT_VIEWS = new Set(['classifier', 'chronicler', 'author', 'narrator', 'scribe', 'diviner', 'locator',
  'sketcher', 'designer', 'exhibitor', 'inspector', 'drafter']);
const PROJECT_MAX_VIEWS = 8;
function projectPage(d, managerId, moduleIds, mods) {
  const ins = d.prepare(`INSERT INTO page_block (module_ref, item_key, block_type, component, source_key, config, block_order)
    VALUES (?,NULL,'component',?,?,?,?)`);
  let order = 0, shown = 0;
  ins.run(managerId, 'core.properties', null, null, order++);
  ins.run(managerId, 'manager.view', null, JSON.stringify({ preset: 'cards' }), order++);
  moduleIds.forEach((id, i) => {
    if (!PROJECT_VIEWS.has(mods[i].kind) || shown >= PROJECT_MAX_VIEWS) return;
    ins.run(managerId, `${mods[i].kind}.view`, `module_${id}`, null, order++);
    shown++;
  });
  ins.run(managerId, 'core.related', null, null, order++);
  d.prepare(`INSERT OR IGNORE INTO module_ui (module_ref, ui_key, ui_value) VALUES (?, 'pageInit', '1')`).run(managerId);
}

function createBundle(nexusId, parentId, spec) {
  const d = getDB();
  const mods = arr(spec?.modules).filter((m) => KINDS.has(m?.kind) && str(m.name, 200).trim()).slice(0, MAX_MODULES);
  const name = str(spec?.name, 200).trim();
  if (!name) return { ok: false, code: 'name_required' };
  const reindex = []; // [key, text] — after the rows exist, so a [[link]] finds its target
  const run = d.transaction(() => {
    const col = colorId(d, spec.color);
    const bare = spec.folder === false;
    const folderId = bare ? (parentId ?? null)
      : moduleDb.createModule({ nexus_ref: nexusId, parent_id: parentId ?? null, name, kind: 'collector', icon: spec.icon || null, color: col, icon_color: col });
    const created = [];
    const modByRef = new Map();
    const objByRef = new Map();
    const pendingFieldRel = []; // [templateId, relTo]
    const pendingLinks = [];    // [objectId, templateId, [objRef]]
    const pendingSelects = [];  // [moduleId, [ref]]
    for (const m of mods) {
      const id = moduleDb.createModule({
        nexus_ref: nexusId, parent_id: folderId, name: str(m.name, 200).trim(), kind: m.kind,
        icon: m.icon || null, color: col, icon_color: col,
        cat_type: m.kind === 'classifier' ? (['object', 'character', 'element'].includes(m.catType) ? m.catType : 'object') : null,
      }, { logHistory: false });
      created.push(id);
      if (m.ref) modByRef.set(m.ref, id);
      if (m.description) {
        d.prepare(`UPDATE module SET description=? WHERE id=?`).run(str(m.description, 20000), id);
        reindex.push([`module_${id}`, str(m.description, 20000)]);
      }
      if (m.kind === 'classifier') {
        const tplByName = new Map();
        for (const f of arr(m.fields)) {
          const opts = typeof f.options === 'string' ? JSON.parse(f.options || 'null') : (f.options || null);
          const o = { ...(opts || {}), ...(f.role ? { role: f.role } : {}) };
          const tid = cls.createTemplate(id, str(f.name, 200), f.type || 'text', !!f.levelable, !!f.hasCondition, null,
            Object.keys(o).length ? JSON.stringify(o) : null);
          tplByName.set(str(f.name, 200), { id: tid, type: f.type || 'text' });
          if (f.relTo) pendingFieldRel.push([tid, f.relTo, o]);
        }
        for (const ob of arr(m.objects)) {
          const oid = cls.createObject(id, str(ob.name, 200), null, null);
          if (ob.ref) objByRef.set(ob.ref, oid);
          if (ob.note) { d.prepare(`UPDATE classifier_object SET note=? WHERE id=?`).run(str(ob.note, 20000), oid); }
          for (const [fname, v] of Object.entries(ob.values || {})) {
            const tp = tplByName.get(fname);
            if (!tp) continue;
            const val = Array.isArray(v) ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? '1' : '0') : str(v);
            d.prepare(`INSERT OR REPLACE INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(oid, tp.id, val);
          }
          for (const [fname, refs] of Object.entries(ob.links || {})) {
            const tp = tplByName.get(fname);
            if (tp) pendingLinks.push([oid, tp.id, arr(refs)]);
          }
          reindex.push([`cobj_${oid}`, null]);
        }
      }
      if (m.kind === 'author') {
        arr(m.chapters).forEach((c, i) => {
          const cid = d.prepare(`INSERT INTO book_chapter (module_ref, name, chapter_label, chapter_content, chapter_order, synopsis, status) VALUES (?,?,?,?,?,?,?)`)
            .run(id, str(c.name, 200), String(i + 1), str(c.content, 200000) || null, i, str(c.synopsis) || null,
              ['idea', 'draft', 'revised', 'done'].includes(c.status) ? c.status : null).lastInsertRowid;
          if (c.content) reindex.push([`bchp_${cid}`, str(c.content, 200000)]);
        });
      }
      if (m.kind === 'diviner' && arr(m.tables).length) preset.applyPreset(id, { tables: m.tables });
      if (m.kind === 'chronicler') {
        const tl = d.prepare(`SELECT id FROM timeline WHERE module_ref=?`).get(id)?.id;
        for (const e of arr(m.events)) {
          if (!tl) break;
          const [y, mo, dy] = arr(e.date).map((n) => Math.trunc(Number(n) || 0));
          const eid = d.prepare(`INSERT INTO timeline_event (timeline_id, event_name, start_at, story) VALUES (?,?,?,?)`)
            .run(tl, str(e.name, 200), timeline.getOrCreateDate(dy || 1, mo || 1, y || 1, 0, 0), str(e.story) || null).lastInsertRowid;
          if (e.story) reindex.push([`tlev_${eid}`, str(e.story)]);
        }
      }
      if (m.kind === 'narrator') {
        arr(m.dialogues).forEach((g, i) => {
          const gid = d.prepare(`INSERT INTO story_dialogue (module_ref, name, description, pos_x, pos_y) VALUES (?,?,?,?,?)`)
            .run(id, str(g.name, 200), str(g.description) || null, 80 + i * 220, 120).lastInsertRowid;
          arr(g.talks).forEach((tk, k) => d.prepare(`INSERT INTO story_talk (dialogue_ref, speaker, talk_sentence, talk_order, row_type) VALUES (?,?,?,?, 'talk')`)
            .run(gid, str(tk.speaker, 200) || null, str(tk.text), k));
          if (i > 0) {
            const prev = d.prepare(`SELECT id FROM story_dialogue WHERE module_ref=? ORDER BY id DESC LIMIT 1 OFFSET 1`).get(id)?.id;
            if (prev) d.prepare(`INSERT OR IGNORE INTO story_edge (module_ref, from_ref, to_ref) VALUES (?,?,?)`).run(id, prev, gid);
          }
          if (g.description) reindex.push([`sdlg_${gid}`, str(g.description)]);
        });
      }
      if (m.kind === 'scribe') {
        for (const s of arr(m.sessions)) {
          const sid = d.prepare(`INSERT INTO chat_session (module_ref, name) VALUES (?,?)`).run(id, str(s.name, 200)).lastInsertRowid;
          for (const msg of arr(s.messages)) d.prepare(`INSERT INTO chat_message (session_ref, message) VALUES (?,?)`).run(sid, str(msg));
          reindex.push([`chss_${sid}`, arr(s.messages).map((x) => str(x)).join('\n')]);
        }
      }
      if (m.kind === 'designer') {
        for (const n of arr(m.nodes)) {
          d.prepare(`INSERT INTO design_node (module_ref, shape, x, y, node_text) VALUES (?,?,?,?,?)`)
            .run(id, str(n.shape, 20) || 'box', Number(n.x) || 0, Number(n.y) || 0, str(n.text) || null);
        }
      }
      if (m.kind === 'sketcher') {
        arr(m.pages).forEach((p, i) => d.prepare(`INSERT INTO sketch_page (module_ref, name, page_order) VALUES (?,?,?)`).run(id, str(p, 200), i));
      }
      if (['exhibitor', 'manager'].includes(m.kind) && arr(m.selects).length) pendingSelects.push([id, arr(m.selects)]);
    }
    // A relation field names the module it points into; values point at objects.
    for (const [tid, relTo, o] of pendingFieldRel) {
      const target = modByRef.get(relTo);
      if (target) d.prepare(`UPDATE classifier_template SET options=? WHERE id=?`).run(JSON.stringify({ targetKinds: ['object'], ...o, targetModuleId: target }), tid);
    }
    for (const [oid, tid, refs] of pendingLinks) {
      for (const r of refs) {
        const to = objByRef.get(r);
        if (to) d.prepare(`INSERT OR IGNORE INTO entity_relation (nexus_ref, from_key, to_key, rel_type, directed) VALUES (?,?,?,?,1)`).run(nexusId, `cobj_${oid}`, `cobj_${to}`, `ctpl_${tid}`);
      }
    }
    const setUi = d.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)
      ON CONFLICT(module_ref, ui_key) DO UPDATE SET ui_value=excluded.ui_value`);
    for (const [mid, refs] of pendingSelects) {
      const groups = refs.map((r) => modByRef.get(r)).filter(Boolean).map((moduleId) => ({ rules: [{ field: 'childOf', moduleId }] }));
      if (groups.length) setUi.run(mid, 'filterDef', JSON.stringify({ groups }));
    }
    let managerId = null;
    if (spec.manager !== false && !bare) {
      managerId = moduleDb.createModule({ nexus_ref: nexusId, parent_id: folderId, name, kind: 'manager', color: col, icon_color: col }, { logHistory: false });
      setUi.run(managerId, 'filterDef', JSON.stringify({ groups: [{ rules: [{ field: 'childOf', moduleId: folderId }] }] }));
      projectPage(d, managerId, created, mods);
    }
    return { folderId: bare ? null : folderId, managerId, moduleIds: created, modules: mods.length };
  });
  let out;
  try { out = run(); } catch (e) { return { ok: false, code: 'failed', message: String(e?.message || e) }; }
  // Index text only once every row exists: a [[link]] to a module made later
  // in the same bundle resolves instead of dangling.
  const { CONTENT_SOURCES } = require('./wiki-sources');
  for (const [key, text] of reindex) {
    const prefix = key.split('_')[0];
    const body = text ?? CONTENT_SOURCES[prefix]?.content(d, Number(key.split('_')[1])) ?? '';
    try { wiki.reindexWikiLinks(key, body, nexusId); } catch (_) {}
  }
  try { require('./versions').recordNexusHistory(nexusId, 'create', out.folderId ?? out.moduleIds[0], name, null); } catch (_) {}
  return { ok: true, ...out };
}

module.exports = { createBundle };
