'use strict';
// ═══ Locate Nexus — the folder mirror, renderer side (v5 Part 4, §8.5–§8.6)
// The Nexus modal's "Local folder" row, and the syncs that keep the mirror
// current. Main does the work (main.js syncLocate → db/mirror.js); this file
// only decides when to ask. EXE only: in the PWA build the preload has no
// locate calls, so the row simply does not render.
//
// When the mirror syncs:
//   - when the folder is picked, and from the row's Sync button
//   - once in the background after a Nexus opens ('open': a full check)
//   - when the window comes back to the front ('focus') and after the tree
//     changes ('tree') — both cheap since Procress 20 part 1: main walks the
//     folder only when its watcher saw something, and mirrors only the
//     modules that changed
//   - ~2 s after any write, by main itself, without a call from here
// The .ddx is the truth either way (§8.1).

const hasLocate = () => typeof api.nexus?.locatePick === 'function';
const nexusRow = (id) => S.nexuses?.find(v => v.id === id) || null;

function nexusLocateRowHtml(n) {
  if (!hasLocate()) return '';
  const dir = n.locate_dir;
  return `
    <div class="fg${n.locate_missing ? ' nx-locate-missing' : ''}">
      <label>${t('nexusLocalFolder')}</label>
      <div class="sync-hint">${t('nexusLocalFolderHint')}</div>
      <div class="sync-key-row">
        <input readonly value="${x(dir || '')}" title="${x(dir || '')}" placeholder="${x(t('nexusLocalFolderNone'))}" data-no-i18n>
        <button class="btn btn-s btn-sm" onclick="pickNexusLocate(${n.id})">${dir ? t('nexusLocate') : t('nexusLocalFolderPick')}</button>
        ${dir && !n.locate_missing ? `
          <button class="btn btn-g btn-sm" onclick="syncNexusLocate(${n.id})">${t('nexusLocalFolderSync')}</button>
          <button class="btn btn-g btn-sm" onclick="api.nexus.locateOpen(${n.id})">${t('nexusLocalFolderOpen')}</button>` : ''}
        ${dir ? `<button class="btn btn-g btn-sm" onclick="forgetNexusLocate(${n.id})">${t('nexusLocalFolderForget')}</button>` : ''}
      </div>
      ${n.locate_missing ? `<div class="sync-hint">${t('nexusLocalFolderMissing')}</div>` : ''}
    </div>`;
}

function reportLocateSync(r, quiet) {
  if (!r || r.canceled) return;
  if (!r.ok) {
    if (!quiet) toast(t(r.code === 'missing' ? 'nexusLocalFolderMissing' : 'nexusLocalFolderNone'), 'err');
    return;
  }
  if (quiet && !r.imported?.collectors && !r.imported?.added) return;
  toast(`${t('nexusLocalFolderSynced')} ${r.files} · ${r.dirs}`, 'ok');
}

async function pickNexusLocate(id) {
  const r = await api.nexus.locatePick(id);
  if (!r || r.canceled) return;
  reportLocateSync(r, false);
  await afterLocateChange(id, r);
}

async function syncNexusLocate(id, quiet = false, reason = 'manual') {
  const r = await api.nexus.locateSync(id, { reason });
  reportLocateSync(r, quiet);
  // The folder side may have brought collectors / assets in.
  if (r?.imported && (r.imported.collectors || r.imported.added)) await reloadModuleTree({ skipMirror: true });
  return r;
}

async function forgetNexusLocate(id) {
  if (!await uiConfirm(t('nexusLocalFolderForgetConfirm'))) return;
  await api.nexus.locateForget(id);
  await afterLocateChange(id, null);
}

async function afterLocateChange(id, r) {
  await reloadNexuses();
  if (S.nexus?.id === id) S.nexus = nexusRow(id) || S.nexus;
  if (r?.imported && (r.imported.collectors || r.imported.added)) await reloadModuleTree({ skipMirror: true });
  openNexusModal(id); // every caller is a button in this modal — redraw it
}

// One timer per window. A pending 'open' (the full check) is never
// downgraded by a focus or tree change landing before it fires.
let _mirrorTimer = null;
let _mirrorReason = null;
function scheduleMirrorSync(delay = 2000, reason = 'tree') {
  if (!hasLocate() || !S.nexus?.locate_dir || S.nexus.locate_missing) return;
  clearTimeout(_mirrorTimer);
  if (_mirrorReason !== 'open') _mirrorReason = reason;
  const id = S.nexus.id;
  _mirrorTimer = setTimeout(() => {
    const why = _mirrorReason;
    _mirrorReason = null;
    if (S.nexus?.id === id) syncNexusLocate(id, true, why);
  }, delay);
}

// Procress 16 part 2 (Suggestion.md): files the user puts into the project
// folder from Explorer show up in the Nest — the Locate sync runs again when
// the window comes back to the front, not only when the vault opens.
window.addEventListener('focus', () => scheduleMirrorSync(400, 'focus'));
