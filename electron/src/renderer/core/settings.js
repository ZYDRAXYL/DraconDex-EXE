// UI settings + the surfaces that edit them: t()/tr() translation lookup,
// load/save/apply of the settings blob, font & UI scale, the gear dropdown,
// the shortcuts modal and the Preferences panel (theme / language / size).
function t(key){
  const lang = S.settings?.language || 'th';
  return L[lang]?.[key] || L.en[key] || key;
}

// Translate a source UI string (Thai or English) through COMMON_UI_TEXT.
// Used for strings rendered outside the DOM observer's reach (toasts,
// confirm dialogs, modal titles) so they translate immediately.
function tr(text){
  const lang = S.settings?.language || 'th';
  const entry = COMMON_UI_TEXT[String(text)];
  if(!entry) return text;
  return entry[lang] || (lang === 'th' ? text : (entry.en || text));
}

function saveUiSettings(){
  localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(S.settings));
}

function applyUiSettings(){
  // custom themes (Phase 22): data-theme 'custom' + the 10 palette tokens
  // as inline CSS vars; built-ins clear them and use style.css rules.
  const custom = String(S.settings.theme).startsWith('custom:')
    ? (S.settings.customThemes || []).find(ct => `custom:${ct.id}` === S.settings.theme) : null;
  // A theme installed from DraconDex-PKG applies exactly like a user-made
  // custom one — inline CSS variables on <body>, under data-theme="custom".
  // index.html's CSP is why: connect-src 'none' and style-src 'self' mean a
  // downloaded stylesheet can be neither fetched here nor <link>ed, so a
  // package's palette has to arrive as data and be set as properties.
  const installed = String(S.settings.theme).startsWith('pkg:')
    ? installedThemeVars(S.settings.theme) : null;
  const vars = custom?.vars || installed;
  document.body.dataset.theme = (custom || installed) ? 'custom' : S.settings.theme;
  for (const tok of CUSTOM_THEME_TOKENS) {
    if (vars && vars[tok]) document.body.style.setProperty(tok, vars[tok]);
    else document.body.style.removeProperty(tok);
  }
  document.documentElement.style.setProperty('--fsc', String((S.settings.fontScale || 100) / 100));
  // Process 7 part 1: speed preset for the toggle-animation keyframes below
  // (nav-hub.css/inspector.css) — a single token so every consumer picks up
  // a speed change live, same idiom as --fsc/--ui-scale.
  document.documentElement.style.setProperty('--anim-dur', ANIM_SPEED_MS[S.settings.animationSpeed] ? `${ANIM_SPEED_MS[S.settings.animationSpeed]}ms` : '.15s');
  document.documentElement.lang = S.settings.language;
  const scale = S.settings.size / 100;
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  document.body.style.zoom = String(scale);
  if(scale !== 1){
    document.body.style.height = `${(100 / scale).toFixed(4)}vh`;
    document.body.style.width  = `${(100 / scale).toFixed(4)}vw`;
  } else {
    document.body.style.height = '';
    document.body.style.width  = '';
  }
}

function setUiSetting(key, value){
  const isCustomTheme = String(value).startsWith('custom:') &&
    (S.settings.customThemes || []).some(ct => `custom:${ct.id}` === value);
  // UI_THEME_OPTIONS already carries `pkg:<id>` for every installed theme
  // package (state.js's applyInstalledPackages extends it in place), so an
  // installed theme passes this gate without a second condition.
  if(key === 'theme' && !UI_THEME_OPTIONS.includes(value) && !isCustomTheme) return;
  if(key === 'nameMode' && !['unique','classic'].includes(value)) return;
  if(key === 'fontScale'){
    value = Math.min(130, Math.max(80, Math.round(Number(value) || 100)));
  }
  if(key === 'language' && !UI_LANGUAGE_OPTIONS.includes(value)) return;
  if(key === 'size'){
    value = Number(value);
    if(!Number.isFinite(value)) return;
    value = Math.min(UI_SIZE_MAX, Math.max(UI_SIZE_MIN, Math.round(value)));
  }
  S.settings[key] = value;
  saveUiSettings();
  applyUiSettings();
  renderSettingsMenu();
  // procress1 part3: #prefs-panel was the old Preferences floating panel,
  // replaced by the Setting window — this guard checked an element that no
  // longer exists, silently skipping the refresh renderSettingWindow() now
  // does; it already no-ops when the panel isn't open.
  renderSettingWindow();
  translateStaticChrome();
  renderProjectTabs();
  if(key === 'language') switchView(S.view || 'projects');
  // the name-mode toggle relabels nest badges / tabs / inspector / status
  // bar instantly (Phase 22 acceptance)
  if(key === 'nameMode' && S.view === 'nexus' && !S.activeModule){ renderNexusHome(); updateStatusBar({}); }
  toast(t('applied'),'ok');
}

