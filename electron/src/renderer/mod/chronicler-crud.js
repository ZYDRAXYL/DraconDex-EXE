'use strict';
// ═══ Chronicler — line and event CRUD ══════════════════════════════════
// Split out of mod/chronicler.js in v5 Part 8, when per-instance state pushed
// that file past the ~500-line band. Everything here acts on the CURRENT
// Chronicler instance (S.chroniclerData, page/page.js pbCurrent).

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
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
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
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
  if (!await uiConfirm(t('confirmDeleteItem'))) return;
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
// No modal (APP src/design/no-modal #05): the event's page and the Down-line
// row already edit every field, so a new event is made at once — on the
// line's latest date, named "New event" — with its name selected to type
// over: in the Down-line list when that is showing, else on its own page.
async function newChroniclerEvent(tlid) {
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
  try {
    const data = S.chroniclerData;
    const evs = await api.timeline.getEvents(tlid);
    const last = evs[evs.length - 1], cur = data?.calCursor;
    const sid = await api.timeline.getOrCreateDate(last?.s_day || cur?.d || 1, last?.s_month || cur?.m || 1,
      last?.s_years || cur?.y || 1, last?.s_hour || 0, last?.s_minute || 0);
    const r = await api.timeline.createEvent(tlid, t('chroniclerEventNew'), sid, null, null, '');
    const id = Number(r?.lastInsertRowid) || Math.max(...(await api.timeline.getEvents(tlid)).map((e) => e.id));
    const moduleId = data?.moduleId;
    const inList = data?.view === 'downline';
    if (inList) data.inspectorEventId = id;
    // the Nest's re-render redraws the graph too (asynchronously), so the row
    // opens with it; wait for its name box rather than racing that redraw
    if (moduleId != null) invalidateNestItems(moduleId, 1);
    if (!inList && moduleId != null) await openItemNode('chronicler', moduleId, id);
    else if (moduleId == null) { pbUse(__iid); await mountChroniclerGraph(); }
    for (let i = 0; i < 40; i++) {
      const inp = document.querySelector(inList ? `#chr-insp-body-${id} #chr-insp-n` : '#item-chr-insp #chr-insp-n');
      if (inp?.isConnected) { await new Promise((r) => setTimeout(r, 60)); if (inp.isConnected) { inp.focus(); inp.select(); break; } }
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch (e) { toast(e.message, 'err'); console.error(e); }
}

// A dot on the line opens the event's page — where all of it is edited.
function openChroniclerEventPage(evId) {
  if (S.chroniclerData?.moduleId != null) openItemNode('chronicler', S.chroniclerData.moduleId, evId);
}

async function deleteChroniclerEvent(evId, tlid) {
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
  if (!await uiConfirm(t('confirmDeleteItem'))) return;
  await api.timeline.deleteEvent(evId);
  if (S.chroniclerData?.inspectorEventId === evId) S.chroniclerData.inspectorEventId = null;
  const moduleId = S.chroniclerData?.moduleId;
  pbUse(__iid); await mountChroniclerGraph();
  if (moduleId != null) invalidateNestItems(moduleId, -1);
  toast(t('deleted'), 'ok');
}

// Procress 16 part 7 — the game line: a play session logged against the
// world's own calendar. Real time (today, how long) and in-game time (the
// date the session reached) side by side, as an event on a "Play log"
// timeline made the first time — the Chronicler's own data, nothing new.
function openPlaySessionModal(moduleId) {
  openModal(t('chrLogSession'), `
    <div class="fg"><label>${t('chrInGame')} *</label>${dateInputsHTML('chr-ps', null, 's_day', 's_month', 's_years', 's_hour', 's_minute')}</div>
    <div class="fg"><label for="chr-ps-min">${t('chrRealMinutes')}</label><input id="chr-ps-min" type="number" min="0" step="5" value="60"></div>
    <div class="fg"><label for="chr-ps-note">${t('story')}</label><textarea id="chr-ps-note" data-wiki></textarea></div>
    <div class="mfoot"><button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="savePlaySession(${moduleId})">${t('create')}</button></div>`);
}
async function savePlaySession(moduleId) {
  const sid = await getDateFromInputs('chr-ps');
  if (!sid) { toast(t('chrInGame'), 'err'); return; }
  const lines = (await api.timeline.getModuleTimelines(moduleId)) || [];
  let line = lines.find((l) => l.line_name === t('chrPlayLog'));
  if (!line) {
    const r = await api.timeline.createModuleTimeline(moduleId, t('chrPlayLog'), null);
    line = { id: r?.lastInsertRowid ?? r?.id ?? r };
  }
  const n = ((await api.timeline.getEvents(line.id)) || []).length + 1;
  const now = new Date();
  const real = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const min = Math.max(0, Number(q('#chr-ps-min')?.value) || 0);
  const note = q('#chr-ps-note')?.value.trim() || '';
  await api.timeline.createEvent(line.id, `${t('chrSession')} ${n}`, sid, null, null, `${real} · ${min} min${note ? `\n\n${note}` : ''}`);
  closeModal();
  await reloadSource(moduleId);
  toast(t('created'), 'ok');
}
