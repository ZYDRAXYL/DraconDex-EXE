'use strict';
// ═══ Exhibitor (v5 Part 2, APP docs/V5.md §3) ═══════════════════════════
// One kind replacing the Analys "Viewer" and the Relation "Connector": a
// saved filter (module_ui 'filterDef') re-evaluated against api.viewer.index
// on every open, shown through six views —
//   scene  a Konva canvas whose nodes are real exhibit_node rows (mod/exhibitor-scene.js)
//   graph  the old Connector's auto-laid-out graph (mod/exhibitor-graph.js)
//   table · cards · board · edges  (mod/exhibitor-table.js)
// — the union of both old kinds' views plus the Scene, so nothing a user had
// before v5 is gone. After v5 this is the only place a relation is authored
// (§3.5): Classifier and Chronicler read relations and hand off here through
// openExhibitorFor. wiki_link edges are drawn dashed and stay read-only (§3.7).
//
// This file: shared state, the filter engine + its popup, the relation form,
// and the view shell. Split up front per dracondex-file-arch (§5 risk 6).

const EXH_VIEWS = ['scene', 'graph', 'table', 'cards', 'board', 'edges'];
const EXH_VIEW_LABEL = { scene: 'Scene', graph: 'Graph', table: 'Table', cards: 'Cards', board: 'Board', edges: 'Edges' };
// Locale-invariant item badges, like KIND_LABEL (A.3 #7).
const VIEWER_KIND_LABEL = { object: 'Object', event: 'Event', dialogue: 'Dialogue', chapter: 'Chapter', chat: 'Chat', module: 'Module', file: 'Asset' };

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


// ── Load / view switching ───────────────────────────────────────────────
async function loadExhibitorData(m) {
  const nx = S.nexus.id;
  const [index, relations, graph, ui, scene, relTypes] = await Promise.all([
    api.viewer.index(nx), api.viewer.getRelations(nx), api.wiki.getGraph(nx),
    api.module.getUi(m.id), api.exhibitor.scene(m.id), api.viewer.relationTypes(nx),
  ]);
  const def = parseFilterDef(ui);
  const items = applyFilterGroups(index, def, m.id);
  const byKey = new Map(index.map(it => [it.key, it]));
  // wiki_link pairs (derived from [[...]] text, read-only, §3.7).
  const keyOfNode = new Map(graph.nodes.map(n => [n.id, n.key]));
  const wikiPairs = graph.edges.filter(e => e.wiki)
    .map(e => ({ from: keyOfNode.get(e.source), to: keyOfNode.get(e.target) }))
    .filter(p => p.from && p.to);
  let nodes = scene.nodes;
  // §4.3: a former Connector (or a fresh "Open in Exhibitor") lays its
  // current filter results out once, as saved rows, on the same circle the
  // old Connector computed at runtime — it opens looking the way it did.
  const seed = [];
  if (ui.seedScene === '1' && !nodes.length) {
    const R = Math.min(240, 90 + items.length * 18);
    items.forEach((it, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, items.length) - Math.PI / 2;
      seed.push({ linker_key: it.key, node_type: it.kind === 'file' ? 'asset' : 'entity', x: R * Math.cos(a), y: R * Math.sin(a) });
    });
  }
  const focus = S.exhibitorFocusKey;
  if (focus && byKey.has(focus) && !nodes.some(n => n.linker_key === focus) && !seed.some(n => n.linker_key === focus)) {
    const it = byKey.get(focus);
    seed.push({ linker_key: focus, node_type: it.kind === 'file' ? 'asset' : 'entity', x: 0, y: 0 });
  }
  if (seed.length) {
    await api.exhibitor.addNodes(m.id, seed);
    nodes = (await api.exhibitor.scene(m.id)).nodes;
  }
  if (ui.seedScene === '1') await api.module.setUi(m.id, 'seedScene', '0');
  const cls = await loadExhibitorClassifierValues(nodes, byKey);
  const prev = S.exhibitorData?.moduleId === m.id ? S.exhibitorData : null;
  const focusNode = focus ? nodes.find(n => n.linker_key === focus) : null;
  S.exhibitorFocusKey = null;
  S.exhibitorData = {
    moduleId: m.id, def, items, index: byKey, relations, wikiPairs, relTypes, cls,
    view: EXH_VIEWS.includes(ui.activeView) ? ui.activeView : 'scene',
    groupBy: ui.boardGroupBy || 'module',
    nodes, camera: scene.view,
    sel: focusNode ? focusNode.id : (prev?.sel ?? null),
    linkFrom: null,
  };
}

