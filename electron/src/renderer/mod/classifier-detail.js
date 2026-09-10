'use strict';
// ═══ Classifier element detail (Process 8 part 1) ══════════════════════
// Split out of mod/classifier.js, which was at the ~500-line band before this
// round added three features to the detail view alone (the level table, the
// 5-box date input and the cross-classifier link section). The list/table/grid
// views, object CRUD and template CRUD stay in classifier.js; everything that
// renders the body of ONE element lives here.
//
// Both callers of renderClassifierObjectDetail pick these up for free: the
// module's own List+Detail view (renderClassifierListDetail) and the element's
// dedicated Builder page (ITEM_KIND.classifier.renderBody, mod/item.js).

// ── Date attribute (Plan: "input ประเภท date ... 5 ช่องใน 1 row") ────────
// Reuses Chronicler's dateInputsHTML/.date-row-inline widget rather than a
// second one, so both modules read the same. What it does NOT reuse is
// getDateFromInputs — that resolves to a timeline_date row id, which is
// Chronicler's storage; a classifier attribute is a TEXT column, so the five
// parts are serialized to the same "D/M/YYYY HH:MM" string fmtDate produces
// and re-split on render. Per-row prefix because dateInputsHTML builds ids
// from it and a detail view renders many of these at once.
const CLS_DATE_PREFIX = (oid, tid) => `cls-date-${oid}-${tid}`;

// "3/7/1482 09:30" -> the shape dateInputsHTML expects. Anything unparseable
// (including values typed into the old free-text box before this round) comes
// back empty rather than throwing, so the row still renders and can be refilled.
function clsParseDateValue(val) {
  const m = /^\s*(\d+)\/(\d+)\/(\d+)(?:\s+(\d+):(\d+))?\s*$/.exec(String(val || ''));
  if (!m) return null;
  return { d: +m[1], mo: +m[2], y: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0) };
}

function clsDateInputsHtml(o, c) {
  const p = CLS_DATE_PREFIX(o.id, c.id);
  const v = clsParseDateValue(o.attrMap[c.id]);
  const ev = v ? { d: v.d, mo: v.mo, y: v.y, h: v.h, mi: v.mi } : null;
  const save = `saveClassifierAttrDate(${o.id},${c.id})`;
  return dateInputsHTML(p, ev, 'd', 'mo', 'y', 'h', 'mi', save);
}

// Day/month/year are required together — a partial date saves as empty rather
// than as a half-written string no reader could parse back.
async function saveClassifierAttrDate(oid, tid) {
  const p = CLS_DATE_PREFIX(oid, tid);
  const num = (sfx) => parseInt(q(`#${p}-${sfx}`)?.value, 10) || 0;
  const d = num('d'), mo = num('mo'), y = num('y');
  const value = (d && mo && y) ? fmtDate(d, mo, y, num('h'), num('min')) : '';
  await api.classifier.upsertAttr(oid, tid, value);
  const obj = S.classifierData?.objects.find(v => v.id === oid);
  if (obj) obj.attrMap[tid] = value;
}

// ── Level / condition table ─────────────────────────────────────────────
// Replaces the old "number box + step buttons parsed from the template's
// level_steps string". Stages are per element now and free text, so the shape
// is a table the user adds rows to. Column set is driven by the template's two
// flags (Plan: condition alone = condi+info, condition+levelable = level+
// condi+info), and levelable alone gets level+info by the same rule.
function clsLevelColumns(c) {
  const cols = [];
  if (c.levelable) cols.push(['level_label', 'levelColLevel']);
  if (c.has_condition) cols.push(['condition_value', 'condition']);
  cols.push(['info_value', 'levelColInfo']);
  return cols;
}

