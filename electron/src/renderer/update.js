'use strict';
// Checks this repo's latest GitHub Release via src/db/update.js's
// api.update.check() and shows a modal when a newer version exists. Install
// downloads + verifies + runs it in-app (api.update.install); builds that
// can't self-install (portable folder, dev) open the release page instead.
// Plan process1 part2 #1: no longer gated behind a Cloud Sync/Drive login
// (see src/db/update.js) — instead gated behind the app_setting-backed
// "auto-check" toggle on the new Setting → appdata → Versions page below.

// Cached result of the most recent check (boot's auto-check, or an explicit
// click on the Setting page's "Check version" button) — shared between the
// modal, the Versions page and the title-bar indicator so none of them has
// to hit the network just to read the current state.
let _lastCheckResult = null;
let _lastAutoCheck = null;
let _updateMode = null;
const _askedReady = new Set(); // "Later" = ask again next launch, not again this session

// Procress 29 part 9: the main process checks, downloads and verifies by
// itself (src/db/update.js scheduleUpdateChecks) and tells every window its
// state; this side only shows it — the title-bar indicator, and ONE prompt
// when a verified update is ready ("Install and restart" / "Later").
async function initVersionCheck() {
  if (S.isPopup) return; // the main window shows it; a popup must not duplicate the prompt
  api.update.onState(onUpdateState);
  try { onUpdateState(await api.update.state()); } catch (_) { /* no update data — nothing to show */ }
  try {
    const j = await api.update.justUpdated();
    if (j) toastAction(t('updateDone').replace('{v}', j.to), t('updateWhatsNew'), () => api.update.openDownload(j.url), 'ok', 12000);
  } catch (_) { /* first run, or no setting store */ }
}

function onUpdateState(st) {
  if (!st) return;
  _updateMode = st.mode;
  _lastAutoCheck = st.mode !== 'off';
  _lastCheckResult = st.available ? { ...st, ok: true } : (_lastCheckResult?.available ? _lastCheckResult : { ok: true, available: false, current: st.current });
  updateTitlebarIndicator();
  const body = q('#setting-versions-body');
  if (body) body.innerHTML = settingVersionsBodyHtml();
  // a quiet install on quit needs no prompt — unless releases are not signed yet
  const quiet = st.mode === 'quit' && st.signed;
  if (st.ready && !quiet && st.mode !== 'off' && !_askedReady.has(st.version)) { _askedReady.add(st.version); showUpdateReadyModal(st); }
}

// silent:true never pops a modal — the Versions page's own "Check version"
// button shows the result inline. A check that finds an update starts its
// download at once (the ask / quit modes), like the background check does.
async function runVersionCheck({ silent = false } = {}) {
  let r;
  try { r = await api.update.check(); } catch (_) { return null; } // never surface a check failure to the user
  _lastCheckResult = r?.ok ? r : null;
  updateTitlebarIndicator();
  if (_lastCheckResult?.available && ['ask', 'quit'].includes(_updateMode) && r.canInstall) api.update.download();
  else if (_lastCheckResult?.available && !_lastCheckResult.dismissed && !silent) showUpdateModal(_lastCheckResult);
  return _lastCheckResult;
}

function updateTitlebarIndicator() {
  const b = q('#titlebar-update-btn');
  if (!b) return;
  b.classList.toggle('hidden', !_lastCheckResult?.available);
  b.classList.toggle('update-ready', !!_lastCheckResult?.ready);
}

// The title-bar arrow: a ready update asks to install; otherwise the Versions page.
function titlebarUpdateClick() {
  if (_lastCheckResult?.ready) showUpdateReadyModal(_lastCheckResult);
  else openSettingWindow('appdata', 'versions');
}

// Downloaded and verified: the only question left is when.
function showUpdateReadyModal(st) {
  openModal(t('updateReadyTitle'), `
    <div class="modal-hint">${I.info}<span>${t('updateReadyHint').replace('{v}', x(st.version))}</span></div>
    ${st.notes ? `<div class="modal-hint"><span>${x(st.notes)}</span></div>` : ''}
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('updateLater')}</button>
      <button class="btn btn-p" id="update-install-btn" onclick="updateDownloadClick()">${t('updateInstallRestart')}</button>
    </div>
    <div class="modal-hint" id="update-progress" hidden></div>
  `);
}

// `version`/`notes`/`url` come off the network, so they are never interpolated
// into the inline handlers below — the release is parked in _lastCheckResult
// and the buttons take no arguments at all. (Putting remote text inside
// onclick="f('...')" was a live injection: the shared escaper leaves `'`
// alone, so a quote in the value closed the JS string literal and the rest
// ran in this renderer, which holds the whole window.api surface.) The two
// text-context interpolations below still go through x().
function showUpdateModal(r) {
  openModal(t('updateAvailableTitle'), `
    <div class="modal-hint">${I.info}<span>${t('updateAvailableHint')} ${x(r.version)}</span></div>
    ${r.notes ? `<div class="modal-hint"><span>${x(r.notes)}</span></div>` : ''}
    <div class="mfoot">
      <button class="btn btn-s" onclick="updateRemindLaterClick()">${t('updateRemindLater')}</button>
      <button class="btn btn-p" id="update-install-btn" onclick="updateDownloadClick()">${t(r.canInstall ? 'updateInstallBtn' : 'updateDownload')}</button>
    </div>
    <div class="modal-hint" id="update-progress" hidden></div>
  `);
}

