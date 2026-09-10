'use strict';
// ═══ Analys "Viewer" (progress.md Phase 14) ════════════════════════════
// A read-only lens over a saved filter (mockups 14 / 32 / 33): the filter
// definition persists in module_ui key 'filterDef' and re-evaluates
// against api.viewer.index(nexus) on every open, so source-data edits
// show up automatically. Three views: Table · Cards · Board (grouped by
// source module, switchable to kind/tag). The filter editor modal here is
// shared with Relation "Connector" (mod/connector.js).

const VIEWER_VIEWS = ['table', 'cards', 'board'];
const VIEWER_VIEW_LABEL = { table: 'Table', cards: 'Cards', board: 'Board' };
// Locale-invariant kind badges, like KIND_LABEL (A.3 #7).
const VIEWER_ITEM_KINDS = ['object', 'event', 'dialogue', 'chapter', 'chat', 'module'];
const VIEWER_KIND_LABEL = { object: 'Object', event: 'Event', dialogue: 'Dialogue', chapter: 'Chapter', chat: 'Chat', module: 'Module' };

// Plan part6 #1: Obsidian-style filter — groups of rules, AND within a
// group, OR (union) between groups. Rule fields: kind (module type,
// multi-select of MODULE_KINDS — no operator, a closed enum), childOf
// (this module or its immediate children — no operator, structural
// membership), hashtag/name (5 string operators: is/is not/starts with/
// ends with/contains).
const FILTER_FIELDS = ['kind', 'childOf', 'hashtag', 'name'];
const FILTER_OPS = ['is', 'isNot', 'startsWith', 'endsWith', 'contains'];

function parseFilterDef(ui) {
  let raw = {};
  try { raw = JSON.parse(ui.filterDef || '{}'); } catch (_) {}
  if (Array.isArray(raw.groups)) return { groups: raw.groups };
  // Migrate the old flat {query,kinds,moduleIds,tag} shape. moduleIds had
  // OR semantics ("item's module is any of these") — since one group can
  // only AND its rules, each old moduleId becomes its own group (with
  // query/tag folded in as shared AND conditions) to preserve that OR.
  // Old item-kind `kinds` has no destination field in the new module-kind
  // model and is intentionally dropped.
  const baseRules = [];
  if (raw.query) baseRules.push({ field: 'name', op: 'contains', value: raw.query });
  if (raw.tag) baseRules.push({ field: 'hashtag', op: 'is', value: raw.tag });
  const groups = [];
  if (Array.isArray(raw.moduleIds) && raw.moduleIds.length) {
    for (const mid of raw.moduleIds) groups.push({ rules: [...baseRules, { field: 'childOf', moduleId: mid }] });
  } else if (baseRules.length) {
    groups.push({ rules: baseRules });
  }
  return { groups };
}

// this module or its immediate child modules (one level down only, no
// recursion needed) — a local equivalent of quickswitch.js's qsDescendants,
// inlined because quickswitch.js is lazy-loaded and viewer.js/connector.js
// run much earlier in the app lifecycle.
function filterModuleScope(rootId) {
  const out = new Set([rootId]);
  const m = findModuleNode(rootId);
  for (const c of (m?.children || [])) out.add(c.id);
  return out;
}

