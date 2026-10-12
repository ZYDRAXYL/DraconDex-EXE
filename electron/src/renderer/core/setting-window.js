'use strict';
// The full "Setting window" (Plan.md part1 #Setting) — replaces the old
// Preferences floating panel. Two-level nav (group → page) instead of the
// old flat PREFS_SECTIONS sidebar. Each page is contributed by whichever
// file owns that feature (same "section-per-file" convention the old
// Preferences panel used for Backup/Extension) via registerSettingPage() —
// this file only owns the shell plus the Workspace → Theme/Text&Size pages
// that used to live in settings.js's Preferences panel code.
// 'tokensync' is listed only when cloudSyncAvailable() (state.js) says so —
// either the CLOUD_SYNC_ENABLED build flag, or the user having finished the
// Supabase Project setup page. The page itself is still registered by
// src/renderer/sync.js exactly as before; leaving it out of the list is what
// makes it unreachable, and openSettingWindow() already falls back to the
// group's first page if S.settingPage is a stale id.
//
// It is filtered in settingGroupPages() rather than here because this object
// is built once at parse time, before S.supabaseReady has been read back from
// the main process — a const array computed here would freeze the answer to
// "no" for the whole session.
//
// v5 Part 6 (APP docs/V5.md §10.3): 17 pages → 13. Four pairs that are one
// subject are shown as one page — each half keeps its own registered
// renderer, run one after the other (SETTING_PAGE_MERGE), so the files that
// register them (account.js, drive.js, plugin.js, db-transfer.js) did not
// change. An old id still opens the page it now lives on (SETTING_PAGE_ALIAS).
// Procress 24 (UX-LAYOUT §13): Appearance split in two again — theme + UI
// style, then Language & text — so neither needs scrolling to find; and
// "This Nexus" (name, colour, Locate folder) joins the group, so the open
// vault is changed here instead of from the Welcome window.
const SETTING_GROUPS = {
  workspace: ['theme', 'textsize', 'thisnexus', 'tooltoggle', 'style', 'startup'],
  user: ['account'],
  appdata: ['tokensync', 'transfer', 'database', 'cloudstorage', 'versions'],
  plugin: ['extension', 'plugin', 'packages'],
};
const SETTING_PAGE_MERGE = {
  account: ['account', 'profile'],
  database: ['database', 'backup'],
  plugin: ['plugin', 'pluginsettings'],
};
const SETTING_PAGE_ALIAS = { profile: 'account', backup: 'database', pluginsettings: 'plugin' };
function settingGroupPages(group){
  const pages = SETTING_GROUPS[group] || SETTING_GROUPS.workspace;
  return cloudSyncAvailable() ? pages : pages.filter(p => p !== 'tokensync');
}
const SETTING_GROUP_LABEL_KEY = {
  workspace: 'settingGroupWorkspace', user: 'settingGroupUser',
  appdata: 'settingGroupAppdata', plugin: 'settingGroupPlugin',
};
const SETTING_PAGE_LABEL_KEY = {
  theme: 'settingPageAppearance', textsize: 'settingPageTextSize', thisnexus: 'settingPageThisNexus', tooltoggle: 'settingPageToolToggle',
  style: 'settingPageWorkspaceStyle', startup: 'settingPageStartup',
  account: 'settingPageAccount', profile: 'settingPageProfile',
  tokensync: 'settingPageTokenSync', transfer: 'settingPageTransfer',
  database: 'settingPageDatabase', backup: 'prefs_backup',
  cloudstorage: 'settingPageCloudStorage', versions: 'settingPageVersions',
  plugin: 'prefs_plugin', pluginsettings: 'settingPagePluginSettings',
  packages: 'settingPagePackages', extension: 'settingPageExtension',
};
// Populated by each page's owning file at parse time — key is 'group.page'.
// A page renderer may be synchronous (returns final HTML) or kick off an
// async load and patch its own DOM once ready (the pattern drive.js/
// plugin.js already used for the old Preferences panel sections).
const SETTING_PAGE_RENDERERS = {};
function registerSettingPage(group, page, fn){
  SETTING_PAGE_RENDERERS[`${group}.${page}`] = fn;
}

