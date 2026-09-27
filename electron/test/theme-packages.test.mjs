// Procress 10 part 2 — the app ships 4 themes and 2 UI styles; the rest are
// DraconDex-PKG packages. Two things must hold for that not to cost anyone
// their look: a saved former built-in is carried over to its package id, and
// a saved `pkg:` value survives the restart (it used to be checked against the
// built-in list before packages loaded, and reset to midnight every launch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const stateSrc = read('../src/renderer/core/state.js');
const themesCss = read('../css/themes.css');
const uiStyleCss = read('../css/ui-style.css');
const navCss = read('../css/nav-hub.css');

function loadState(saved) {
  const store = {};
  const ctx = {
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    window: {}, screen: { width: 1920, height: 1080 }, document: {}, navigator: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${stateSrc}
    ;this.__ = { loadUiSettings, UI_SETTINGS_KEY, UI_THEME_OPTIONS_BUILTIN, PACKAGED_THEMES,
                 UI_STYLE_OPTIONS_BUILTIN, PACKAGED_UISTYLES };`, ctx);
  if (saved) store[ctx.__.UI_SETTINGS_KEY] = JSON.stringify(saved);
  return ctx.__;
}

test('a former built-in theme / UI style is carried over to its package', () => {
  const s = loadState({ theme: 'atDusk', uiStyle: 'hardBlock' }).loadUiSettings();
  assert.equal(s.theme, 'pkg:theme-atDusk');
  assert.equal(s.uiStyle, 'pkg:uistyle-hardBlock');
});

test('an installed package choice survives a restart', () => {
  const s = loadState({ theme: 'pkg:theme-someNewTheme', uiStyle: 'pkg:uistyle-x' }).loadUiSettings();
  assert.equal(s.theme, 'pkg:theme-someNewTheme');
  assert.equal(s.uiStyle, 'pkg:uistyle-x');
});

test('built-ins pass through, garbage falls back', () => {
  assert.equal(loadState({ theme: 'daylight', uiStyle: 'fluent' }).loadUiSettings().theme, 'daylight');
  const s = loadState({ theme: 'pkg:../x', uiStyle: 'nope' }).loadUiSettings();
  assert.equal(s.theme, 'midnight');
  assert.equal(s.uiStyle, 'oldPlain');
});

test('css ships exactly the built-ins', () => {
  const st = loadState();
  const blocks = (css, attr) => new Set([...css.matchAll(new RegExp(`body\\[${attr}="(\\w+)"\\]\\s*\\{`, 'g'))].map(m => m[1]));
  const themes = blocks(themesCss, 'data-theme');
  for (const t of st.UI_THEME_OPTIONS_BUILTIN) assert.ok(themes.has(t), `built-in ${t} has no palette`);
  for (const t of st.PACKAGED_THEMES) {
    assert.ok(!themes.has(t), `${t} is a package but still has a palette block`);
    assert.ok(!navCss.includes(`"${t}"`), `${t} still has a logo rule`);
  }
  const styles = blocks(uiStyleCss, 'data-ui-style');
  for (const u of st.PACKAGED_UISTYLES) assert.ok(!styles.has(u), `${u} is a package but still has a block`);
  // oldPlain is tokens.css's own defaults and has no block by design.
  for (const u of st.UI_STYLE_OPTIONS_BUILTIN.filter(u => u !== 'oldPlain')) assert.ok(styles.has(u), `${u} has no block`);
});
