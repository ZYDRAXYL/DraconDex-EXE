'use strict';
// ═══ Chronicler — line and event CRUD ══════════════════════════════════
// Split out of mod/chronicler.js in v5 Part 8, when per-instance state pushed
// that file past the ~500-line band. Everything here acts on the CURRENT
// Chronicler instance (S.chroniclerData, page/page.js pbCurrent).

// ═══ Timeline line CRUD ════════════════════════════════════════════════
// No modal (APP src/design/no-modal #04): the line's name and colour sit in a
// panel over the graph (.sel-panel, core/fields.js), saved as each changes —
// "Edit line" opens and closes it. A module's first line is made at once,
// named after the module, with the panel open and its name ready to type.
async function toggleChroniclerLinePanel(open = null) {
  const data = S.chroniclerData;
  if (!data) return;
  data.lineEdit = open ?? !data.lineEdit;
  renderNexusHome();
  if (data.lineEdit) fieldsFocus('name');
}

async function newChroniclerTimeline(moduleId) {
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
  if (S.chroniclerData?.timelines.length) return; // only 1 line/module (C2)
  const r = await api.timeline.createModuleTimeline(moduleId, findModuleNode(moduleId)?.name || t('chroniclerLineNew'), null);
  pbUse(__iid);
  S.chroniclerData.activeId = r.lastInsertRowid;
  S.chroniclerData.lineEdit = true;
  await loadChroniclerData(findModuleNode(moduleId));
  renderNexusHome();
  fieldsFocus('name');
}

function chroniclerLinePanelHtml(data, moduleId) {
  const tl = data.lineEdit ? data.timelines.find((l) => l.id === data.activeId) : null;
  if (!tl) return '';
  return `<section class="sel-panel" data-r="line-panel">
    <div class="sel-panel-h"><span>${t('chrEditLine')}</span>
      <span><button class="btn btn-g btn-i" onclick="deleteChroniclerTimeline(${moduleId},${tl.id})" title="${x(t('delete'))}" aria-label="${x(t('delete'))}">${I.delete}</button><button class="btn btn-g btn-i" onclick="toggleChroniclerLinePanel(false)" title="${x(t('cancel'))}" aria-label="${x(t('cancel'))}">${I.close}</button></span></div>
    ${fieldsStripHtml([
      { key: 'name', title: t('name'), value: tl.line_name || '' },
      { key: 'color', title: t('color'), type: 'color', value: tl.color ?? '', hex: tl.color_code },
    ])}</section>`;
}

function mountChroniclerLinePanel() {
  const data = S.chroniclerData;
  const panel = data && pbQOr('[data-r="line-panel"]');
  const tl = panel && data.timelines.find((l) => l.id === data.activeId);
  if (!tl) return;
  const iid = data.iid;
  fieldsStripMount(panel, async (key, v) => {
    if (key === 'name' && !v) return t('nameRequired');
    await api.timeline.update(tl.id, key === 'name' ? v : tl.line_name, key === 'color' ? Number(v) || null : tl.color ?? null);
    pbUse(iid);
    await loadChroniclerData(findModuleNode(data.moduleId));
    renderNexusHome();
    return true;
  });
}

async function deleteChroniclerTimeline(moduleId, id) {
  const __iid = pbCurrent(); // re-bound below: an await can hand the turn to another instance
  if (!await uiConfirm(t('confirmDeleteItem'))) return;
  await api.timeline.delete(id);
  const m = findModuleNode(moduleId);
  if (S.chroniclerData.activeId === id) S.chroniclerData.activeId = null;
  S.chroniclerData.lineEdit = false;
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
// No modal (#06): a play session is logged at once — dated like the play log's
// last session (else the line's latest event), 60 minutes — and opens on its
// event page with the story ready to type, where its date and text are
// edited like any event's (#05).
async function logPlaySession(moduleId) {
  const data = S.chroniclerData;
  const lines = (await api.timeline.getModuleTimelines(moduleId)) || [];
  let line = lines.find((l) => l.line_name === t('chrPlayLog'));
  if (!line) {
    const r = await api.timeline.createModuleTimeline(moduleId, t('chrPlayLog'), null);
    line = { id: r?.lastInsertRowid ?? r?.id ?? r };
  }
  const logged = (await api.timeline.getEvents(line.id)) || [];
  const from = logged.at(-1) || (data?.activeId ? ((await api.timeline.getEvents(data.activeId)) || []).at(-1) : null);
  const cur = data?.calCursor;
  const sid = await api.timeline.getOrCreateDate(from?.s_day || cur?.d || 1, from?.s_month || cur?.m || 1, from?.s_years || cur?.y || 1, from?.s_hour || 0, from?.s_minute || 0);
  const now = new Date();
  const real = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const r = await api.timeline.createEvent(line.id, `${t('chrSession')} ${logged.length + 1}`, sid, null, null, `${real} · 60 min`);
  const id = Number(r?.lastInsertRowid) || Math.max(...(await api.timeline.getEvents(line.id)).map((e) => e.id));
  invalidateNestItems(moduleId, 1);
  await openItemNode('chronicler', moduleId, id);
  focusWhenSettled('#item-chr-insp #chr-insp-story', false);
}