// Process 7 part 2: which group.page was rendered last, so renderSettingWindow()
// can tell a same-page value change (restore scroll) apart from a tab switch
// (start at top, same as opening the window fresh) — reset on open so the
// window always starts at the top the moment it's shown.
let _settingWindowLastKey = null;
// Procress 24 (UX-LAYOUT §13.1): Settings opens on the page that fits where
// it was opened from (the caller names it); opened plainly — the ⚙ — it is
// Appearance, always, not whichever page was looked at last.
function openSettingWindow(group, page){
  page = SETTING_PAGE_ALIAS[page] || page;
  if (!group) { group = 'workspace'; page = 'theme'; }
  S.settingGroup = group;
  const pages = settingGroupPages(S.settingGroup);
  S.settingPage = page && pages.includes(page) ? page : pages[0];
  _settingWindowLastKey = null;
  openFloatingPanel('setting-window', `${I.settings} ${t('settingWindowTitle')}`, settingWindowBodyHtml(), {width:1040, height:680});
  _settingWindowLastKey = `${S.settingGroup}.${S.settingPage}`;
}
function selectSettingPage(group, page){
  S.settingGroup = group;
  S.settingPage = SETTING_PAGE_ALIAS[page] || page;
  renderSettingWindow();
}
function renderSettingWindow(){
  const body = q('#setting-window .fp-body');
  if(!body) return;
  const key = `${S.settingGroup}.${S.settingPage}`;
  const samePage = key === _settingWindowLastKey;
  const content = q('#setting-window .setting-content');
  const bodyScroll = samePage ? body.scrollTop : 0;
  const contentScroll = samePage && content ? content.scrollTop : 0;
  body.innerHTML = settingWindowBodyHtml();
  _settingWindowLastKey = key;
  body.scrollTop = bodyScroll;
  const newContent = q('#setting-window .setting-content');
  if(newContent) newContent.scrollTop = contentScroll;
  // procress1 part3: the floating-panel title itself is baked in once by
  // openFloatingPanel (data-no-i18n, exempt from the auto-translate DOM
  // walk) — refresh it here too so a language change updates it immediately
  // instead of only on next open.
  const head = q('#setting-window .fp-head span');
  if(head) head.innerHTML = `${I.settings} ${t('settingWindowTitle')}`;
}
function settingWindowNavHtml(){
  // Plan part2 "session head": every group's page list stays open (no more
  // single-open accordion), and the group header is plain text now that
  // clicking it has nothing left to toggle — page rows below are the only
  // way to select a page. Procress 21: compact rows of the shared list
  // (core/list.js), the open page as the selected row.
  return listHtml({ list: 'setting-nav', aria: t('settingWindowTitle'), body: Object.keys(SETTING_GROUPS).map(g => {
    const openGroup = S.settingGroup === g;
    const rows = settingGroupPages(g).map(p => listRowHtml({ density: 'compact', title: t(SETTING_PAGE_LABEL_KEY[p]),
      state: { selected: openGroup && S.settingPage === p }, onclick: `selectSettingPage('${g}','${p}')` })).join('');
    return listGroupHtml({ list: 'setting-nav', id: g, title: t(SETTING_GROUP_LABEL_KEY[g]), rows, collapsible: false });
  }).join('') });
}
function settingWindowBodyHtml(){
  const parts = (SETTING_PAGE_MERGE[S.settingPage] || [S.settingPage])
    .map(p => SETTING_PAGE_RENDERERS[`${S.settingGroup}.${p}`]).filter(Boolean);
  // G5 (core/setting-search.js): a query shows the results in place of the page.
  const query = String(S.settingQuery || '').trim();
  const content = query ? settingSearchResultsHtml(query) : parts.length
    ? parts.map(fn => fn()).join('<div class="setting-merge-sep"></div>')
    : `<div class="empty"><p>${t('syncWorking')}</p></div>`;
  const search = `<div class="fg setting-search"><input type="search" value="${x(S.settingQuery || '')}" placeholder="${x(t('settingSearch'))}" oninput="onSettingSearch(this.value)"></div>`;
  return `<div class="setting-shell"><div class="setting-sidebar">${search}${settingWindowNavHtml()}</div><div class="setting-content">${content}</div></div>`;
}

