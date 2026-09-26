'use strict';
// ═══ "Save as Artisan bundle…" (Procress 14, APP docs/TEMPLATES.md §4.4) ═
// A Collector's subtree, captured as a v2 bundle spec that createBundle
// (db/bundle.js) makes again: folders, modules with their look and fields
// (a relation's target and an Exhibitor/Manager selection become refs),
// each module's pages (a borrowed block keeps pointing inside the bundle),
// and — when asked — up to three examples per module. Anything that points
// outside the folder is left out: a bundle is made in another project.
//
// Stored in module_preset as kind 'bundle' (no schema change), so it rides
// the .ddx and a snapshot like any preset.
const { getDB } = require('./core');
const pageTpl = require('./page-template');

const MAX_SAMPLES = 3;
const slug = (s) => String(s || '').normalize('NFKD').replace(/[^A-Za-z0-9]+/g, ' ').trim()
  .split(/\s+/).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('') || 'f';
const json = (v) => { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } };

// data: 'none' | 'samples' (≤ 3 per module).
function captureBundle(folderId, { data = 'none' } = {}) {
  const d = getDB();
  const root = d.prepare(`SELECT id, name, kind, icon FROM module WHERE id=?`).get(folderId);
  if (!root || root.kind !== 'collector') throw new Error('not a folder');
  // the subtree, breadth-first
  const all = [];
  for (let q = [root.id]; q.length;) {
    const id = q.shift();
    for (const m of d.prepare(`SELECT id, parent_id, name, kind, icon, cat_type, description FROM module WHERE parent_id=? ORDER BY display_order, id`).all(id)) {
      all.push(m);
      if (m.kind === 'collector') q.push(m.id);
    }
  }
  const inside = new Set([root.id, ...all.map((m) => m.id)]);
  const ref = (id) => `m${id}`;
  const folders = [{ ref: 'root', name: root.name }];
  const folderRef = new Map([[root.id, 'root']]);
  for (const m of all.filter((x) => x.kind === 'collector')) {
    folderRef.set(m.id, `f${m.id}`);
    folders.push({ ref: `f${m.id}`, name: m.name, parent: folderRef.get(m.parent_id) });
  }
  const objRef = new Map(); // cobj id → ref, for links between examples
  const modules = [];
  for (const m of all.filter((x) => x.kind !== 'collector')) {
    const out = { ref: ref(m.id), kind: m.kind, name: m.name, folder: folderRef.get(m.parent_id) || 'root' };
    if (m.icon) out.icon = m.icon;
    if (m.description) out.description = m.description;
    if (m.kind === 'classifier') {
      out.catType = m.cat_type || 'object';
      const used = new Set();
      out.fields = d.prepare(`SELECT id, description AS name, attribute_type AS type, options, levelable, has_condition AS hasCondition
        FROM classifier_template WHERE module_ref=? AND object_ref IS NULL ORDER BY display_order, id`).all(m.id).map((f) => {
        const o = json(f.options) || {};
        let key = typeof o.key === 'string' ? o.key : slug(f.name);
        for (let n = 2; used.has(key); n++) key = `${slug(f.name)}${n}`;
        used.add(key);
        const target = o.targetModuleId;
        delete o.targetModuleId; delete o.key;
        const field = { key, name: f.name, type: f.type, _id: f.id };
        if (Object.keys(o).length) field.options = o;
        if (f.levelable) field.levelable = true;
        if (f.hasCondition) field.hasCondition = true;
        if (target && inside.has(target)) field.relTo = ref(target);
        return field;
      });
    }
    const ui = Object.fromEntries(d.prepare(`SELECT ui_key, ui_value FROM module_ui WHERE module_ref=?`).all(m.id).map((r) => [r.ui_key, r.ui_value]));
    const sel = (json(ui.filterDef)?.groups || []).flatMap((g) => (g.rules || []).filter((r) => r.field === 'childOf').map((r) => r.moduleId))
      .filter((id) => folderRef.has(id) || inside.has(id));
    if (sel.length && ['exhibitor', 'manager'].includes(m.kind)) out.selects = sel.map((id) => folderRef.get(id) || ref(id));
    if (m.kind === 'wanderer') {
      const uses = [ui.mapModule, ui.timelineModule].map(Number).filter((id) => id && inside.has(id));
      if (uses.length) out.uses = uses.map(ref);
    }
    // pages: a borrow of a module in the folder stays bound (as its ref)
    const borrow = (sk) => { const id = Number(String(sk).replace(/^module_/, '')); return inside.has(id) ? ref(id) : null; };
    const page = pageTpl.capturePage(m.id, null, borrow);
    const itemPage = pageTpl.capturePage(m.id, '*', borrow);
    if (page.length) out.page = page;
    if (itemPage.length) out.itemPage = itemPage;
    if (data === 'samples') {
      if (m.kind === 'classifier') {
        out.objects = d.prepare(`SELECT id, name, note FROM classifier_object WHERE module_ref=? ORDER BY id LIMIT ?`).all(m.id, MAX_SAMPLES).map((o) => {
          objRef.set(o.id, `o${o.id}`);
          const ob = { ref: `o${o.id}`, sample: true, name: o.name };
          if (o.note) ob.note = o.note;
          for (const f of out.fields) {
            if (f.type === 'relation') continue;
            const v = d.prepare(`SELECT attribute_value AS v FROM classifier_attribute WHERE object_ref=? AND template_ref=?`).get(o.id, f._id)?.v;
            if (v != null && v !== '') (ob.values ||= {})[f.key] = v;
          }
          return ob;
        });
      }
      if (m.kind === 'chronicler') {
        out.events = d.prepare(`SELECT e.event_name AS name, e.story, dt.years AS y, dt.month AS mo, dt.day AS dy
          FROM timeline_event e JOIN timeline t ON t.id=e.timeline_id LEFT JOIN timeline_date dt ON dt.id=e.start_at
          WHERE t.module_ref=? ORDER BY e.id LIMIT ?`).all(m.id, MAX_SAMPLES)
          .map((e) => ({ sample: true, name: e.name, ...(e.story ? { story: e.story } : {}), date: [e.y || 1, e.mo || 1, e.dy || 1] }));
      }
      if (m.kind === 'author') {
        out.chapters = d.prepare(`SELECT name, chapter_content AS content, synopsis, status FROM book_chapter WHERE module_ref=? ORDER BY chapter_order, id LIMIT ?`)
          .all(m.id, MAX_SAMPLES).map((c) => ({ sample: true, name: c.name, ...(c.content ? { content: c.content } : {}),
            ...(c.synopsis ? { synopsis: c.synopsis } : {}), ...(c.status ? { status: c.status } : {}) }));
      }
    }
    modules.push(out);
  }
  // links between captured examples, through relation fields that stay inside
  if (data === 'samples') {
    for (const m of modules.filter((x) => x.kind === 'classifier')) {
      const rel = m.fields.filter((f) => f.type === 'relation' && f.relTo);
      for (const ob of m.objects || []) {
        const oid = Number(ob.ref.slice(1));
        for (const f of rel) {
          const to = d.prepare(`SELECT to_key FROM entity_relation WHERE from_key=? AND rel_type=?`).all(`cobj_${oid}`, `ctpl_${f._id}`)
            .map((r) => objRef.get(Number(String(r.to_key).replace(/^cobj_/, '')))).filter(Boolean);
          if (to.length) (ob.links ||= {})[f.key] = to;
        }
      }
    }
  }
  for (const m of modules) for (const f of m.fields || []) delete f._id;
  const manager = modules.find((m) => m.kind === 'manager');
  return { name: root.name, icon: root.icon || null, folders, modules, ...(manager ? { home: manager.ref } : {}) };
}

function saveBundle(nexusId, folderId, name, opts = {}) {
  const n = String(name || '').trim().slice(0, 120);
  if (!n) throw new Error('name required');
  const spec = captureBundle(folderId, opts);
  getDB().prepare(`
    INSERT INTO module_preset (nexus_ref, kind, name, spec) VALUES (?, 'bundle', ?, ?)
    ON CONFLICT(nexus_ref, kind, name) DO UPDATE SET spec=excluded.spec, update_at=datetime('now')`)
    .run(nexusId, n, JSON.stringify(spec));
  return { name: n, modules: spec.modules.length };
}

// The user's own bundles ("Mine" in the Artisan gallery).
const listBundles = (nexusId) => getDB().prepare(`SELECT id, name, spec FROM module_preset WHERE nexus_ref=? AND kind='bundle' ORDER BY name COLLATE NOCASE`)
  .all(nexusId).map((r) => ({ id: r.id, name: r.name, spec: json(r.spec) || { modules: [] } }));

module.exports = { captureBundle, saveBundle, listBundles };