// Column width ratio (Process 8 part 2): level is capped at 10% of the row,
// condition takes 30% of whatever's left after level's share — so it's still
// ~30% of the full row when there's no level column at all — and info takes
// the rest. Grip/action stay small fixed percentages of their own rather than
// px, so they share the same 100%-of-row budget as the data columns instead
// of fighting table-layout:fixed's px-vs-% column math.
function clsLevelColumnWidths(c) {
  const gripPct = 6, actPct = 8;
  const rowPct = 100 - gripPct - actPct;
  const levelPct = c.levelable ? rowPct * 0.10 : 0;
  const condPct = c.has_condition ? (rowPct - levelPct) * 0.30 : 0;
  const infoPct = rowPct - levelPct - condPct;
  return { gripPct, actPct, level_label: levelPct, condition_value: condPct, info_value: infoPct };
}

function renderClassifierLevelTableHtml(o, c) {
  const cols = clsLevelColumns(c);
  const rows = (o.levelMap?.[c.id]) || [];
  const w = clsLevelColumnWidths(c);
  const colgroup = `<colgroup><col style="width:${w.gripPct}%">
    ${cols.map(([field]) => `<col style="width:${w[field]}%">`).join('')}
    <col style="width:${w.actPct}%"></colgroup>`;
  const head = cols.map(([, k]) => `<th>${t(k)}</th>`).join('');
  const body = rows.map(r => `<tr data-lid="${r.id}"
      ondragover="onClassifierLevelRowDragOver(event,this)"
      ondragleave="this.classList.remove('drop-before','drop-after')"
      ondrop="onClassifierLevelRowDrop(event,${o.id},${c.id},${r.id})">
    <td class="cls-lv-grip"><span class="nar-grip" draggable="true" title="${t('dragReorder')}"
      ondragstart="onClassifierLevelRowDragStart(event,${r.id})">${I.move}</span></td>
    ${cols.map(([field]) => `<td><input class="cls-lv-inp" value="${x(r[field] || '')}"
      data-lid="${r.id}" data-field="${field}" onblur="saveClassifierLevelField(this)"></td>`).join('')}
    <td class="cls-lv-act"><button class="btn btn-g btn-i" onclick="deleteClassifierLevelRow(${r.id})" title="${t('delete')}">${I.delete}</button></td>
  </tr>`).join('');
  return `<div class="cls-lv-wrap">
    <div class="cls-lv-head"><span class="pk">${x(c.description)}</span>
      <button class="btn btn-g cls-lv-add" onclick="addClassifierLevel(${o.id},${c.id})">${I.plus} ${t('levelAddRow')}</button></div>
    ${rows.length ? `<table class="cls-lv-table">${colgroup}<thead><tr><th></th>${head}<th></th></tr></thead><tbody>${body}</tbody></table>`
      : `<div class="cls-lv-empty">${t('levelNoRows')}</div>`}
  </div>`;
}

// Drag-reorder for level rows, mirroring narrator-dialogue.js's
// onNarratorRowDragStart/DragOver/Drop. The drag source is the grip, not the
// row, since rows are almost entirely <input> and a drag begun on one would
// just select text. Scoped to one attribute's own row set — each table only
// ever renders one attribute's rows, so there's no cross-attribute drop
// target to guard against in the UI, and moveLevels' own WHERE clause
// (object_ref AND template_ref) is a defense-in-depth guarantee besides.
function onClassifierLevelRowDragStart(ev, id) {
  S.dragClassifierLevelRow = id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.stopPropagation();
}

function onClassifierLevelRowDragOver(ev, row) {
  if (S.dragClassifierLevelRow == null) return;
  ev.preventDefault();
  ev.stopPropagation();
  const r = row.getBoundingClientRect();
  const before = (ev.clientY - r.top) / r.height < 0.5;
  row.classList.remove('drop-before', 'drop-after');
  row.classList.add(before ? 'drop-before' : 'drop-after');
}