// ═══ Workspace → Theme (moved from settings.js's old Preferences panel) ══
// `onclick` and `tools` both default to the Setting window's own behavior, so
// every existing call site is unchanged. The first-run wizard (core/welcome.js)
// overrides both: it needs its own handler to re-render the wizard after the
// theme applies, and the duplicate/edit tools have no place in a setup step.
// The mini app mockup a theme card draws from a palette. Shared by installed
// cards and, since the catalog carries `preview.vars`, by not-yet-downloaded
// ones — so a locked theme shows its real colours before download.
function themeMockupHtml(vars){
  return `<div class="ctm-preview mini" style="background:${x(vars['--bg'])};border-color:${x(vars['--border'])}">
      <div class="ctm-pv-side" style="background:${x(vars['--surface'])}">
        <i class="ctm-pv-acc" style="background:${x(vars['--accent'])}"></i>
        <i style="background:${x(vars['--raised'])}"></i>
        <i style="background:${x(vars['--raised'])}"></i>
      </div>
      <div class="ctm-pv-main">
        <span class="ctm-pv-txt w80" style="color:${x(vars['--t2'])}"></span>
        <span class="ctm-pv-txt w60" style="color:${x(vars['--t3'])}"></span>
        <span class="ctm-pv-btn" style="background:${x(vars['--accent'])}"></span>
      </div>
    </div>`;
}
function settingThemeGridCellHtml(key, name, vars, {active, isCustom, onclick, tools = true} = {}){
  const rawId = isCustom ? key.split(':')[1] : null;
  return `<div class="prefs-theme-cell${active?' active':''}"${isCustom ? '' : ` data-preview-theme="${x(key)}"`} onclick="${onclick || `setUiSetting('theme','${key}')`}">
    ${themeMockupHtml(vars)}
    <div class="prefs-theme-name" data-no-i18n>${x(name)}</div>
    ${tools ? `<div class="prefs-theme-tools">
      <span onclick="event.stopPropagation();duplicateTheme(${xj(key)})" title="${t('duplicate')}">⧉</span>
      ${isCustom ? `<span onclick="event.stopPropagation();openCustomThemeModal(${xj(rawId)})" title="${t('edit')}">${I.edit}</span>
                    <span onclick="event.stopPropagation();deleteCustomTheme(${xj(rawId)})" title="${t('delete')}">×</span>` : ''}
    </div>` : ''}
    ${active ? `<span class="prefs-theme-check">${I.check}</span>` : ''}
  </div>`;
}
// Procress 10 part 1: "Theme" (Workspace group) renamed to "Appearance" and
// split into two independently-collapsible subsections — the existing theme
// grid, and a new UI-style (shape/elevation) picker. Both use the same
// "boolean on S + renderSettingWindow()" idiom toggleSettingAdvanced()
// already established on the Text&Size page, but as their own flags: sharing
// one flag across two unrelated sections on two different pages would expand
// one every time the other is opened.
function settingThemePageHtml(){
  return `<div class="settings-label">${t('settingPageAppearance')}</div>
    ${settingThemeSectionHtml()}
    ${settingUiStyleSectionHtml()}`;
}
registerSettingPage('workspace', 'theme', settingThemePageHtml);

