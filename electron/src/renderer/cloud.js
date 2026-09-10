'use strict';
// ═══ Cloud storage settings page (v4.9.0) ══════════════════════════════════
// Setting window → App Data → Cloud Storage. Lists every backend the provider
// registry (src/db/cloud.js) knows about and lets the user pick one and
// say what they want it used for.
//
// NOTHING NEW IS CONNECTED HERE. Google Drive is the only working backend and
// it reaches this page through an adapter over the existing src/db/drive.js —
// its own Backup page (src/renderer/drive.js) is unchanged and remains where
// backup/restore actually happens. Every other provider renders from a
// declared stub and says so.
//
// The point of shipping the page in that state rather than waiting: "connect
// your own storage" is a promise about whose account holds the data, and the
// settings UI is where a user goes to check that. A page that names the
// backends, states which are ready, and stores the choice is a truthful
// answer; a hidden feature flag is not.

function cloudErrToast(r) {
  const map = {
    unknown_provider: 'cloudErrUnknownProvider',
    not_implemented: 'cloudNotImplemented',
    unsupported_role: 'cloudErrUnsupportedRole',
    bad_role: 'cloudErrUnsupportedRole',
    no_config: 'driveErrNoConfig',
    not_connected: 'driveErrNotConnected',
    login_timeout: 'driveErrLoginTimeout',
    auth: 'driveErrAuth',
    network: 'driveErrNetwork',
  };
  toast(t(map[r?.code] || 'driveErrServer'), 'error');
}

function settingCloudStoragePageHtml() {
  cloudRefreshSection();
  return `<div class="settings-label">${t('settingPageCloudStorage')}</div>
    <div class="modal-hint">${I.info}<span>${t('cloudIntroHint')}</span></div>
    <div id="cloud-body">${t('syncWorking')}</div>`;
}
registerSettingPage('appdata', 'cloudstorage', settingCloudStoragePageHtml);

// Only the ACTIVE provider's live status is fetched — a status() call per
// provider would be a network round trip each, every time the page opens, for
// backends the user isn't using. Everything else renders from local settings.
async function cloudRefreshSection() {
  const list = await api.cloud.listProviders();
  const active = list?.ok && list.active
    ? await api.cloud.status(list.active)
    : null;
  const el = q('#cloud-body');
  if (!el) return; // page closed or switched before this resolved
  el.innerHTML = cloudBodyHtml(list, active);
}

function cloudCapsHtml(p) {
  const caps = [];
  if (p.capabilities?.backup) caps.push(t('cloudRoleBackup'));
  if (p.capabilities?.sync) caps.push(t('cloudRoleSync'));
  return caps.map((c) => `<span class="sync-tag-chip">${c}</span>`).join('');
}

function cloudProviderRowHtml(p, isActive, status) {
  const planned = p.availability !== 'available';
  const connected = !planned && !!status?.connected;
  // Three states worth distinguishing, in the order a user asks about them:
  // not built yet / built but you haven't connected an account / connected.
  const state = planned
    ? `<span class="sync-hint">${t('cloudProviderPlanned')}</span>`
    : connected
      ? `<span class="sync-hint">${t('driveConnected')} <b data-no-i18n>${x(status.email || '')}</b></span>`
      : `<span class="sync-hint">${t('driveNotConnected')}</span>`;

  return `
    <div class="sync-upload-row${isActive ? ' sync-upload-row-mine' : ''}">
      <div>
        <b>${t(p.labelKey)}</b> ${cloudCapsHtml(p)}
        <div>${state}</div>
      </div>
      <div class="sync-upload-actions">
        ${planned
          ? `<button class="btn btn-s btn-sm" disabled title="${t('cloudNotImplemented')}">${t('cloudProviderConnect')}</button>`
          : isActive
            ? `<button class="btn btn-d btn-sm" onclick="cloudSetActiveClick(null)">${t('cloudUseStop')}</button>`
            : `<button class="btn btn-s btn-sm" onclick="cloudSetActiveClick(${xj(p.id)})">${t('cloudUse')}</button>`}
      </div>
    </div>`;
}

function cloudBodyHtml(list, activeStatus) {
  if (!list?.ok) return `<div class="modal-hint">${I.info}<span>${t('driveErrServer')}</span></div>`;
  const rows = list.providers
    .map((p) => cloudProviderRowHtml(p, p.id === list.active, p.id === list.active ? activeStatus : null))
    .join('');
  // The role picker only appears once a provider is actually chosen — asking
  // "backup or sync?" about a backend nobody selected is noise.
  const activeProvider = list.providers.find((p) => p.id === list.active);
  return `${rows}${activeProvider ? cloudRoleHtml(activeProvider) : ''}`;
}

function cloudRoleHtml(p) {
  const opt = (role, labelKey, enabled) => `
    <button class="btn ${p.role === role ? 'btn-p' : 'btn-s'} btn-sm"
      ${enabled ? `onclick="cloudSetRoleClick(${xj(p.id)},${xj(role)})"` : `disabled title="${t('cloudErrUnsupportedRole')}"`}
    >${t(labelKey)}</button>`;
  const both = p.capabilities?.backup && p.capabilities?.sync;
  return `
    <div class="fg">
      <label>${t('cloudRoleLabel')}</label>
      <div class="sync-hint">${t('cloudRoleHint')}</div>
      <div class="sync-upload-actions">
        ${opt('backup', 'cloudRoleBackup', !!p.capabilities?.backup)}
        ${opt('sync', 'cloudRoleSync', !!p.capabilities?.sync)}
        ${opt('both', 'cloudRoleBoth', !!both)}
      </div>
    </div>`;
}

async function cloudSetActiveClick(id) {
  const r = await api.cloud.setActive(id);
  if (!r?.ok) return cloudErrToast(r);
  toast(t(id ? 'cloudActiveSet' : 'cloudActiveCleared'), 'ok');
  cloudRefreshSection();
}

async function cloudSetRoleClick(id, role) {
  const r = await api.cloud.setPrefs(id, { role });
  if (!r?.ok) return cloudErrToast(r);
  cloudRefreshSection();
}