async function onClassifierLevelRowDrop(ev, objectId, templateId, targetId) {
  ev.preventDefault();
  ev.stopPropagation();
  const row = ev.currentTarget;
  const before = row.classList.contains('drop-before');
  row.classList.remove('drop-before', 'drop-after');
  const dragId = S.dragClassifierLevelRow;
  S.dragClassifierLevelRow = null;
  if (dragId == null || dragId === targetId) return;
  // Read the current order straight off the table rather than off
  // S.classifierData: the element-detail page (item.js's openItemNode path)
  // hydrates its own local levelMap instead of populating S.classifierData,
  // so the DOM is the one place this row set is reliably found either way.
  const ids = Array.from(row.closest('tbody').querySelectorAll('tr[data-lid]'))
    .map(tr => Number(tr.dataset.lid)).filter(id => id !== dragId);
  const idx = ids.indexOf(targetId);
  ids.splice(before ? idx : idx + 1, 0, dragId);
  await api.classifier.moveLevels(objectId, templateId, ids);
  await reloadClassifierDetail();
}

async function addClassifierLevel(oid, tid) {
  await api.classifier.createLevel(oid, tid);
  await reloadClassifierDetail();
}

async function saveClassifierLevelField(el) {
  await api.classifier.updateLevelField(Number(el.dataset.lid), el.dataset.field, el.value.trim());
  // Deliberately no re-render: the user may be tabbing straight into the next
  // cell, and rebuilding the table would blow away their focus mid-row. The
  // local cache is patched instead so the next real render is still correct.
  const rows = Object.values(S.classifierData?.objects || {})
    .flatMap(o => Object.values(o.levelMap || {}).flat());
  const row = rows.find(r => r.id === Number(el.dataset.lid));
  if (row) row[el.dataset.field] = el.value.trim();
}

async function deleteClassifierLevelRow(id) {
  await api.classifier.deleteLevel(id);
  await reloadClassifierDetail();
}

// The detail body renders in two places and only one of them has
// S.classifierData loaded — refresh whichever is live, same split as
// Chronicler's saveChroniclerInspectorField.
async function reloadClassifierDetail() {
  if (S.activeItemNode?.itemKind === 'classifier') {
    await openItemNode('classifier', S.activeItemNode.moduleId, S.activeItemNode.id);
    return;
  }
  await loadClassifierData(S.activeModuleNode);
  renderNexusHome();
}

// ── Linked elements from other Major modules ────────────────────────────
// Stored as entity_relation rows keyed cobj_<id> — the same vault-wide,
// module-agnostic link table Connector and the Relation view already write, so
// this needs no schema of its own. The picker and the "which module did this
// come from" label both come from viewer.index, whose rows already carry
// moduleName/moduleKind.
// Both entry points (the module view's loadClassifierData and the element
// page's renderBody) hand their already-fetched relations + viewer index here,
// so the render pass below stays synchronous — renderClassifierObjectDetail is
// called from string-building code that can't await.
let _clsLinks = [];
let _clsLinkIndex = {};
function setClassifierLinkData(relations, index) {
  _clsLinks = relations || [];
  _clsLinkIndex = {};
  for (const e of (index || [])) _clsLinkIndex[e.key] = e;
}

function renderClassifierLinksHtml(o) {
  const links = _clsLinks.filter(l => l.from_key === `cobj_${o.id}` || l.to_key === `cobj_${o.id}`);
  const rows = links.map(l => {
    const otherKey = l.from_key === `cobj_${o.id}` ? l.to_key : l.from_key;
    const e = _clsLinkIndex[otherKey];
    const name = e ? e.name : otherKey;
    // The module name is the point of this section, not decoration: a linked
    // element is meaningless without knowing which Major module it lives in.
    const from = e ? `${e.moduleName || '—'}${e.moduleKind ? ` · ${kindLabel(e.moduleKind)}` : ''}` : '—';
    return `<div class="cls-link-row">
      <span class="cls-link-name" onclick="openEntityByKey('${x(otherKey)}')">${x(name)}</span>
      <span class="cls-link-mod">${x(from)}</span>
      ${l.label ? `<span class="cls-link-lbl">${x(l.label)}</span>` : ''}
      <button class="btn btn-g btn-i" onclick="deleteClassifierLink(${l.id})" title="${t('delete')}">${I.delete}</button>
    </div>`;
  }).join('');
  return `<div class="insp-label cls-link-label">${t('linkedElements')}</div>
    <div class="cls-link-list">${rows || `<div class="cls-lv-empty">${t('noLinkedElements')}</div>`}</div>
    <button class="btn btn-g" style="margin:4px 14px" onclick="openClassifierLinkModal(${o.id})">${I.plus} ${t('addLinkedElement')}</button>`;
}