function setFontScaleFromSlider(value){
  const v = Math.min(130, Math.max(80, Math.round(Number(value) || 100)));
  S.settings.fontScale = v;
  saveUiSettings();
  document.documentElement.style.setProperty('--fsc', String(v / 100));
  const el = q('#settings-font-value');
  if(el) el.textContent = `${v}%`;
}

function setUiSizeFromSlider(value){
  const size = Math.min(UI_SIZE_MAX, Math.max(UI_SIZE_MIN, Math.round(Number(value) || 100)));
  S.settings.size = size;
  saveUiSettings();
  applyUiSettings();
  const valueEl = q('#settings-size-value');
  if(valueEl) valueEl.textContent = `${size}%`;
}

function updateUiSizeLabel(value){
  const size = Math.min(UI_SIZE_MAX, Math.max(UI_SIZE_MIN, Math.round(Number(value) || 100)));
  const valueEl = q('#settings-size-value');
  if(valueEl) valueEl.textContent = `${size}%`;
}

// Read each theme's live palette straight from the CSS variables so the
// settings picker never drifts from style.css. We briefly swap body's
// data-theme to sample the computed vars, then restore it — all synchronous,
// so the browser never paints an intermediate theme. Result is cached.
let THEME_PALETTE_CACHE = null;
const THEME_SWATCH_VARS = ['--bg','--raised','--accent','--accentH','--t1']; // quick-dropdown swatch strip
function getThemePalettes(){
  if(THEME_PALETTE_CACHE) return THEME_PALETTE_CACHE;
  const body = document.body;
  const prev = body.dataset.theme;
  const cache = {};
  for(const theme of UI_THEME_OPTIONS){
    body.dataset.theme = theme;
    const cs = getComputedStyle(body);
    // Full CUSTOM_THEME_TOKENS superset (not just THEME_SWATCH_VARS) so the
    // Preferences theme-grid mockup (Plan part3) can use the same cache.
    cache[theme] = Object.fromEntries(CUSTOM_THEME_TOKENS.map(tok => [tok, cs.getPropertyValue(tok).trim()]));
  }
  if(prev === undefined) delete body.dataset.theme; else body.dataset.theme = prev;
  THEME_PALETTE_CACHE = cache;
  return cache;
}

