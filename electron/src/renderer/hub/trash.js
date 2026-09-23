'use strict';
// ═══ Trash panel (v5 Part 7, APP docs/V5.md §11.4) ══════════════════════
// Where a deleted module waits (db/trash.js). Restore puts it back under its
// old folder — at the top level if that folder is gone — with every relation
// that touched it. Its version history does not come back, and the panel
// says so. "Empty trash" and "Delete forever" are the only confirms: they
// are the steps that cannot be undone.

async function openTrashPanel() {
  if (!S.nexus) return;
  const rows = await api.trash.list(S.nexus.id);
  openModal(t('trashTitle'), `
    <p class="sync-hint">${t('trashHint')}</p>
    ${rows.length ? `<div class="objlist trash-list">${rows.map(r => `
      <div class="li">
        <span class="kicon" style="color:${x(KIND_COLOR[r.kind] || 'var(--t3)')}">${I[KIND_ICON[r.kind]] || ''}</span>
        <span class="name" data-no-i18n>${x(r.name)}</span>
        <span class="drafter-hint" data-no-i18n>${x(kindLabel(r.kind))}${r.module_count > 1 ? ` · ${r.module_count}` : ''}${r.parent_name ? ` · ${x(r.parent_name)}` : ''} · ${x(String(r.deleted_at || '').slice(0, 16))}</span>
        <span class="acts">
          <button class="btn btn-s btn-sm" onclick="restoreTrashItem(${r.id})">${t('trashRestore')}</button>
          <button class="btn btn-g btn-i" onclick="deleteTrashItem(${r.id})" title="${x(t('trashDeleteForever'))}">${I.delete}</button>
        </span>
      </div>`).join('')}</div>` : `<div class="empty"><p>${t('trashEmpty')}</p></div>`}
    <div class="mfoot">
      ${rows.length ? `<button class="btn btn-d" onclick="emptyTrashNow()">${t('trashEmptyAll')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('close')}</button>
    </div>`);
}

async function restoreTrashItem(id) {
  const r = await api.trash.restore(S.nexus.id, id);
  if (!r?.ok) { toast(t('driveErrServer'), 'err'); return; }
  await reloadModuleTree();
  if (document.querySelector('.trash-list')) await openTrashPanel(); // opened from the panel, not the toast
  toastSnapshotResult(r, 'trashRestored');
  if (r.moduleId != null) { focusModuleInNest(r.moduleId); renderNexusHome(); }
}

async function deleteTrashItem(id) {
  if (!await uiConfirm(t('trashDeleteConfirm'))) return;
  await api.trash.delete(S.nexus.id, id);
  await openTrashPanel();
}

async function emptyTrashNow() {
  if (!await uiConfirm(t('trashEmptyConfirm'))) return;
  await api.trash.empty(S.nexus.id);
  await openTrashPanel();
  toast(t('deleted'), 'ok');
}
