'use strict';
// ═══ Category "Classifier" (progress.md Phase 5, relation view + icon/
// levelable/condition/display-type from Plan part5) ═══════════════════
// Major kind (any depth), 4 views (Table · List + Detail (default) · Relation in
// Cat · Grid Collection). A Classifier module IS its category — objects
// live directly under it (src/db/classifier.js, a parallel schema; see
// progress.md Section C for why it doesn't reuse Director's object_*
// tables). "Relation in Cat" reuses sage.js's force graph (src/db/viewer.js
// entity_relation as its data source, scoped client-side to this module's
// own objects).

const CLASSIFIER_VIEWS = ['table', 'listDetail', 'relationCat', 'grid'];
const CLASSIFIER_VIEW_LABEL = { table: 'Table', listDetail: 'Detail', relationCat: 'Relation', grid: 'Grid' };

// Plan part2 #2.1: this used to cost 4 + 2N round-trips — objects +
// templates + ui, then getAttrs AND getObjectTemplates per object. The two
// per-object queries hit the same two tables for every object in the module,
// so src/db/classifier.js's getObjectsFull does them as one pass each and
// hydrates attrMap/conditionMap/privateTemplates server-side. Now a flat 3
// (4 counting the inspector's own composite load, which runs in parallel).
async function loadClassifierData(m) {
  // timeline.js is lazy and owns dateInputsHTML, which a 'date' attribute row
  // now renders with (classifier-detail.js) — without this the widget is
  // undefined for anyone who opens a classifier before ever opening a
  // chronicler.
  await loadModule('src/renderer/timeline.js');
  const [full, ui, relations, index] = await Promise.all([
    api.classifier.getObjectsFull(m.id),
    api.module.getUi(m.id),
    api.viewer.getRelations(S.nexus.id),
    api.viewer.index(S.nexus.id),
  ]);
  const { objects, templates } = full;
  setClassifierLinkData(relations, index);
  S.classifierData = { moduleId: m.id, objects, templates, relations };
  S.classifierView = CLASSIFIER_VIEWS.includes(ui.activeView) ? ui.activeView : 'listDetail';
  if (S.classifierSelectedObject && !objects.find(o => o.id === S.classifierSelectedObject)) S.classifierSelectedObject = null;
  if (!S.classifierSelectedObject && objects.length) S.classifierSelectedObject = objects[0].id;
}

