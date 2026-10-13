'use strict';
// ═══ Locate Nexus — the folder mirror, renderer side (v5 Part 4, §8.5–§8.6)
// Since Procress 20 every Nexus IS a folder — main makes it (db/locate.js)
// at create, or the first time a Nexus from before then opens; nothing here
// asks the user to pick one. This file draws the Nexus modal's "Local
// folder" row (where · open · move), the Nest's notice when the folder's
// drive is gone, the delete-time "trash the folder too?" question, and
// decides when a sync runs. Main does the work (main.js syncLocate →
// db/mirror.js). EXE only: in the PWA build the preload has no locate calls,
// so none of this renders.
//
// When the mirror syncs:
//   - once in the background after a Nexus opens ('open': a full check)
//   - when the window comes back to the front ('focus') and after the tree
//     changes ('tree') — both cheap: main walks the folder only when its
//     watcher saw something, and mirrors only the modules that changed
//   - ~2 s after any write, by main itself, without a call from here
// The .ddx is the truth either way (§8.1).

const hasLocate = () => typeof api.nexus?.locateOpen === 'function';
const nexusRow = (id) => S.nexuses?.find(v => v.id === id) || null;

function nexusLocateRowHtml(n) {
  if (!hasLocate()) return '';
  const dir = n.locate_dir || '';
  return `
    <div class="fg${n.locate_missing ? ' nx-locate-missing' : ''}">
      <label>${t('nexusLocalFolder')}</label>
      <div class="sync-hint">${t('nexusLocalFolderHint')}</div>
      <div class="sync-key-row">
        <input readonly value="${x(dir)}" title="${x(dir)}" data-no-i18n>
        ${dir && !n.locate_missing ? `<button class="btn btn-g btn-sm" onclick="api.nexus.locateOpen(${n.id})">${t('nexusLocalFolderOpen')}</button>` : ''}
        <button class="btn btn-s btn-sm" onclick="moveNexusLocate(${n.id}, true)">${t('nexusLocalFolderMove')}</button>
      </div>
      ${n.locate_missing ? `<div class="sync-hint">${t('nexusLocalFolderDriveGone')}</div>` : ''}
    </div>`;
}

// The Nest's own line when the folder is out of reach (a USB drive pulled
// out): the Nexus still works — the .ddx is the truth — but new files have
// nowhere to go until the drive is back or the folder moves.
function nestLocateWarnHtml() {
  if (!hasLocate() || !S.nexus?.locate_missing) return '';
  return `<div class="nest-locate-warn" role="status"><span>${t('nexusLocalFolderDriveGone')}</span>
    <button class="btn btn-g btn-sm" onclick="moveNexusLocate(S.nexus.id)">${t('nexusLocalFolderMove')}</button></div>`;
}

function reportLocateSync(r, quiet) {
  if (!r || r.canceled) return;
  if (!r.ok) {
    if (!quiet) toast(t(r.driveGone ? 'nexusLocalFolderDriveGone' : 'driveErrServer'), 'err');
    return;
  }
  // A Nexus from before Procress 20, opened for the first time: told once —
  // the folder is made once.
  if (r.created) {
    toastAction(t('nexusLocalFolderCreated').replace('{dir}', r.dir || ''), t('nexusLocalFolderOpen'), () => api.nexus.locateOpen(S.nexus?.id), 'ok', 9000);
    return;
  }
  if (r.recreated) { toast(t('nexusLocalFolderRecreated'), 'warn'); return; }
  if (quiet && !r.imported?.collectors && !r.imported?.added) return;
  toast(`${t('nexusLocalFolderSynced')} ${r.files} · ${r.dirs}`, 'ok');
}

async function syncNexusLocate(id, quiet = false, reason = 'manual') {
  const r = await api.nexus.locateSync(id, { reason });
  reportLocateSync(r, quiet);
  // The folder was made, made again, or found out of reach: the registry
  // row changed — refresh it, and the Nest header that shows its state.
  const wasMissing = !!S.nexus?.locate_missing;
  const nowMissing = r?.ok === false && !!r.driveGone;
  if (r?.created || r?.recreated || wasMissing !== nowMissing) {
    await reloadNexuses();
    if (S.nexus?.id === id && leftDest() === 'nest') renderLeftPanel();
  }
  // The folder side may have brought collectors / assets in.
  if (r?.imported && (r.imported.collectors || r.imported.added)) await reloadModuleTree({ skipMirror: true });
  return r;
}

// "Move folder…" — from the Nexus modal (reopened after), the Nest notice
// or Problems. Main asks where, moves the folder with everything in it.
async function moveNexusLocate(id, fromModal = false) {
  const r = await api.nexus.locateMove(id);
  if (!r || r.canceled) return;
  if (!r.ok) { toast(t('driveErrServer'), 'error'); return; }
  toast(t('nexusLocalFolderMoved').replace('{dir}', r.dir || ''), 'ok');
  await reloadNexuses();
  if (r.imported && (r.imported.collectors || r.imported.added)) await reloadModuleTree({ skipMirror: true });
  if (fromModal) openNexusModal(id);
  else if (S.nexus?.id === id && leftDest() === 'nest') renderLeftPanel();
  if (S.leftTool === 'problems' && typeof loadProblemsPanel === 'function') loadProblemsPanel();
}

// Asset files a Nexus from before Procress 20 keeps outside its folder are
// left where they are until the user asks: this COPIES them in.
async function gatherNexusAssets(id, n) {
  if (!await uiConfirm(t('locateGatherConfirm').replace('{n}', n), { okText: t('locateGather'), danger: false })) return;
  const r = await api.nexus.locateGather(id);
  if (!r?.ok) { toast(t('driveErrServer'), 'error'); return; }
  S.importFiles = undefined;
  toast(t('locateGathered').replace('{n}', r.copied), r.failed ? 'warn' : 'ok');
  if (S.leftTool === 'problems' && typeof loadProblemsPanel === 'function') loadProblemsPanel();
  if (typeof settingRefreshLocateSection === 'function') settingRefreshLocateSection();
}

// After a Nexus is deleted: its folder may hold the user's own files, so it
// stays unless they say otherwise — "Keep" is the default (Enter / Esc).
async function offerTrashNexusFolder(dir) {
  if (!dir || !hasLocate()) return;
  const yes = await uiConfirm(t('nexusDeleteTrashFolder').replace('{dir}', dir),
    { okText: t('nexusDeleteTrashYes'), cancelText: t('nexusDeleteKeepFolder'), danger: true, defaultCancel: true });
  if (!yes) return;
  const r = await api.nexus.trashLocate(dir);
  toast(r?.ok ? t('nexusDeleteTrashed') : t('driveErrServer'), r?.ok ? 'ok' : 'error');
}

// One timer per window. A pending 'open' (the full check) is never
// downgraded by a focus or tree change landing before it fires.
let _mirrorTimer = null;
let _mirrorReason = null;
function scheduleMirrorSync(delay = 2000, reason = 'tree') {
  if (!hasLocate() || !S.nexus) return;
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