function strOpMatch(hay, op, needle) {
  const a = (hay || '').toLowerCase();
  const b = (needle || '').trim().replace(/^#/, '').toLowerCase();
  if (!b) return true; // an unfilled rule value never blocks a match
  if (op === 'isNot') return a !== b;
  if (op === 'startsWith') return a.startsWith(b);
  if (op === 'endsWith') return a.endsWith(b);
  if (op === 'contains') return a.includes(b);
  return a === b; // 'is' (default)
}

function ruleMatches(it, r) {
  if (r.field === 'kind') return !r.values?.length || r.values.includes(it.moduleKind);
  if (r.field === 'childOf') return r.moduleId != null && filterModuleScope(r.moduleId).has(it.moduleId);
  if (r.field === 'hashtag') return (it.tags || []).some(tg => strOpMatch(tg, r.op, r.value));
  if (r.field === 'name') return strOpMatch(it.name, r.op, r.value);
  return true;
}

function applyFilterGroups(items, def, selfModuleId) {
  return items.filter(it => {
    if (it.key === `module_${selfModuleId}`) return false; // not itself
    if (!def.groups.length) return true;
    return def.groups.some(g => g.rules.length && g.rules.every(r => ruleMatches(it, r)));
  });
}

function filterRuleLabel(r) {
  if (r.field === 'kind') return (r.values || []).map(k => kindLabel(k)).join(' + ') || t('filterField_kind');
  if (r.field === 'childOf') { const m = findModuleNode(r.moduleId); return `⊂ ${x(m ? m.name : '?')}`; }
  if (r.field === 'hashtag') return `#${x(r.value || '')}`;
  if (r.field === 'name') return `"${x(r.value || '')}"`;
  return '?';
}

function filterChipsHtml(def) {
  if (!def.groups.length) return `<span class="vw-chip">${t('filterAll')}</span>`;
  return def.groups.map(g => `<span class="vw-chip">${g.rules.map(filterRuleLabel).join(' &amp; ') || '—'}</span>`)
    .join(`<span class="vw-chip-or" data-no-i18n>${t('filterOr')}</span>`);
}

const viewerTimeText = (it) => it.time && it.time.years != null
  ? fmtDate(it.time.day, it.time.month, it.time.years, it.time.hour, it.time.minute) : '';

async function loadViewerData(m) {
  const [items, ui] = await Promise.all([
    api.viewer.index(S.nexus.id),
    api.module.getUi(m.id),
  ]);
  const def = parseFilterDef(ui);
  const view = VIEWER_VIEWS.includes(ui.activeView) ? ui.activeView : 'table';
  S.viewerData = {
    moduleId: m.id, def, view,
    groupBy: ui.boardGroupBy || 'module',
    items: applyFilterGroups(items, def, m.id),
  };
}

async function setViewerView(view) {
  const d = S.viewerData;
  d.view = view;
  await api.module.setUi(d.moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === d.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

async function setViewerGroupBy(g) {
  const d = S.viewerData;
  d.groupBy = g;
  await api.module.setUi(d.moduleId, 'boardGroupBy', g);
  renderNexusHome();
}

function openViewerItem(key, moduleId) {
  // Keys without a wiki kind (tlev_/sdlg_) open their source module.
  if (/^(tlev|sdlg)_/.test(key)) openModuleNode(moduleId);
  else openEntityByKey(key);
}

function buildViewerMainHtml(m) {
  const d = (S.viewerData && S.viewerData.moduleId === m.id) ? S.viewerData : null;
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const viewBar = `<div class="viewbar">
    ${VIEWER_VIEWS.map(v => `<span class="vitem${v === d.view ? ' act' : ''}" onclick="setViewerView('${v}')" data-no-i18n>${VIEWER_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <span class="vw-filterlabel">Filter:</span>${filterChipsHtml(d.def)}
    <button class="btn btn-g btn-i" onclick="openSavedFilterPopup('viewer', this)" title="${t('editFilter')}">${I.edit}</button>
    ${viewBar}
  </div>
  <div class="drafter-hint">${t('viewerHint')}</div>`;
  if (!d.items.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div>
      <h3>${x(m.name)}</h3><p>${t('noFilterResults')}</p></div>`;
  }
  let body;
  if (d.view === 'cards') body = buildViewerCardsHtml(d);
  else if (d.view === 'board') body = buildViewerBoardHtml(d);
  else body = buildViewerTableHtml(d);
  return toolbar + body;
}

// ── Table view (mockup 14) ──────────────────────────────────────────────
function buildViewerTableHtml(d) {
  const rows = d.items.map(it => `
    <tr onclick="openViewerItem(${xj(it.key)},${it.moduleId})">
      <td><span class="dot" style="background:${x(it.color || 'var(--accent)')}"></span> ${x(it.name)}</td>
      <td>${x(it.moduleName)}</td>
      <td data-no-i18n>${VIEWER_KIND_LABEL[it.kind] || it.kind}</td>
      <td data-no-i18n>${x(viewerTimeText(it))}</td>
      <td>${(it.tags || []).map(tg => `<span class="htag">#${x(tg)}</span>`).join(' ')}</td>
    </tr>`).join('');
  return `<table class="vw-table">
    <thead><tr><th>${t('name')}</th><th data-no-i18n>Module</th><th>${t('moduleKind')}</th><th>${t('timeLabel')}</th><th data-no-i18n>Tags</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ── Cards view (mockup 32) ──────────────────────────────────────────────
function buildViewerCardsHtml(d) {
  return `<div class="vw-cards">${d.items.map(it => `
    <div class="vw-card" style="border-top:3px solid ${x(it.color || 'var(--accent)')}" onclick="openViewerItem(${xj(it.key)},${it.moduleId})">
      <div class="vw-card-head"><span class="vw-card-name">${x(it.name)}</span>
        <span class="vw-card-kind" data-no-i18n>${VIEWER_KIND_LABEL[it.kind] || it.kind}</span></div>
      <div class="vw-card-src" data-no-i18n>Module: ${x(it.moduleName)}</div>
      ${viewerTimeText(it) ? `<div class="vw-card-time" data-no-i18n>${x(viewerTimeText(it))}</div>` : ''}
      ${(it.tags || []).length ? `<div class="vw-card-tags">${it.tags.map(tg => `<span class="htag">#${x(tg)}</span>`).join(' ')}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ── Board view (mockup 33): grouped columns ─────────────────────────────
function buildViewerBoardHtml(d) {
  const groups = new Map();
  for (const it of d.items) {
    let gk, gl;
    if (d.groupBy === 'kind') { gk = it.kind; gl = VIEWER_KIND_LABEL[it.kind] || it.kind; }
    else if (d.groupBy === 'tag') { gk = (it.tags || [])[0] || '—'; gl = gk === '—' ? '—' : `#${gk}`; }
    else { gk = `m${it.moduleId}`; gl = `${it.moduleName} (${kindLabel(it.moduleKind)})`; }
    if (!groups.has(gk)) groups.set(gk, { label: gl, items: [] });
    groups.get(gk).items.push(it);
  }
  const cols = [...groups.values()].map(g => `
    <div class="vw-col">
      <div class="vw-col-head" data-no-i18n><span>${x(g.label)}</span><span class="cnt">${g.items.length}</span></div>
      ${g.items.map(it => `
        <div class="vw-col-card" style="border-left:3px solid ${x(it.color || 'var(--accent)')}" onclick="openViewerItem(${xj(it.key)},${it.moduleId})">
          <div class="vw-card-name">${x(it.name)}</div>
          <div class="vw-card-src" data-no-i18n>${VIEWER_KIND_LABEL[it.kind] || it.kind}${viewerTimeText(it) ? ` · ${x(viewerTimeText(it))}` : ''}</div>
        </div>`).join('')}
    </div>`).join('');
  return `<div class="vw-board">${cols}</div>
    <div class="drafter-hint">${t('groupBy')}:
      <select class="vw-groupby" onchange="setViewerGroupBy(this.value)" data-no-i18n>
        ${['module', 'kind', 'tag'].map(g => `<option value="${g}" ${d.groupBy === g ? 'selected' : ''}>${g}</option>`).join('')}
      </select></div>`;
}

// ── Saved-filter editor popup (shared with Connector) ───────────────────
// Obsidian-style: groups of rules OR'd together, each group's rules AND'd.
// Live-saves on every structural change (matches every other .kind-popup in
// this codebase) — no Save/Cancel footer. Free-text rule values (hashtag/
// name) debounce-save ~500ms after typing stops instead of on every
// keystroke.
let filterPopupDebounce = null;

function flattenModulesForFilter() {
  const mods = [];
  for (const mm of S.moduleTree) {
    mods.push(mm);
    for (const c of (mm.children || [])) mods.push(c);
  }
  return mods;
}

function filterRuleValueHtml(r, gi, ri, mods) {
  if (r.field === 'kind') {
    return `<select class="fp-input" multiple size="4" data-act="val-kind" data-gi="${gi}" data-ri="${ri}" data-no-i18n>
      ${MODULE_KINDS.map(k => `<option value="${k}" ${(r.values || []).includes(k) ? 'selected' : ''}>${kindLabel(k)}</option>`).join('')}
    </select>`;
  }
  if (r.field === 'childOf') {
    return `<select class="fp-input" data-act="val-childof" data-gi="${gi}" data-ri="${ri}">
      <option value="">—</option>
      ${mods.map(mm => `<option value="${mm.id}" ${r.moduleId === mm.id ? 'selected' : ''}>${x(mm.name)} (${kindLabel(mm.kind)})</option>`).join('')}
    </select>`;
  }
  return `<select class="fp-op" data-act="val-op" data-gi="${gi}" data-ri="${ri}" data-no-i18n>
      ${FILTER_OPS.map(op => `<option value="${op}" ${r.op === op ? 'selected' : ''}>${t('filterOp_' + op)}</option>`).join('')}
    </select>
    <input class="fp-input" data-act="val-text" data-gi="${gi}" data-ri="${ri}" value="${x(r.value || '')}"
      ${r.field === 'hashtag' ? 'list="fp-hashtag-list" placeholder="#tag"' : `placeholder="${t('name')}"`}>`;
}

function filterRuleRowHtml(r, gi, ri, mods) {
  return `<div class="fp-rule-row">
    <select class="fp-field" data-act="field" data-gi="${gi}" data-ri="${ri}">
      ${FILTER_FIELDS.map(f => `<option value="${f}" ${r.field === f ? 'selected' : ''}>${t('filterField_' + f)}</option>`).join('')}
    </select>
    ${filterRuleValueHtml(r, gi, ri, mods)}
    <button class="btn btn-g btn-i" data-act="del-rule" data-gi="${gi}" data-ri="${ri}" title="${t('delete')}">${I.delete}</button>
  </div>`;
}

function renderFilterPopupBody() {
  const def = S.filterDraft.def;
  const mods = flattenModulesForFilter();
  const groupsHtml = def.groups.map((g, gi) => `
    ${gi > 0 ? `<div class="fp-or-divider">${t('filterOr')}</div>` : ''}
    <div class="fp-group">
      <div class="fp-rules">${g.rules.map((r, ri) => filterRuleRowHtml(r, gi, ri, mods)).join('') || `<div class="ghost fp-empty">${t('filterAll')}</div>`}</div>
      <div class="fp-group-actions">
        <button class="btn btn-g btn-sm" data-act="add-rule" data-gi="${gi}">${I.plus} ${t('filterAddRule')}</button>
        ${def.groups.length > 1 ? `<button class="btn btn-g btn-i" data-act="del-group" data-gi="${gi}" title="${t('delete')}">${I.delete}</button>` : ''}
      </div>
    </div>`).join('');
  return `<div class="fp-groups">${groupsHtml}</div>
    <button class="btn btn-g fp-add-group" data-act="add-group">${I.plus} ${t('filterAddGroup')}</button>
    <datalist id="fp-hashtag-list">${(S.filterPopupTags || []).map(tg => `<option value="${x(tg)}">`).join('')}</datalist>`;
}

async function openSavedFilterPopup(which, anchor) {
  closeAllPopups();
  const d = which === 'connector' ? S.connectorData : S.viewerData;
  if (!d || !anchor) return;
  S.filterDraft = { moduleId: d.moduleId, def: JSON.parse(JSON.stringify(d.def)) };
  if (!S.filterDraft.def.groups.length) S.filterDraft.def.groups.push({ rules: [] });
  // Snapshot the rect, not the element — `anchor` sits inside #main-inner,
  // which persistFilterDraft's openModuleNode() rebuilds from scratch on
  // every save, so the live element goes stale after the first persist.
  const r = anchor.getBoundingClientRect();
  S.filterPopupAnchorRect = { top: r.top, bottom: r.bottom, left: r.left };
  S.filterPopupTags = (await api.hashtag.getAll()).map(h => h.tag_name);
  const pop = document.createElement('div');
  pop.className = 'kind-popup filter-popup';
  pop.innerHTML = renderFilterPopupBody();
  document.body.appendChild(pop);
  wireFilterPopup(pop);
  positionPopupNear(pop, S.filterPopupAnchorRect);
}

function wireFilterPopup(pop) {
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.tagName !== 'BUTTON') return;
    const def = S.filterDraft.def;
    const gi = Number(btn.dataset.gi), ri = Number(btn.dataset.ri);
    if (btn.dataset.act === 'add-group') def.groups.push({ rules: [] });
    else if (btn.dataset.act === 'del-group') { def.groups.splice(gi, 1); if (!def.groups.length) def.groups.push({ rules: [] }); }
    else if (btn.dataset.act === 'add-rule') def.groups[gi].rules.push({ field: 'kind', values: [] });
    else if (btn.dataset.act === 'del-rule') def.groups[gi].rules.splice(ri, 1);
    else return;
    persistFilterDraft(pop);
  });
  pop.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName !== 'SELECT') return;
    const gi = Number(el.dataset.gi), ri = Number(el.dataset.ri);
    const rule = S.filterDraft.def.groups[gi]?.rules[ri];
    if (!rule) return;
    if (el.dataset.act === 'field') {
      const field = el.value;
      S.filterDraft.def.groups[gi].rules[ri] = field === 'kind' ? { field, values: [] }
        : field === 'childOf' ? { field, moduleId: null }
        : { field, op: 'contains', value: '' };
    } else if (el.dataset.act === 'val-kind') rule.values = [...el.selectedOptions].map(o => o.value);
    else if (el.dataset.act === 'val-childof') rule.moduleId = el.value ? Number(el.value) : null;
    else if (el.dataset.act === 'val-op') rule.op = el.value;
    else return;
    persistFilterDraft(pop);
  });
  pop.addEventListener('input', (e) => {
    const el = e.target.closest('[data-act="val-text"]');
    if (!el) return;
    const gi = Number(el.dataset.gi), ri = Number(el.dataset.ri);
    const rule = S.filterDraft.def.groups[gi]?.rules[ri];
    if (!rule) return;
    rule.value = el.value;
    clearTimeout(filterPopupDebounce);
    filterPopupDebounce = setTimeout(() => persistFilterDraft(pop, false), 500);
  });
}

async function persistFilterDraft(pop, rerenderPopup = true) {
  const draft = S.filterDraft;
  await api.module.setUi(draft.moduleId, 'filterDef', JSON.stringify(draft.def));
  await openModuleNode(draft.moduleId);
  if (!document.body.contains(pop)) return; // closed mid-save
  if (rerenderPopup) {
    pop.innerHTML = renderFilterPopupBody();
    positionPopupNear(pop, S.filterPopupAnchorRect);
  }
}
