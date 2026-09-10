'use strict';
// ═══ Timeline "Chronicler" (progress.md Phase 8) ══════════════════════
// A module owns any number of timeline "lines" (generalized `timeline`
// table, module_ref instead of project_id — same shape as Director's
// project-scoped timelines). Down-line reuses timeline.js's existing
// true-time-scale SVG graph + pan/zoom/drag interactions as-is
// (buildTimelineGraphHtml / bindTimelineGraphInteractions are already
// project-agnostic, keyed only by timeline id). One-line and Compare
// Parallel are new, lighter views built the same way but plotted on flat
// axis lines instead of the zigzag layout.

const CHRONICLER_VIEWS = ['oneline', 'downline', 'compare', 'calendar'];
const CHRONICLER_VIEW_LABEL = { oneline: 'Oneline', downline: 'Downline', compare: 'Compare', calendar: 'Calendar' };

// CHRONICLER_CALENDAR_DEFAULTS / chroniclerCalendarConfig are gone: the
// calendar is a unit spec now, normalized by calSpecNormalize (which still
// upgrades the old five-field blob) and held as S.chroniclerData.calendarSpec.

function sortChroniclerEvents(evs, spec) {
  spec = spec || timelineCalendarSpec();
  const key = (e) => calToOrdinal(spec, { y: e.s_years, m: e.s_month, d: e.s_day, h: e.s_hour, mi: e.s_minute });
  return evs.slice().sort((a, b) => {
    const ka = key(a), kb = key(b);
    // A dateless event keeps its arrival order rather than jumping to the top.
    if (ka === null && kb === null) return 0;
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka - kb;
  });
}

async function loadChroniclerData(m) {
  await loadModule('src/renderer/timeline.js');
  const [timelines, ui, relations, index] = await Promise.all([
    api.timeline.getModuleTimelines(m.id),
    api.module.getUi(m.id),
    api.viewer.getRelations(S.nexus.id),
    api.viewer.index(S.nexus.id),
  ]);
  setChroniclerLinkData(relations, index);
  const prev = (S.chroniclerData && S.chroniclerData.moduleId === m.id) ? S.chroniclerData : null;
  let activeId = prev?.activeId;
  if (!activeId || !timelines.find(t => t.id === activeId)) activeId = timelines[0]?.id || null;
  // compareId is another chronicler MODULE's id (not a line id — each
  // chronicler module now holds only 1 line, see C2).
  let compareId = prev?.compareId;
  if (compareId && !modulesOfKind('chronicler').find(cm => cm.id === compareId && cm.id !== m.id)) compareId = null;
  const view = CHRONICLER_VIEWS.includes(ui.view) ? ui.view : 'oneline';
  let calendarConfig = null;
  try { calendarConfig = ui.calendarConfig ? JSON.parse(ui.calendarConfig) : null; } catch (_) { calendarConfig = null; }
  // calSpecNormalize also upgrades the v1 blob, so an existing vault's
  // calendar keeps its shape without ever being rewritten on disk.
  const calendarSpec = calSpecNormalize(calendarConfig);
  const pendingEvent = S.pendingChroniclerEvent;
  S.pendingChroniclerEvent = null;
  S.chroniclerData = {
    moduleId: m.id, timelines, activeId, compareId, view,
    inspectorEventId: pendingEvent ?? prev?.inspectorEventId ?? null,
    calendarConfig, calendarSpec,
    // Which unit the calendar grid is zoomed to, and where it is pointed.
    // Both survive a re-render but are deliberately not persisted — they are
    // a scroll position, not a setting.
    calZoom: prev?.calZoom ?? 'month',
    calCursor: prev?.calCursor ?? null,
    // Custom-calendar panel: open state and which unit page it is showing.
    calPanelOpen: false,
    calPanelUnit: prev?.calPanelUnit ?? 'day',
    // Process 8 part 1: graph display toggles. Stored as '0'/'1' strings in
    // module_ui, absent meaning on, so a timeline made before this round shows
    // both rather than silently losing its labels.
    graphShowIcon: ui.graphShowIcon !== '0',
    graphShowDate: ui.graphShowDate !== '0',
    downlineView: prev?.downlineView ?? { scale: 1, ty: 0 },
  };
}

