'use strict';
// ═══ TimeMap "Wanderer" (progress.md Phase 9) ═════════════════════════
// Dual Map + Timeline graph (mockup docs/mockups/10-wanderer.png). The
// module references one existing Locator and one Chronicler (stored in
// module_ui as mapModule/timelineModule); MapEvent "Link" pins live in the
// map_event table (src/db/wanderer.js) — each pin sits at (x,y) on the
// Locator's map and displays the start time of its bound Chronicler event.
// The map pane reuses map.js's renderMapBoard wholesale (S.map is set to
// the Locator's map row, same as loadLocatorData); the timeline pane
// reuses chronicler.js's one-line strip + shared pan/zoom interactions.

const WANDERER_VIEWS = ['area', 'map', 'timeline'];
const WANDERER_VIEW_LABEL = { area: 'Area', map: 'Map', timeline: 'Timeline' };

// Resolves each link's linker_key to its actual vault entity (module,
// classifier object, character, chapter, note, …) in one batched call —
// same pattern designer.js's loadDesignerData uses for design_node pins.
async function resolveWandererLinks(links) {
  const keys = links.map(l => l.linker_key).filter(Boolean);
  const ents = keys.length ? await api.wiki.resolveKeys(keys) : [];
  const byKey = new Map(ents.map(e => [e.key, e]));
  for (const l of links) l.entity = l.linker_key ? (byKey.get(l.linker_key) || null) : null;
  return links;
}

async function loadWandererData(m) {
  // chronicler.js (one-line strip + sortChroniclerEvents) is statically
  // loaded from index.html; map.js/timeline.js are lazy like in Phases 7-8.
  await loadModule('src/renderer/map.js');
  await loadModule('src/renderer/timeline.js');
  await ensureKonva();
  const ui = await api.module.getUi(m.id);
  const locators = modulesOfKind('locator');
  const chroniclers = modulesOfKind('chronicler');
  const mapModuleId = Number(ui.mapModule) || null;
  const timelineModuleId = Number(ui.timelineModule) || null;
  const view = WANDERER_VIEWS.includes(ui.activeView) ? ui.activeView : 'area';
  const prev = (S.wandererData && S.wandererData.moduleId === m.id) ? S.wandererData : null;

  let map = null, areas = [];
  if (mapModuleId && locators.find(l => l.id === mapModuleId)) {
    map = await api.map.getOrCreateModuleMap(mapModuleId);
    areas = await api.map.getAreas(map.id);
    await Promise.all(areas.map(async (a) => { mapState.pointsByArea[a.id] = await api.map.getPoints(a.id); }));
  }
  // A Chronicler can own several timeline lines — a MapEvent may bind to an
  // event on any of them, so the strip shows the merged, sorted set.
  // The strip is drawn in the referenced Chronicler's calendar, not in this
  // Wanderer's (it has none) and not in whichever Chronicler happens to be
  // open — so read that module's own spec and thread it through.
  let timeline = null, events = [], calendarSpec = calSpecNormalize(null);
  if (timelineModuleId && chroniclers.find(c => c.id === timelineModuleId)) {
    const lines = await api.timeline.getModuleTimelines(timelineModuleId);
    timeline = lines[0] || null;
    const tlUi = await api.module.getUi(timelineModuleId);
    let rawCal = null;
    try { rawCal = tlUi.calendarConfig ? JSON.parse(tlUi.calendarConfig) : null; } catch (_) { rawCal = null; }
    calendarSpec = calSpecNormalize(rawCal);
    const perLine = await Promise.all(lines.map(l => api.timeline.getEvents(l.id)));
    events = sortChroniclerEvents(perLine.flat(), calendarSpec);
  }
  const links = await resolveWandererLinks(await api.wanderer.list(m.id));
  let openAreaId = prev?.openAreaId ?? null;
  if (openAreaId && !areas.find(a => a.id === openAreaId)) openAreaId = null;
  S.map = map;
  S.wandererData = { moduleId: m.id, locators, chroniclers, mapModuleId, timelineModuleId, map, areas, timeline, events, links, view, openAreaId, calendarSpec };
}

async function setWandererRef(moduleId, key, value) {
  await api.module.setUi(moduleId, key, value || '');
  await openModuleNode(moduleId);
}

