'use strict';
// ═══ Category "Classifier" (progress.md Phase 5, reworked v5 Part 3) ═══
// A Classifier module IS its category — objects live directly under it
// (src/db/classifier.js, a parallel schema; see progress.md Section C for why
// it doesn't reuse Director's object_* tables). Four views: Table · Detail
// (list + detail, default) · Relation · Grid.
//
// v5 Part 3 (APP docs/V5.md §7.4–§7.5) split this kind into four files, each
// under the ~500-line band:
//   classifier.js         data load, the view shell and the four views
//   classifier-detail.js  the body of ONE object (fields, levels, links)
//   classifier-fields.js  "Fields of this category" and per-object fields
//   classifier-ctx.js     right-click menus, object CRUD, quick start
// Relations are read-only here; they are authored in an Exhibitor (§3.5).

const CLASSIFIER_VIEWS = ['table', 'listDetail', 'relationCat', 'grid'];
// §7.5 bug #10: these rendered as raw English beside a translated toolbar.
const CLASSIFIER_VIEW_KEY = { table: 'clsViewTable', listDetail: 'clsViewDetail', relationCat: 'clsViewRelation', grid: 'clsViewGrid' };

// ── Data, per module (v5 Part 8, APP docs/V5.md §12.3) ──────────────────
// Was one S.classifierData for "the" open Classifier. A page can now show
// several — its own and borrowed ones (§12.12) — so data is cached per
// module, and what differs per instance (the preset, the selected object)
// lives on the instance (page/page.js pbState), never on a global.
const CLS = {};
const clsData = (moduleId) => CLS[moduleId] || { moduleId, objects: [], templates: [], relations: [], ui: {} };
const clsAllData = () => Object.values(CLS);
// An object or field wherever it is cached — handlers that get only an id.
const clsFindObject = (oid) => clsAllData().flatMap((d) => d.objects).find((o) => o.id === oid) || null;
const clsModuleOfObject = (oid) => clsAllData().find((d) => d.objects.some((o) => o.id === oid))?.moduleId ?? null;
const clsFindTemplate = (tid) => clsAllData().flatMap((d) => [...d.templates, ...d.objects.flatMap((o) => o.privateTemplates || [])])
  .find((tp) => tp.id === tid) || null;

// Plan part2 #2.1: 3 round-trips, not 4 + 2N — getObjectsFull hydrates
// attrMap / levelMap / privateTemplates server-side in one pass.
async function loadClassifierData(m) {
  // timeline.js is lazy and owns dateInputsHTML, which a 'date' field renders
  // with (classifier-detail.js) — without this the widget is undefined for
  // anyone who opens a classifier before ever opening a chronicler.
  await loadModule('src/renderer/timeline.js');
  const [full, ui, relations, index] = await Promise.all([
    api.classifier.getObjectsFull(m.id),
    api.module.getUi(m.id),
    api.viewer.getRelations(S.nexus.id),
    api.viewer.index(S.nexus.id),
  ]);
  const { objects, templates } = full;
  setClassifierLinkData(relations, index);
  CLS[m.id] = { moduleId: m.id, objects, templates, relations, ui };
  return CLS[m.id];
}

// The instance's view: its block's preset, else the module's saved one.
function clsViewOf(c) {
  const p = c.config?.preset || clsData(c.source.id).ui?.activeView;
  return CLASSIFIER_VIEWS.includes(p) ? p : 'listDetail';
}

// The instance's selected object: a link that just asked for one wins,
// then what this instance had, then the first object.
function clsSelectedOf(c, d) {
  const st = c.state;
  if (S.clsPendingSelect != null && d.objects.some((o) => o.id === S.clsPendingSelect)) {
    st.sel = S.clsPendingSelect;
    S.clsPendingSelect = null;
  }
  const sel = d.objects.find((o) => o.id === st.sel) || d.objects[0] || null;
  st.sel = sel?.id ?? null;
  return sel;
}

// A chip on the view bar: this instance's preset, and the module's default
// for the next page that shows it.
async function setClassifierView(iid, view) {
  const i = pbInst(iid);
  if (!i) return;
  const mid = i.sourceId ?? i.moduleId;
  await api.module.setUi(mid, 'activeView', view);
  if (CLS[mid]) CLS[mid].ui = { ...CLS[mid].ui, activeView: view };
  if (S.inspectorData?.moduleId === mid) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  await pbSetConfig(iid, { preset: view });
}