// Collapsed shows only the 3 basic built-ins (UI_THEME_OPTIONS_BUILTIN's
// first three: daylight/moonlight/midnight); expanded shows every theme,
// built-in and PKG-installed alike (getThemePalettes() already spans both —
// core/settings.js's applyInstalledPackages extends UI_THEME_OPTIONS in
// place). Custom themes and the add-box are never hidden behind the
// collapse — hiding a user's own saved theme would look like data loss.
// Procress 10 part 2: a catalog theme package not yet downloaded, shown
// locked (no onclick-to-select) with an inline Download button in place of
// the swatch preview — the payload/colors only exist once installed, so
// there's nothing real to preview here.
function settingThemeCatalogCellHtml(p){
  const btnSel = `#pkg-inline-${p.id}`;
  if (p.appTooOld) return `<div class="prefs-theme-cell locked" title="${x(pkgNeedsAppText(p))}">
    <div class="ctm-preview mini prefs-theme-cell-lockglyph">${I.info}</div>
    <div class="prefs-theme-name" data-no-i18n>${x(pkgDisplayName(p))}</div>
  </div>`;
  // The catalog's preview.vars (validated in main) is enough to draw the real
  // mockup; an entry without one (older catalog) keeps the plain glyph.
  const pv = p.preview?.vars;
  const mock = pv ? themeMockupHtml(pv) : `<div class="ctm-preview mini prefs-theme-cell-lockglyph">${I.import}</div>`;
  return `<div class="prefs-theme-cell locked${pv ? ' has-preview' : ''}" title="${t('pkgPreviewHint')}">
    ${mock}
    <div class="prefs-theme-name" data-no-i18n>${x(pkgDisplayName(p))}</div>
    <button class="btn btn-p btn-i btn-i-sm prefs-theme-dl" id="pkg-inline-${x(p.id)}" onclick="event.stopPropagation();pkgInstallInline('${x(p.id)}','${btnSel}')" title="${t('pkgInstall')}">${I.import}</button>
  </div>`;
}
function settingThemeSectionHtml(){
  const expanded = !!S.settingThemeExpanded;
  const palettes = getThemePalettes();
  const shownBuiltins = expanded ? UI_THEME_OPTIONS : UI_THEME_OPTIONS_BUILTIN.slice(0, 3);
  const builtins = shownBuiltins.map(key =>
    settingThemeGridCellHtml(key, themeOptionLabel(key), palettes[key] || {}, {active: S.settings.theme === key})
  ).join('');
  const customs = (S.settings.customThemes || []).map(ct =>
    settingThemeGridCellHtml(`custom:${ct.id}`, ct.name, ct.vars || {}, {active: S.settings.theme === `custom:${ct.id}`, isCustom: true})
  ).join('');
  // Procress 24: a card that says what it is — "Your themes" over "Create
  // custom theme" — not a bare +; and a real button for the keyboard.
  const addBox = `<div class="prefs-theme-cell prefs-theme-add" role="button" tabindex="0" onclick="openCustomThemeModal()"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}" title="${t('customThemeNew')}" aria-label="${t('customThemeNew')}">
    <span class="prefs-theme-add-group">${t('themeGroupCustom')}</span>${I.plus}<span class="prefs-theme-add-label">${t('customThemeNew')}</span></div>`;
  // Not-yet-downloaded catalog themes only ever show once expanded — the
  // collapsed 3-slot view is reserved for the app's own basics, same rule
  // custom themes already follow just above.
  const notDownloaded = expanded
    ? pkgCatalogGap('theme', UI_THEME_OPTIONS_BUILTIN).map(settingThemeCatalogCellHtml).join('') : '';
  return `<div class="settings-group">
      <div class="settings-label-row">
        <span class="settings-label">${t('theme')}</span>
        <button class="btn btn-s btn-sm" onclick="toggleSettingThemeExpanded()">${expanded ? t('settingCollapse') : t('settingShowAll')}</button>
      </div>
      <div class="prefs-theme-grid">${builtins}${customs}${addBox}${notDownloaded}</div>
    </div>`;
}
function toggleSettingThemeExpanded(){
  S.settingThemeExpanded = !S.settingThemeExpanded;
  renderSettingWindow();
}

