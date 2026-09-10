'use strict';
// Plugins (renamed from "Github extensions" in v4.2.0). Paste-a-link install,
// preview, list and uninstall UI — the actual sandboxed execution and the
// pluginApi.* table bridge live in main.js/preload-plugin.js/src/db/plugin.js;
// this file only talks to the main-app-facing api.plugin.* surface (never
// api.pluginApi — that bridge doesn't even exist in this window). See
// docs/PLUGINS.md.

function pluginErrToast(r) {
  const map = {
    bad_url: 'pluginErrBadUrl',
    unsupported_host: 'pluginErrUnsupportedHost',
    no_manifest: 'pluginErrNoManifest',
    bad_manifest: 'pluginErrBadManifest',
    already_installed: 'pluginErrAlreadyInstalled',
    missing_file: 'pluginErrBadManifest',
    too_large: 'pluginErrBadManifest',
    network: 'pluginErrNetwork',
    install_failed: 'pluginErrServer',
    running: 'pluginErrRunning',
    not_found: 'pluginErrNotFound',
    dependency_failed: 'pluginErrDependencyFailed',
    missing_dependency: 'pluginErrMissingDependency',
    self_dependency: 'pluginErrDependencyFailed',
  };
  toast(t(map[r?.code] || 'pluginErrServer'), 'error');
}

// Setting-window page-render function — kicks off an async load and patches
// its own DOM once ready, same pattern every setting page uses.
function settingPluginPageHtml() {
  pluginRefreshSection();
  pluginRefreshOrgRepos();
  return `<div id="plugin-org-repos"></div><div class="settings-label">${t('prefs_plugin')}</div><div id="plugin-body">${t('syncWorking')}</div>`;
}
registerSettingPage('plugin', 'plugin', settingPluginPageHtml);

async function pluginRefreshSection() {
  const list = await api.plugin.list();
  // Panel contributions (v4.3.0) change with the plugin list, so an install or
  // uninstall must be reflected in the pane-head buttons without a restart.
  // Fire-and-forget — this section's own render must not wait on it.
  if (typeof loadPluginPanels === 'function') loadPluginPanels().then(() => renderNexusHome());
  const el = q('#plugin-body');
  if (!el) return; // panel closed or switched section before this resolved
  const running = await Promise.all(list.map((p) => api.plugin.isRunning(p.id)));
  el.innerHTML = pluginBodyHtml(list, running);
}