// §7.9 cards and tables read live values: one getObjectsFull per category
// that has an object placed in this scene, on every load — never a copy.
async function loadExhibitorClassifierValues(nodes, byKey) {
  const mods = new Set();
  for (const n of nodes) {
    if (!n.linker_key?.startsWith('cobj_')) continue;
    const mid = byKey.get(n.linker_key)?.moduleId;
    if (mid != null) mods.add(mid);
  }
  const cls = { objects: new Map(), templates: new Map() };
  const full = await Promise.all([...mods].map(mid => api.classifier.getObjectsFull(mid)));
  [...mods].forEach((mid, i) => {
    cls.templates.set(mid, full[i].templates.filter(tp => tp.object_ref == null));
    for (const o of full[i].objects) cls.objects.set(o.id, o);
  });
  return cls;
}

async function setExhibitorView(view) {
  const d = S.exhibitorData;
  d.view = view;
  await api.module.setUi(d.moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === d.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

async function setExhibitorGroupBy(g) {
  const d = S.exhibitorData;
  d.groupBy = g;
  await api.module.setUi(d.moduleId, 'boardGroupBy', g);
  renderNexusHome();
}

// Reload in place after a write (relation, scene edit) without leaving the page.
async function refreshExhibitor() {
  const m = S.activeModuleNode;
  if (!m || m.kind !== 'exhibitor') return;
  await loadExhibitorData(m);
  renderNexusHome();
}

function openViewerItem(key, moduleId) {
  // Keys without a wiki page of their own (tlev_/sdlg_) open their source module.
  if (/^(tlev|sdlg)_/.test(key)) openModuleNode(moduleId);
  else openEntityByKey(key);
}

const exhNameOf = (key) => S.exhibitorData?.index.get(key)?.name || key;

// Relations among a key set; wiki pairs among the same set, minus any pair
// a real relation already covers (in either direction).
function exhibitorEdgesAmong(keys) {
  const d = S.exhibitorData;
  const rels = d.relations.filter(r => keys.has(r.from_key) && keys.has(r.to_key))
    .map(r => ({ id: r.id, from: r.from_key, to: r.to_key, label: r.label || '', relType: r.rel_type || '',
      directed: r.directed !== 0, color: r.color_code || null, wiki: false }));
  const seen = new Set(rels.flatMap(e => [`${e.from}→${e.to}`, `${e.to}→${e.from}`]));
  const wiki = d.wikiPairs.filter(p => keys.has(p.from) && keys.has(p.to) && !seen.has(`${p.from}→${p.to}`))
    .map(p => ({ id: null, from: p.from, to: p.to, label: '', relType: '', directed: false, wiki: true }));
  return [...rels, ...wiki];
}

function buildExhibitorMainHtml(m) {
  const d = (S.exhibitorData && S.exhibitorData.moduleId === m.id) ? S.exhibitorData : null;
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const viewBar = viewBarHtml(EXH_VIEWS, d.view, v => `setExhibitorView('${v}')`, v => EXH_VIEW_LABEL[v], { noI18n: true });
  const toolbar = `<div class="classifier-toolbar">
    <button class="btn btn-p" onclick="openExhibitorRelationModal()">${I.plus} ${t('addRelation')}</button>
    <span class="vw-filterlabel">${t('exhibitorFilter')}</span>${filterChipsHtml(d.def)}
    <button class="btn btn-g btn-i" onclick="openSavedFilterPopup(this)" title="${t('editFilter')}">${I.edit}</button>
    ${viewBar}
  </div>`;
  if (d.view === 'scene') return toolbar + buildExhibitorSceneHtml(d);
  if (!d.items.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div>
      <h3>${x(m.name)}</h3><p>${t('noFilterResults')}</p></div>`;
  }
  if (d.view === 'graph') return toolbar + buildExhibitorGraphHtml(d);
  if (d.view === 'edges') return toolbar + buildExhibitorEdgesHtml(d);
  if (d.view === 'cards') return toolbar + buildViewerCardsHtml(d);
  if (d.view === 'board') return toolbar + buildViewerBoardHtml(d);
  return toolbar + `<div class="drafter-hint">${t('viewerHint')}</div>` + buildViewerTableHtml(d);
}

// Called from core/views.js runBuilderMounts after every render.
function mountExhibitor() {
  const d = S.exhibitorData;
  if (!d || S.activeModuleNode?.id !== d.moduleId) return;
  if (d.view === 'scene') mountExhibitorScene();
  else if (d.view === 'graph') mountExhibitorGraph();
}

// §4.2: the v5 entity_relation rebuild removes duplicate rows an old vault
// had piled up (the old UNIQUE never deduped NULL labels). The count is
// held in main until asked, so the user is told once, the first time.
async function reportRelationDedupe() {
  try {
    const n = await api.exhibitor.dedupeReport();
    if (n) toast(`${t('relationDedupeRemoved')} ${n}`, 'ok');
  } catch (_) { /* informational only */ }
}

// ── "Open in Exhibitor" (§3.5, §3.6) ────────────────────────────────────
// The hand-off every read-only relation surface uses. Opens the Exhibitor
// that belongs to moduleId, creating it on first use (next to the module,
// filtered to it, seeded as a Scene), and selects focusKey in the Scene.
async function openExhibitorFor(moduleId, focusKey) {
  closeAllPopups();
  if (moduleId == null || !S.nexus) return;
  let exId = await api.exhibitor.findFor(moduleId);
  if (!exId) {
    const src = findModuleNode(moduleId);
    exId = await api.module.create({
      nexus_ref: S.nexus.id, parent_id: src?.parent_id ?? null,
      name: `${src?.name || ''} · Exhibitor`, kind: 'exhibitor',
    });
    await api.module.setUi(exId, 'exhibitorFor', String(moduleId));
    await api.module.setUi(exId, 'filterDef', JSON.stringify({ groups: [{ rules: [{ field: 'childOf', moduleId }] }] }));
    await api.module.setUi(exId, 'activeView', 'scene');
    await api.module.setUi(exId, 'seedScene', '1');
    await reloadModuleTree();
  } else {
    await api.module.setUi(exId, 'activeView', 'scene');
  }
  S.exhibitorFocusKey = focusKey || null;
  await openModuleNode(exId);
}

// ── Relation form (create / edit) ───────────────────────────────────────
// rel_type and directed are the v5 columns (§3.5). Endpoints are the
// filtered items plus everything placed in the Scene, so a relation can be
// drawn to a node a user dragged in from outside the filter.
function exhibitorRelationTargets() {
  const d = S.exhibitorData;
  const keys = new Set([...d.items.map(it => it.key), ...d.nodes.map(n => n.linker_key).filter(Boolean)]);
  return [...keys].map(k => ({ key: k, name: exhNameOf(k) })).sort((a, b) => a.name.localeCompare(b.name));
}

function openExhibitorRelationModal(relId = null, fromKey = null, toKey = null) {
  const d = S.exhibitorData;
  if (!d) return;
  const rel = relId ? d.relations.find(r => r.id === relId) : null;
  const from = rel?.from_key ?? fromKey, to = rel?.to_key ?? toKey;
  const opts = (sel) => exhibitorRelationTargets()
    .map(o => `<option value="${x(o.key)}" ${o.key === sel ? 'selected' : ''}>${x(o.name)}</option>`).join('');
  openModal(rel ? t('moduleEdit') : t('addRelation'), `
    <div class="fg cls-rel-endpoints">
      <div><label>${t('relFrom')}</label><select id="xr-from" ${rel ? 'disabled' : ''}>${opts(from)}</select></div>
      <div><label>${t('relTo')}</label><select id="xr-to" ${rel ? 'disabled' : ''}>${opts(to)}</select></div>
    </div>
    <div class="fg"><label>${t('relationLabel')}</label><input id="xr-label" value="${x(rel?.label || '')}" autocomplete="off"></div>
    <div class="fg"><label>${t('relationType')}</label><input id="xr-type" list="xr-types" value="${x(rel?.rel_type || '')}" autocomplete="off">
      <datalist id="xr-types">${d.relTypes.map(v => `<option value="${x(v)}">`).join('')}</datalist></div>
    <label class="fv-useimg"><input type="checkbox" id="xr-dir" ${!rel || rel.directed !== 0 ? 'checked' : ''}> ${t('relationDirected')}</label>
    <div class="mfoot">
      ${rel ? `<button class="btn btn-d" onclick="deleteExhibitorRelation(${rel.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitExhibitorRelation(${relId ?? 'null'})">${rel ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#xr-label')?.focus(), 0);
}

async function submitExhibitorRelation(relId) {
  const d = S.exhibitorData;
  const label = q('#xr-label').value.trim();
  const opts = { relType: q('#xr-type').value.trim() || null, directed: q('#xr-dir').checked };
  if (relId) {
    await api.viewer.updateRelation(relId, label, undefined, opts);
  } else {
    const from = q('#xr-from').value, to = q('#xr-to').value;
    // §7.5 bug #8 applies here too: same-endpoint used to be a silent no-op.
    if (!from || !to || from === to) { toast(t('relationSameEnds'), 'err'); return; }
    await api.viewer.createRelation(S.nexus.id, from, to, label, null, { ...opts, moduleRef: d.moduleId });
  }
  closeModal();
  await refreshExhibitor();
  toast(relId ? t('saved') : t('created'), 'ok');
}

async function deleteExhibitorRelation(id) {
  if (!await uiConfirm(t('relationDeleteConfirm'))) return;
  await api.viewer.deleteRelation(id);
  closeModal();
  await refreshExhibitor();
  toast(t('deleted'), 'ok');
}

// ── Saved-filter editor popup ────────────────────────────────────────────
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

async function openSavedFilterPopup(anchor) {
  closeAllPopups();
  const d = S.exhibitorData;
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