// UI style (Procress 10 part 1, new) — shape/elevation preset, see
// state.js's UI_STYLE_OPTIONS and css/ui-style.css. Collapsed shows the
// first 3 options; expanded shows the rest plus, since the Procress 10 part 2
// slim, the catalog's not-yet-downloaded presets as locked rows. The label
// map still lists the three that became packages — pkgLocalName() reads it so
// they keep their translated names.
const UI_STYLE_LABEL_KEY = {
  roundedMinimal: 'uiStyleRoundedMinimal', cleanMinimal: 'uiStyleCleanMinimal',
  fluent: 'uiStyleFluent', hardBlock: 'uiStyleHardBlock', oldPlain: 'uiStyleOldPlain',
  glass: 'uiStyleGlass',
};
// Procress 23: a built-in style's sample — the glass one shows a frosted pane
// over the current theme's backdrop (css/glass.css), the others their shape.
function uiStyleSampleHtml(key){
  return `<span class="uistyle-sample${key === 'glass' ? ' glass-sample' : ''}" aria-hidden="true"><i></i></span>`;
}
// Procress 10 part 2: a catalog uistyle package not yet downloaded — locked,
// no onclick, Download button where the checkmark slot would be.
function settingUiStyleCatalogItemHtml(p){
  const btnSel = `#pkg-inline-${p.id}`;
  // Procress 23: made for a newer app (minAppVersion) — say so, no Download.
  if (p.appTooOld) return listRowHtml({ title: pkgDisplayName(p), meta: pkgNeedsAppText(p), state: { disabled: true }, attrs: 'data-no-i18n' });
  // A shape sample drawn from the catalog's preview.vars: the preset's own
  // corner radius and popup shadow, on the current theme's colours.
  const pv = p.preview?.vars;
  const sample = pv
    ? `<span class="uistyle-sample" style="border-radius:${x(pv['--rl'])};box-shadow:${x(pv['--shadow-pop'])}"><i style="border-radius:${x(pv['--rs'])}"></i></span>` : '';
  return listRowHtml({ lead: sample, title: pkgDisplayName(p), tip: t('pkgPreviewHint'), state: { disabled: true }, attrs: 'data-no-i18n',
    trailing: `<button class="btn btn-p btn-i btn-i-sm" id="pkg-inline-${x(p.id)}" onclick="event.stopPropagation();pkgInstallInline('${x(p.id)}','${btnSel}')" title="${t('pkgInstall')}" aria-label="${t('pkgInstall')}">${I.import}</button>` });
}
function settingUiStyleSectionHtml(){
  const expanded = !!S.settingUiStyleExpanded;
  const shown = expanded ? UI_STYLE_OPTIONS : UI_STYLE_OPTIONS.slice(0, 3);
  const current = S.settings.uiStyle || 'oldPlain';
  const cells = shown.map((key) => {
    const active = current === key;
    // Built-ins resolve through UI_STYLE_LABEL_KEY's i18n keys as before; an
    // installed pkg: uistyle has no such key, so it shows its own
    // displayName (pkgDisplayName, same helper pkg.js's Packages page uses),
    // falling back to the raw key if that lookup somehow comes up empty.
    const label = UI_STYLE_LABEL_KEY[key]
      ? t(UI_STYLE_LABEL_KEY[key])
      : pkgDisplayName(INSTALLED_PACKAGES.uistyles.find(u => `pkg:${u.id}` === key)) || key;
    return listRowHtml({ lead: UI_STYLE_LABEL_KEY[key] ? uiStyleSampleHtml(key) : '', title: label, state: { selected: active }, onclick: `setUiSetting('uiStyle','${key}')`,
      meta: key === 'glass' ? t('uiStyleGlassHint') : '',
      attrs: UI_STYLE_LABEL_KEY[key] ? '' : 'data-no-i18n', trailing: active ? `<span class="theme-check">${I.check}</span>` : '' });
  }).join('');
  const notDownloaded = expanded
    ? pkgCatalogGap('uistyle', UI_STYLE_OPTIONS_BUILTIN).map(settingUiStyleCatalogItemHtml).join('') : '';
  return `<div class="settings-group">
      <div class="settings-label-row">
        <span class="settings-label">${t('settingUiStyle')}</span>
        <button class="btn btn-s btn-sm" onclick="toggleSettingUiStyleExpanded()">${expanded ? t('settingCollapse') : t('settingShowAll')}</button>
      </div>
      ${listHtml({ list: 'uistyles', aria: t('settingUiStyle'), body: cells + notDownloaded })}
      ${settingReduceTransparencyHtml()}
    </div>`;
}
// Procress 23: app-wide, not glass-only — it also turns fluent's Acrylic and
// the dimmed scrims behind dialogs solid. The OS setting applies on its own.
function settingReduceTransparencyHtml(){
  const on = !!S.settings.reduceTransparency;
  return `<div class="togglerow setting-switch" role="switch" tabindex="0" aria-checked="${on}" onclick="setUiSetting('reduceTransparency', ${!on})"
    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"><span class="tg${on ? ' on' : ''}"></span>${t('settingReduceTransparency')}</div>`;
}
function toggleSettingUiStyleExpanded(){
  S.settingUiStyleExpanded = !S.settingUiStyleExpanded;
  renderSettingWindow();
}

