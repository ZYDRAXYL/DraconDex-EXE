// Packages settings page — browse the DraconDex-PKG catalog, install a theme,
// locale or view preset, and manage what is installed.
//
// Same shape as plugin.js's page: register a renderer that returns a shell
// immediately and patches its own DOM once the async load resolves. The network
// itself happens in main (src/db/pkg.js) — index.html's CSP sets
// connect-src 'none', so this file never fetches anything.

function settingPkgPageHtml() {
  pkgRefreshInstalled();
  pkgRefreshCatalog();
  return `<div class="settings-label">${t('settingPagePackages')}</div>
    <div class="sync-hint">${t('pkgIntro')}</div>
    <div id="pkg-installed">${t('syncWorking')}</div>
    <div class="settings-label">${t('pkgAvailable')}</div>
    <div id="pkg-catalog">${t('syncWorking')}</div>`;
}
registerSettingPage('plugin', 'packages', settingPkgPageHtml);

const PKG_KIND_LABEL_KEY = { theme: 'pkgKindTheme', lang: 'pkgKindLang', view: 'pkgKindView', uistyle: 'pkgKindUistyle' };

function pkgDisplayName(p) {
  const lang = S.settings?.language || 'th';
  return p?.display?.[lang] || p?.displayName?.[lang] || p?.display?.en || p?.displayName?.en || p?.name || p?.id || '';
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------
async function pkgRefreshInstalled() {
  const list = await api.pkg.list();
  const el = q('#pkg-installed');
  if (!el) return; // page closed or switched before this resolved
  el.innerHTML = list.length
    ? list.map(pkgInstalledRowHtml).join('')
    : `<div class="modal-hint">${I.info}<span>${t('pkgNoneInstalled')}</span></div>`;
}

function pkgInstalledRowHtml(p) {
  const kind = t(PKG_KIND_LABEL_KEY[p.kind] || 'pkgKindTheme');
  return `
    <div class="sync-upload-row">
      <div>
        <b>${x(pkgDisplayName(p))}</b> <span class="sync-hint">v${x(p.version)}</span>
        <div class="sync-hint">${x(kind)} · ${x(p.source_release)} · ${x(p.pkg_id)}</div>
      </div>
      <div class="sync-upload-actions">
        ${p.kind === 'view'
          ? `<button class="btn btn-s btn-sm" onclick="pkgApplyViewClick('${x(p.pkg_id)}')">${t('pkgApply')}</button>`
          : `<button class="btn btn-s btn-sm" onclick="pkgUseClick('${x(p.pkg_id)}','${x(p.kind)}')">${t('pkgUse')}</button>`}
        <button class="btn btn-d btn-sm" onclick="pkgUninstallClick('${x(p.pkg_id)}')">${t('delete')}</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
async function pkgRefreshCatalog() {
  const r = await api.pkg.catalog();
  const el = q('#pkg-catalog');
  if (!el) return;
  if (!r?.ok) {
    // Advisory only, same silence convention as plugin.js's org-repo list: the
    // catalog is a nice-to-have, and being offline should not throw an error
    // toast at someone who only opened the settings page.
    el.innerHTML = `<div class="modal-hint">${I.info}<span>${t('pkgCatalogUnavailable')}</span></div>`;
    return;
  }
  const rows = r.packages.filter(p => !p.installedVersion || p.updateAvailable);
  el.innerHTML = rows.length
    ? `<div class="sync-hint">${x(r.release)}</div>` + rows.map(pkgCatalogRowHtml).join('')
    : `<div class="modal-hint">${I.info}<span>${t('pkgAllInstalled')}</span></div>`;
}

function pkgCatalogRowHtml(p) {
  const kind = t(PKG_KIND_LABEL_KEY[p.kind] || 'pkgKindTheme');
  const lang = S.settings?.language || 'th';
  const desc = p.description?.[lang] || p.description?.en || '';
  return `
    <div class="sync-upload-row">
      <div>
        <b>${x(pkgDisplayName(p))}</b> <span class="sync-hint">v${x(p.version)}</span>
        <div class="sync-hint">${x(kind)}${desc ? ` · ${x(desc)}` : ''}</div>
      </div>
      <div class="sync-upload-actions">
        <button class="btn btn-p btn-sm" id="pkg-install-${x(p.id)}" onclick="pkgInstallClick('${x(p.id)}')">
          ${p.updateAvailable ? t('pkgUpdate') : t('pkgInstall')}
        </button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
/** Shared by every "Download"/"Install" button, wherever it's drawn. */
async function pkgInstallCore(id, btnSel) {
  syncBtnBusy(btnSel, true);
  const r = await api.pkg.install(id);
  syncBtnBusy(btnSel, false);
  if (!r?.ok) { toast(pkgErrText(r), 'error'); return false; }
  await pkgReloadActive();
  toast(t('pkgInstalled'), 'success');
  return true;
}

async function pkgInstallClick(id) {
  if (!await pkgInstallCore(id, `#pkg-install-${id}`)) return;
  pkgRefreshInstalled();
  pkgRefreshCatalog();
}

/**
 * Install button drawn inline at a "choice" (Theme/UI style/Language picker)
 * rather than on the Packages page itself — Procress 10 part 2. Beyond the
 * shared install, this also refreshes the catalog cache those pickers read
 * (S.pkgCatalogCache) and re-renders the Setting window, so the row the user
 * just downloaded disappears from the locked list immediately instead of
 * only updating once the Packages page happens to be opened.
 */
async function pkgInstallInline(id, btnSel) {
  if (!await pkgInstallCore(id, btnSel)) return;
  const cat = await api.pkg.catalog().catch(() => null);
  if (cat) S.pkgCatalogCache = cat;
  renderSettingWindow();
}

/**
 * Catalog entries of `kind` that are (a) not installed and (b) not already
 * one of the app's own built-ins — Procress 10 part 2's "choice" pages only
 * ever need to show a genuine gap. Every package this repo has today is
 * named after a built-in (theme-atDusk, lang-ja, uistyle-fluent, …), so this
 * legitimately returns [] against the real catalog; it exists for the day a
 * package introduces something the app doesn't already ship for free.
 * `builtins` is one of UI_THEME_OPTIONS_BUILTIN / UI_STYLE_OPTIONS_BUILTIN /
 * UI_LANGUAGE_OPTIONS_BUILTIN. A not-yet-installed catalog entry carries no
 * payload (no `locale`/`name` — those only arrive once downloaded), so the
 * underlying name is derived from the package's own `<kind>-<name>` id
 * prefix, the convention every extracted package follows (theme-atDusk,
 * lang-ja, uistyle-fluent, …). An id that doesn't follow it fails the strip
 * and is treated as non-built-in (shown) — the safe default, since hiding a
 * genuinely new package over a naming quirk is worse than one
 * redundant-looking row.
 */
function pkgCatalogGap(kind, builtins) {
  const packages = S.pkgCatalogCache?.packages;
  if (!Array.isArray(packages)) return [];
  const prefix = `${kind}-`;
  return packages.filter(p => {
    if (p.kind !== kind || p.installedVersion) return false;
    const name = p.id.startsWith(prefix) ? p.id.slice(prefix.length) : null;
    return name === null || !builtins.includes(name);
  });
}

async function pkgUninstallClick(id) {
  if (!await uiConfirm(t('pkgConfirmUninstall'))) return;
  const r = await api.pkg.uninstall(id);
  if (!r?.ok) { toast(pkgErrText(r), 'error'); return; }
  // If the theme, uistyle or language being removed is the active one, fall
  // back to a built-in before the registry loses it — otherwise
  // applyUiSettings() lands on a palette/shape with nothing behind it.
  if (S.settings.theme === `pkg:${id}`) setUiSetting('theme', 'midnight');
  if (S.settings.uiStyle === `pkg:${id}`) setUiSetting('uiStyle', 'oldPlain');
  await pkgReloadActive();
  const langGone = !UI_LANGUAGE_OPTIONS.includes(S.settings.language);
  if (langGone) setUiSetting('language', 'th');
  toast(t('pkgUninstalled'), 'success');
  pkgRefreshInstalled();
  pkgRefreshCatalog();
}

function pkgUseClick(id, kind) {
  if (kind === 'theme') setUiSetting('theme', `pkg:${id}`);
  else if (kind === 'uistyle') setUiSetting('uiStyle', `pkg:${id}`);
  else if (kind === 'lang') {
    const l = INSTALLED_PACKAGES.langs.find(x => `pkg:${x.id}` === `pkg:${id}` || x.id === id);
    if (l) setUiSetting('language', l.locale);
  }
  toast(t('pkgApplied'), 'success');
}

function pkgApplyViewClick(id) {
  const v = INSTALLED_PACKAGES.views.find(x => x.id === id);
  if (!v?.settings) { toast(t('pkgErrInvalid'), 'error'); return; }
  // setUiSetting validates each key itself and silently drops anything it does
  // not recognise, so a view preset can never write a setting the app does not
  // understand — even though pkg.js already checked the same list in main.
  for (const [k, val] of Object.entries(v.settings)) setUiSetting(k, val);
  toast(t('pkgApplied'), 'success');
}

/** Re-read the active set and re-apply, so an install shows without a restart. */
async function pkgReloadActive() {
  const active = await api.pkg.active().catch(() => null);
  if (!active) return;
  loadInstalledPackages(active);
  applyUiSettings();
}

function pkgErrText(r) {
  const code = r?.code;
  if (code === 'network') return t('pkgErrNetwork');
  if (code === 'not_found') return t('pkgErrNotFound');
  if (code === 'checksum') return t('pkgErrChecksum');
  if (code === 'invalid') return t('pkgErrInvalid');
  if (code === 'too_large') return t('pkgErrTooLarge');
  return t('pkgErrGeneric');
}
