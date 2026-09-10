'use strict';
// Google Drive appdata backup — "Backup" section of the Preferences panel
// (src/renderer/core/settings.js's PREFS_SECTIONS). Independent Google login
// from the Cloud Sync feature (src/renderer/sync.js) — see docs/DRIVE.md for
// why. All network work happens in the main process via api.drive.* — this
// file only renders, dispatches, and owns the hourly auto-backup timer
// (which must live in the renderer since the "layout profile" payload only
// exists in renderer localStorage — main can't read it).

function driveErrToast(r) {
  const map = {
    no_config: 'driveErrNoConfig',
    not_connected: 'driveErrNotConnected',
    login_timeout: 'driveErrLoginTimeout',
    auth: 'driveErrAuth',
    network: 'driveErrNetwork',
    no_refresh_token: 'driveErrAuth',
    nothing_enabled: 'driveErrNothingEnabled',
    drive_full: 'driveErrDriveFull',
    not_found: 'driveErrNotFound',
    bad_backup: 'driveErrServer',
    server: 'driveErrServer',
  };
  toast(t(map[r?.code] || 'driveErrServer'), 'error');
}

function driveFmtTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch (_) { return iso; }
}

function driveFmtBytes(n) {
  if (n == null) return '—';
  const gb = n / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(n / (1024 * 1024))}MB`;
}

function driveStorageBarHtml(storage) {
  if (!storage) return '';
  if (storage.limit == null) {
    return `<div class="sync-hint">${t('driveStorageUsage')}: ${driveFmtBytes(storage.usage)}</div>`;
  }
  const pct = Math.min(100, Math.round((storage.usage / storage.limit) * 100));
  const cls = storage.state === 'full' ? 'drive-bar-full' : storage.state === 'near_full' ? 'drive-bar-near' : '';
  const warn = storage.state === 'full' ? `<div class="modal-hint">${I.info}<span>${t('driveFull')}</span></div>`
    : storage.state === 'near_full' ? `<div class="modal-hint">${I.info}<span>${t('driveNearFull')}</span></div>` : '';
  return `
    <div class="sync-hint">${t('driveStorageUsage')}: ${driveFmtBytes(storage.usage)} / ${driveFmtBytes(storage.limit)} (${pct}%)</div>
    <div class="drive-bar"><div class="drive-bar-fill ${cls}" style="width:${pct}%"></div></div>
    ${warn}`;
}

function driveConfigFormHtml(cfg) {
  return `
    <div class="modal-hint">${I.info}<span>${t('driveConfigHint')}</span></div>
    <div class="fg"><label>${t('driveClientId')}</label><input id="drive-client-id" value="${x(cfg.clientId || '')}"></div>
    <div class="fg"><label>${t('driveClientSecret')}</label><input id="drive-client-secret" type="password" value="${x(cfg.clientSecret || '')}"></div>
    <button class="btn btn-p" onclick="driveSaveConfig()">${t('save')}</button>`;
}

function driveBackupLogRowHtml(entry) {
  const ok = entry.ok !== false;
  const parts = [entry.layout ? t('driveIncludeLayout') : '', entry.ddx ? t('driveIncludeDdx') : ''].filter(Boolean).join(', ');
  return `<div class="li"><span class="name">${driveFmtTime(entry.at)}</span>
    <span class="tag" data-no-i18n>${ok ? (parts || '—') : `⚠ ${x(entry.code || '')}`}</span></div>`;
}
function driveBackupLogHtml(log) {
  if (!log || !log.length) return '';
  return `<div class="settings-label" style="margin-top:10px">${t('settingBackupHistory')}</div>
    <div class="modal-data">${log.map(driveBackupLogRowHtml).join('')}</div>`;
}

function driveBackupBodyHtml(st, cfg, log) {
  if (!st.dev && !st.configured) return driveConfigFormHtml(cfg);

  if (!st.connected) {
    return `
      ${st.dev ? `<div class="modal-hint">${I.info}<span>${t('driveDevServer')}</span></div>` : ''}
      <div class="modal-hint">${I.info}<span>${t('driveNotConnected')}</span></div>
      <button class="btn btn-p" id="drive-connect-btn" onclick="driveConnectNow()">☁ ${t('driveConnect')}</button>`;
  }

  return `
    ${st.dev ? `<div class="modal-hint">${I.info}<span>${t('driveDevServer')}</span></div>` : ''}
    <div class="sync-status-row"><span>${t('driveConnected')}</span><b>${x(st.email || '')}</b></div>
    ${driveStorageBarHtml(st.storage)}
    <div class="sync-status-row"><span>${t('driveLastBackup')}</span><b>${driveFmtTime(st.lastBackupAt)}</b></div>
    <div class="fg">
      <label><input type="checkbox" ${st.autoBackup ? 'checked' : ''} onchange="driveToggle('setAutoBackup', this.checked)"> ${t('driveAutoBackup')}</label>
      <label><input type="checkbox" ${st.backupLayout ? 'checked' : ''} onchange="driveToggle('setBackupLayout', this.checked)"> ${t('driveIncludeLayout')}</label>
      <label><input type="checkbox" ${st.backupDdx ? 'checked' : ''} onchange="driveToggle('setBackupDdx', this.checked)"> ${t('driveIncludeDdx')}</label>
    </div>
    <div class="mfoot">
      <button class="btn btn-s btn-sm" onclick="driveShowConfigForm()">${t('syncServerSettings')}</button>
      <button class="btn btn-d" onclick="driveDisconnectNow()">${t('driveDisconnect')}</button>
      <button class="btn btn-s" onclick="driveRestoreLayoutNow()">${t('driveRestoreLayout')}</button>
      <button class="btn btn-s" onclick="driveRestoreDatabaseNow()">${t('driveRestoreDatabase')}</button>
      <button class="btn btn-p" id="drive-backup-btn" onclick="driveBackupNowClick()">☁ ${t('driveBackupNow')}</button>
    </div>
    ${driveBackupLogHtml(log)}`;
}

// Setting-window page-render functions stay fully synchronous like every
// other page (setting-window.js's SETTING_PAGE_RENDERERS) — this kicks off
// the async status fetch and patches its own DOM once ready, same pattern
// src/renderer/sync.js uses for its modal states. (Was prefsBackupSectionHtml
// under the old Preferences panel; renamed, unchanged otherwise.)
function settingBackupPageHtml() {
  driveRefreshBackupSection();
  // Two ways to get your data off this machine, one page: Google Drive backup
  // above, and "bring your own Supabase project" (src/renderer/supabase.js)
  // below it as its own section. Same async-patch contract — that function
  // returns its shell now and fills it in once its own IPC read returns.
  return `<div class="settings-label">${t('prefs_backup')}</div><div id="drive-backup-body">${t('syncWorking')}</div>
    ${supabaseSetupSectionHtml()}`;
}
registerSettingPage('appdata', 'backup', settingBackupPageHtml);

async function driveRefreshBackupSection() {
  const [st, cfg, log] = await Promise.all([api.drive.status(), api.drive.getConfig(), api.drive.getBackupLog()]);
  const el = q('#drive-backup-body');
  if (!el) return; // panel closed or switched section before this resolved
  el.innerHTML = driveBackupBodyHtml(st, cfg, log);
}

// Both the Backup page and Setting -> User -> Account can host the client
// id/secret form now (the Google login is one login for the whole app, so
// asking for its credentials on the Account page and nowhere else was the
// odd part), hence the target selector rather than a hardcoded one.
async function driveShowConfigForm(sel = '#drive-backup-body') {
  const cfg = await api.drive.getConfig();
  const el = q(sel);
  if (el) el.innerHTML = driveConfigFormHtml(cfg);
}

// The two pages show the same connection, so every mutation refreshes both.
// Each refresher no-ops when its own container is not on screen, so this is
// safe to call from either page.
function driveRefreshAllSections() {
  driveRefreshBackupSection();
  settingRefreshAccountSection();
}

async function driveSaveConfig() {
  const id = q('#drive-client-id')?.value.trim() || '';
  const secret = q('#drive-client-secret')?.value.trim() || '';
  await api.drive.setConfig(id, secret);
  toast(t('syncConfigSaved'), 'ok');
  driveRefreshAllSections();
}

async function driveConnectNow() {
  syncBtnBusy('#drive-connect-btn', true);
  const r = await api.drive.connect();
  syncBtnBusy('#drive-connect-btn', false);
  if (!r.ok) return driveErrToast(r);
  toast(t('driveConnected'), 'ok');
  driveRefreshAllSections();
  renderSettingsMenu();
}

async function driveDisconnectNow() {
  if (!(await uiConfirm(t('driveDisconnectConfirm')))) return;
  await api.drive.disconnect();
  driveApplyAutoBackupToggle(false);
  toast(t('driveDisconnect'), 'ok');
  driveRefreshAllSections();
  renderSettingsMenu();
}

async function driveToggle(setter, enabled) {
  const r = await api.drive[setter](enabled);
  if (!r.ok) return driveErrToast(r);
  if (setter === 'setAutoBackup') driveApplyAutoBackupToggle(enabled);
}

async function driveBackupNowClick() {
  syncBtnBusy('#drive-backup-btn', true);
  const r = await api.drive.backupNow(localStorage.getItem(UI_SETTINGS_KEY));
  syncBtnBusy('#drive-backup-btn', false);
  if (!r.ok) return driveErrToast(r);
  toast(t('driveBackupNow'), 'ok');
  driveRefreshBackupSection();
}

// Reload instead of re-running every setUiSetting cascade step — deliberate
// simplification, restoring a whole layout profile is rare.
async function driveRestoreLayoutNow() {
  if (!(await uiConfirm(t('driveRestoreLayoutConfirm')))) return;
  const r = await api.drive.restoreLayout();
  if (!r.ok) return driveErrToast(r);
  try { localStorage.setItem(UI_SETTINGS_KEY, r.json); }
  catch (_) { return toast(t('driveErrServer'), 'error'); }
  location.reload();
}

// importDatabaseMerge is a natural-key MERGE, not a wipe-and-replace — the
// confirm copy must say so (driveRestoreDatabaseConfirm, all 18 locales).
async function driveRestoreDatabaseNow() {
  if (!(await uiConfirm(t('driveRestoreDatabaseConfirm')))) return;
  const r = await api.drive.restoreDatabase();
  if (!r.ok) return driveErrToast(r);
  toast(t('driveRestoreDatabase'), 'ok');
  location.reload();
}

// ---------------------------------------------------------------------------
// Auto-backup timer — lives here, not main, since the layout-profile payload
// only exists in renderer localStorage. Toggling arms/clears this interval
// immediately; main-process drive.js stays purely reactive.
// ---------------------------------------------------------------------------
const DRIVE_AUTOBACKUP_OWNER = 'novel-manager-drive-autobackup-owner';
let driveAutoBackupTimer = null;

function driveApplyAutoBackupToggle(enabled) {
  if (driveAutoBackupTimer) { clearInterval(driveAutoBackupTimer); driveAutoBackupTimer = null; }
  if (enabled) driveAutoBackupTimer = setInterval(driveAutoBackupTick, 3600000);
}

async function driveAutoBackupTick() {
  const r = await api.drive.backupNow(localStorage.getItem(UI_SETTINGS_KEY));
  if (!r.ok && r.code !== 'nothing_enabled') driveErrToast(r);
  if (q('#drive-backup-body')) driveRefreshBackupSection();
}

async function initDriveAutoBackup() {
  if (S.isPopup) return; // popup windows share the DB/process — must not run a second competing timer
  // v4.9.0: with one .ddx per Nexus, every open vault window would otherwise
  // run its own hourly timer and upload its own vault concurrently. Only the
  // first window to claim the flag keeps a timer; it is released on unload so
  // closing that window hands the job to another.
  if (localStorage.getItem(DRIVE_AUTOBACKUP_OWNER) && localStorage.getItem(DRIVE_AUTOBACKUP_OWNER) !== String(S._windowId)) return;
  localStorage.setItem(DRIVE_AUTOBACKUP_OWNER, String(S._windowId));
  window.addEventListener('beforeunload', () => {
    if (localStorage.getItem(DRIVE_AUTOBACKUP_OWNER) === String(S._windowId)) localStorage.removeItem(DRIVE_AUTOBACKUP_OWNER);
  });
  const st = await api.drive.status();
  if (!st.connected || !st.autoBackup) return;
  driveAutoBackupTick(); // fire once immediately, fire-and-forget — must not block first paint
  driveAutoBackupTimer = setInterval(driveAutoBackupTick, 3600000);
}