// Reload after any write, whichever surfaces are live: the element's own
// page, and every Classifier instance on screen (a borrowed one included).
async function refreshClassifier() {
  if (S.activeItemNode?.itemKind === 'classifier') {
    await openItemNode('classifier', S.activeItemNode.moduleId, S.activeItemNode.id);
    return;
  }
  const ids = new Set(Object.values(PB_INST).filter((i) => i.component === 'classifier.view').map((i) => i.sourceId));
  if (S.activeModuleNode?.kind === 'classifier') ids.add(S.activeModuleNode.id);
  await Promise.all([...ids].map((id) => findModuleNode(id)).filter(Boolean).map(loadClassifierData));
  renderNexusHome();
}

registerComponent('classifier.view', {
  kind: 'classifier', label: () => kindLabel('classifier'), borrow: true,
  presets: () => CLASSIFIER_VIEWS, presetLabel: (p) => t(CLASSIFIER_VIEW_KEY[p]),
  load: (m) => loadClassifierData(m),
  render: (c) => buildClassifierMainHtml(c.source, c),
  mount: (c) => { if (clsViewOf(c) === 'relationCat') mountClassifierRelationGraph(c); },
});

function buildClassifierMainHtml(m, c) {
  const d = clsData(m.id);
  const view = clsViewOf(c);
  const iid = xj(c.iid);
  const viewBar = viewBarHtml(CLASSIFIER_VIEWS, view, v => `setClassifierView(${iid},'${v}')`, v => t(CLASSIFIER_VIEW_KEY[v]));
  // §7.1: one primary action on the toolbar; fields are the advanced tier.
  const toolbar = `<div class="classifier-toolbar" oncontextmenu="openCtx('classifier.category',event,{moduleId:${m.id}})">
    ${cmdBtn('classifier.addObject', { moduleId: m.id }, { cls: 'btn-p' })}
    ${cmdBtn('classifier.fields', { moduleId: m.id })}
    ${viewBar}
  </div>`;
  let body;
  if (!d.objects.length) {
    // §7.5 bug #3: this said "create your first Main module". §7.4: one click
    // to a usable category instead of ~10.
    body = kindEmptyStateHtml(m, {
      attrs: `oncontextmenu="openCtx('classifier.category',event,{moduleId:${m.id}})"`,
      extra: `<p class="drafter-hint">${t('clsQuickStartHint')}</p>`,
    });
  } else if (view === 'listDetail') body = renderClassifierListDetail(m, d, c);
  else if (view === 'grid') body = renderClassifierGrid(m, d, c);
  else if (view === 'relationCat') body = renderClassifierRelation(m, d);
  else body = renderClassifierTable(m, d, c);
  return `${toolbar}${body}`;
}

// ── Table view ──────────────────────────────────────────────────────────
// §7.5 bug #6: a levelable / conditioned field keeps its value in
// classifier_level rows, not in attribute_value — typing into a flat cell
// here wrote a value no view ever showed. Procress 26 part 3: the cell edits
// the LAST level row's own field (its level, else its condition) in place;
// "· N" opens the element for the rest, and an empty cell's + adds the first.
function classifierTableCellHtml(m, o, c) {
  if (c.levelable || c.has_condition) {
    const rows = o.levelMap?.[c.id] || [];
    const last = rows[rows.length - 1];
    const all = `<button class="btn btn-g btn-sm cls-lv-all" title="${x(t('clsLevelCellHint'))}" onclick="openItemNode('classifier',${m.id},${o.id})" data-no-i18n>· ${rows.length}</button>`;
    if (!last) {
      return `<td class="cls-cell cls-cell-ctl"><button class="btn btn-g btn-i" title="${x(t('levelAddRow'))}" aria-label="${x(t('levelAddRow'))}" onclick="addClsLevelFromCell(${o.id},${c.id})">${I.plus}</button></td>`;
    }
    const field = c.levelable ? 'level_label' : 'condition_value';
    return `<td class="cls-cell cls-cell-ctl"><span class="cls-lv-cell" contenteditable="true" data-oid="${o.id}" data-tid="${c.id}" data-lid="${last.id}" data-field="${field}"
      aria-label="${x(c.description || '')}" onblur="saveClsLevelCell(this)" data-no-i18n>${x(last[field] || '')}</span>${all}</td>`;
  }
  return clsFieldCellHtml(m, o, c); // v5 Part 7 (§11.3), mod/cls-field-types.js
}