async function setChroniclerView(view) {
  S.chroniclerData.view = view;
  S.chroniclerData.inspectorEventId = null;
  await api.module.setUi(S.chroniclerData.moduleId, 'view', view);
  if (S.inspectorData?.moduleId === S.chroniclerData.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, view };
  renderNexusHome();
}

async function selectChroniclerTimeline(moduleId, id) {
  S.chroniclerData.activeId = Number(id) || null;
  S.chroniclerData.inspectorEventId = null;
  renderNexusHome();
}

async function setChroniclerCompare(id) {
  S.chroniclerData.compareId = Number(id) || null;
  S.chroniclerData.inspectorEventId = null;
  await mountChroniclerGraph();
}

function buildChroniclerMainHtml(m) {
  const data = (S.chroniclerData && S.chroniclerData.moduleId === m.id) ? S.chroniclerData : null;
  if (!data) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const { timelines, activeId, compareId, view } = data;
  const viewBar = `<div class="viewbar">
    ${CHRONICLER_VIEWS.map(v => `<span class="vitem${v === view ? ' act' : ''}" onclick="setChroniclerView('${v}')">${CHRONICLER_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  // Only ever 1 line per chronicler module — no line-picker needed once one
  // exists, and the "add line" button hides itself the same way.
  const lineSelect = timelines.length > 1 ? `<select id="chr-line-select" onchange="selectChroniclerTimeline(${m.id},this.value)">
    ${timelines.map(t => `<option value="${t.id}" ${t.id === activeId ? 'selected' : ''}>${x(t.line_name || '—')}</option>`).join('')}
  </select>` : '';
  const toolbar = `<div class="classifier-toolbar">
    ${lineSelect}
    ${!timelines.length ? `<button class="btn btn-g btn-i" onclick="openChroniclerTimelineModal(${m.id})" title="${t('addTimelineLine')}">${I.plus}</button>` : ''}
    ${activeId ? `<button class="btn btn-g btn-i" onclick="openChroniclerTimelineModal(${m.id},${activeId})" title="${t('edit')}">${I.edit}</button>` : ''}
    ${activeId ? `<button class="btn btn-p" onclick="openChroniclerEventModal(${activeId})">${I.plus} ${t('addEvent')}</button>` : ''}
    ${viewBar}
    ${view === 'oneline' || view === 'downline'
      ? `<button class="btn btn-g btn-i" onclick="event.stopPropagation();openChroniclerGraphOptions(this)" title="${t('chrGraphOptions')}">${I.options}</button>` : ''}
    ${view === 'downline' ? `<button class="btn btn-g btn-i" onclick="resetChroniclerDownlineView()" title="${t('chrResetView')}">${I.return}</button>` : ''}
  </div>`;

  if (!timelines.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${I.timeline}</div><h3>${t('noTimelineYet')}</h3>
      <button class="btn btn-p" onclick="openChroniclerTimelineModal(${m.id})">${I.plus} ${t('createTimelineLine')}</button></div>`;
  }

  let compareBar = '';
  if (view === 'compare') {
    // Compare picks another CHRONICLER MODULE (each now holds only 1 line),
    // not another line within this same module.
    const opts = modulesOfKind('chronicler').filter(cm => cm.id !== m.id);
    compareBar = `<div class="classifier-toolbar" style="margin-top:8px">
      <span class="vlbl">${t('compareWith')}:</span>
      <select id="chr-compare-select" onchange="setChroniclerCompare(this.value)">
        <option value="">--</option>
        ${opts.map(cm => `<option value="${cm.id}" ${cm.id === compareId ? 'selected' : ''}>${x(cm.name || '—')}</option>`).join('')}
      </select>
    </div>`;
  }

  return `${toolbar}${compareBar}
    <div id="chronicler-graph-host"></div>`;
}

// Post-DOM hook (parallels mountLocatorBoard/mountDetailEditor): fetches
// events for whichever timeline(s) the current view needs and renders the
// SVG graph, then binds the shared pan/zoom/drag interactions.
async function mountChroniclerGraph() {
  const data = S.chroniclerData;
  const host = q('#chronicler-graph-host');
  if (!data || !host || !data.activeId) return;
  const activeTl = data.timelines.find(t => t.id === data.activeId);
  const col = activeTl?.color_code || '#06b6d4';
  const evs = sortChroniclerEvents(await api.timeline.getEvents(data.activeId));

  if (data.view === 'compare') {
    if (!data.compareId) {
      host.innerHTML = `<div class="empty" style="margin-top:20px"><div class="ei">${I.timeline}</div><h3>${t('pickCompareTimeline')}</h3></div>`;
      return;
    }
    // compareId is another chronicler module's id — fetch its single line.
    const compareLines = await api.timeline.getModuleTimelines(data.compareId);
    const compareTl = compareLines[0] || null;
    const evsB = compareTl ? sortChroniclerEvents(await api.timeline.getEvents(compareTl.id)) : [];
    const key = `cmp-${data.activeId}-${data.compareId}`;
    host.innerHTML = buildChroniclerCompareHtml(evs, evsB, key, col, compareTl?.color_code || '#f97316');
    bindTimelineGraphInteractions(key);
    return;
  }

  if (data.view === 'calendar') {
    // The cursor starts on the first event so an existing timeline opens
    // showing something, rather than on an empty year 0.
    if (data.calCursor == null) {
      const first = evs[0];
      data.calCursor = { y: first?.s_years ?? 1, m: first?.s_month ?? 1, d: first?.s_day ?? 1 };
    }
    host.innerHTML = buildChroniclerCalendarHtml(evs, data);
    return;
  }

  if (!evs.length) {
    host.innerHTML = `<div class="empty" style="margin-top:20px"><div class="ei">${I.timeline}</div><h3>${t('noEventsYet')}</h3>
        <button class="btn btn-p" onclick="openChroniclerEventModal(${data.activeId})">${I.plus} ${t('addEvent')}</button></div>`;
    return;
  }
  if (data.view === 'downline') {
    // Mockup 22: a vertical proportional time line on the left, the event
    // list on the right. Gained wheel-zoom / right-drag-pan in Process 8
    // part 1 — see bindChroniclerDownlineInteractions for why it is a
    // separate binding from the oneline one rather than a shared axis.
    host.innerHTML = await buildChroniclerDownlineHtml(evs, data.activeId, col, data.inspectorEventId);
    bindChroniclerDownlineInteractions();
    return;
  }
  host.innerHTML = await buildChroniclerOneLineHtml(evs, data.activeId, col, data.inspectorEventId);
  bindTimelineGraphInteractions(data.activeId);
}

// ═══ Event Inspector (Plan part3 #2/#2.1/#2.2) ═════════════════════════
// A single id on chroniclerData (not a Set) — only one inspector is ever
// open at a time, in either view. That's a hard requirement (#2.2) rather
// than just a UX choice: the shared colorPicker() widget below renders
// singleton ids (#sel-color, #cpicker-grid, …), so more than one instance
// mounted at once would collide.
async function toggleChroniclerInspector(tlid, evId) {
  const data = S.chroniclerData;
  if (!data) return;
  data.inspectorEventId = (data.inspectorEventId === evId) ? null : evId;
  await mountChroniclerGraph();
}

async function buildChroniclerEventInspectorHtml(ev, tlid) {
  // Process 8 part 1: start and end sit side by side. Two stacked .fg blocks,
  // each holding a full 5-box date row, made the inspector far taller and wider
  // than the information in it justified.
  return `
    <div class="fg"><label>${t('name')} *</label><input id="chr-insp-n" value="${x(ev.event_name || '')}" onchange="saveChroniclerInspectorField(${ev.id},${tlid})"></div>
    <div class="chr-daterow">
      <div class="fg"><label>${t('startDate')} *</label>${dateInputsHTML('chr-insp-s', ev, 's_day', 's_month', 's_years', 's_hour', 's_minute', `saveChroniclerInspectorField(${ev.id},${tlid})`)}</div>
      <div class="fg"><label>${t('endDate')}</label>${dateInputsHTML('chr-insp-e', ev, 'e_day', 'e_month', 'e_years', 'e_hour', 'e_minute', `saveChroniclerInspectorField(${ev.id},${tlid})`)}</div>
    </div>
    <div class="fg"><label>${t('story')}</label><textarea id="chr-insp-story" onchange="saveChroniclerInspectorField(${ev.id},${tlid})">${x(ev.story || '')}</textarea></div>
    ${renderChroniclerEventLinksHtml(ev)}`;
}

// ── Linked elements from other Major modules ────────────────────────────
// Same mechanism as the classifier's element links (mod/classifier-detail.js):
// entity_relation rows, here keyed tlev_<id>. migrate_v3.js already writes that
// key kind, so nothing new is needed in the schema. viewer.index supplies both
// the picker and the "which module did this come from" label the Plan asks for.
let _chrLinks = [];
let _chrLinkIndex = {};
function setChroniclerLinkData(relations, index) {
  _chrLinks = relations || [];
  _chrLinkIndex = {};
  for (const e of (index || [])) _chrLinkIndex[e.key] = e;
}

function renderChroniclerEventLinksHtml(ev) {
  const self = `tlev_${ev.id}`;
  const rows = _chrLinks.filter(l => l.from_key === self || l.to_key === self).map(l => {
    const otherKey = l.from_key === self ? l.to_key : l.from_key;
    const e = _chrLinkIndex[otherKey];
    const from = e ? `${e.moduleName || '—'}${e.moduleKind ? ` · ${kindLabel(e.moduleKind)}` : ''}` : '—';
    return `<div class="cls-link-row">
      <span class="cls-link-name" onclick="openEntityByKey('${x(otherKey)}')">${x(e ? e.name : otherKey)}</span>
      <span class="cls-link-mod">${x(from)}</span>
      ${l.label ? `<span class="cls-link-lbl">${x(l.label)}</span>` : ''}
      <button class="btn btn-g btn-i" onclick="deleteChroniclerEventLink(${l.id})" title="${t('delete')}">${I.delete}</button>
    </div>`;
  }).join('');
  return `<div class="insp-label cls-link-label">${t('linkedElements')}</div>
    <div class="cls-link-list">${rows || `<div class="cls-lv-empty">${t('noLinkedElements')}</div>`}</div>
    <button class="btn btn-g" style="margin:4px 0" onclick="openChroniclerEventLinkModal(${ev.id})">${I.plus} ${t('addLinkedElement')}</button>`;
}

async function openChroniclerEventLinkModal(evId) {
  const ix = await api.viewer.index(S.nexus.id);
  const opts = ix.filter(e => e.key !== `tlev_${evId}` && !e.key.startsWith('module_'));
  openModal(t('addLinkedElement'), `
    <div class="fg"><label>${t('element')}</label>
      <select id="chrl-target">${opts.map(e =>
        `<option value="${x(e.key)}">${x(e.name)} — ${x(e.moduleName || '')}</option>`).join('')}</select></div>
    <div class="fg"><label>${t('relationLabel')}</label><input id="chrl-label"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitChroniclerEventLink(${evId})">${t('create')}</button>
    </div>`);
}

async function submitChroniclerEventLink(evId) {
  const target = q('#chrl-target')?.value;
  if (!target) { closeModal(); return; }
  try {
    await api.viewer.createRelation(S.nexus.id, `tlev_${evId}`, target, q('#chrl-label')?.value.trim() || null, null);
  } catch (e) {
    toast(t('linkExists'), 'err');
    return;
  }
  closeModal();
  await reloadChroniclerLinks();
  await mountChroniclerGraph();
  toast(t('created'), 'ok');
}

async function deleteChroniclerEventLink(id) {
  await api.viewer.deleteRelation(id);
  await reloadChroniclerLinks();
  await mountChroniclerGraph();
}

async function reloadChroniclerLinks() {
  const [relations, index] = await Promise.all([
    api.viewer.getRelations(S.nexus.id),
    api.viewer.index(S.nexus.id),
  ]);
  setChroniclerLinkData(relations, index);
}

// Color+icon are picked via clicking the event's dot (openChroniclerEventIconPopup)
// instead of an inline swatch grid — same click-to-popup, live-save pattern
// as hub.js's module-tree icon popup (openModuleIconPopup/saveModuleIconLive).
async function openChroniclerEventIconPopup(evId, anchor, tlid) {
  closeAllPopups();
  if (!anchor) return;
  const evs = await api.timeline.getEvents(tlid);
  const ev = evs.find(e => e.id === evId);
  if (!ev) return;
  const pop = document.createElement('div');
  pop.className = 'kind-popup icon-edit-popup';
  pop.innerHTML = await iconPicker(ev.icon || null, ev.color || null, ev.event_name);
  document.body.appendChild(pop);
  pop.addEventListener('click', e => {
    e.stopPropagation();
    if (e.target.closest('.ipk-cell') || e.target.closest('.cswatch')) saveChroniclerEventIconLive(evId, tlid);
  });
  positionPopupNear(pop, anchor.getBoundingClientRect());
}

async function saveChroniclerEventIconLive(evId, tlid) {
  const icon = getIconPickerValue() || null;
  const color = q('#sel-color')?.value || null;
  await api.timeline.updateEventIcon(evId, icon, color);
  if (S.chroniclerData?.moduleId != null) invalidateNestItems(S.chroniclerData.moduleId);
  await mountChroniclerGraph();
}

async function saveChroniclerInspectorField(evId, tlid) {
  try {
    const n = q('#chr-insp-n')?.value.trim();
    if (!n) { toast(t('name'), 'err'); return; }
    const sid = await getDateFromInputs('chr-insp-s');
    if (!sid) { toast(t('startDate'), 'err'); return; }
    const eid = await getDateFromInputs('chr-insp-e');
    const story = q('#chr-insp-story')?.value.trim() || '';
    const existing = (await api.timeline.getEvents(tlid)).find(e => e.id === evId);
    await api.timeline.updateEvent(evId, n, sid, eid, existing?.color || null, story); // color/icon unchanged — set via the dot's icon popup
    // This same reused body (buildChroniclerEventInspectorHtml) renders in
    // two contexts (Plan part4): the module's own Oneline/Downline view, or
    // the event's own dedicated item page — refresh whichever is live.
    if (S.activeItemNode?.itemKind === 'chronicler' && S.activeItemNode?.id === evId) {
      invalidateNestItems(S.activeItemNode.moduleId);
      await openItemNode('chronicler', S.activeItemNode.moduleId, evId);
    } else {
      if (S.chroniclerData?.moduleId != null) invalidateNestItems(S.chroniclerData.moduleId);
      await mountChroniclerGraph();
    }
    toast(t('saved'), 'ok');
  } catch (e) { toast(e.message, 'err'); console.error(e); }
}

// buildChroniclerDownlineHtml / buildChroniclerOneLineHtml /
// buildChroniclerCompareHtml and the graph display toggles moved to
// mod/chronicler-graph.js (Process 8 part 1) — see that file's header.

// The calendar view, its Custom-calendar panel and both setup wizards moved to
// mod/chronicler-calendar.js (Process 8 part 1) — see that file's header.

// Plan part3 #2.1/#2.2: each row expands into an inline, autosaving
// inspector instead of jumping to the modal — and since inspectorEventId is
// a single value (not a Set), opening one row's dropdown always collapses
// whichever other row was open.
async function buildChroniclerEventListHtml(evs, tlid, col, inspectorEventId) {
  if (!evs.length) return '';
  let html = `<div class="ph"><h4>${t('name')}</h4><button class="btn btn-p" style="padding:6px 12px;font-size:calc(12.5px * var(--fsc,1))" onclick="openChroniclerEventModal(${tlid})">${I.plus} ${t('addEvent')}</button></div><div class="objlist">`;
  for (const ev of evs) {
    const ec = ev.color_code || col;
    const sTxt = fmtDate(ev.s_day, ev.s_month, ev.s_years, ev.s_hour, ev.s_minute);
    const hasEnd = !!(ev.e_day && ev.e_month && ev.e_years);
    const dateTxt = hasEnd ? `${sTxt} - ${fmtDate(ev.e_day, ev.e_month, ev.e_years, ev.e_hour, ev.e_minute)}` : sTxt;
    const open = inspectorEventId === ev.id;
    // Process 8 part 1: name, date and chevron share ONE row — the date used to
    // sit on a second line, which made two adjacent collapsed events read as
    // one four-line block. Delete moved into the expanded body (below), so the
    // collapsed row carries nothing destructive.
    html += `<div class="chr-insp-row${open ? ' open' : ''}">
      <div class="objrow" onclick="toggleChroniclerInspector(${tlid},${ev.id})">
        <div class="odot" style="background:${ec};cursor:pointer" onclick="event.stopPropagation();openChroniclerEventIconPopup(${ev.id},this,${tlid})"></div>
        <div class="oname chr-ev-name">${x(ev.event_name || '—')}</div>
        <div class="chr-ev-date">${x(dateTxt)}</div>
        <svg class="icon tree-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="${open ? '6 9 12 15 18 9' : '9 18 15 12 9 6'}"/></svg>
      </div>
      ${open ? `<div class="chr-insp-body" id="chr-insp-body-${ev.id}">${await buildChroniclerEventInspectorHtml(ev, tlid)}
        <div class="chr-insp-foot"><button class="btn btn-d" onclick="deleteChroniclerEvent(${ev.id},${tlid})">${I.delete} ${t('delete')}</button></div>
      </div>` : ''}
    </div>`;
  }
  html += `</div>`;
  return html;
}

// ═══ Timeline line CRUD ════════════════════════════════════════════════
async function openChroniclerTimelineModal(moduleId, id = null) {
  const tl = id ? S.chroniclerData.timelines.find(t => t.id === id) : null;
  openModal(tl ? t('chroniclerLineEdit') : t('chroniclerLineNew'), `
    <div class="fg"><label>${t('name')} *</label><input id="chr-tl-name" value="${x(tl?.line_name || '')}"></div>
    <div class="fg"><label>${t('color')}</label>${await colorPicker(tl?.color)}</div>
    <div class="mfoot">${tl ? `<button class="btn btn-d" onclick="deleteChroniclerTimeline(${moduleId},${id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitChroniclerTimelineForm(${moduleId},${tl ? id : 'null'})">${tl ? t('save') : t('create')}</button></div>`);
  setTimeout(() => q('#chr-tl-name').focus(), 60);
}

async function submitChroniclerTimelineForm(moduleId, id) {
  const name = q('#chr-tl-name').value.trim();
  if (!name) return;
  const colorId = q('#sel-color').value || null;
  if (id) {
    await api.timeline.update(id, name, colorId);
  } else {
    if (S.chroniclerData.timelines.length >= 1) { closeModal(); return; } // only 1 line/module (C2)
    const r = await api.timeline.createModuleTimeline(moduleId, name, colorId);
    S.chroniclerData.activeId = r.lastInsertRowid;
  }
  closeModal();
  const m = findModuleNode(moduleId);
  await loadChroniclerData(m);
  renderNexusHome();
  toast(id ? t('saved') : t('created'), 'ok');
}

async function deleteChroniclerTimeline(moduleId, id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.timeline.delete(id);
  closeModal();
  const m = findModuleNode(moduleId);
  if (S.chroniclerData.activeId === id) S.chroniclerData.activeId = null;
  await loadChroniclerData(m);
  renderNexusHome();
  toast(t('deleted'), 'ok');
}

// ═══ Event CRUD (module-scoped: no Director relation/hashtag coupling —
// those systems are project-scoped, see progress.md Section C item 8 for
// the same reasoning applied to Classifier) ═════════════════════════════
async function openChroniclerEventModal(tlid, evId = null) {
  let ev = null;
  if (evId) { const evs = await api.timeline.getEvents(tlid); ev = evs.find(e => e.id === evId); }
  openModal(ev ? t('chroniclerEventEdit') : t('chroniclerEventNew'), `
    <div class="fg"><label>${t('name')} *</label><input id="chr-ev-n" value="${x(ev?.event_name || '')}"></div>
    <div class="fg"><label>${t('startDate')} *</label>${dateInputsHTML('chr-ev-s', ev, 's_day', 's_month', 's_years', 's_hour', 's_minute')}</div>
    <div class="fg"><label>${t('endDate')}</label>${dateInputsHTML('chr-ev-e', ev, 'e_day', 'e_month', 'e_years', 'e_hour', 'e_minute')}</div>
    <div class="fg"><label>${t('story')}</label><textarea id="chr-ev-story">${x(ev?.story || '')}</textarea></div>
    <div class="mfoot">${ev ? `<button class="btn btn-d" onclick="deleteChroniclerEvent(${evId},${tlid})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="${ev ? `saveChroniclerEvent(${evId},${tlid})` : `createChroniclerEvent(${tlid})`}">${ev ? t('save') : t('create')}</button></div>`);
  setTimeout(() => q('#chr-ev-n').focus(), 60);
}

async function createChroniclerEvent(tlid) {
  try {
    const n = q('#chr-ev-n').value.trim();
    if (!n) { toast(t('name'), 'err'); return; }
    const sid = await getDateFromInputs('chr-ev-s');
    if (!sid) { toast(t('startDate'), 'err'); return; }
    const eid = await getDateFromInputs('chr-ev-e');
    const story = q('#chr-ev-story')?.value.trim() || '';
    await api.timeline.createEvent(tlid, n, sid, eid, null, story); // color/icon set later via the dot's icon popup
    closeModal();
    await mountChroniclerGraph();
    if (S.chroniclerData?.moduleId != null) invalidateNestItems(S.chroniclerData.moduleId, 1);
    toast(t('created'), 'ok');
  } catch (e) { toast(e.message, 'err'); console.error(e); }
}

async function saveChroniclerEvent(evId, tlid) {
  try {
    const n = q('#chr-ev-n').value.trim();
    if (!n) { toast(t('name'), 'err'); return; }
    const sid = await getDateFromInputs('chr-ev-s');
    if (!sid) { toast(t('startDate'), 'err'); return; }
    const eid = await getDateFromInputs('chr-ev-e');
    const story = q('#chr-ev-story')?.value.trim() || '';
    const existing = (await api.timeline.getEvents(tlid)).find(e => e.id === evId);
    await api.timeline.updateEvent(evId, n, sid, eid, existing?.color || null, story); // color/icon unchanged — set via the dot's icon popup
    closeModal();
    await mountChroniclerGraph();
    if (S.chroniclerData?.moduleId != null) invalidateNestItems(S.chroniclerData.moduleId);
    toast(t('saved'), 'ok');
  } catch (e) { toast(e.message, 'err'); console.error(e); }
}

async function deleteChroniclerEvent(evId, tlid) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.timeline.deleteEvent(evId);
  if (S.chroniclerData?.inspectorEventId === evId) S.chroniclerData.inspectorEventId = null;
  closeModal();
  const moduleId = S.chroniclerData?.moduleId;
  await mountChroniclerGraph();
  if (moduleId != null) invalidateNestItems(moduleId, -1);
  toast(t('deleted'), 'ok');
}