// ═══ Workspace → Text&Size (language + UI size + font size merged, plus
// an Advanced reveal carrying the per-area size sliders and — since they
// had no other home in the new structure — the shortcuts/tour help block
// and the per-module version-history limit) ═══════════════════════════
const SETTING_LANG_PREVIEW_KEYS = ['settings', 'theme', 'uiSize', 'kcFolder', 'kcProject', 'kcCategory', 'edit', 'delete'];
function settingPreviewLangStrings(lang){
  return SETTING_LANG_PREVIEW_KEYS.map(k => L[lang]?.[k] || L.en[k] || k);
}
function settingLangPreviewHtml(lang){
  return settingPreviewLangStrings(lang).map(s => `<div data-no-i18n>${x(s)}</div>`).join('');
}
function settingPreviewLang(lang){
  S.settingPreviewLang = lang;
  // Procress 19 F8: only the saved language is parsed at boot — load the
  // hovered one, then draw it if the pointer is still on it.
  if (!i18nLoaded(lang)) return i18nLoad(lang).then(() => { if (S.settingPreviewLang === lang) settingPreviewLang(lang); });
  const el = q('.prefs-lang-preview');
  if (el) el.innerHTML = settingLangPreviewHtml(lang);
}
// Per-area UI scale (Plan part1 #Setting, the "advanced" reveal): every text/icon size in
// the app already resolves through `calc(Npx * var(--fsc,1))` (300+ rules,
// see tokens.css) — so overriding `--fsc` as an inline style on just the
// area's own container reuses all of them for free instead of touching any
// component stylesheet. 100% = no override (falls back to the inherited/
// global font scale from applyUiSettings()).
const SETTING_AREA_CONTAINERS = {
  leftPanel: ['#left-panel'],
  navSidebar: ['#nav-sidebar'],
  builder: ['#main-area'], // a top-row pane's tabs are in #main-area too, lifted onto the title bar
};
function applyAreaScales(){
  const areas = S.settings.areaScale || {};
  const globalFsc = (S.settings.fontScale || 100) / 100;
  for (const key of Object.keys(SETTING_AREA_CONTAINERS)) {
    const pct = Number(areas[key]);
    const value = Number.isFinite(pct) && pct !== 100 ? String(globalFsc * (pct / 100)) : null;
    for (const sel of SETTING_AREA_CONTAINERS[key]) {
      const el = q(sel);
      if (!el) continue;
      if (value) el.style.setProperty('--fsc', value);
      else el.style.removeProperty('--fsc');
    }
  }
}
function setAreaScale(key, value){
  const v = Math.min(150, Math.max(50, Math.round(Number(value) || 100)));
  S.settings.areaScale = Object.assign({}, S.settings.areaScale, { [key]: v });
  saveUiSettings();
  applyAreaScales();
  renderSettingWindow();
}
// Shared by every size row in the Advanced reveal (Plan part2 #1) — a slider
// and a number input in one row (5:1 width ratio via .size-slider-row CSS),
// synced live by writing straight to the sibling on oninput; onchange still
// calls the same setter each row already used, so persistence is unchanged.
function sliderNumberRowHtml(labelHtml, { min, max, step = 1, value, commit }) {
  return `<div class="fg"><label>${labelHtml}</label>
    <div class="size-slider-row">
      <input class="settings-slider" type="range" min="${min}" max="${max}" step="${step}" value="${value}" oninput="this.nextElementSibling.value=this.value" onchange="${commit}">
      <input class="settings-number" type="number" min="${min}" max="${max}" value="${value}" oninput="this.previousElementSibling.value=this.value" onchange="${commit}">
    </div></div>`;
}
// Procress 10 part 2: a catalog lang package not yet downloaded — locked,
// no hover preview / onclick select, Download button in place of the
// checkmark slot.
function settingLangCatalogItemHtml(p){
  const btnSel = `#pkg-inline-${p.id}`;
  return listRowHtml({ title: pkgDisplayName(p), state: { disabled: true }, attrs: 'data-no-i18n',
    trailing: `<button class="btn btn-p btn-i btn-i-sm" id="pkg-inline-${x(p.id)}" onclick="event.stopPropagation();pkgInstallInline('${x(p.id)}','${btnSel}')" title="${t('pkgInstall')}" aria-label="${t('pkgInstall')}">${I.import}</button>` });
}
// Procress 21: one language row of the shared list (core/list.js) — its own
// name, and as meta its name in the language the app speaks now. Hovering
// it previews the language (data-preview-lang, core/settings.js).
function langNameHere(lang) {
  try { const n = new Intl.DisplayNames([S.settings.language], { type: 'language' }).of(lang); return n && n !== lang ? n : ''; } catch (_) { return ''; }
}
function langRowHtml(lang, onclick) {
  const on = S.settings.language === lang;
  return listRowHtml({ title: LANGUAGE_LABELS[lang], meta: langNameHere(lang), state: { selected: on }, onclick, attrs: `data-preview-lang="${lang}" data-no-i18n`,
    trailing: on ? `<span class="theme-check">${I.check}</span>` : '' });
}
function settingTextSizePageHtml(){
  const rows = listHtml({ list: 'langs', aria: t('language'), body: UI_LANGUAGE_OPTIONS.map(lang => langRowHtml(lang, `setUiSetting('language','${lang}')`)).join('')
    + pkgCatalogGap('lang', UI_LANGUAGE_OPTIONS_BUILTIN).map(settingLangCatalogItemHtml).join('') });
  const areaRows = Object.keys(SETTING_AREA_CONTAINERS).map(key =>
    sliderNumberRowHtml(`${t('settingArea_'+key)} (%)`, { min: 50, max: 150, value: (S.settings.areaScale||{})[key] ?? 100, commit: `setAreaScale('${key}', this.value)` })).join('');
  return `<div class="settings-label">${t('language')}</div>
    <div class="prefs-lang-shell">
      <div class="lang-list">${rows}</div>
      <div class="prefs-lang-preview">${settingLangPreviewHtml(S.settingPreviewLang || S.settings.language)}</div>
    </div>
    <div class="settings-group">
      <div class="settings-label">${t('moduleNameMode')}</div>
      ${nameModeSegHtml()}
      ${nameModeCompareListHtml()}
    </div>
    <div class="settings-group">
      <div class="settings-label">${t('fontSize')}</div>
      ${fontSizeSliderHtml()}
    </div>
    <button class="btn ${S.settingAdvanced ? 'btn-p' : 'btn-s'}" onclick="toggleSettingAdvanced()">${t('advanced')}</button>
    ${S.settingAdvanced ? `<div class="prefs-advanced">
      ${sliderNumberRowHtml(`${t('fontSize')} (%)`, { min: 80, max: 130, step: 5, value: S.settings.fontScale || 100, commit: "setUiSetting('fontScale', this.value)" })}
      <div class="settings-label">${t('settingAreaScale')}</div>
      ${areaRows}
      <div class="settings-label">${t('help')}</div>
      <div class="setting-wide-btns"><button class="btn btn-s" onclick="openShortcutsModal()">${I.info} ${t('shortcuts')}</button>
      <button class="btn btn-s" onclick="replayGuideTour()">${I.book} ${t('replayTour')}</button></div>
    </div>` : ''}`;
}
function toggleSettingAdvanced(){
  S.settingAdvanced = !S.settingAdvanced;
  renderSettingWindow();
}
registerSettingPage('workspace', 'textsize', settingTextSizePageHtml);

// ═══ Workspace → This Nexus (Procress 24) ═══════════════════════════════
// The open vault's name, memo, colour, file and Locate folder — the same
// fields as its Edit modal (nexusEditFieldsHtml, core/nexus.js), and the same
// saveNexus(). Async (the colour picker reads the palette), so it patches its
// own box once ready, like the plugin and package pages.
function settingThisNexusPageHtml(){
  const n = S.nexus;
  if (!n) return `<div class="settings-label">${t('settingPageThisNexus')}</div><p class="drafter-hint">${t('nexusEmpty')}</p>`;
  nexusEditFieldsHtml(n.id).then((html) => {
    const el = q('#setting-thisnexus');
    if (!el || S.settingPage !== 'thisnexus') return;
    el.innerHTML = `${html}<div class="mfoot"><button class="btn btn-p" onclick="saveNexus(${n.id})">${t('save')}</button></div>`;
  }).catch(() => {});
  return `<div class="settings-label">${t('settingPageThisNexus')}</div><div id="setting-thisnexus">${t('syncWorking')}</div>`;
}
registerSettingPage('workspace', 'thisnexus', settingThisNexusPageHtml);