async function saveClsLevelCell(el) {
  const value = el.textContent.trim();
  const row = (clsFindObject(Number(el.dataset.oid))?.levelMap?.[el.dataset.tid] || []).find((r) => r.id === Number(el.dataset.lid));
  if (row && (row[el.dataset.field] || '') === value) return;
  await api.classifier.updateLevelField(Number(el.dataset.lid), el.dataset.field, value);
  if (row) row[el.dataset.field] = value;
}

async function addClsLevelFromCell(oid, tid) {
  await api.classifier.createLevel(oid, tid);
  await refreshClassifier();
  q(`.cls-lv-cell[data-oid="${oid}"][data-tid="${tid}"]`)?.focus();
}

// Procress 17 P1: rows render in chunks as they scroll in (core/ui.js lazyRows).
const clsLazy = (c, view) => ((c.state.lazy ||= {})[view] ||= {});

// Procress 26 part 3: the name cell renames on a double click (an input in
// place, hub/edit.js's pattern); the grip before it drags the row.
function classifierNameCellHtml(m, o) {
  const grip = reorderGripHtml(`clsDragDown(event,this.closest('tr'),'obj',${m.id},${o.id})`);
  const dot = `<span class="dot" style="background:${x(o.color_code || 'var(--accent)')}"></span>`;
  const name = S.clsRenamingObject === o.id
    ? `<input id="rename-cobj-${o.id}" class="rename-input" value="${x(S.clsRenameDraft?.id === o.id ? S.clsRenameDraft.value : o.name)}" onblur="saveClsObjectRename(${o.id},this.value,this)" onkeydown="clsRenameKey(event,this,${o.id})" data-no-i18n>`
    : `<span class="cls-name" title="${x(t('rename'))}" ondblclick="startRenameClsObject(${o.id})" data-no-i18n>${x(o.name)}</span>`;
  return `<td class="cls-name-cell">${grip}${dot}${name}</td>`;
}

// Procress 27 part 4: a column head's guide text says what kind of field it is.
const clsColumnTip = (c) => [t(CLASSIFIER_DISPTYPE_KEY[c.attribute_type] || 'dispTypeText'), c.levelable ? t('levelable') : '', c.has_condition ? t('condition') : '']
  .filter(Boolean).join(' · ') + `\n${t('clsFieldMenu')}`;

function renderClassifierTable(m, d, inst) {
  // Procress 24: a column's head is its field — click it for the field menu
  // (type · rename · delete), two clicks from the module page. Procress 26:
  // drag the head to move the column.
  let html = `<div class="cls-table-wrap"><table class="cls-table"><tr><th>${t('name')}</th>${d.templates.map(c => `<th class="cls-col-head" data-cls-tid="${c.id}" onpointerdown="clsDragDown(event,this,'tpl',${m.id},${c.id},'x')"><button type="button" class="btn btn-g btn-sm" aria-haspopup="menu" title="${x(clsColumnTip(c))}" onclick="event.stopPropagation();openClsFieldMenu(this,${m.id},${c.id})" data-no-i18n>${x(c.description)}</button></th>`).join('')}<th></th></tr>`;
  const keep = S.clsRenamingObject != null ? d.objects.findIndex((o) => o.id === S.clsRenamingObject) : -1;
  html += lazyRows(d.objects, (o) => {
    let html = `<tr data-cls-oid="${o.id}" oncontextmenu="openCtx('classifier.object',event,{moduleId:${m.id},objectId:${o.id}})">${classifierNameCellHtml(m, o)}`;
    for (const c of d.templates) html += classifierTableCellHtml(m, o, c);
    html += `<td class="cls-rowacts">
      <button class="btn btn-g btn-i" onclick="openClassifierObjectModal(${m.id},${o.id})" title="${t('edit')}">${I.edit}</button>
      <button class="btn btn-g btn-i" onclick="deleteClassifierObjectRow(${o.id})" title="${t('delete')}">${I.delete}</button>
    </td></tr>`;
    return html;
  }, clsLazy(inst, 'table'), { keep, more: (id) => `<tr class="lazy-more" data-lazy="${id}"><td colspan="${d.templates.length + 2}"></td></tr>` });
  html += `</table></div>`;
  return html;
}

