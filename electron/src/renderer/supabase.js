'use strict';
// Setting window → App Data → Backup → "Supabase Project" section.
//
// The one screen that turns "I have a Supabase account" into a working Cloud
// Sync backend: paste the project URL + publishable key, press Check, and the
// app reports exactly which tables and functions are present; press Auto setup
// and it puts the missing ones there. Everything network-facing happens in the
// main process (src/db/supabase-setup.js) — this file only renders and
// dispatches, like every other renderer module.
//
// Two install paths, both offered on the same screen because only the user
// knows which they want: paste a personal access token and let the app run the
// SQL (nothing to do by hand, token never stored), or copy the SQL into the
// project's own SQL editor. Check verifies the result either way.

// Cached so a re-render of the page (language change, tab switch back) keeps
// showing the last result instead of resetting to "not checked yet".
let sbLastCheck = null;

function sbErrToast(r) {
  const map = {
    no_config: 'sbErrNoConfig',
    invalid_url: 'sbErrInvalidUrl',
    bad_key: 'sbErrBadKey',
    unreachable: 'sbErrUnreachable',
    network: 'syncErrNetwork',
    needs_manual: 'sbErrNeedsManual',
    bad_access_token: 'sbErrBadAccessToken',
    forbidden: 'sbErrForbidden',
    no_project_ref: 'sbErrNoProjectRef',
    rate_limited: 'sbErrRateLimited',
    sql_error: 'sbErrSqlError',
    bad_page: 'sbErrNoProjectRef',
  };
  toast(t(map[r?.code] || 'syncErrServer'), 'error');
}

// A SECTION of Setting -> App Data -> Backup, not a page of its own: this is
// where the user already goes to decide where their data lives (Drive backup
// sits directly above it), and Cloud Sync is one more answer to that same
// question. drive.js's settingBackupPageHtml() calls this; like the Drive
// section above it, the markup is returned synchronously (page renderers must
// be — see setting-window.js's SETTING_PAGE_RENDERERS) and the async config
// read patches its own container once it lands.
function supabaseSetupSectionHtml() {
  sbRefreshPage();
  return `<div class="settings-label" style="margin-top:14px">${t('settingPageSupabase')}</div>
    <div id="sb-body">${t('syncWorking')}</div>`;
}

async function sbRefreshPage() {
  const cfg = await api.supabase.getSetup();
  const wasReady = !!S.supabaseReady;
  S.supabaseReady = !!cfg.configured;
  // Finishing (or clearing) setup changes which pages the Setting window's
  // sidebar lists at all — cloudSyncAvailable() is what gates Token Sync — so
  // redraw the whole window rather than leave the nav a render behind. Guarded
  // on the flag actually flipping: the redraw re-enters this function, and by
  // then wasReady matches, so it settles after exactly one extra pass.
  if (wasReady !== S.supabaseReady && q('#setting-window')) return renderSettingWindow();
  const el = q('#sb-body');
  if (el) el.innerHTML = sbBodyHtml(cfg, sbLastCheck);
}

function sbItemRowHtml(item) {
  return `<div class="li">
    <span class="name" data-no-i18n>${x(item.id)}</span>
    <span class="tag" data-no-i18n>${item.ok ? '✓' : '✗'}</span>
  </div>`;
}

// The install offer. Shown whenever the project is not fully ready — including
// before the first check, since a brand-new project always needs it and hiding
// it until after a check just adds a step.
function sbInstallHtml() {
  return `<div class="settings-label">${t('sbAutoInstall')}</div>
    <div class="modal-hint">${I.info}<span>${t('sbAutoInstallHint')}</span></div>
    <div class="fg"><label>${t('sbAccessToken')}</label>
      <input id="sb-token" type="password" placeholder="sbp_..." spellcheck="false" autocomplete="off">
      <div class="sync-hint">${t('sbAccessTokenHint')}</div>
    </div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="sbOpenDash('tokens')">${t('sbGetToken')}</button>
      <button class="btn btn-p" id="sb-install-btn" onclick="sbInstallNow()">${t('sbAutoInstall')}</button>
    </div>
    <div class="settings-label">${t('sbManualTitle')}</div>
    <div class="modal-hint">${I.info}<span>${t('sbManualHint')}</span></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="sbCopySql()">${t('sbCopySql')}</button>
      <button class="btn btn-s" onclick="sbOpenDash('sql')">${t('sbOpenSqlEditor')}</button>
    </div>`;
}