async function setClassifierView(moduleId, view) {
  S.classifierView = view;
  await api.module.setUi(moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

function buildClassifierMainHtml(m) {
  const d = (S.classifierData && S.classifierData.moduleId === m.id) ? S.classifierData : { objects: [], templates: [] };
  const view = S.classifierView || 'listDetail';
  const viewBar = `<div class="viewbar">
    ${CLASSIFIER_VIEWS.map(v => `<span class="vitem${v === view ? ' act' : ''}" onclick="setClassifierView(${m.id},'${v}')">${CLASSIFIER_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <button class="btn btn-p" onclick="openClassifierObjectModal(${m.id})">${I.plus} ${t('addObject')}</button>
    <button class="btn btn-s" onclick="openClassifierTemplateModal(${m.id})">${I.edit} ${t('editTemplate')}</button>
    ${viewBar}
  </div>`;
  let body;
  if (!d.objects.length) {
    body = `<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3><p>${t('nestEmpty')}</p></div>`;
  } else if (view === 'listDetail') body = renderClassifierListDetail(m, d);
  else if (view === 'grid') body = renderClassifierGrid(m, d);
  else if (view === 'relationCat') body = renderClassifierRelation(m, d);
  else body = renderClassifierTable(m, d);
  return `${toolbar}${body}`;
}

// ── Table view (default) ────────────────────────────────────────────────
function renderClassifierTable(m, d) {
  let html = `<div class="cls-table-wrap"><table class="cls-table"><tr><th>${t('name')}</th>${d.templates.map(c => `<th>${x(c.description)}</th>`).join('')}<th></th></tr>`;
  for (const o of d.objects) {
    html += `<tr><td><span class="dot" style="background:${x(o.color_code || '#6366f1')}"></span>${x(o.name)}</td>`;
    for (const c of d.templates) {
      html += `<td class="cls-cell" contenteditable="true" data-oid="${o.id}" data-tid="${c.id}" onblur="saveClassifierAttrCell(this)">${x(o.attrMap[c.id] || '')}</td>`;
    }
    html += `<td class="cls-rowacts">
      <button class="btn btn-g btn-i" onclick="openClassifierObjectModal(${m.id},${o.id})" title="${t('edit')}">${I.edit}</button>
      <button class="btn btn-g btn-i" onclick="deleteClassifierObjectRow(${o.id})" title="${t('delete')}">${I.delete}</button>
    </td></tr>`;
  }
  html += `</table></div>`;
  return html;
}

async function saveClassifierAttrCell(el) {
  const oid = Number(el.dataset.oid), tid = Number(el.dataset.tid);
  const value = el.textContent.trim();
  await api.classifier.upsertAttr(oid, tid, value);
  const obj = S.classifierData?.objects.find(o => o.id === oid);
  if (obj) obj.attrMap[tid] = value;
}

// Resolves an object's own icon (`iconPicker()`'s svg:/sym:/img: value),
// falling back to the category's default person/item glyph.
function classifierObjectIconHtml(o, m) {
  return iconRefHtml(o.icon, m.cat_type === 'character' ? I.person : I.item);
}

// ── Grid Collection view ────────────────────────────────────────────────
function renderClassifierGrid(m, d) {
  // Mockup 21: card with a color top border and a circled, tinted object
  // icon; character-type classifiers use the person glyph.
  return `<div class="cls-grid">${d.objects.map(o => {
    const col = o.color_code || '#6366f1';
    return `
    <div class="cls-card" style="border-top:3px solid ${x(col)}" onclick="openClassifierObjectModal(${m.id},${o.id})">
      <span class="disp-thumb"><img data-display-key="cobj_${o.id}" alt=""></span>
      <span class="cls-card-icon" style="border-color:${x(col)};color:${x(col)}">${classifierObjectIconHtml(o, m)}</span>
      <div class="cls-card-name">${x(o.name)}</div>
    </div>`;
  }).join('')}</div>`;
}

// ── List + Detail view (default view, Plan part5 #1) ────────────────────
function renderClassifierListDetail(m, d) {
  const sel = d.objects.find(o => o.id === S.classifierSelectedObject) || d.objects[0];
  const list = d.objects.map(o => `<div class="li${sel && o.id === sel.id ? ' sel' : ''}" onclick="selectClassifierObject(${o.id})">
    <span class="kicon" style="color:${x(o.color_code || '#6366f1')}">${classifierObjectIconHtml(o, m)}</span><span class="name">${x(o.name)}</span></div>`).join('');
  const detail = sel ? renderClassifierObjectDetail(m, sel) : '';
  return `<div class="cls-listdetail"><div class="cls-list">${list}</div><div class="cls-detail">${detail}</div></div>`;
}

// renderClassifierAttrRowHtml / renderClassifierObjectDetail moved to
// mod/classifier-detail.js (Process 8 part 1) — see that file's header.

function selectClassifierObject(id) {
  S.classifierSelectedObject = id;
  renderNexusHome();
}

async function saveClassifierAttrInput(el) {
  const oid = Number(el.dataset.oid), tid = Number(el.dataset.tid);
  const value = el.value.trim();
  if (el.placeholder === 'dd/mm/yy hh:mm' && value && !/^\d{2}\/\d{2}\/\d{2}\s\d{2}:\d{2}$/.test(value)) {
    toast(t('invalidDateFormat'), 'err');
    return;
  }
  await api.classifier.upsertAttr(oid, tid, value);
  const obj = S.classifierData?.objects.find(o => o.id === oid);
  if (obj) obj.attrMap[tid] = value;
}

// ── Relation view (real force graph, Plan part5 #6) ─────────────────────
function renderClassifierRelation(m, d) {
  return `<div class="cls-rel-wrap">
    <div id="cls-rel-graph" style="position:relative;overflow:hidden;min-height:340px;border:1px solid var(--border);border-radius:var(--r)"></div>
    <button class="btn btn-p cls-rel-add" onclick="openClassifierRelationModal(${m.id})">${I.plus} ${t('addRelation')}</button>
    ${buildClassifierRelationListHtml(m, d)}
  </div>`;
}

function classifierModuleRelations(m, d) {
  const keys = new Set(d.objects.map(o => `cobj_${o.id}`));
  return (d.relations || []).filter(r => keys.has(r.from_key) && keys.has(r.to_key));
}

function buildClassifierRelationListHtml(m, d) {
  const nameOf = (key) => d.objects.find(o => `cobj_${o.id}` === key)?.name || key;
  const rels = classifierModuleRelations(m, d);
  const rows = rels.map(r => `
    <tr>
      <td>${x(nameOf(r.from_key))}</td>
      <td><span class="cswatch cls-rel-swatch" style="background:${x(r.color_code || 'var(--border)')}"></span>${x(r.label || '—')}</td>
      <td>${x(nameOf(r.to_key))}</td>
      <td><span class="acts">
        <button class="btn btn-g btn-i" onclick="openClassifierRelationModal(${m.id},${r.id})" title="${t('edit')}">${I.edit}</button>
        <button class="btn btn-g btn-i" onclick="deleteClassifierRelationRow(${r.id})" title="${t('delete')}">${I.delete}</button>
      </span></td>
    </tr>`).join('');
  return `<table class="vw-table cls-rel-list">
    <thead><tr><th>${t('relFrom')}</th><th>${t('relationLabel')}</th><th>${t('relTo')}</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="ghost">—</td></tr>`}</tbody>
  </table>`;
}

async function mountClassifierRelationGraph() {
  const m = S.activeModuleNode;
  const d = S.classifierData;
  if (!d || d.moduleId !== m.id || !q('#cls-rel-graph')) return;
  await loadModule('src/renderer/sage.js'); // buildSageGraph lives there
  const nodes = d.objects.map(o => ({
    id: `cobj_${o.id}`, objId: o.id, module: 'obj', label: o.name,
    fill: o.color_code || m.color_code || '#8b5cf6',
  }));
  const edges = classifierModuleRelations(m, d).map(r => ({ source: r.from_key, target: r.to_key, color: r.color_code }));
  buildSageGraph({ nodes, edges }, new Set(), {
    container: '#cls-rel-graph',
    colors: { obj: m.color_code || '#8b5cf6' },
    labels: { obj: x(m.name) },
    onNodeClick: (n) => openClassifierObjectModal(m.id, n.objId),
  });
}

// ── Create/edit relation modal ───────────────────────────────────────────
function classifierRecentRelationNames() {
  const rels = S.classifierData?.relations || [];
  return [...new Set(rels.slice().sort((a, b) => b.id - a.id).map(r => r.label).filter(Boolean))].slice(0, 3);
}

function classifierRelationObjectOptions(sel) {
  return (S.classifierData?.objects || []).map(o =>
    `<option value="cobj_${o.id}" ${sel === `cobj_${o.id}` ? 'selected' : ''}>${x(o.name)}</option>`).join('');
}

async function openClassifierRelationModal(moduleId, relId = null) {
  const rel = relId ? classifierModuleRelations(S.activeModuleNode, S.classifierData).find(r => r.id === relId) : null;
  openModal(rel ? t('moduleEdit') : t('addRelation'), `
    <div class="fg"><label>${t('relationLabel')}</label>
      <input id="cr-name" value="${x(rel?.label || '')}" oninput="filterClassifierRecentNames()" autocomplete="off">
      <div class="cls-rel-recent-lbl">${t('recentUsed')}</div>
      <div class="crecent-row" id="cr-recent"></div>
    </div>
    <div class="fg cls-rel-endpoints">
      <div><label>${t('relFrom')}</label><select id="cr-from" ${rel ? 'disabled' : ''}>${classifierRelationObjectOptions(rel?.from_key)}</select></div>
      <div><label>${t('relTo')}</label><select id="cr-to" ${rel ? 'disabled' : ''}>${classifierRelationObjectOptions(rel?.to_key)}</select></div>
    </div>
    <div class="fg"><label>${t('color')}</label>${await colorPicker(rel?.color || null)}</div>
    <div class="mfoot">
      ${rel ? `<button class="btn btn-d" onclick="deleteClassifierRelationRow(${rel.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierRelationForm(${moduleId},${relId ?? 'null'})">${rel ? t('save') : t('create')}</button>
    </div>`);
  filterClassifierRecentNames();
}

function filterClassifierRecentNames() {
  const box = q('#cr-recent');
  if (!box) return;
  const value = (q('#cr-name')?.value || '').trim().toLowerCase();
  const names = classifierRecentRelationNames().filter(n => !value || n.toLowerCase().includes(value));
  box.innerHTML = names.length
    ? names.map(n => `<span class="htag-chip" style="cursor:pointer" onclick="q('#cr-name').value=${xj(n)}">${x(n)}</span>`).join('')
    : '';
}

async function submitClassifierRelationForm(moduleId, relId) {
  const label = q('#cr-name').value.trim();
  const colorId = q('#sel-color').value || null;
  if (relId) {
    await api.viewer.updateRelation(relId, label, colorId);
  } else {
    const from = q('#cr-from').value, to = q('#cr-to').value;
    if (!from || !to || from === to) return;
    await api.viewer.createRelation(S.nexus.id, from, to, label, colorId);
  }
  closeModal();
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
  toast(relId ? t('saved') : t('created'), 'ok');
}

async function deleteClassifierRelationRow(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.viewer.deleteRelation(id);
  closeModal();
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
  toast(t('deleted'), 'ok');
}

// ── Object CRUD ─────────────────────────────────────────────────────────
async function openClassifierObjectModal(moduleId, objectId) {
  const m = S.activeModuleNode;
  const o = objectId ? S.classifierData?.objects.find(x2 => x2.id === objectId) : null;
  openModal(o ? t('moduleEdit') : t('addObject'), `
    <div class="fg"><label>${t('name')} *</label><input id="co-name" value="${x(o?.name || '')}"></div>
    <div class="fg"><label>${t('iconCollection')}</label>${await iconPicker(o?.icon || null, o?.color || null, o?.name || '', m.cat_type === 'character' ? t('catTypeCharacter') : t('catTypeObject'))}</div>
    <div class="mfoot">
      ${o ? `<button class="btn btn-d" onclick="deleteClassifierObjectRow(${o.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierObjectForm(${moduleId},${o ? o.id : 'null'})">${o ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#co-name').focus(), 60);
}

async function submitClassifierObjectForm(moduleId, objectId) {
  const name = q('#co-name').value.trim();
  if (!name) return;
  const colorId = q('#sel-color').value || null;
  const icon = typeof getIconPickerValue === 'function' ? getIconPickerValue() : null;
  if (objectId) await api.classifier.updateObject(objectId, name, colorId, icon);
  else await api.classifier.createObject(moduleId, name, colorId, icon);
  closeModal();
  await loadClassifierData(S.activeModuleNode);
  // No renderNexusHome() here — invalidateNestItems schedules a coalesced
  // one (Plan part2 #2.5), so this path repaints once instead of twice.
  invalidateNestItems(moduleId, objectId ? 0 : 1);
  toast(objectId ? t('saved') : t('created'), 'ok');
}

async function deleteClassifierObjectRow(objectId) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  const moduleId = S.activeModuleNode?.id;
  await api.classifier.deleteObject(objectId);
  closeModal();
  if (S.classifierSelectedObject === objectId) S.classifierSelectedObject = null;
  await loadClassifierData(S.activeModuleNode);
  if (moduleId != null) invalidateNestItems(moduleId, -1);
  else renderNexusHome();
  toast(t('deleted'), 'ok');
}

// ── Shared template CRUD ────────────────────────────────────────────────
const CLASSIFIER_DISPTYPE_KEY = { text: 'dispTypeText', textarea: 'dispTypeTextarea', date: 'dispTypeDate' };

// Process 8 part 1: the two flags are no longer gated to cat_type 'element' —
// a Character classifier gets levelable/condition too. The level-steps input is
// gone entirely: stages are authored per element in the detail view now
// (classifier-detail.js), not once for the whole category here.
// `editing` is a template id when the form is prefilled for an edit, else null.
async function openClassifierTemplateModal(moduleId, editing = null) {
  const templates = S.classifierData?.templates || [];
  const cur = editing ? templates.find(tp => tp.id === editing) : null;
  openModal(t('editTemplate'), `
    <div>${templates.map(tpl => `
      <div class="prop insp-attr${tpl.id === editing ? ' cls-tpl-editing' : ''}">
        <span class="pk">${x(tpl.description)}</span>
        <span class="pv ghost">${[t(CLASSIFIER_DISPTYPE_KEY[tpl.attribute_type] || 'dispTypeText'), tpl.levelable ? t('levelable') : '', tpl.has_condition ? t('condition') : ''].filter(Boolean).join(' · ')}</span>
        <span class="acts">
          <button class="btn btn-g btn-i" onclick="openClassifierTemplateModal(${moduleId},${tpl.id})" title="${t('edit')}">${I.edit}</button>
          <button class="btn btn-g btn-i" onclick="deleteClassifierTemplateRow(${tpl.id})" title="${t('delete')}">${I.delete}</button>
        </span>
      </div>`).join('') || `<p style="color:var(--t3);font-size:calc(12px * var(--fsc,1));padding:4px 0">${t('nestEmpty')}</p>`}
    </div>
    <div class="fg" style="margin-top:10px"><label>${cur ? t('editAttribute') : t('addAttribute')}</label><input id="ct-name" placeholder="${t('name')}" value="${x(cur?.description || '')}"></div>
    <div class="fg"><label>${t('displayType')}</label>
      <select id="ct-disptype">
        <option value="text" ${cur?.attribute_type === 'text' || !cur ? 'selected' : ''}>${t('dispTypeText')}</option>
        <option value="textarea" ${cur?.attribute_type === 'textarea' ? 'selected' : ''}>${t('dispTypeTextarea')}</option>
        <option value="date" ${cur?.attribute_type === 'date' ? 'selected' : ''}>${t('dispTypeDate')}</option>
      </select>
    </div>
    <div class="togglerow" onclick="toggleTemplateFlag('lv')"><span class="tg${cur?.levelable ? ' on' : ''}" id="ct-lv-tg"></span>${t('levelable')}</div>
    <div class="togglerow" onclick="toggleTemplateFlag('cond')"><span class="tg${cur?.has_condition ? ' on' : ''}" id="ct-cond-tg"></span>${t('condition')}</div>
    <input type="hidden" id="ct-lv" value="${cur?.levelable ? 1 : 0}"><input type="hidden" id="ct-cond" value="${cur?.has_condition ? 1 : 0}">
    <div class="mfoot">
      ${cur ? `<button class="btn btn-s" onclick="openClassifierTemplateModal(${moduleId})">${t('cancel')}</button>` : `<button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>`}
      <button class="btn btn-p" onclick="submitClassifierTemplateForm(${moduleId},${editing ?? 'null'})">${cur ? t('save') : t('addAttribute')}</button>
    </div>`);
}

function toggleTemplateFlag(key) {
  const hidden = q(`#ct-${key}`);
  const on = hidden.value === '1';
  hidden.value = on ? '0' : '1';
  q(`#ct-${key}-tg`)?.classList.toggle('on', !on);
}

// One submit for both create and edit — updateTemplate has been wired through
// preload/main since Phase 5 but had no renderer caller until now, so editing
// an existing attribute needed no backend work, only this branch.
async function submitClassifierTemplateForm(moduleId, editing = null) {
  const name = q('#ct-name').value.trim();
  if (!name) return;
  const dispType = q('#ct-disptype')?.value || 'text';
  const levelable = q('#ct-lv')?.value === '1';
  const hasCondition = q('#ct-cond')?.value === '1';
  if (editing) await api.classifier.updateTemplate(editing, name, dispType, levelable, hasCondition, null);
  else await api.classifier.createTemplate(moduleId, name, dispType, levelable, hasCondition, null, null);
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
  toast(t(editing ? 'saved' : 'created'), 'ok');
  openClassifierTemplateModal(moduleId);
}

async function deleteClassifierTemplateRow(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.classifier.deleteTemplate(id);
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
  toast(t('deleted'), 'ok');
  openClassifierTemplateModal(S.activeModuleNode.id);
}

// ── Character type's one private attribute ──────────────────────────────
async function openClassifierCustomAttrModal(moduleId, objectId) {
  const count = await api.classifier.countObjectTemplates(objectId);
  if (count > 0) return;
  openModal(t('customAttribute'), `
    <div class="fg"><label>${t('name')} *</label><input id="cca-name"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierCustomAttr(${moduleId},${objectId})">${t('create')}</button>
    </div>`);
  setTimeout(() => q('#cca-name').focus(), 60);
}

async function submitClassifierCustomAttr(moduleId, objectId) {
  const name = q('#cca-name').value.trim();
  if (!name) return;
  await api.classifier.createTemplate(moduleId, name, 'text', 0, 0, objectId);
  closeModal();
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
  toast(t('created'), 'ok');
}