// Plan part2 #5 — default "install from @ZYDRAXYL" list, so a user doesn't need
// a repo URL already in hand. Advisory only: a network failure (offline, rate
// limited) just leaves this section empty, no error toast — same silence
// convention as the auto-preview-on-type path below.
async function pluginRefreshOrgRepos() {
  const r = await api.plugin.listOrgRepos();
  const el = q('#plugin-org-repos');
  if (!el) return; // panel closed or switched section before this resolved
  if (!r?.ok || !r.repos.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="fg">
      <label>${t('pluginOrgReposLabel')}</label>
      ${r.repos.map((repo) => `
        <div class="sync-upload-row">
          <div>
            <b data-no-i18n>${x(repo.name)}</b>
            <div class="sync-hint" data-no-i18n>${x(repo.description)}</div>
          </div>
          <div class="sync-upload-actions">
            <button class="btn btn-s btn-sm" onclick="pluginInstallFromOrgRepo(${xj(repo.url)})">${t('pluginPreviewBtn')}</button>
          </div>
        </div>`).join('')}
    </div>`;
}

// Feeds straight into the existing paste-a-link flow (pluginUrlInput +
// pluginPreviewRun) rather than a second install path — the preview→confirm
// trust boundary (docs/PLUGINS.md §2.3b) stays the one and only way in.
function pluginInstallFromOrgRepo(url) {
  const input = q('#plugin-url');
  if (input) input.value = url;
  pluginUrlInput(url);
  pluginPreviewRun();
}

// v4.9.0 — the plugins this one declared but doesn't have. An install no
// longer aborts over a dependency (docs/PLUGINS.md §1.8), so this block is
// where an unmet requirement becomes visible and fixable: one Download button
// per missing plugin, and Launch stays disabled until the list empties. It
// also covers the case the install-time check never could — a dependency the
// user uninstalled afterwards.
function pluginDepsMissingHtml(p) {
  const missing = p.missingDeps || [];
  if (!missing.length) return '';
  const items = missing.map((d) => {
    // Resolved name when we have one, the raw URL when resolution failed —
    // never nothing, so "what do I actually need" is always answerable.
    const label = d.name
      ? `${x(d.name)} <span class="sync-hint" data-no-i18n>${x(d.key)}</span>`
      : `<span data-no-i18n>${x(d.url)}</span> <span class="sync-hint">(${t('pluginDepUnresolved')})</span>`;
    return `<li>${label}
      <button class="btn btn-s btn-sm" onclick="pluginInstallDepClick(${p.id},${xj(d.url)},this)">${t('pluginDepDownload')}</button>
    </li>`;
  }).join('');
  return `<div class="plugin-dep-missing">
    <div class="plugin-preview-warn">${t('pluginDepsMissing')}</div>
    <ul class="plugin-preview-files">${items}</ul>
  </div>`;
}

function pluginRowHtml(p, isRunning) {
  const at = p.repo_host === 'gitlab' ? 'GitLab' : 'GitHub';
  const blocked = !!(p.missingDeps || []).length;
  return `
    <div class="sync-upload-row">
      <div>
        <b>${x(p.name)}</b> <span class="sync-hint">v${x(p.version || '—')}</span>
        <div class="sync-hint">${at} · ${x(p.repo_owner)}/${x(p.repo_name)}@${x(p.repo_ref)} · ${p.tables.length} ${t('pluginTablesLabel')}</div>
        ${pluginDepsMissingHtml(p)}
      </div>
      <div class="sync-upload-actions">
        ${isRunning
          ? `<button class="btn btn-d btn-sm" onclick="pluginStopClick(${p.id})">${t('pluginStop')}</button>`
          : blocked
            ? `<button class="btn btn-s btn-sm" disabled title="${t('pluginLaunchBlocked')}">${t('pluginLaunch')}</button>`
            : `<button class="btn btn-s btn-sm" onclick="pluginLaunchClick(${p.id})">${t('pluginLaunch')}</button>`}
        <button class="btn btn-d btn-sm" onclick="pluginUninstallClick(${p.id})">${t('delete')}</button>
      </div>
    </div>`;
}

// `running` is positional-parallel to `list` — pass it through explicitly
// rather than letting Array.map hand pluginRowHtml the index as its second
// argument (that bug made row 0 always show Launch and every other row Stop).
function pluginBodyHtml(list, running) {
  const rows = list.length
    ? list.map((p, i) => pluginRowHtml(p, running?.[i])).join('')
    : `<div class="modal-hint">${I.info}<span>${t('pluginNoneInstalled')}</span></div>`;
  return `
    <div class="fg">
      <label>${t('pluginInstallNew')}</label>
      <div class="sync-hint">${t('pluginUrlHint')}</div>
      <div class="sync-key-row">
        <input id="plugin-url" placeholder="${t('pluginUrlPlaceholder')}" value="${x(S.pluginUrlDraft || '')}"
               oninput="pluginUrlInput(this.value)" onkeydown="if(event.key==='Enter')pluginPreviewRun()">
        <button class="btn btn-p" id="plugin-preview-btn" onclick="pluginPreviewRun()">${t('pluginPreviewBtn')}</button>
      </div>
      <div id="plugin-preview">${S.pluginPreview ? pluginPreviewHtml(S.pluginPreview) : ''}</div>
    </div>
    ${rows}`;
}

// ─── Paste a link → preview ────────────────────────────────────────────────
// The real URL parsing lives in src/db/plugin-manifest.js (main process). This
// is only a cheap "is it worth a round trip" gate so typing doesn't fire a
// network request per keystroke.
function pluginLooksLikeRepoUrl(v) {
  const s = String(v || '').trim();
  if (!s || /\s/.test(s)) return false;
  const path = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '').replace(/:/g, '/');
  return path.split('/').filter(Boolean).length >= 2;
}

let _pluginPreviewTimer = null;
let _pluginPreviewSeq = 0;

function pluginUrlInput(value) {
  S.pluginUrlDraft = value;
  // A typed/pasted URL that no longer matches the shown preview invalidates it.
  if (S.pluginPreview && S.pluginPreview.url !== String(value || '').trim()) pluginPreviewClear();
  clearTimeout(_pluginPreviewTimer);
  if (!pluginLooksLikeRepoUrl(value)) return;
  // Auto-fetch on paste/typing settle: silent, so a half-typed URL doesn't
  // spray error toasts. The explicit button reports failures out loud.
  _pluginPreviewTimer = setTimeout(() => pluginPreviewRun(true), 400);
}

function pluginPreviewClear() {
  S.pluginPreview = null;
  const el = q('#plugin-preview');
  if (el) el.innerHTML = '';
}

async function pluginPreviewRun(silent) {
  clearTimeout(_pluginPreviewTimer);
  const url = (q('#plugin-url')?.value || S.pluginUrlDraft || '').trim();
  S.pluginUrlDraft = url;
  if (!url) { if (!silent) toast(t('pluginErrBadUrl'), 'error'); return; }

  const seq = ++_pluginPreviewSeq;
  const box = q('#plugin-preview');
  if (box) box.innerHTML = `<div class="sync-hint">${t('pluginPreviewChecking')}</div>`;
  syncBtnBusy('#plugin-preview-btn', true);
  const r = await api.plugin.preview(url);
  syncBtnBusy('#plugin-preview-btn', false);
  if (seq !== _pluginPreviewSeq) return; // a newer keystroke already won

  if (!r?.ok) {
    pluginPreviewClear();
    if (!silent) pluginErrToast(r);
    return;
  }
  S.pluginPreview = r;
  const el = q('#plugin-preview');
  if (el) el.innerHTML = pluginPreviewHtml(r);
}

// The two v4.3.0 grants that are NOT just "files and tables": a panel embeds
// the plugin's page inside the main window, and each net origin is a host the
// plugin may reach — and, because the request runs in the main process, read
// the response from. Rendered as its own block so a user scanning the preview
// sees them before confirming, not after. Omitted entirely when the manifest
// asks for neither, which is every plugin written before v4.3.0.
function pluginPreviewGrantsHtml(m) {
  const panels = m.panels || [];
  const origins = m.netOrigins || [];
  if (!panels.length && !origins.length) return '';
  let h = '';
  if (panels.length) {
    const items = panels.map((p) => `<li>${x(p.title)} <span class="sync-hint">(${x(p.entry)})</span></li>`).join('');
    h += `<div class="plugin-preview-row"><span>${t('pluginPreviewPanelsLabel')}</span><b>${panels.length}</b></div>
      <ul class="plugin-preview-files">${items}</ul>`;
  }
  if (origins.length) {
    const items = origins.map((o) => `<li data-no-i18n>${x(o)}</li>`).join('');
    h += `<div class="plugin-preview-row"><span>${t('pluginPreviewNetLabel')}</span><b>${origins.length}</b></div>
      <ul class="plugin-preview-files">${items}</ul>
      <div class="plugin-preview-warn">${t('pluginPreviewNetWarn')}</div>`;
  }
  return h;
}

// v4.8.0 — other plugins this one declares in `dependencies`. Shown as its own
// block for the same reason panels/net get one: installing this plugin does
// more than create its own files and tables, and the user should see that
// before confirming, not discover it afterward. A dependency that failed to
// resolve is still listed (by its raw URL) rather than silently dropped, so
// "why do I suddenly have two new plugins" never has a hidden half.
function pluginPreviewDepsHtml(m) {
  const deps = m.dependencies || [];
  if (!deps.length) return '';
  const items = deps.map((d) => {
    if (!d.ok) return `<li data-no-i18n>${x(d.url)} <span class="plugin-preview-warn">(${x(d.code || 'error')})</span></li>`;
    const already = d.alreadyInstalled ? ` <span class="sync-hint">(${t('pluginPreviewDepAlready')})</span>` : '';
    return `<li>${x(d.name)} <span class="sync-hint" data-no-i18n>${x(d.id)}</span>${already}</li>`;
  }).join('');
  return `<div class="plugin-preview-row"><span>${t('pluginPreviewDepsLabel')}</span><b>${deps.length}</b></div>
    <ul class="plugin-preview-files">${items}</ul>
    <div class="plugin-preview-warn">${t('pluginPreviewDepsWarn')}</div>`;
}

// Everything rendered here came off the internet a moment ago — every single
// field goes through x() before it touches an HTML string. This is the one
// place in the app where remote text is drawn as markup.
function pluginPreviewHtml(p) {
  const m = p.manifest;
  const at = p.host === 'gitlab' ? 'GitLab' : 'GitHub';
  const files = m.files.map((f) => `<li>${x(f)}</li>`).join('');
  const tables = (m.tables || []).length
    ? (m.tables || []).map((tb) => `<li>${x(tb.name)} <span class="sync-hint">(${tb.columns.map((c) => `${x(c.name)} ${x(String(c.type).toUpperCase())}`).join(', ')})</span></li>`).join('')
    : `<li class="sync-hint">—</li>`;
  return `
    <div class="plugin-preview">
      <div class="plugin-preview-head">
        <b>${x(m.name)}</b> <span class="sync-hint">v${x(m.version || '—')} · ${x(m.id)}</span>
        <div class="sync-hint">${at} · ${x(p.owner)}/${x(p.repo)}@${x(p.ref)} · ${x(p.manifestName)}</div>
      </div>
      <div class="plugin-preview-row"><span>${t('pluginPreviewEntry')}</span><b>${x(m.entry)}</b></div>
      <div class="plugin-preview-row"><span>${t('pluginPreviewFilesLabel')}</span><b>${m.files.length}</b></div>
      <ul class="plugin-preview-files">${files}</ul>
      <div class="plugin-preview-row"><span>${t('pluginPreviewTablesLabel')}</span><b>${(m.tables || []).length}</b></div>
      <ul class="plugin-preview-files">${tables}</ul>
      ${pluginPreviewGrantsHtml(m)}
      ${pluginPreviewDepsHtml(m)}
      <div class="plugin-preview-warn">${t('pluginPreviewWarn')}</div>
      <div class="plugin-preview-actions">
        ${p.alreadyInstalled
          ? `<span class="sync-hint">${t('pluginErrAlreadyInstalled')}</span>`
          : `<button class="btn btn-p btn-sm" id="plugin-install-btn" onclick="pluginInstallClick()">${t('pluginConfirmInstall')}</button>`}
        <button class="btn btn-d btn-sm" onclick="pluginPreviewClear()">${t('cancel')}</button>
      </div>
    </div>`;
}

// Sends the URL, not the previewed manifest — src/db/plugin.js re-resolves and
// re-validates everything itself, so a stale or tampered preview can't widen
// what gets installed.
async function pluginInstallClick() {
  const url = S.pluginPreview?.url;
  if (!url) return toast(t('pluginErrBadUrl'), 'error');
  syncBtnBusy('#plugin-install-btn', true);
  const r = await api.plugin.install(url);
  syncBtnBusy('#plugin-install-btn', false);
  if (!r.ok) return pluginErrToast(r);
  toast(t('pluginInstalled'), 'ok');
  S.pluginUrlDraft = '';
  S.pluginPreview = null;
  pluginRefreshSection();
}

// Download one missing dependency. The URL is only a lookup key here — the
// main process re-checks it against the plugin's recorded plugin_dependency
// rows before installing anything, so this is not a second install door.
// Busy state is set on the clicked element rather than through syncBtnBusy,
// which takes a selector and there is one of these buttons per dependency.
async function pluginInstallDepClick(pluginId, url, btn) {
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = t('syncWorking'); }
  const r = await api.plugin.installDependency(pluginId, url);
  if (!r?.ok) {
    if (btn) { btn.disabled = false; if (btn.dataset.label) btn.textContent = btn.dataset.label; }
    return pluginErrToast(r);
  }
  toast(t('pluginInstalled'), 'ok');
  pluginRefreshSection();
}

async function pluginLaunchClick(id) {
  const r = await api.plugin.launch(id);
  if (!r.ok) return pluginErrToast(r);
  pluginRefreshSection();
}

async function pluginStopClick(id) {
  const r = await api.plugin.stop(id);
  if (!r.ok) return pluginErrToast(r);
  pluginRefreshSection();
}

async function pluginUninstallClick(id) {
  if (!(await uiConfirm(t('pluginUninstallConfirm')))) return;
  const r = await api.plugin.uninstall(id);
  if (!r.ok) return pluginErrToast(r);
  toast(t('pluginUninstalled'), 'ok');
  pluginRefreshSection();
}

// Setting window → Plugin → Plugin setting. No installed plugin's manifest
// declares a settings schema today — the dracondex-plugin.json format
// (docs/PLUGINS.md) has no such field yet — so this just lists what's
// installed with an empty state instead of inventing a settings UI for a
// schema that doesn't exist. Once a manifest gains a `settingsEntry`/
// `settingsSchema` field, that's what renders here per plugin instead of the
// placeholder line.
function settingPluginSettingsPageHtml() {
  pluginRefreshSettingsSection();
  return `<div class="settings-label">${t('settingPagePluginSettings')}</div><div id="plugin-settings-body">${t('syncWorking')}</div>`;
}
async function pluginRefreshSettingsSection() {
  const list = await api.plugin.list();
  const el = q('#plugin-settings-body');
  if (!el) return;
  el.innerHTML = list.length
    ? list.map((p) => `<div class="li"><span class="name">${x(p.name)}</span><span class="tag">${t('settingPluginNoSettings')}</span></div>`).join('')
    : `<div class="modal-hint">${I.info}<span>${t('pluginNoneInstalled')}</span></div>`;
}
registerSettingPage('plugin', 'pluginsettings', settingPluginSettingsPageHtml);
