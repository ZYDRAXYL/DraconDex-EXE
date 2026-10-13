'use strict';
// ═══ Problems panel (v5 Part 7, APP docs/V5.md §11.10) ═══════════════════
// Shown inside the Activity Bar's Tools destination (hub/activity.js). The
// list comes from db/problems.js; the one thing only this renderer knows —
// what the last import / pull could not bring across (S.lastImportDrops,
// set by toastSnapshotResult) — heads the list. Every row opens its place.

const PROBLEM_TYPE_KEY = { link: 'probLink', empty: 'probEmpty', relation: 'probRelation' };
const PROBLEM_TYPE_ICON = { link: 'relation', empty: 'folder', relation: 'delete' };

function problemsPanelHtml() {
  return leftPanelHead(t('probTitle'), `
      <button class="btn btn-g btn-i" onclick="loadProblemsPanel()" title="${t('probRefresh')}">${I.return}</button>
      <button class="btn btn-g btn-i" onclick="closeProblemsPanel()" title="${t('guideBack')}">${I.close}</button>`)
    + `<div class="left-dest-body" id="left-problems"><p class="drafter-hint">${t('syncWorking')}</p></div>`;
}

function closeProblemsPanel() {
  S.leftTool = null;
  renderLeftPanel();
}

// Procress 21: the shared list (core/list.js) — one group per kind of
// problem with its count, a filter on top; every row opens its place.
async function loadProblemsPanel() {
  const box = q('#left-problems');
  if (!box || !S.nexus) return;
  const rows = await api.tools.problems(S.nexus.id);
  const groups = [];
  const drops = S.lastImportDrops;
  const dropN = drops ? (drops.relations || 0) + (drops.pins || 0) : 0;
  if (dropN) groups.push({ id: 'drops', items: [{ icon: I.import, title: t('probDrops').replace('{n}', dropN), meta: String(drops.at || '').slice(0, 16).replace('T', ' ') }] });
  for (const type of ['link', 'relation', 'empty']) {
    const list = rows.filter(r => r.type === type);
    if (list.length) groups.push({ id: type, title: t(PROBLEM_TYPE_KEY[type]), count: list.length, items: list.map(r => ({
      icon: I[PROBLEM_TYPE_ICON[type]], title: r.name, meta: type === 'empty' ? kindLabel(r.detail) : r.detail,
      onclick: r.key ? `openEntityByKey(${xj(r.key)})` : '' })) });
  }
  // Procress 16 B6: files whose source is gone — was the Import Dock's job.
  // Opening Problems is an explicit check, so stat the files again (a file
  // moved away mid-session) — straight to the list, no re-render loop.
  try { await api.importdock.sweep(S.nexus.id); } catch (_) { /* stale flags at worst */ }
  if (typeof loadImportFiles === 'function') await loadImportFiles();
  const missing = (S.importFiles || []).filter(f => f.missing);
  if (missing.length) {
    groups.push({ id: 'missing', title: t('probMissing'), count: missing.length, items: [
      ...missing.map(f => ({ icon: I.folder || '', title: f.file_name, meta: f.file_path || '', tip: t('assetRelink'), onclick: `relinkImportFile(${f.id})` })),
      { icon: I.folder || '', title: t('assetRelinkFolder'), onclick: `runCommand('dock.relinkFolder')`, attrs: 'data-cmd="dock.relinkFolder"', cmd: true },
    ] });
  }
  // Procress 20: the Nexus's folder — out of reach (its drive is gone), or
  // asset files a Nexus from before then still keeps outside it.
  const ls = typeof hasLocate === 'function' && hasLocate() ? await api.nexus.locateStatus(S.nexus.id).catch(() => null) : null;
  if (ls && (ls.driveGone || ls.outside)) {
    groups.push({ id: 'locate', title: t('probLocate'), items: [
      ...(ls.driveGone ? [{ icon: I.folder || '', title: t('nexusLocalFolderDriveGone'), meta: ls.dir || '', onclick: 'moveNexusLocate(S.nexus.id)', cmd: true }] : []),
      ...(ls.outside ? [{ icon: I.import || '', title: t('locateGather'), meta: t('locateOutside').replace('{n}', ls.outside), onclick: `gatherNexusAssets(S.nexus.id, ${Number(ls.outside)})`, cmd: true }] : []),
    ] });
  }
  const s = listRegister('problems', problemsBodyHtml);
  s.groups = groups;
  const body = problemsBodyHtml();
  box.innerHTML = listHtml({ list: 'problems', aria: t('probTitle'), body,
    head: groups.length ? listHeadHtml({ list: 'problems', count: s.shownCount }) : '' });
}

function problemRowHtml(it) {
  return listRowHtml({ icon: it.icon, title: it.title, meta: it.meta, onclick: it.onclick, tip: it.tip ?? null,
    attrs: `${it.attrs || ''}${it.cmd ? '' : ' data-no-i18n'}` });
}

function problemsBodyHtml() {
  const s = listState('problems');
  const groups = s.groups || [];
  if (!groups.length) { s.shownCount = 0; return emptyStateHtml({ icon: I.check, text: t('probNone') }); }
  let n = 0;
  const html = groups.map((g) => {
    const items = listView('problems', g.items, { name: (it) => it.title, text: (it) => [it.title, it.meta] });
    n += items.length;
    if (!items.length) return '';
    const rows = listRowsHtml('problems', items, problemRowHtml, { key: g.id });
    return g.title ? listGroupHtml({ list: 'problems', id: g.id, title: g.title, count: g.count != null ? items.length : null, rows }) : rows;
  }).join('');
  s.shownCount = n;
  return n ? html : emptyStateHtml({ icon: I.search, text: t('listNoMatch') });
}

function openProblemsPanel() {
  S.leftTool = 'problems';
  showLeftDest('tools');
}