// Shared by the quick settings dropdown and the Preferences panel (Plan
// part3) so both surfaces render the identical control from one source.
function nameModeSegHtml(){
  return `<div class="name-mode-seg">
    <button class="btn ${S.settings.nameMode !== 'classic' ? 'btn-p' : 'btn-s'}" onclick="setUiSetting('nameMode','unique')" data-no-i18n>Unique</button>
    <button class="btn ${S.settings.nameMode === 'classic' ? 'btn-p' : 'btn-s'}" onclick="setUiSetting('nameMode','classic')" data-no-i18n>Classic</button>
  </div>
  <div class="settings-hint">${t('moduleNameModeHint')}</div>`;
}
// Read-only compare view (Plan part2 #3) alongside the toggle above — every
// kind's name in both vocabularies at once, so a user can see the full list
// before switching. Same two-column markup as the wizard's picker
// (welcomeStepNamesHtml, core/welcome.js) but with the onclick/active-state
// removed: nameModeSegHtml() above is still the only thing that switches
// nameMode, this is purely informational.
function nameModeCompareListHtml(){
  const kinds = Object.keys(KIND_CLASSIC_KEY);
  const uniqueName = k => (typeof KIND_LABEL !== 'undefined' && KIND_LABEL[k]) || k;
  const box = (label, nameOf) => `
    <div class="welcome-name-box">
      <div class="welcome-name-head" data-no-i18n>${label}</div>
      <div class="welcome-name-list" onscroll="welcomeSyncNameScroll(this)">
        ${kinds.map(k => `<div class="welcome-name-row" data-no-i18n>${x(nameOf(k))}</div>`).join('')}
      </div>
    </div>`;
  return `<div class="welcome-name-cols setting-name-cols">
    ${box('Unique', uniqueName)}
    ${box('Classic', k => t(KIND_CLASSIC_KEY[k]))}
  </div>`;
}
// UI size (--ui-scale, overall zoom) moved to Workspace → Style (Process 7
// part 2) — it's a layout/UI concern, not a text one. Only the font-size
// slider stays on the Text & Size page now.
function fontSizeSliderHtml(){
  return `
    <div class="settings-group">
      <div class="settings-label settings-label-row">
        <span>${t('fontSize')}</span>
        <span id="settings-font-value">${S.settings.fontScale || 100}%</span>
      </div>
      <input class="settings-slider" type="range" min="80" max="130" step="5" value="${S.settings.fontScale || 100}" oninput="setFontScaleFromSlider(this.value)">
      <div class="settings-slider-scale"><span>80%</span><span>100%</span><span>130%</span></div>
    </div>`;
}

// Trimmed to Plan.md's "quick setting" default (part1 #Setting): language +
// module name-mode + UI size + a button into the full Setting window only.
// Everything else (theme grid, font size, version limit, help) moved into
// Setting-window pages (src/renderer/core/setting-window.js) — reachable
// from there, not cluttering the fast popup. Optional extra blocks (today:
// theme/account/profile) can be opted back into this popup via the Setting
// window's Workspace → Tool toggle page (S.settings.quickExtras).
function renderSettingsMenu(){
  const menu = q('#settings-menu');
  if(!menu) return;
  const languageOptions = UI_LANGUAGE_OPTIONS.map(lang =>
    `<option value="${lang}" ${S.settings.language===lang?'selected':''}>${LANGUAGE_LABELS[lang]}</option>`
  ).join('');
  const extras = S.settings.quickExtras || {};
  const extraBlocks = [
    extras.theme ? quickThemeExtraHtml() : '',
    extras.account ? (typeof quickAccountExtraHtml === 'function' ? quickAccountExtraHtml() : '') : '',
    extras.profile ? (typeof quickProfileExtraHtml === 'function' ? quickProfileExtraHtml() : '') : '',
  ].join('');
  menu.innerHTML = `
    <div class="settings-head">
      <span>${t('settings')}</span>
      <button class="settings-close" onclick="toggleSettingsMenu(false)" title="${t('close')}">x</button>
    </div>
    <div class="settings-group">
      <div class="settings-label">${t('language')}</div>
      <select class="settings-select" onchange="setUiSetting('language', this.value)">
        ${languageOptions}
      </select>
    </div>
    <div class="settings-group">
      <div class="settings-label">${t('moduleNameMode')}</div>
      ${nameModeSegHtml()}
    </div>
    <div class="settings-group">
      <div class="settings-label">${t('uiSize')}</div>
      ${uiSizeOnlySliderHtml()}
    </div>
    ${extraBlocks}
    <button class="btn btn-p" style="width:100%;margin-top:4px" onclick="toggleSettingsMenu(false);openSettingWindow()">${I.settings} ${t('settingOpenWindow')}</button>
  `;
}

