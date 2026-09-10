'use strict';
// Workspace → Tool toggle page (Plan.md part1 #Setting "Tool toggle") — lets
// the user choose which optional items show in 3 different UI surfaces:
// the Quick Setting popup (extras beyond its trimmed default 4), the nav
// sidebar's "quick buttons" (import/export/hashtag/colors), and the status
// bar's segments. All three are booleans in S.settings, same localStorage
// tier as theme/nameMode (per-machine UI chrome, not vault data) — see
// loadUiSettings() in state.js for defaults. Toggle rows reuse the existing
// .togglerow/.tg switch idiom from the Nest-options popup (hub/menus.js).

// The 4 nav-sidebar "quick buttons" Plan.md names (colors/hashtag/import/export)
// — the only static nav-btn elements that aren't already gated by the
// existing .nexus-only/.director-only/etc. visibility system.
const NAV_TOGGLE_SELECTORS = {
  importDb: '#btn-import-db',
  exportDb: '#btn-export-db',
  hashtag: '.nav-btn[data-panel="hashtag"]',
  colors: '.nav-btn[data-panel="colors"]',
};
function applyNavToggles(){
  const nav = S.settings.navToggles || {};
  for (const key of Object.keys(NAV_TOGGLE_SELECTORS)) {
    const el = q(NAV_TOGGLE_SELECTORS[key]);
    if (el) el.classList.toggle('tool-toggle-hidden', nav[key] === false);
  }
}
// Plan part2 #4 "tools switch" preview — the Setting window is a modeless
// .floating-panel (components.css), so the live nav rail/status bar already
// sit visible behind it and update instantly; this just makes that change
// impossible to miss with a brief highlight on the element that just changed.
function flashEl(sel){
  const el = q(sel);
  if (!el) return;
  el.classList.remove('tool-toggle-flash');
  void el.offsetWidth; // restart the animation if the same element flashes twice in a row
  el.classList.add('tool-toggle-flash');
  setTimeout(() => el.classList.remove('tool-toggle-flash'), 700);
}
function toggleNavSetting(key){
  const cur = (S.settings.navToggles || {})[key] !== false;
  S.settings.navToggles = Object.assign({}, S.settings.navToggles, { [key]: !cur });
  saveUiSettings();
  applyNavToggles();
  renderSettingWindow();
  flashEl(NAV_TOGGLE_SELECTORS[key]);
}
function toggleStatusSetting(key){
  const cur = (S.settings.statusToggles || {})[key] !== false;
  S.settings.statusToggles = Object.assign({}, S.settings.statusToggles, { [key]: !cur });
  saveUiSettings();
  updateStatusBar({});
  renderSettingWindow();
  flashEl('#status-bar');
}
function toggleQuickExtra(key){
  const cur = !!(S.settings.quickExtras || {})[key];
  S.settings.quickExtras = Object.assign({}, S.settings.quickExtras, { [key]: !cur });
  saveUiSettings();
  renderSettingsMenu();
  renderSettingWindow();
}

function toolToggleRowHtml(label, on, onclick){
  return `<div class="togglerow nest-opt-row" onclick="${onclick}"><span class="tg${on ? ' on' : ''}"></span>${label}</div>`;
}
function settingToolTogglePageHtml(){
  const extras = S.settings.quickExtras || {};
  const nav = S.settings.navToggles || {};
  const st = S.settings.statusToggles || {};
  return `<div class="settings-label">${t('settingToolQuickGroup')}</div>
    <div class="settings-group">
      ${toolToggleRowHtml(t('theme'), !!extras.theme, "toggleQuickExtra('theme')")}
      ${toolToggleRowHtml(t('settingExtraAccount'), !!extras.account, "toggleQuickExtra('account')")}
      ${toolToggleRowHtml(t('settingPageProfile'), !!extras.profile, "toggleQuickExtra('profile')")}
    </div>
    <div class="settings-label">${t('settingToolNavGroup')}</div>
    <div class="settings-group">
      ${toolToggleRowHtml(t('importDb'), nav.importDb !== false, "toggleNavSetting('importDb')")}
      ${toolToggleRowHtml(t('exportDb'), nav.exportDb !== false, "toggleNavSetting('exportDb')")}
      ${toolToggleRowHtml(t('hashtag'), nav.hashtag !== false, "toggleNavSetting('hashtag')")}
      ${toolToggleRowHtml(t('colors'), nav.colors !== false, "toggleNavSetting('colors')")}
    </div>
    <div class="settings-label">${t('settingToolStatusGroup')}</div>
    <div class="settings-group">
      ${toolToggleRowHtml(t('settingStatusVault'), st.vault !== false, "toggleStatusSetting('vault')")}
      ${toolToggleRowHtml(t('settingStatusBreadcrumb'), st.breadcrumb !== false, "toggleStatusSetting('breadcrumb')")}
      ${toolToggleRowHtml(t('words'), st.words !== false, "toggleStatusSetting('words')")}
      ${toolToggleRowHtml(t('settingStatusSave'), st.saveState !== false, "toggleStatusSetting('saveState')")}
    </div>`;
}
registerSettingPage('workspace', 'tooltoggle', settingToolTogglePageHtml);
