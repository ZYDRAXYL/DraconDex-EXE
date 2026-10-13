'use strict';
// ═══ VERSION HISTORY PANEL (progress.md Phase 21) ══════════════════════
// Opens in the side panel (v5 Part 8, page/side-panel.js) (mockup 26):
// `v{seq} — {action}` rows with a detail line, relative time, the latest
// tagged as current, and ↩ Restore per row. Restore re-applies the
// recorded before-state through db/versions.js and lands as a NEW
// version — history is never overwritten. Retention (default 50/module)
// is a Settings number input (Phase 22) stored in app_setting.

// Action code -> localized label (codes are stored in the DB; labels
// resolve at render time so history follows the UI language).
const VERSION_ACTION_KEY = {
  attr: 'vActAttr', attrDel: 'vActAttrDel', object: 'vActObject',
  objectDel: 'vActObjectDel', objectEdit: 'vActObjectEdit',
  template: 'vActTemplate', note: 'vActNote', tags: 'vActTags',
  chapter: 'vActChapter', chapterName: 'vActChapterName', restore: 'vActRestore',
  block: 'vActBlock', blockDel: 'vActBlockDel',
};
const versionActionLabel = (a) => t(VERSION_ACTION_KEY[a] || '') || a;

function versionRelTime(createAt) {
  const dt = new Date(String(createAt).replace(' ', 'T') + 'Z');
  if (isNaN(dt)) return '';
  const mins = Math.max(0, Math.round((Date.now() - dt.getTime()) / 60000));
  if (mins < 60) return `${mins} ${t('vMinAgo')}`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} ${t('vHourAgo')}`;
  return dt.toLocaleDateString();
}

// v5 Part 8 (§12.8): opens in the side panel (page/side-panel.js), which
// follows the page — switching modules shows the new module's history.
async function openVersionPanel(moduleId) {
  const [rows, limitRaw] = await Promise.all([
    api.versions.list(moduleId),
    api.setting.get('versionLimit'),
  ]);
  const limit = Number(limitRaw) >= 1 ? Number(limitRaw) : 50;
  openSidePanel({ kind: 'versions', moduleId, rows, limit });
}

function toggleVersionPanel(moduleId) {
  if (sidePanelOpen('versions')) closeSidePanel(); else openVersionPanel(moduleId);
}

const closeVersionPanel = () => closeSidePanel();

// Procress 21: the shared list (core/list.js) — grouped by day (today /
// this week / older), the latest marked current, Restore at the row's end.
function versionRowHtml(v, latest) {
  return listRowHtml({
    title: `v${v.seq} — ${versionActionLabel(v.action)}`,
    meta: [v.detail, versionRelTime(v.create_at)].filter(Boolean).join(' · '),
    state: { current: latest }, attrs: 'data-no-i18n',
    trailing: latest ? `<span class="ls-chip ls-on">${x(t('vCurrent'))}</span>` : '',
    actions: latest ? '' : listActHtml({ icon: I.return, name: t('trashRestore'), text: true, key: 'Enter', onclick: `restoreVersionRow(${v.id})` }),
  });
}

function buildVersionListHtml(d) {
  const latest = d.rows[0];
  const body = d.rows.length
    ? listByDate(d.rows, (v) => v.create_at).map(([id, title, group]) => listGroupHtml({ list: 'versions', id, title, count: group.length,
      rows: listRowsHtml('versions', group, (v) => versionRowHtml(v, v === latest), { key: id }) })).join('')
    : emptyStateHtml({ icon: I.timeline, text: t('vEmpty') });
  return `<div class="vh-list">${listHtml({ list: 'versions', aria: t('versionHistory'), body })}</div>
    <div class="vh-foot">${t('vFootNote')}</div>`;
}

async function restoreVersionRow(id) {
  const d = S.side;
  if (d?.kind !== 'versions') return;
  const res = await api.versions.restore(id);
  if (!res?.ok) { toast(t('vRestoreFailed'), 'error'); return; }
  toast(t('vRestored'), 'ok');
  // reload module data + refreshed history
  await openModuleNode(d.moduleId);
  await openVersionPanel(d.moduleId);
}