async function saveClassifierAttrCell(el) {
  const oid = Number(el.dataset.oid), tid = Number(el.dataset.tid);
  const value = el.textContent.trim();
  await api.classifier.upsertAttr(oid, tid, value);
  const obj = clsFindObject(oid);
  if (obj) obj.attrMap[tid] = value;
}

// An object's own icon (iconPicker()'s svg:/sym:/img: value), falling back
// to the category's default glyph.
function classifierObjectIconHtml(o, m) {
  return iconRefHtml(o.icon, m.cat_type === 'character' ? I.person : I.item);
}

// ── Grid view ───────────────────────────────────────────────────────────
// §7.5 bug #9: a card opened the rename/icon modal; it opens the element now
// (rename and colour moved to the card's right-click menu).
function renderClassifierGrid(m, d, inst) {
  return `<div class="cls-grid" oncontextmenu="if(event.target===this)openCtx('classifier.category',event,{moduleId:${m.id}})">${lazyRows(d.objects, o => {
    const col = o.color_code || 'var(--accent)';
    return `
    <div class="card card-link cls-tile" data-cls-oid="${o.id}" style="border-top:3px solid ${x(col)}" onclick="openItemNode('classifier',${m.id},${o.id})"
        oncontextmenu="openCtx('classifier.object',event,{moduleId:${m.id},objectId:${o.id}})" onpointerdown="clsDragDown(event,this,'obj',${m.id},${o.id},'xy')">
      <span class="disp-thumb"><img data-display-key="cobj_${o.id}" alt=""></span>
      <span class="cls-card-icon" style="border-color:${x(col)};color:${x(col)}">${classifierObjectIconHtml(o, m)}</span>
      <div class="cls-card-name">${x(o.name)}</div>
    </div>`;
  }, clsLazy(inst, 'grid'))}</div>`;
}

// ── Detail view (list + detail, default) ────────────────────────────────
function renderClassifierListDetail(m, d, c) {
  const sel = clsSelectedOf(c, d);
  // Procress 21: compact rows of the shared list (core/list.js) — ⋯ and a
  // right click are the object menu; F2 renames, Delete deletes (with Undo).
  const list = lazyRows(d.objects, o => listRowHtml({
    density: 'compact', drag: true, state: { selected: !!(sel && o.id === sel.id) }, onclick: `selectClassifierObject(${xj(c.iid)},${o.id})`,
    icon: `<span style="color:${x(o.color_code || 'var(--accent)')}">${classifierObjectIconHtml(o, m)}</span>`, title: o.name,
    menu: `openCtx('classifier.object',event,{moduleId:${m.id},objectId:${o.id}})`,
    attrs: `data-no-i18n data-cls-oid="${o.id}" onpointerdown="clsDragDown(event,this,'obj',${m.id},${o.id})"`,
    actions: listActHtml({ hidden: true, key: 'F2', name: t('rename'), onclick: `openClassifierObjectModal(${m.id},${o.id})` })
      + listActHtml({ hidden: true, key: 'Delete', name: t('delete'), onclick: `deleteClassifierObjectRow(${o.id})` }),
  }), clsLazy(c, 'list'), { keep: sel ? d.objects.indexOf(sel) : -1 });
  const detail = sel ? renderClassifierObjectDetail(m, sel, d.templates) : '';
  return `<div class="cls-listdetail"><div class="cls-list ls-list" role="listbox" aria-label="${x(m.name)}" oncontextmenu="if(event.target===this)openCtx('classifier.category',event,{moduleId:${m.id}})">${list}</div><div class="cls-detail">${detail}</div></div>`;
}

function selectClassifierObject(iid, id) {
  pbState(iid).sel = id;
  S.classifierSelectedObject = id; // the palette's target (core/commands.js)
  renderNexusHome();
}

async function saveClassifierAttrInput(el) {
  const oid = Number(el.dataset.oid), tid = Number(el.dataset.tid);
  const value = el.value.trim();
  await api.classifier.upsertAttr(oid, tid, value);
  const obj = clsFindObject(oid);
  if (obj) obj.attrMap[tid] = value;
}