function sbStatusHtml(chk) {
  if (!chk) return `<div class="modal-hint">${I.info}<span>${t('sbNotChecked')}</span></div>${sbInstallHtml()}`;

  const google = chk.googleProvider === null ? '' :
    `<div class="modal-hint">${I.info}<span>${t(chk.googleProvider ? 'sbGoogleOn' : 'sbGoogleOff')}</span></div>
     ${chk.googleProvider ? '' : `<div class="mfoot"><button class="btn btn-s" onclick="sbOpenDash('auth')">${t('sbOpenAuthProviders')}</button></div>`}`;

  return `<div class="sync-status-row"><span>${t('sbSchemaVersion')}</span>
      <b data-no-i18n>${x(String(chk.installedVersion))} / ${x(String(chk.requiredVersion))}</b></div>
    <div class="settings-label">${t('sbObjects')}</div>
    <div class="modal-data">${chk.items.map(sbItemRowHtml).join('')}</div>
    <div class="modal-hint">${I.info}<span>${t(chk.ready ? 'sbReady' : 'sbNeedSetup')}</span></div>
    ${google}
    ${chk.ready ? '' : sbInstallHtml()}`;
}

function sbBodyHtml(cfg, chk) {
  return `<div class="modal-hint">${I.info}<span>${t('sbIntro')}</span></div>
    <div class="fg"><label>${t('sbUrl')}</label>
      <input id="sb-url" placeholder="https://xxxxxxxx.supabase.co" spellcheck="false" value="${x(cfg.url || '')}"></div>
    <div class="fg"><label>${t('sbKey')}</label>
      <input id="sb-key" type="password" spellcheck="false" autocomplete="off" placeholder="${cfg.keySet ? x(cfg.keyPreview) : 'sb_publishable_...'}">
      ${cfg.keySet ? `<div class="sync-hint">${t('sbKeyStored')}</div>` : ''}
    </div>
    <div class="mfoot">
      ${cfg.configured ? `<button class="btn btn-d btn-sm" onclick="sbClearNow()">${t('sbClear')}</button>` : ''}
      <button class="btn btn-s" onclick="sbOpenDash('api')">${t('sbOpenApiSettings')}</button>
      <button class="btn btn-s" id="sb-check-btn" onclick="sbCheckNow()">${t('sbCheck')}</button>
      <button class="btn btn-p" onclick="sbSaveNow()">${t('save')}</button>
    </div>
    ${sbStatusHtml(chk)}`;
}

// --- actions ---------------------------------------------------------------

// The key input is deliberately left EMPTY when one is already stored (its
// placeholder shows the masked tail instead), so saving with a blank key means
// "keep the stored one" — setSetup treats it that way, and clearing is its own
// button.
async function sbSaveNow() {
  const url = (q('#sb-url')?.value || '').trim();
  const key = (q('#sb-key')?.value || '').trim();
  if (!url) return toast(t('sbErrNoConfig'), 'error');
  const r = await api.supabase.setSetup(url, key);
  if (!r.ok) return sbErrToast(r);
  sbLastCheck = null;
  toast(t('saved'), 'ok');
  await sbCheckNow();
}

async function sbCheckNow() {
  syncBtnBusy('#sb-check-btn', true);
  const r = await api.supabase.check();
  syncBtnBusy('#sb-check-btn', false);
  if (!r.ok) { sbLastCheck = null; await sbRefreshPage(); return sbErrToast(r); }
  sbLastCheck = r;
  await sbRefreshPage();
  toast(t(r.ready ? 'sbReady' : 'sbNeedSetup'), r.ready ? 'ok' : '');
}

// The access token is read straight out of the input and passed through — it
// is never stored on either side of the IPC boundary (see src/db/supabase-setup.js).
async function sbInstallNow() {
  const token = (q('#sb-token')?.value || '').trim();
  if (!token) return toast(t('sbErrNeedsManual'), 'error');
  syncBtnBusy('#sb-install-btn', true);
  const r = await api.supabase.install(token);
  syncBtnBusy('#sb-install-btn', false);
  if (!r.ok) return sbErrToast(r);
  sbLastCheck = r;
  await sbRefreshPage();
  toast(t(r.ready ? 'sbInstalled' : 'sbNeedSetup'), r.ready ? 'ok' : '');
}

async function sbCopySql() {
  const { sql } = await api.supabase.getSql();
  try { await navigator.clipboard.writeText(sql); toast(t('copied'), 'ok'); }
  catch (_) { toast(t('syncErrServer'), 'error'); }
}

async function sbOpenDash(page) {
  const r = await api.supabase.openDash(page);
  if (!r.ok) sbErrToast(r);
}

async function sbClearNow() {
  if (!(await uiConfirm(t('sbClearConfirm')))) return;
  await api.supabase.clearSetup();
  sbLastCheck = null;
  await sbRefreshPage();
  toast(t('sbCleared'), 'ok');
}

// Cloud Sync's own entry points (the ☁ button in the left panel, the Token
// Sync setting page) are hidden until a project is configured — see
// cloudSyncAvailable() in core/state.js. Ask once at load so those surfaces
// are right on the first render, not only after this page has been opened.
// A failure here is not worth surfacing: it just means "not ready", which is
// also the default.
(async () => {
  try { S.supabaseReady = !!(await api.supabase.getSetup()).configured; }
  catch (_) { S.supabaseReady = false; }
})();
