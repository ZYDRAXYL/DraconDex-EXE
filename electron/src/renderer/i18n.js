'use strict';
// i18n for the renderer: the `L` locale table, the language-picker labels,
// and the Thai→other-locale table used by translateCommonUiText(). Loaded
// before core.js (see index.html) so these top-level bindings are visible to
// every renderer script.
//
// Procress 19 F8: the strings themselves live in i18n/<lang>.js, one file per
// language. All 18 used to be one 1.9 MB file — ~45 % of the JS every window
// parsed — of which one language was ever read. Now a window parses en.js
// (the fallback t() and tr() end on, a static tag in index.html) plus the
// saved language, written in by the block at the bottom of this file.
const L = {};
const LANGUAGE_LABELS = { en:'ENG - English', ja:'JP - 日本語', ko:'KR - 한국어', th:'TH - ไทย', zh:'CN - 中文', vi:'VI - Tiếng Việt', id:'ID - Bahasa Indonesia', es:'ES - Español', pt:'PT - Português (Brasil)', fr:'FR - Français', de:'DE - Deutsch', ru:'RU - Русский', it:'IT - Italiano', nl:'NL - Nederlands', pl:'PL - Polski', uk:'UA - Українська', tr:'TR - Türkçe', qd:'🐉 Draconic' };
const COMMON_UI_TEXT = {};
// The languages that have a file. Captured before state.js's
// loadInstalledPackages() adds a package's locale to LANGUAGE_LABELS — those
// arrive as data and have no file to load.
const I18N_FILE_LANGS = Object.keys(LANGUAGE_LABELS);
const I18N_LOADED = new Set();
const _i18nPending = {};

// Called by each i18n/<lang>.js. A lang package installed from DraconDex-PKG
// may have filled L[lang] first (loadInstalledPackages, core/state.js); the
// built-in strings are laid over it, so a package can add keys but never
// rewrite the app's own — the same rule as before the split.
function i18nAdd(lang, keys, common) {
  L[lang] = Object.assign(L[lang] || {}, keys);
  for (const k in common) (COMMON_UI_TEXT[k] ||= {})[lang] = common[k];
  I18N_LOADED.add(lang);
}
function i18nLoaded(lang) {
  return I18N_LOADED.has(lang) || !I18N_FILE_LANGS.includes(lang);
}
// After boot, a language is a plain <script> added on demand (setUiSetting,
// the picker's hover preview). Resolves on error too: a missing file leaves
// t() on its English fallback, which is better than a picker that never acts.
function i18nLoad(lang) {
  if (i18nLoaded(lang)) return Promise.resolve();
  return _i18nPending[lang] ||= new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = `src/renderer/i18n/${lang}.js`;
    s.onload = s.onerror = () => { delete _i18nPending[lang]; resolve(); };
    document.head.appendChild(s);
  });
}

// The saved language, before core/ parses. It has to be parser-blocking — every
// script after this one reads L at its top level or in init() — and
// document.write is the only way a script can add one: a created <script>
// element runs whenever it arrives, after the parser has moved on. The CSP
// (script-src 'self') allows it like any tag of ours. Key, default and
// fallback match loadUiSettings() (core/state.js): an unknown or package-only
// code reads as 'th' there, so 'th' is the file it needs here.
(function () {
  let lang = 'th';
  try {
    const saved = JSON.parse(localStorage.getItem('novel-manager-ui-settings') || '{}');
    if (I18N_FILE_LANGS.includes(saved.language)) lang = saved.language;
  } catch (_) { /* unreadable settings: loadUiSettings() falls back to 'th' too */ }
  if (lang !== 'en') document.write(`<script src="src/renderer/i18n/${lang}.js"><\/script>`);
})();