// The quick popup's optional "Theme" extra (Tool toggle opt-in) — same swatch
// list the old always-shown block used, just gated now instead of default.
function quickThemeExtraHtml(){
  const palettes = getThemePalettes();
  const themeOptions = UI_THEME_OPTIONS.map(theme => {
    const active = S.settings.theme === theme;
    const swatches = THEME_SWATCH_VARS.map(v =>
      `<i style="background:${palettes[theme]?.[v] || ''}"></i>`
    ).join('');
    return `<button type="button" class="theme-item${active?' active':''}" onclick="setUiSetting('theme','${theme}')" title="${t(theme)}">
        <span class="theme-swatches">${swatches}</span>
        <span class="theme-name">${t(theme)}</span>
        ${active?'<span class="theme-check">✓</span>':''}
      </button>`;
  }).join('');
  const customOptions = (S.settings.customThemes || []).map(ct => {
    const key = `custom:${ct.id}`;
    const active = S.settings.theme === key;
    const swatches = ['--bg','--raised','--accent','--accentH','--t1'].map(tok =>
      `<i style="background:${x(ct.vars?.[tok] || '#000')}"></i>`).join('');
    return `<button type="button" class="theme-item${active?' active':''}" onclick="setUiSetting('theme','${key}')" title="${x(ct.name)}">
        <span class="theme-swatches">${swatches}</span>
        <span class="theme-name" data-no-i18n>${x(ct.name)}</span>
        ${active?'<span class="theme-check">✓</span>':''}
      </button>`;
  }).join('');
  return `<div class="settings-group">
      <div class="settings-label">${t('theme')}</div>
      <div class="theme-list">${themeOptions}${customOptions}</div>
    </div>`;
}

// UI-size-only slider (no font size — that lives on the Text&Size setting
// page now) for the trimmed quick popup.
function uiSizeOnlySliderHtml(){
  return `<div class="settings-label settings-label-row">
      <span id="settings-size-value">${S.settings.size}%</span>
    </div>
    <input class="settings-slider" type="range" min="${UI_SIZE_MIN}" max="${UI_SIZE_MAX}" step="${UI_SIZE_STEP}" value="${S.settings.size}" oninput="updateUiSizeLabel(this.value)" onchange="setUiSizeFromSlider(this.value)">
    <div class="settings-slider-scale"><span>${UI_SIZE_MIN}%</span><span>100%</span><span>${UI_SIZE_MAX}%</span></div>`;
}

// The Ctrl+P/W/Tab/N/E bindings in bindGlobalShortcuts() were previously
// undiscoverable — they appeared nowhere in the UI. Keys stay data-no-i18n
// (they're literal key names, not translatable text).
const SHORTCUT_HELP = [
  ['Ctrl+P', 'scQuickSwitch'],
  ['Ctrl+W', 'scCloseTab'],
  ['Ctrl+Tab', 'scNextTab'],
  ['Ctrl+Shift+Tab', 'scPrevTab'],
  ['Ctrl+N', 'scNewNote'],
  ['Ctrl+E', 'scToggleEditor'],
  ['Ctrl+Z', 'scUndo'],
  ['Ctrl+Shift+Z', 'scRedo'],
];
function openShortcutsModal(){
  const rows = SHORTCUT_HELP.map(([combo, key]) =>
    `<div class="li"><span class="name">${t(key)}</span><span class="tag" data-no-i18n>${combo}</span></div>`).join('');
  openModal(t('shortcuts'), `<div class="modal-data">${rows}</div>`);
}

// The first-run coach marks previously fired from exactly one place (the
// welcome modal's tour checkbox) with no way to see them again. guide.js
// already skips steps whose target element is absent, so replaying from an
// arbitrary app state is safe.
async function replayGuideTour(){
  if (typeof startNexusGuide !== 'function') await loadModule('src/renderer/guide.js');
  if (typeof startNexusGuide === 'function') startNexusGuide();
}

async function setVersionLimit(v){
  const n = Math.min(500, Math.max(1, Math.round(Number(v) || 50)));
  S.versionLimitCache = n;
  await api.setting.set('versionLimit', n);
  toast(t('applied'),'ok');
}

// The old "Preferences panel" (PREFS_SECTIONS/openPreferencesPanel/
// prefsBodyHtml/theme-grid/language-preview/ui-size-advanced) has been
// replaced by the full Setting window — see src/renderer/core/setting-window.js,
// which owns the Workspace → Theme/Text&Size pages that absorbed this code.

// ═══ CUSTOM THEME EDITOR (Phase 22, mockup 27) ═════════════════════════
function currentPaletteVars(){
  const cs = getComputedStyle(document.body);
  const out = {};
  for (const tok of CUSTOM_THEME_TOKENS) out[tok] = (cs.getPropertyValue(tok) || '#000000').trim();
  return out;
}

