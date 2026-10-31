'use strict';
// ═══ Classifier — view options: sort · shown fields · wordwrap · overflow ═
// Procress 31 parts 2–3 (Suggestion.md "After Real Use", round 6). One
// button on the view bar of the list views (table · detail · grid) opens a
// popover; what it sets is the MODULE's, saved in module_ui like activeView:
//   clsSort   { by: 'manual'|'name'|'created'|'edited'|'field', dir: 'asc'|'desc', field: templateId }
//   clsTable  { hidden: [templateId…], lines: n|'auto', overflow: 'hidden'|'expand' }
// 'manual' is the self-align order (display_order, dragged by hand); any
// other order is computed here from what getObjects already returns and
// never written back, so switching back to manual finds the order as it was.

const CLS_SORTS = ['manual', 'name', 'created', 'edited', 'field'];
const CLS_SORT_KEY = { manual: 'clsSortManual', name: 'clsSortName', created: 'clsSortCreated', edited: 'clsSortEdited', field: 'clsSortField' };
const CLS_LINES_MAX = 20;

function clsUiJson(d, key) {
  try { const v = JSON.parse(d.ui?.[key] || 'null'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

function clsSortOf(d) {
  const s = clsUiJson(d, 'clsSort');
  const by = CLS_SORTS.includes(s.by) ? s.by : 'manual';
  const field = d.templates.some((tp) => tp.id === s.field) ? s.field : null;
  return { by: by === 'field' && field == null ? 'manual' : by, dir: s.dir === 'desc' ? 'desc' : 'asc', field };
}

function clsTableOf(d) {
  const s = clsUiJson(d, 'clsTable');
  const ids = new Set(d.templates.map((tp) => tp.id));
  const n = Number(s.lines);
  return {
    hidden: Array.isArray(s.hidden) ? s.hidden.filter((id) => ids.has(id)) : [], // a deleted field drops out
    lines: Number.isInteger(n) && n >= 1 ? Math.min(n, CLS_LINES_MAX) : 'auto',
    overflow: s.overflow === 'expand' ? 'expand' : 'hidden',
  };
}

// The db moved the object's update_at (db/classifier.js touchObject); the
// cached copy follows, so "last edited" is right without a reload.
const clsTouched = (o) => { o.update_at = new Date().toISOString().slice(0, 19).replace('T', ' '); };

const clsManualOrder = (d) => clsSortOf(d).by === 'manual';
const clsShownTemplates = (d) => { const h = new Set(clsTableOf(d).hidden); return d.templates.filter((tp) => !h.has(tp.id)); };

// The objects in the order the module is set to show them. A copy — the
// cached d.objects keeps display_order, which drag-reorder works on.
function clsSortedObjects(d) {
  const s = clsSortOf(d);
  if (s.by === 'manual') return d.objects;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sign = s.dir === 'desc' ? -1 : 1;
  const str = (v) => String(v ?? '');
  const key = {
    name: (o) => str(o.name),
    created: (o) => str(o.create_at),
    edited: (o) => str(o.update_at),
    field: (o) => str(o.attrMap?.[s.field]).trim(),
  }[s.by];
  const num = (v) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
  return d.objects.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (s.by === 'field') {
      if (!ka !== !kb) return ka ? -1 : 1; // an empty value goes last, either way
      const na = num(ka), nb = num(kb);
      if (na != null && nb != null && na !== nb) return sign * (na - nb);
    }
    return sign * coll.compare(ka, kb) || a.display_order - b.display_order || a.id - b.id;
  });
}

// ── The table's look: wordwrap + overflow ───────────────────────────────
// Lines clamp in CSS (css/inspector.css .cls-table[data-lines], read with a
// typed attr() — no inline style). Expand
// widens a long cell instead of clipping it: min-width ≈ its text spread over
// the allowed lines. ponytail: an average-character estimate (ch), not a
// measurement — a line of wide glyphs may still clip; measure in a mount
// pass if that shows up.
function clsTableAttrs(d) {
  const tb = clsTableOf(d);
  if (tb.lines === 'auto') return '';
  return ` data-lines="${tb.lines}" data-overflow="${tb.overflow}"`;
}
function clsCellWidthAttr(d, text) {
  const tb = clsTableOf(d);
  if (tb.lines === 'auto' || tb.overflow !== 'expand') return '';
  const w = Math.min(80, Math.ceil(String(text || '').length / tb.lines) + 2);
  return w > 14 ? ` data-w="${w}"` : ''; // css: min-width = attr(data-w) ch
}

// ── The popover ─────────────────────────────────────────────────────────
function clsViewOptsBtnHtml(m, view) {
  if (view === 'relationCat') return '';
  return iconBtnHtml('sliders', t('clsViewOpts'), `openClsViewOpts(this,${m.id},'${view}')`, { cls: 'cls-vopts-btn' });
}

let _clsVo = null; // { pop, moduleId, view }
function openClsViewOpts(anchor, moduleId, view) {
  const pop = openPopover(anchor, clsViewOptsHtml(moduleId, view), {
    cls: 'cls-vopts-popup', aria: t('clsViewOpts'), onClose: () => { _clsVo = null; },
  });
  _clsVo = { pop, moduleId, view, anchor };
}

function clsViewOptsHtml(moduleId, view) {
  const d = clsData(moduleId);
  const s = clsSortOf(d);
  const opt = (v, label, on) => `<option value="${x(v)}"${on ? ' selected' : ''}>${x(label)}</option>`;
  let html = `<div class="ctx-head">${t('clsSortBy')}</div>
    <div class="cls-vo-line"><select class="pv-input" aria-label="${x(t('clsSortBy'))}" onchange="setClsSort(${moduleId},{by:this.value})">
      ${CLS_SORTS.filter((b) => b !== 'field' || d.templates.length).map((b) => opt(b, t(CLS_SORT_KEY[b]), b === s.by)).join('')}</select>`;
  if (s.by !== 'manual') {
    html += segmentedHtml([{ value: 'asc', icon: 'chevronUp', title: t('clsSortAsc') }, { value: 'desc', icon: 'chevronDown', title: t('clsSortDesc') }], s.dir,
      { size: 'sm', aria: t('clsSortBy'), onclick: (v) => `setClsSort(${moduleId},{dir:'${v}'})` });
  }
  html += '</div>';
  if (s.by === 'field') {
    html += `<div class="cls-vo-line"><select class="pv-input" aria-label="${x(t('clsSortField'))}" onchange="setClsSort(${moduleId},{field:Number(this.value)})">
      ${d.templates.map((tp) => opt(tp.id, tp.description, tp.id === s.field)).join('')}</select></div>`;
  }
  if (view !== 'table') return `<div class="cls-vopts">${html}</div>`;

  const tb = clsTableOf(d);
  const hidden = new Set(tb.hidden);
  html += `<div class="ctx-head">${t('clsShownFields')}</div><div class="cls-vo-fields">`
    + d.templates.map((tp) => `<div class="togglerow setting-switch nest-opt-row" role="switch" tabindex="0" aria-checked="${!hidden.has(tp.id)}"
        onclick="toggleClsField(${moduleId},${tp.id})" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();this.click()}">
        <span class="tg${hidden.has(tp.id) ? '' : ' on'}"></span><span data-no-i18n>${x(tp.description)}</span></div>`).join('')
    + '</div>';
  const auto = tb.lines === 'auto';
  html += `<div class="ctx-head">${t('clsWrapLines')}</div>
    <div class="cls-vo-line"><input type="number" class="pv-input cls-vo-lines" min="1" max="${CLS_LINES_MAX}" step="1" value="${auto ? '' : tb.lines}" placeholder="${x(t('clsWrapAuto'))}"
        aria-label="${x(t('clsWrapLines'))}" onchange="setClsTable(${moduleId},{lines:this.value===''?'auto':Math.max(1,Math.round(Number(this.value))||1)})">
      ${segmentedHtml([{ value: 'auto', text: t('clsWrapAuto') }], auto ? 'auto' : null, { size: 'sm', onclick: () => `setClsTable(${moduleId},{lines:'auto'})` })}</div>
    <div class="ctx-head">${t('clsOverflow')}</div>
    <div class="cls-vo-line${auto ? ' is-off' : ''}" title="${auto ? x(t('clsOverflowAutoHint')) : ''}">${segmentedHtml(
      [{ value: 'hidden', text: t('clsOverflowHidden') }, { value: 'expand', text: t('clsOverflowExpand') }], tb.overflow,
      { size: 'sm', aria: t('clsOverflow'), onclick: (v) => `setClsTable(${moduleId},{overflow:'${v}'})` })}</div>`;
  return `<div class="cls-vopts">${html}</div>`;
}

async function clsSaveUi(moduleId, key, value) {
  const json = JSON.stringify(value);
  if (CLS[moduleId]) CLS[moduleId].ui = { ...CLS[moduleId].ui, [key]: json };
  if (_clsVo?.moduleId === moduleId && _clsVo.pop.isConnected) {
    _clsVo.pop.innerHTML = clsViewOptsHtml(moduleId, _clsVo.view);
    repositionPopover(_clsVo.pop, _clsVo.anchor);
  }
  renderNexusHome();
  await api.module.setUi(moduleId, key, json);
}

function setClsSort(moduleId, patch) {
  const d = clsData(moduleId);
  const s = { ...clsSortOf(d), ...patch };
  if (s.by === 'field' && s.field == null) s.field = d.templates[0]?.id ?? null;
  clsSaveUi(moduleId, 'clsSort', s);
}
function setClsTable(moduleId, patch) {
  clsSaveUi(moduleId, 'clsTable', { ...clsTableOf(clsData(moduleId)), ...patch });
}
function toggleClsField(moduleId, tid) {
  const h = new Set(clsTableOf(clsData(moduleId)).hidden);
  if (h.has(tid)) h.delete(tid); else h.add(tid);
  setClsTable(moduleId, { hidden: [...h] });
}