async function openClassifierLinkModal(objectId) {
  const ix = await api.viewer.index(S.nexus.id);
  // Modules themselves aren't "minor elements", and an element can't link to
  // itself — everything else in the vault is fair game, including elements
  // from other Major modules, which is the whole point of the feature.
  const opts = ix.filter(e => e.key !== `cobj_${objectId}` && !e.key.startsWith('module_'));
  openModal(t('addLinkedElement'), `
    <div class="fg"><label>${t('element')}</label>
      <select id="cl-target">${opts.map(e =>
        `<option value="${x(e.key)}">${x(e.name)} — ${x(e.moduleName || '')}</option>`).join('')}</select></div>
    <div class="fg"><label>${t('relationLabel')}</label><input id="cl-label"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitClassifierLink(${objectId})">${t('create')}</button>
    </div>`);
}

async function submitClassifierLink(objectId) {
  const target = q('#cl-target')?.value;
  if (!target) { closeModal(); return; }
  try {
    await api.viewer.createRelation(S.nexus.id, `cobj_${objectId}`, target, q('#cl-label')?.value.trim() || null, null);
  } catch (e) {
    // UNIQUE(from_key,to_key,label) — re-adding the same pair is a no-op the
    // user shouldn't see as a crash.
    toast(t('linkExists'), 'err');
    return;
  }
  closeModal();
  await reloadClassifierDetail();
  toast(t('created'), 'ok');
}

async function deleteClassifierLink(id) {
  await api.viewer.deleteRelation(id);
  await reloadClassifierDetail();
}

// ── One attribute row ───────────────────────────────────────────────────
// Branch order matters: a levelable or conditioned template renders as the
// table above and ignores attribute_type entirely, since its values live in
// classifier_level rather than in the single attribute_value cell.
function renderClassifierAttrRowHtml(o, c) {
  if (c.levelable || c.has_condition) return renderClassifierLevelTableHtml(o, c);
  const val = x(o.attrMap[c.id] || '');
  let valueHtml;
  if (c.attribute_type === 'textarea') {
    valueHtml = `<textarea class="pv-textarea" data-oid="${o.id}" data-tid="${c.id}" onblur="saveClassifierAttrInput(this)">${val}</textarea>`;
  } else if (c.attribute_type === 'date') {
    valueHtml = clsDateInputsHtml(o, c);
  } else {
    valueHtml = `<span class="pv" contenteditable="true" data-oid="${o.id}" data-tid="${c.id}" onblur="saveClassifierAttrCell(this)">${val}</span>`;
  }
  return `<div class="prop"><span class="pk">${x(c.description)}</span>${valueHtml}</div>`;
}

// `templates` defaults to the ambient module-view cache — the item page
// (src/renderer/mod/item.js) passes its own freshly-fetched templates instead,
// since it can be opened without the module's own view ever having loaded
// S.classifierData.
function renderClassifierObjectDetail(m, o, templates = S.classifierData?.templates || []) {
  let html = `<h3 style="margin-bottom:8px">${x(o.name)}</h3>`;
  for (const c of templates) html += renderClassifierAttrRowHtml(o, c);
  if (m.cat_type === 'character') {
    html += `<div class="insp-label">${t('customAttribute')}</div>`;
    if (o.privateTemplates.length) {
      const pt = o.privateTemplates[0];
      html += `<div class="prop"><span class="pk">${x(pt.description)}</span>
        <span class="pv" contenteditable="true" data-oid="${o.id}" data-tid="${pt.id}" onblur="saveClassifierAttrCell(this)">${x(pt.value || '')}</span></div>`;
    } else {
      html += `<button class="btn btn-g" style="margin:4px 14px" onclick="openClassifierCustomAttrModal(${m.id},${o.id})">${I.plus} ${t('customAttribute')}</button>`;
    }
  }
  html += renderClassifierLinksHtml(o);
  return html;
}
