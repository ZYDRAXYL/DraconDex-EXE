'use strict';
// Setting window → Appdata → Database (Plan.md part1 #Setting): list the
// user's Nexuses, export/import per-Nexus and per-module. All the actual
// serialization lives in src/db/sync.js (reused from Token Sync) and
// src/db/db-transfer.js (file I/O + module-subtree scoping) — this file only
// renders and dispatches. Names are never embedded into onclick string
// literals (a Nexus/module name could contain a quote) — every handler
// takes only an id and looks the row up from the cached list/tree instead.

function settingDatabasePageHtml(){
  settingRefreshDatabaseSection();
  return `<div id="setting-db-legacy"></div><div class="settings-label">${t('settingDbNexusList')}</div><div id="setting-db-body">${t('syncWorking')}</div>`;
}
async function settingRefreshDatabaseSection(){
  const nexuses = await api.nexus.getAll();
  S.settingDbNexuses = nexuses;
  const el = q('#setting-db-body');
  if (!el) return;
  el.innerHTML = nexuses.length
    ? nexuses.map(settingDbNexusRowHtml).join('')
    : `<div class="modal-hint">${I.info}<span>${t('settingDbNoModules')}</span></div>`;
  if (S.settingDbExpandedNexus) settingDbLoadModules(S.settingDbExpandedNexus);
  settingDbRefreshLegacyButton();
}
// Plan process2 part2 #2.1.1: manual re-entry point for a user who picked
// "export" on the boot-time legacy prompt (or whose open vault has
// un-migrated legacy data without ever having been prompted) — reuses the
// same comparison-list preview the boot prompt and the Import DB merge flow
// both open (hub/legacy-migrate.js), skipping straight past the export-or-
// convert choice since clicking this button already is "convert."
async function settingDbRefreshLegacyButton(){
  const el = q('#setting-db-legacy');
  if (!el) return;
  if (!S.nexus) { el.innerHTML = ''; return; }
  let hasLegacy = false;
  for (const tg of MIGRATE_TARGETS) {
    try { if ((await api.migrate.list(tg.id, S.nexus.id)).length) { hasLegacy = true; break; } }
    catch (_) { /* keep checking the other targets */ }
  }
  if (!q('#setting-db-legacy')) return; // page switched while this was in flight
  el.innerHTML = hasLegacy
    ? `<button class="btn btn-p" style="margin-bottom:10px" onclick="settingDbConvertLegacyClick()">${t('settingDbConvertLegacy')}</button>`
    : '';
}
function settingDbConvertLegacyClick(){
  // .floating-panel sits at a higher z-index than #modal-overlay (150 vs
  // 100, components.css) — openModal() alone would render behind this
  // still-open Setting window, so close it first.
  closeFloatingPanel('setting-window');
  openLegacyMigratePreviewModal();
}
function settingDbNexusRowHtml(n){
  const expanded = S.settingDbExpandedNexus === n.id;
  return `<div class="li${expanded ? ' active' : ''}" onclick="settingDbToggleNexus(${n.id})">
      <span class="dot" style="${n.color_code ? `background:${x(n.color_code)}` : ''}"></span>
      <span class="name" data-no-i18n>${x(n.name)}</span>
      <button class="btn btn-s btn-sm" onclick="event.stopPropagation();settingDbExportNexus(${n.id})">${t('settingDbExportNexus')}</button>
      <button class="btn btn-s btn-sm" onclick="event.stopPropagation();settingDbImportNexus(${n.id})">${t('settingDbImportNexus')}</button>
    </div>
    ${expanded ? `<div id="setting-db-modules-${n.id}" style="padding-left:20px">${t('syncWorking')}</div>` : ''}`;
}
function settingDbToggleNexus(nexusId){
  S.settingDbExpandedNexus = S.settingDbExpandedNexus === nexusId ? null : nexusId;
  renderSettingWindow();
}
async function settingDbLoadModules(nexusId){
  const tree = await api.module.getTree(nexusId);
  S.settingDbModuleTrees = S.settingDbModuleTrees || {};
  S.settingDbModuleTrees[nexusId] = tree;
  const el = q(`#setting-db-modules-${nexusId}`);
  if (!el) return; // collapsed again before this resolved
  el.innerHTML = settingDbModuleRowsHtml(tree, nexusId);
}
function settingDbFindModule(nexusId, moduleId){
  const walk = (list) => {
    for (const m of list || []) {
      if (m.id === moduleId) return m;
      const found = walk(m.children);
      if (found) return found;
    }
    return null;
  };
  return walk((S.settingDbModuleTrees || {})[nexusId]);
}
function settingDbModuleRowsHtml(list, nexusId, depth = 0){
  if (!list || !list.length) {
    return depth === 0 ? `<div class="modal-hint">${I.info}<span>${t('settingDbNoModules')}</span></div>` : '';
  }
  return list.map((m) => `
    <div class="li" style="padding-left:${depth * 16}px">
      <span class="name" data-no-i18n>${x(m.name)}</span>
      <span class="tag" data-no-i18n>${x(kindLabel(m.kind))}</span>
      <button class="btn btn-s btn-sm" onclick="settingDbExportModule(${nexusId},${m.id})">${t('settingDbExportModule')}</button>
      <button class="btn btn-s btn-sm" onclick="settingDbImportModule(${nexusId},${m.id})">${t('settingDbImportModule')}</button>
    </div>
    ${settingDbModuleRowsHtml(m.children, nexusId, depth + 1)}`).join('');
}

async function settingDbExportNexus(nexusId){
  const n = (S.settingDbNexuses || []).find((x0) => x0.id === nexusId);
  const r = await api.db.exportNexusFile(nexusId, n?.name);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbExportOk'), 'ok');
}
async function settingDbImportNexus(nexusId){
  if (!(await uiConfirm(t('settingDbImportConfirm')))) return;
  const r = await api.db.importNexusFile(nexusId);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbImportOk'), 'ok');
  if (S.nexus?.id === nexusId) renderNexusHome();
}
async function settingDbExportModule(nexusId, moduleId){
  const m = settingDbFindModule(nexusId, moduleId);
  const r = await api.db.exportModuleFile(nexusId, moduleId, m?.name);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbExportOk'), 'ok');
}
// "Import module" brings a module snapshot IN as a new child of the row you
// clicked (the simplest unambiguous target — importing "into" a leaf module
// just means importing as its sibling-under-the-same-parent would need an
// extra parent-picker step this keeps out of scope for v1).
async function settingDbImportModule(nexusId, parentModuleId){
  const r = await api.db.importModuleFile(nexusId, parentModuleId);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbImportOk'), 'ok');
  settingDbLoadModules(nexusId);
  if (S.nexus?.id === nexusId) renderNexusHome();
}
registerSettingPage('appdata', 'database', settingDatabasePageHtml);