// ── Relation view (read-only, v5) ───────────────────────────────────────
// §7.4 "one relation surface": this view and the detail page's Linked
// elements used to write entity_relation through two unrelated modals.
// Both now READ through classifierRelationRowsHtml (classifier-detail.js) —
// this one for every relation touching the category, the detail for one
// object — and both hand off to the Exhibitor to author (§3.5).
function renderClassifierRelation(m, d) {
  const keys = new Set(d.objects.map(o => `cobj_${o.id}`));
  return `<div class="cls-rel-wrap">
    <div class="cls-rel-graph" data-r="rel-graph"></div>
    <button class="btn btn-p cls-rel-add" onclick="openExhibitorFor(${m.id})">${I.relation} ${t('openInExhibitor')}</button>
    ${listLinksHtml(classifierRelationRowsHtml(keys))}
  </div>`;
}

async function mountClassifierRelationGraph(c) {
  const m = c.source;
  const d = clsData(m.id);
  const box = c.root.querySelector('[data-r="rel-graph"]');
  if (!box) return;
  await loadModule('src/renderer/sage.js'); // buildSageGraph lives there
  // Procress 28 part 3: every object, not only the linked ones — an object
  // with no relation sits on the outer rings (sage.js n.outer), out of the
  // force layout that made 3,000 dots cost ~2 s (Procress 17 P1). Modules
  // linked to this one (api.module.linked — relations and [[links]]) bring
  // their elements too, each behind the graph's own module checkbox; which
  // ones are ticked is kept per module (module_ui clsRelInclude).
  const [linkedMods, ui, index] = await Promise.all([
    api.module.linked(m.id), api.module.getUi(m.id), S.nexus ? api.viewer.index(S.nexus.id) : [],
  ]);
  if (!box.isConnected) return;
  let shown = new Set();
  try { shown = new Set(JSON.parse(ui?.clsRelInclude || '[]').map(Number)); } catch (_) {}
  const others = linkedMods.map((e) => findModuleNode(e.id)).filter((mm) => mm && mm.kind !== 'collector');
  const otherIds = new Set(others.map((mm) => mm.id));
  const extra = index.filter((e) => otherIds.has(e.moduleId) && e.kind !== 'module' && e.kind !== 'file');
  const keys = new Set([...d.objects.map((o) => `cobj_${o.id}`), ...extra.map((e) => e.key)]);
  const rels = (d.relations || []).filter((r) => keys.has(r.from_key) && keys.has(r.to_key));
  const touched = new Set(rels.flatMap((r) => [r.from_key, r.to_key]));
  const own = d.objects.map((o) => {
    const key = `cobj_${o.id}`;
    return { id: key, objId: o.id, module: 'obj', label: o.name, hoverKey: key, outer: !touched.has(key),
      fill: o.color_code || m.color_code || '#8b5cf6', iconHtml: o.icon ? classifierObjectIconHtml(o, m) : null };
  });
  const ext = extra.map((e) => ({ id: e.key, module: `m${e.moduleId}`, label: e.name, hoverKey: e.key, outer: !touched.has(e.key),
    fill: e.color || findModuleNode(e.moduleId)?.color_code || 'var(--t2)' }));
  const edges = rels.map((r) => ({ source: r.from_key, target: r.to_key, color: r.color_code }));
  const colors = { obj: m.color_code || '#8b5cf6' }, labels = { obj: x(m.name) };
  for (const mm of others) { colors[`m${mm.id}`] = mm.color_code || 'var(--t2)'; labels[`m${mm.id}`] = x(mm.name); }
  const hidden = new Set(others.filter((mm) => !shown.has(mm.id)).map((mm) => `m${mm.id}`));
  buildSageGraph({ nodes: [...own, ...ext], edges }, hidden, {
    container: box, colors, labels,
    // §7.5 bug #9: a node opens the element, not the rename modal.
    onNodeClick: (n) => (n.objId ? openItemNode('classifier', m.id, n.objId) : openEntityByKey(n.id)),
    onNodeContext: (n, e) => { if (n.objId) openCtx('classifier.object', e, { moduleId: m.id, objectId: n.objId }); },
    onFilterChange: (h) => api.module.setUi(m.id, 'clsRelInclude', JSON.stringify(others.filter((mm) => !h.has(`m${mm.id}`)).map((mm) => mm.id))),
  });
}
