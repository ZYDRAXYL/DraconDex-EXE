'use strict';
// ═══ Trash panel (v5 Part 7, APP docs/V5.md §11.4) ══════════════════════
// Where a deleted module waits (db/trash.js). Restore puts it back under its
// old folder — at the top level if that folder is gone — with every relation
// that touched it. Its version history does not come back, and the panel
// says so. "Empty trash" and "Delete forever" are the only confirms: they
// are the steps that cannot be undone.

// One trash list, shared by the modal (a toast's link) and the Activity
// Bar's trash destination (hub/activity.js). Procress 21: the shared list
// (core/list.js) — grouped by when it was deleted (today / this week /
// older), Restore and Delete forever at the end of the row, a filter on top.
function trashRowHtml(r) {
  const meta = [kindLabel(r.kind), r.module_count > 1 ? String(r.module_count) : '', r.parent_name || '', String(r.deleted_at || '').slice(0, 16)]
    .filter(Boolean).join(' · ');
  return listRowHtml({
    icon: `<span style="color:${x(KIND_COLOR[r.kind] || 'var(--t3-aa,var(--t2))')}">${I[KIND_ICON[r.kind]] || ''}</span>`,
    title: r.name, meta, attrs: `data-trash="${r.id}" data-no-i18n`,
    actions: listActHtml({ name: t('trashRestore'), text: true, key: 'Enter', onclick: `restoreTrashItem(${r.id})` })
      + listActHtml({ icon: I.delete, name: t('trashDeleteForever'), danger: true, key: 'Delete', onclick: `deleteTrashItem(${r.id})` }),
  });
}

function trashBodyHtml() {
  const all = listState('trash').rows || [];
  const rows = listView('trash', all, { text: (r) => [r.name, kindLabel(r.kind), r.parent_name] });
  if (!all.length) return emptyStateHtml({ icon: I.delete, text: t('trashEmpty') });
  if (!rows.length) return emptyStateHtml({ icon: I.search, text: t('listNoMatch') });
  return listByDate(rows, (r) => r.deleted_at).map(([id, title, group]) =>
    listGroupHtml({ list: 'trash', id, title, count: group.length, rows: listRowsHtml('trash', group, trashRowHtml, { key: id }) })).join('');
}

function trashRowsHtml(rows) {
  const s = listRegister('trash', trashBodyHtml);
  s.rows = rows;
  const body = trashBodyHtml();
  return listHtml({ list: 'trash', aria: t('trashTitle'), cls: 'trash-list', body,
    head: rows.length ? listHeadHtml({ list: 'trash', count: s.shownCount }) : '' });
}

async function openTrashPanel() {
  if (!S.nexus) return;
  const rows = await api.trash.list(S.nexus.id);
  openModal(t('trashTitle'), `
    <p class="sync-hint">${t('trashHint')}</p>
    ${trashRowsHtml(rows)}
    <div class="mfoot">
      ${rows.length ? `<button class="btn btn-d" onclick="emptyTrashNow()">${t('trashEmptyAll')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('close')}</button>
    </div>`);
}

// Whichever trash list is showing — the modal, the left panel, or both.
async function refreshTrashViews() {
  if (q('#modal-overlay:not(.hidden) #modal-body .trash-list')) await openTrashPanel();
  if (q('#left-trash')) await fillLeftTrash();
}

async function restoreTrashItem(id) {
  const r = await api.trash.restore(S.nexus.id, id);
  if (!r?.ok) { toast(t('driveErrServer'), 'err'); return; }
  await reloadModuleTree();
  await refreshTrashViews(); // a list was open (modal or left panel), not just the toast
  toastSnapshotResult(r, 'trashRestored');
  if (r.moduleId != null) { focusModuleInNest(r.moduleId); renderNexusHome(); }
}

async function deleteTrashItem(id) {
  if (!await uiConfirm(t('trashDeleteConfirm'))) return;
  await api.trash.delete(S.nexus.id, id);
  await refreshTrashViews();
}

async function emptyTrashNow() {
  if (!await uiConfirm(t('trashEmptyConfirm'))) return;
  await api.trash.empty(S.nexus.id);
  await refreshTrashViews();
  toast(t('deleted'), 'ok');
}