async function updateDownloadClick() {
  const r = _lastCheckResult;
  if (!r?.available) return;
  if (!r.canInstall) return api.update.openDownload(r.url);
  const btns = ['#update-install-btn', '#setting-versions-install-btn'];
  btns.forEach((b) => syncBtnBusy(b, true));
  const off = api.update.onProgress((p) => {
    const el = q('#update-progress');
    if (!el) return;
    el.hidden = false;
    el.textContent = p >= 0 ? `${t('updateDownloading')} ${Math.round(p * 100)}%` : t('updateDownloading');
  });
  let res;
  try { res = await api.update.install(); } catch (_) { res = null; } finally { off(); }
  // main quits in a moment, the Setup installs silently and starts the new
  // version (Procress 28 part 7) — say so, or the window just vanishes
  if (res?.ok) { toast(t('updateRestarting'), 'ok'); const pe = q('#update-progress'); if (pe) { pe.hidden = false; pe.textContent = t('updateRestarting'); } return; }
  btns.forEach((b) => syncBtnBusy(b, false));
  const pe = q('#update-progress');
  if (pe) pe.hidden = true;
  toast(`${t('updateInstallFailed')}${res?.error ? `: ${res.error}` : ''}`, 'error');
}
function updateRemindLaterClick() {
  if (_lastCheckResult?.available) api.update.dismiss(_lastCheckResult.version);
  closeModal();
}

// ═══ Setting → appdata → Versions page (Plan process1 part2 #1) ═════════
function settingVersionsPageHtml() {
  settingRefreshVersionsSection();
  return `<div class="settings-label">${t('settingPageVersions')}</div><div id="setting-versions-body">${t('syncWorking')}</div>`;
}
async function settingRefreshVersionsSection() {
  _updateMode = await api.update.getMode();
  _lastAutoCheck = _updateMode !== 'off';
  const el = q('#setting-versions-body');
  if (!el) return; // window closed or switched page before this resolved
  el.innerHTML = settingVersionsBodyHtml();
}
function settingVersionsBodyHtml() {
  const r = _lastCheckResult;
  const currentLineHtml = r ? `<div class="sync-status-row"><span>${t('updateCurrentVersion')}</span><b data-no-i18n>${x(r.current || '')}</b></div>` : '';
  const statusHtml = !r
    ? `<div class="modal-hint">${I.info}<span>${t('updateNotCheckedYet')}</span></div>`
    : r.available
      ? `<div class="modal-hint">${I.info}<span>${r.ready ? t('updateReadyHint').replace('{v}', x(r.version)) : `${t(r.downloading ? 'updateDownloading' : 'updateAvailableHint')} ${x(r.version)}`}</span></div>${r.notes ? `<div class="modal-hint"><span>${x(r.notes)}</span></div>` : ''}${currentLineHtml}`
      : `<div class="modal-hint">${I.info}<span>${t('updateUpToDate')}</span></div>${currentLineHtml}`;
  return `
    ${statusHtml}
    <div class="mfoot">
      <button class="btn btn-s" id="setting-versions-check-btn" onclick="settingVersionsCheckClick()">${t('updateCheckBtn')}</button>
      <button class="btn btn-p" id="setting-versions-install-btn" onclick="updateDownloadClick()"${r?.available ? '' : ' style="display:none"'}>${t(r?.canInstall === false ? 'updateDownload' : r?.ready ? 'updateInstallRestart' : 'updateInstallBtn')}</button>
    </div>
    <div class="modal-hint" id="update-progress" hidden></div>
    <div class="settings-label" style="margin-top:14px">${t('updateMode')}</div>
    ${segmentedHtml(['ask', 'quit', 'notify', 'off'].map((m) => ({ value: m, text: t(`updateMode${m[0].toUpperCase()}${m.slice(1)}`) })), _updateMode || (_lastAutoCheck === false ? 'off' : 'ask'),
      { size: 'sm', aria: t('updateMode'), onclick: (m) => `settingVersionsMode('${m}')` })}
    ${_updateMode === 'quit' && r && r.signed === false ? `<div class="drafter-hint">${t('updateModeQuitUnsigned')}</div>` : ''}
    <div class="setting-credit" data-no-i18n>DraconDex · Created by LDKTC</div>`;
}
async function settingVersionsCheckClick() {
  syncBtnBusy('#setting-versions-check-btn', true);
  const r = await runVersionCheck({ silent: true });
  syncBtnBusy('#setting-versions-check-btn', false);
  const el = q('#setting-versions-body');
  if (el) el.innerHTML = settingVersionsBodyHtml();
  if (!r) return toast(t('updateCheckFailed'), 'error');
  toast(r.available ? `${t('updateAvailableHint')} ${r.version}` : t('updateUpToDate'), 'ok');
}
async function settingVersionsMode(mode) {
  _updateMode = mode;
  _lastAutoCheck = mode !== 'off';
  await api.update.setMode(mode);
  try { onUpdateState(await api.update.state()); } catch (_) { /* keeps the page as it is */ }
  toast(t('applied'), 'ok');
}
registerSettingPage('appdata', 'versions', settingVersionsPageHtml);
