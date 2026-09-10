'use strict';
// Read-only: checks this repo's latest GitHub Release via src/db/update.js's
// api.update.check() and shows a modal with a download link when a newer
// version exists. Not an auto-updater.
// Plan process1 part2 #1: no longer gated behind a Cloud Sync/Drive login
// (see src/db/update.js) — instead gated behind the app_setting-backed
// "auto-check" toggle on the new Setting → appdata → Versions page below.

// Cached result of the most recent check (boot's auto-check, or an explicit
// click on the Setting page's "Check version" button) — shared between the
// modal, the Versions page and the title-bar indicator so none of them has
// to hit the network just to read the current state.
let _lastCheckResult = null;
let _lastAutoCheck = null;

async function initVersionCheck() {
  if (S.isPopup) return; // one check per app session — a popup must not duplicate the modal/indicator
  let auto;
  try { auto = await api.update.getAutoCheck(); } catch (_) { return; }
  _lastAutoCheck = auto;
  if (!auto) return;
  await runVersionCheck(); // same as before: pop the modal if an undismissed update is found
}

// silent:true still updates _lastCheckResult / the title-bar indicator /
// the Versions page, but never pops the interruptive modal — used only by
// the Versions page's own "Check version" button, where a modal popping up
// over the very page whose button was just clicked would be redundant (the
// page already shows the same result inline). The boot-time auto-check
// keeps showing the modal, same as before this feature lost its login gate.
async function runVersionCheck({ silent = false } = {}) {
  let r;
  try { r = await api.update.check(); } catch (_) { return null; } // never surface a check failure to the user
  _lastCheckResult = r?.ok ? r : null;
  updateTitlebarIndicator();
  if (_lastCheckResult?.available && !_lastCheckResult.dismissed && !silent) showUpdateModal(_lastCheckResult);
  return _lastCheckResult;
}

function updateTitlebarIndicator() {
  q('#titlebar-update-btn')?.classList.toggle('hidden', !_lastCheckResult?.available);
}

// `version`/`notes`/`url` come off the network, so they are never interpolated
// into the inline handlers below — the release is parked in _lastCheckResult
// and the buttons take no arguments at all. (Putting remote text inside
// onclick="f('...')" was a live injection: the shared escaper leaves `'`
// alone, so a quote in the value closed the JS string literal and the rest
// ran in this renderer, which holds the whole window.api surface.) The two
// text-context interpolations below still go through x().
function showUpdateModal(r) {
  openModal(`☁ ${t('updateAvailableTitle')}`, `
    <div class="modal-hint">${I.info}<span>${t('updateAvailableHint')} ${x(r.version)}</span></div>
    ${r.notes ? `<div class="modal-hint"><span>${x(r.notes)}</span></div>` : ''}
    <div class="mfoot">
      <button class="btn btn-s" onclick="updateRemindLaterClick()">${t('updateRemindLater')}</button>
      <button class="btn btn-p" onclick="updateDownloadClick()">${t('updateDownload')}</button>
    </div>
  `);
}

function updateDownloadClick() {
  if (_lastCheckResult?.available) api.update.openDownload(_lastCheckResult.url);
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
  _lastAutoCheck = await api.update.getAutoCheck();
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
      ? `<div class="modal-hint">${I.info}<span>${t('updateAvailableHint')} ${x(r.version)}</span></div>${r.notes ? `<div class="modal-hint"><span>${x(r.notes)}</span></div>` : ''}${currentLineHtml}`
      : `<div class="modal-hint">${I.info}<span>${t('updateUpToDate')}</span></div>${currentLineHtml}`;
  return `
    ${statusHtml}
    <div class="mfoot">
      <button class="btn btn-s" id="setting-versions-check-btn" onclick="settingVersionsCheckClick()">${t('updateCheckBtn')}</button>
      <button class="btn btn-p" id="setting-versions-install-btn" onclick="updateDownloadClick()"${r?.available ? '' : ' style="display:none"'}>${t('updateInstallBtn')}</button>
    </div>
    <label style="margin-top:14px;display:block">
      <input type="checkbox" ${_lastAutoCheck ? 'checked' : ''} onchange="settingVersionsAutoCheckToggle(this.checked)">
      ${t('updateAutoCheck')}
    </label>`;
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
async function settingVersionsAutoCheckToggle(checked) {
  _lastAutoCheck = checked;
  await api.update.setAutoCheck(checked);
  toast(t('applied'), 'ok');
}
registerSettingPage('appdata', 'versions', settingVersionsPageHtml);