async function setWandererView(view) {
  const d = S.wandererData;
  d.view = view;
  await api.module.setUi(d.moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === d.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

function toggleWandererPlacing() {
  const d = S.wandererData;
  d.placing = !d.placing;
  const btn = q('#wnd-place-btn');
  if (btn) btn.classList.toggle('btn-p', d.placing), btn.classList.toggle('btn-s', !d.placing);
  toast(d.placing ? t('wandererPlaceHint') : t('cancel'), '');
}

// ═══ Area view (Plan part5 W5) ══════════════════════════════════════════
// Only one area's dropdown open at a time (single id, not a Set — same
// precedent as Chronicler's inspectorEventId); when open, the map narrows
// to just that area (see the kind-branch filter in map.js's renderMapBoard).
function toggleWandererAreaOpen(areaId) {
  const d = S.wandererData;
  d.openAreaId = d.openAreaId === areaId ? null : areaId;
  renderNexusHome();
}

function buildWandererAreaListHtml(d) {
  const areas = d.areas || [];
  if (!areas.length) return `<div class="wnd-arealist-pane"><div class="empty" style="padding:16px 8px"><p data-no-i18n>No areas yet</p></div></div>`;
  const rows = areas.map(area => {
    const open = d.openAreaId === area.id;
    const areaLinks = d.links.filter(l => l.area_ref === area.id);
    return `<div class="wnd-area-row">
      <div class="objrow" onclick="toggleWandererAreaOpen(${area.id})">
        <div class="dot" style="background:${area.color_code || '#06b6d4'}"></div>
        <div style="flex:1;min-width:0"><div class="oname">${x(area.area_name || '—')}</div></div>
        <svg class="icon tree-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="${open ? '6 9 12 15 18 9' : '9 18 15 12 9 6'}"/></svg>
      </div>
      ${open ? `<div class="wnd-area-body">
        ${areaLinks.length ? areaLinks.map(l => `<div class="objrow" style="padding:4px 0">
          <div class="dot" style="background:${l.entity?.color || '#f97316'}"></div>
          <div style="flex:1;min-width:0">${x(l.entity?.name || '—')}</div>
        </div>`).join('') : `<div class="empty" style="padding:6px 0;font-size:calc(12px * var(--fsc,1))" data-no-i18n>No links yet</div>`}
        <button class="btn btn-g" style="margin-top:6px" onclick="openWandererAreaAddPicker(${area.id})">${I.plus} ${t('moduleLink')}</button>
      </div>` : ''}
    </div>`;
  }).join('');
  return `<div class="wnd-arealist-pane">${rows}</div>`;
}

// "Add object/element/character" only offers entities already linked to
// THIS wanderer module (d.links) — not a fresh nexus-wide quickIndex pick —
// assigning one into the area just reassigns that link's area_ref.
function openWandererAreaAddPicker(areaId) {
  const d = S.wandererData;
  if (!d.links.length) { toast(t('wandererNeedsRefs'), 'err'); return; }
  const opts = d.links.map(l => `<option value="${l.id}">${x(l.entity?.name || '—')}</option>`).join('');
  openModal(t('moduleLink'), `
    <div class="fg"><label>${t('moduleLink')}</label><select id="wnd-area-add-link">${opts}</select></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitWandererAreaAdd(${areaId})">${t('save')}</button>
    </div>`);
}

async function submitWandererAreaAdd(areaId) {
  const d = S.wandererData;
  const link = d.links.find(l => l.id === Number(q('#wnd-area-add-link').value));
  if (!link) return;
  await api.wanderer.update(link.id, link.event_ref, link.linker_key, link.x, link.y, areaId);
  closeModal();
  d.links = await resolveWandererLinks(await api.wanderer.list(d.moduleId));
  renderNexusHome();
  toast(t('saved'), 'ok');
}

function buildWandererMainHtml(m) {
  const d = (S.wandererData && S.wandererData.moduleId === m.id) ? S.wandererData : null;
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const opt = (list, sel, none) => `<option value="">${none}</option>` +
    list.map(l => `<option value="${l.id}" ${l.id === sel ? 'selected' : ''}>${x(l.name)}</option>`).join('');
  const viewBar = `<div class="viewbar">
    ${WANDERER_VIEWS.map(v => `<span class="vitem${v === d.view ? ' act' : ''}" onclick="setWandererView('${v}')">${WANDERER_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <select onchange="setWandererRef(${m.id},'mapModule',this.value)" title="${t('pickLocatorRef')}">${opt(d.locators, d.mapModuleId, '')}</select>
    <select onchange="setWandererRef(${m.id},'timelineModule',this.value)" title="${t('pickChroniclerRef')}">${opt(d.chroniclers, d.timelineModuleId, '')}</select>
    ${d.map && d.timeline ? `<button id="wnd-place-btn" class="btn ${d.placing ? 'btn-p' : 'btn-s'}" onclick="toggleWandererPlacing()">${I.pin} ${t('addMapEvent')}</button>` : ''}
    ${viewBar}
  </div>`;
  if (!d.map || !d.timeline) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div>
      <h3>${t('wandererNeedsRefs')}</h3><p data-no-i18n>Locator + Chronicler</p></div>`;
  }
  const refLine = `<div class="wnd-refline" data-no-i18n>${t('wandererRefs')}: ${x(d.locators.find(l => l.id === d.mapModuleId)?.name || '')} (Locator) + ${x(d.chroniclers.find(c => c.id === d.timelineModuleId)?.name || '')} (Chronicler)</div>`;
  const mapPane = `
    <div id="map-board" class="map-whiteboard locator-board wnd-map-pane">
      <div id="map-konva-container" style="width:100%;height:100%"></div>
      <div class="chint">${t('locatorPanHint')}</div>
      <div class="czoom">
        <span class="zbtn" onclick="zoomLocator(-1)">−</span>
        <span class="zlvl" id="locator-zoom-lvl">100%</span>
        <span class="zbtn" onclick="zoomLocator(1)">+</span>
      </div>
    </div>`;
  const tlPane = `<div class="wnd-tl-pane" id="wanderer-tl-host"></div>`;
  if (d.view === 'map') return `${toolbar}${refLine}<div class="wanderer-split">${mapPane}</div>`;
  if (d.view === 'timeline') return `${toolbar}${refLine}<div class="wanderer-split">${tlPane}</div>`;
  // 'area': map + Area List side by side, oneline timeline strip below —
  // replaces the old 'dual' (Map & Timeline) view.
  return `${toolbar}${refLine}<div class="wanderer-split">
    <div class="wnd-area-top">${mapPane}${buildWandererAreaListHtml(d)}</div>
    ${tlPane}
  </div>`;
}

// Post-DOM hook (registered in renderNexusHome beside mountLocatorBoard):
// draws the base map, overlays the Link pins on the same Konva layer so
// pan/zoom applies, and renders the one-line timeline strip with linked
// events ringed.
async function mountWandererBoard() {
  const d = S.wandererData;
  if (!d || S.activeModuleNode?.id !== d.moduleId) return;
  if (d.view !== 'timeline' && d.map) {
    S.map = d.map;
    await renderMapBoard();
    addWandererPins();
    bindWandererStageClick();
    if (typeof updateLocatorZoomLabel === 'function') updateLocatorZoomLabel();
  }
  if (d.view !== 'map' && d.timeline) {
    const host = q('#wanderer-tl-host');
    if (host) {
      host.innerHTML = d.events.length
        ? await buildChroniclerOneLineHtml(d.events, d.timeline.id, d.timeline.color_code || '#06b6d4')
        : `<div class="empty" style="padding:20px"><p>${t('noEventsYet')}</p></div>`;
      if (d.events.length) bindTimelineGraphInteractions(d.timeline.id);
      decorateWandererTimeline(host);
    }
  }
}

// Ring the dots of events that have a Link pin; clicking a dot highlights
// its pins instead of opening the Chronicler event modal.
function decorateWandererTimeline(host) {
  const d = S.wandererData;
  const linked = new Set(d.links.filter(l => l.event_ref).map(l => l.event_ref));
  host.querySelectorAll('[data-event-dot]').forEach(dot => {
    const evId = Number(dot.dataset.eventDot);
    if (linked.has(evId)) {
      dot.setAttribute('stroke', '#f97316');
      dot.setAttribute('stroke-width', evId === d.selectedEvent ? '5' : '3');
    }
    dot.onclick = (e) => { e.stopPropagation(); wandererSelectEvent(evId); };
  });
}

async function wandererSelectEvent(evId) {
  const d = S.wandererData;
  d.selectedEvent = d.selectedEvent === evId ? null : evId;
  await mountWandererBoard();
}

function addWandererPins() {
  const d = S.wandererData;
  if (!konvaStage) return;
  const layer = konvaStage.getLayers()[0];
  if (!layer) return;
  const scale = konvaStage.scaleX() || 1;
  // Area view (W5): when one area's dropdown is open, only its own links show.
  const pinLinks = d.openAreaId ? d.links.filter(l => l.area_ref === d.openAreaId) : d.links;
  for (const link of pinLinks) {
    const selectedRing = d.selectedEvent && link.event_ref === d.selectedEvent;
    const pinColor = link.entity?.color || '#f97316';
    const pin = new Konva.Circle({
      x: link.x, y: link.y, radius: 8 / scale,
      fill: pinColor, stroke: selectedRing ? '#fff' : 'rgba(255,255,255,.8)',
      strokeWidth: (selectedRing ? 3.5 : 2) / scale,
      wandererPin: true, draggable: true,
    });
    pin.on('click tap', (e) => {
      if (e.evt.button === 0) { e.cancelBubble = true; openMapEventModal(link.id); }
    });
    pin.on('dragend', async () => {
      const pos = pin.position();
      await api.wanderer.update(link.id, link.event_ref, link.linker_key, pos.x, pos.y, link.area_ref);
      link.x = pos.x; link.y = pos.y;
    });
    const when = link.s_day != null ? fmtDate(link.s_day, link.s_month, link.s_years, link.s_hour, link.s_minute) : '—';
    const label = new Konva.Text({
      x: link.x, y: link.y - (16 / scale),
      text: `${link.entity?.name || '—'}\n⏱ ${when}`,
      fontSize: 12.5 / scale, lineHeight: 1.3,
      fill: pinColor, align: 'center',
      listening: false, mapLabel: true,
    });
    label.offsetX(label.width() / 2);
    label.offsetY(label.height());
    layer.add(pin);
    layer.add(label);
  }
  layer.batchDraw();
}

// In placing mode a left-click on empty map space OR directly on an area
// (Plan part5 W2 — areas are inert terrain here, not a select/edit target)
// drops the new pin there; only an existing pin itself is excluded so its
// own click handler (open-for-edit) isn't hijacked.
function bindWandererStageClick() {
  if (!konvaStage) return;
  konvaStage.on('click.wanderer', (e) => {
    const d = S.wandererData;
    if (!d?.placing || e.evt.button !== 0 || e.target?.attrs?.wandererPin) return;
    const pointer = konvaStage.getPointerPosition();
    const wx = (pointer.x - konvaStage.x()) / konvaStage.scaleX();
    const wy = (pointer.y - konvaStage.y()) / konvaStage.scaleY();
    const areaId = e.target?.attrs?.areaId ?? null;
    d.placing = false;
    openMapEventModal(null, { x: wx, y: wy, areaId });
  });
}

// ═══ Link (MapEvent) CRUD ═══════════════════════════════════════════════
// Plan part5 W4: a link picks a vault entity (module, classifier object,
// character, chapter, note, …) via the same quickIndex picker designer.js
// uses for its pin modal, tied to a Chronicler event for its date — not a
// free-text label anymore.
async function openMapEventModal(id, pos = null) {
  const d = S.wandererData;
  const link = id ? d.links.find(l => l.id === id) : null;
  const px = link ? link.x : (pos?.x ?? 0);
  const py = link ? link.y : (pos?.y ?? 0);
  const areaId = link ? (link.area_ref ?? null) : (pos?.areaId ?? null);
  const evOptions = d.events.map(ev => {
    const when = fmtDate(ev.s_day, ev.s_month, ev.s_years, ev.s_hour, ev.s_minute);
    return `<option value="${ev.id}" ${link?.event_ref === ev.id ? 'selected' : ''}>${x(ev.event_name || '—')} — ${x(when)}</option>`;
  }).join('');
  const ix = await api.wiki.quickIndex(S.nexus.id);
  const keyOptions = `<option value="">--</option>` + ix.map(e =>
    `<option value="${x(e.key)}" ${link?.linker_key === e.key ? 'selected' : ''}>${x(e.name)} (${x(e.type)})</option>`).join('');
  openModal(link ? t('mapEventEdit') : t('addMapEvent'), `
    <div class="fg"><label>${t('moduleLink')}</label><select id="wnd-key">${keyOptions}</select></div>
    <div class="fg"><label>${t('wandererPickTime')}</label><select id="wnd-ev">${evOptions}</select></div>
    <div class="fg"><label data-no-i18n>x · y</label><span class="pv ghost" data-no-i18n>${Math.round(px)} · ${Math.round(py)}</span></div>
    <div class="mfoot">
      ${link ? `<button class="btn btn-d" onclick="deleteMapEventRow(${link.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitMapEventForm(${id ?? 'null'},${px},${py},${areaId ?? 'null'})">${link ? t('save') : t('create')}</button>
    </div>`);
}

async function submitMapEventForm(id, px, py, areaId) {
  const d = S.wandererData;
  const key = q('#wnd-key').value || null;
  const eventRef = Number(q('#wnd-ev').value) || null;
  if (id) await api.wanderer.update(id, eventRef, key, px, py, areaId ?? null);
  else await api.wanderer.create(d.moduleId, eventRef, key, px, py, areaId ?? null);
  closeModal();
  d.links = await resolveWandererLinks(await api.wanderer.list(d.moduleId));
  await mountWandererBoard();
  toast(id ? t('saved') : t('created'), 'ok');
}

async function deleteMapEventRow(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.wanderer.delete(id);
  closeModal();
  const d = S.wandererData;
  d.links = await resolveWandererLinks(await api.wanderer.list(d.moduleId));
  await mountWandererBoard();
  toast(t('deleted'), 'ok');
}
