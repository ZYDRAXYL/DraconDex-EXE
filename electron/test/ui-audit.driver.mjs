// Procress 17 R7 — the UI audit: opens every page of a fresh vault (the
// sample has one module of every kind) and fails on what Procress 16/17 found
// by hand, so it cannot come back quietly:
//   · a page error or console error
//   · an inline handler (onclick=…) that does not parse — the B1 bug class
//   · a text input left as the OS's white box in a dark theme — R2
//   · a raw i18n key shown instead of its text
//   · a page that takes longer than BUDGET_MS to open
//   · Procress 18 part 5: text under 4.5:1 (3:1 large) against what it sits on,
//     in each built-in theme — measured, not judged from a screenshot
//     (ui-contrast.mjs) — and a focus ring under 3:1 against the surfaces
//
//   node --test electron/test/ui-audit.driver.mjs
//
// Needs a display, like ui-smoke.driver.mjs. BUDGET_MS is a ceiling against
// regressions, not the target (Plan.md Procress 17 asks < 200 ms per kind) —
// CI machines vary too much to fail a build on the target itself. Procress 19
// part 8 brought it down from 1,500 to about twice the slowest open measured
// (Drafter: 211 ms on the Windows machine of Procress 17, 63 ms on Linux CI
// containers); the test prints the three slowest opens so the next
// tightening follows a number, not a guess.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithVault } from './ui-app.mjs';
import { contrastProbe } from './ui-contrast.mjs';

const BUDGET_MS = 400;
let ui, win;
const pageErrors = [];

before(async () => {
  ui = await launchWithVault('Audit');
  win = ui.win;
  win.on('pageerror', (e) => pageErrors.push(e.message));
  win.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
});
after(async () => { await ui?.close(); });

// Everything the audit reads off the page that is showing now.
const snapshot = () => win.evaluate(() => {
  const handlers = [];
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) if (a.name.startsWith('on')) handlers.push({ where: `<${el.tagName.toLowerCase()} ${a.name}>`, code: a.value });
  }
  // rgb() or color(srgb …) — a color-mix() token computes to the latter
  const lum = (c) => {
    const s = /color\(srgb ([^)]+)\)/.exec(c);
    const [r, g, b] = s ? s[1].split(/[ /]+/).slice(0, 3).map((v) => Number(v) * 255) : (c.match(/[\d.]+/g) || [0, 0, 0]).map(Number);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const dark = lum(getComputedStyle(document.body).backgroundColor) < 0.4;
  const white = !dark ? [] : [...document.querySelectorAll('input, textarea')]
    .filter((el) => el.offsetParent && !['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(el.type))
    .filter((el) => lum(getComputedStyle(el).backgroundColor) > 0.9)
    .map((el) => el.id || el.className || el.outerHTML.slice(0, 60));
  // a key name on screen where its text should be (the key and its English differ)
  const keys = new Set(Object.keys(L.en).filter((k) => /^[a-z]+[A-Z]\w*$/.test(k) && L.en[k] !== k));
  const shown = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.parentElement?.offsetParent) shown.push(n.nodeValue.trim());
  for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) shown.push(el.title, el.placeholder, el.getAttribute('aria-label'));
  // Procress 18 part 5: a control a screen reader can name — its text, aria-label, aria-labelledby or title
  const nameless = [...document.querySelectorAll('button, [role="button"], a[onclick], [role="tab"], [role="treeitem"], select, input:not([type="hidden"]), textarea')]
    .filter((el) => el.offsetParent && !el.closest('[aria-hidden="true"]'))
    .filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title || el.textContent.trim() || el.placeholder || el.labels?.length || el.closest('label')))
    .map((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 90));
  return { handlers, white, nameless, rawKeys: [...new Set(shown.filter((s) => s && keys.has(s)))] };
});

function audit(where, snap) {
  const bad = [];
  for (const h of snap.handlers) {
    try { new Function('event', h.code); } catch (e) { bad.push(`${h.where}: ${e.message} — ${h.code.slice(0, 80)}`); }
  }
  if (snap.white.length) bad.push(`white OS input(s): ${snap.white.join(', ')}`);
  if (snap.rawKeys.length) bad.push(`raw i18n key(s) on screen: ${snap.rawKeys.join(', ')}`);
  if (snap.nameless.length) bad.push(`control(s) with no accessible name: ${[...new Set(snap.nameless)].join(' | ')}`);
  assert.deepEqual(bad, [], `${where}:\n  ${bad.join('\n  ')}`);
}

test('Home', async () => { audit('Home', await snapshot()); });

test('every module of the sample vault opens clean and in budget', async () => {
  const mods = await win.evaluate(() => {
    const out = [];
    const w = (ns) => ns.forEach((m) => { if (m.kind !== 'collector') out.push({ id: m.id, kind: m.kind, name: m.name }); w(m.children || []); });
    w(S.moduleTree);
    return out;
  });
  assert.ok(mods.length >= 10, 'the sample vault has one module of most kinds');
  const slow = [];
  const times = [];
  for (const m of mods) {
    const ms = await win.evaluate(async (id) => { const t0 = performance.now(); await openModuleNode(id); return performance.now() - t0; }, m.id);
    await win.waitForTimeout(150); // mounts that run after the open resolves
    times.push([Math.round(ms), m.kind]);
    if (ms > BUDGET_MS) slow.push(`${m.kind} "${m.name}" ${Math.round(ms)} ms`);
    audit(`${m.kind} "${m.name}"`, await snapshot());
  }
  // Printed so the budget can follow the numbers (Procress 19 part 8).
  console.log(`slowest opens: ${times.sort((a, b) => b[0] - a[0]).slice(0, 3).map(([t, k]) => `${k} ${t} ms`).join(' · ')} (budget ${BUDGET_MS})`);
  assert.deepEqual(slow, [], `over ${BUDGET_MS} ms`);
});

test('every left-panel destination on the rail', async () => {
  for (const cmd of await win.evaluate(() => [...document.querySelectorAll('#nav-sidebar [data-cmd]')].map((b) => b.dataset.cmd).filter((c) => c !== 'app.settings'))) {
    await win.click(`#nav-sidebar [data-cmd="${cmd}"]`);
    await win.waitForTimeout(250);
    audit(cmd, await snapshot());
  }
});

// ── Procress 18 part 5 ───────────────────────────────────────────────────
test('contrast: every page, every built-in theme — text ≥ 4.5:1, focus ring ≥ 3:1', async () => {
  const bad = [];
  for (const theme of ['midnight', 'moonlight', 'daylight']) {
    await win.evaluate((th) => setUiSetting('theme', th), theme);
    const ring = await win.evaluate(() => {
      const hex = (v) => { const n = parseInt(v.trim().slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
      const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const cs = getComputedStyle(document.body);
      const ring = hex(cs.getPropertyValue('--accentH'));
      return ['--bg', '--surface', '--raised'].map((k) => { const [a, b] = [L(ring), L(hex(cs.getPropertyValue(k)))].sort((p, q) => q - p); return [k, (a + 0.05) / (b + 0.05)]; });
    });
    for (const [k, r] of ring) if (r < 3) bad.push(`${theme}: focus ring on ${k} ${r.toFixed(2)}:1`);
    const pages = await win.evaluate(() => [null, ...flattenModulesByKind(S.moduleTree, []).filter((m) => m.kind !== 'collector').map((m) => m.id)]);
    for (const id of pages) {
      await win.evaluate(async (mid) => { if (mid == null) await builderOpenPage(null); else await openModuleNode(mid); }, id);
      await win.waitForTimeout(350);
      for (const f of await win.evaluate(contrastProbe)) bad.push(`${theme} page ${id ?? 'Home'}: ${f.sel} "${f.text}" ${f.ratio}:1 (needs ${f.need}) ${f.fg} on ${f.bg}`);
    }
  }
  await win.evaluate(() => setUiSetting('theme', 'midnight'));
  assert.deepEqual([...new Set(bad)], []);
});

// ── Procress 21 part 4: the one list (APP docs/UX-LAYOUT.md §12) ─────────
// Every visible row of the shared list (core/list.js) on the list screens:
// 28 or 40 px (× UI Size) and nothing else, focusable, named; its meta, count
// and group heads ≥ 4.5:1 in each built-in theme; and the keyboard path.
const LIST_SCREENS = {
  trash: async () => { showLeftDest('trash'); },
  problems: async () => { openProblemsPanel(); },
  assets: async () => { showLeftDest('nest'); if (!S.importFolderCollapsed.has('#unsorted:open')) toggleImportFolder('#unsorted:open'); },
  versions: async () => { const m = flattenModulesByKind(S.moduleTree, []).find((x2) => x2.kind === 'classifier'); await openModuleNode(m.id); await openVersionPanel(m.id); },
  plugins: async () => { openSettingWindow('plugin', 'plugin'); },
  nest: async () => { showLeftDest('nest'); await builderOpenPage(null); },
  search: async () => { showLeftDest('search'); await new Promise((res) => setTimeout(res, 200)); q('#left-search-q').value = 'harbor'; await runLeftSearch('harbor'); },
  recent: async () => { showLeftDest('recent'); },
  labels: async () => { openCategoryPage(''); await new Promise((res) => setTimeout(res, 300)); const tag = document.querySelector('[data-ls="cat-subs"] .ls-row'); tag?.click(); },
  quickswitch: async () => { await loadModule('src/renderer/quickswitch.js'); await openQuickSwitcher(''); },
  switcher: async () => { showLeftDest('nest'); document.querySelector('[onclick*="toggleNexusSwitcher"]')?.click(); },
  // in a module (the sample vault has one of each kind)
  classifier: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'classifier').id); document.querySelector('[onclick*="setClassifierView"][onclick*="\'detail\'"]')?.click(); },
  relations: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'classifier').id); document.querySelector('[onclick*="setClassifierView"][onclick*="\'relation\'"]')?.click(); },
  manager: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'manager').id); await setManagerView('list'); },
  chronicler: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'chronicler').id); await setChroniclerView('downline'); },
  narrator: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'narrator').id); await setNarratorView('dialogue'); },
  author: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'author').id); },
  sketcher: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'sketcher').id); await setSketcherView('pages'); },
  diviner: async () => { await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'diviner').id); },
  // settings
  'settings-nav': async () => { openSettingWindow('workspace', 'theme'); },
  'settings-lang': async () => { openSettingWindow('workspace', 'textsize'); },
  'quick-themes': async () => { openFloatingPanel('ls-audit-themes', 'Themes', quickThemeExtraHtml(), { width: 320, height: 480 }); },
  props: async () => { localStorage.setItem('dracondex-props-open', '1'); await openModuleNode(flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === 'drafter').id); renderSidePanel(); await new Promise((res) => setTimeout(res, 400)); localStorage.setItem('dracondex-props-open', '0'); },
};
const openListScreen = async (name) => {
  await win.evaluate(() => { closeFloatingPanel('setting-window'); closeFloatingPanel('ls-audit-themes'); closeSidePanel(); closeModal(); closeAllPopups(); document.getElementById('qs-overlay')?.remove(); S.leftTool = null; });
  await win.evaluate(`(${LIST_SCREENS[name]})()`);
  await win.waitForTimeout(500);
};
const rowAudit = () => win.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  const h = { compact: parseFloat(cs.getPropertyValue('--row-compact')), comfy: parseFloat(cs.getPropertyValue('--row-comfy')) };
  // the Nest tree is a compact list too (its rows are tree items, not .ls-row)
  const rows = [...document.querySelectorAll('.ls-row, #nest-tree-body [role="treeitem"]')].filter((r) => r.offsetParent && r.getBoundingClientRect().height);
  const bad = [];
  for (const r of rows) {
    const want = (r.classList.contains('ls-compact') || r.getAttribute('role') === 'treeitem' ? h.compact : h.comfy) * zoom;
    const got = r.getBoundingClientRect().height;
    const name = r.getAttribute('aria-label') || r.querySelector('.name')?.textContent || '';
    if (Math.abs(got - want) > 0.5) bad.push(`${name}: ${got.toFixed(1)} px, wants ${want}`);
    if (!r.hasAttribute('tabindex')) bad.push(`${name}: not focusable`);
    if (!name.trim()) bad.push(`a row with no name: ${r.outerHTML.slice(0, 80)}`);
  }
  for (const box of document.querySelectorAll('.ls-list')) {
    if (box.offsetParent && box.querySelector('.ls-row') && box.querySelectorAll('[tabindex="0"]:is(.ls-row,.ls-group-head)').length !== 1) bad.push(`${box.id}: not exactly one tab stop`);
  }
  return { n: rows.length, bad };
});

test('list rows: 28 or 40 px × UI Size, focusable and named, on every list screen', async () => {
  await win.evaluate(async () => {
    for (const n of ['Old notes', 'Draft map']) { const id = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: n, kind: 'drafter' }); await api.trash.module(S.nexus.id, id); }
    for (const [u, n] of [['https://example.com/a', 'Reference site'], ['https://example.com/b', 'Map source']]) await api.importdock.addUrl(S.nexus.id, u, n, null);
    S.importFiles = undefined; await reloadModuleTree(); renderNexusHome();
  });
  const bad = [];
  let seen = 0;
  for (const size of [100, 125]) {
    await win.evaluate((v) => setUiSetting('size', v), size);
    for (const name of Object.keys(LIST_SCREENS)) {
      await openListScreen(name);
      const r = await rowAudit();
      seen += r.n;
      if (!['plugins', 'props', 'relations'].includes(name) && !r.n) bad.push(`${name}: no rows to measure`);
      bad.push(...r.bad.map((b) => `${size}% ${name}: ${b}`));
    }
  }
  await win.evaluate(() => setUiSetting('size', 100));
  console.log(`list rows measured: ${seen}`);
  assert.deepEqual(bad, []);
});

test('list meta, counts and group heads reach 4.5:1 in every built-in theme', async () => {
  const bad = [];
  for (const theme of ['midnight', 'moonlight', 'daylight']) {
    await win.evaluate((th) => setUiSetting('theme', th), theme);
    for (const name of Object.keys(LIST_SCREENS)) {
      await openListScreen(name);
      for (const f of await win.evaluate(contrastProbe)) if (/\.ls-|^(span|div|p)\.ls/.test(f.sel)) bad.push(`${theme} ${name}: ${f.sel} "${f.text}" ${f.ratio}:1`);
    }
  }
  await win.evaluate(() => { closeFloatingPanel('setting-window'); closeSidePanel(); setUiSetting('theme', 'midnight'); });
  assert.deepEqual([...new Set(bad)], []);
});

test('list keyboard: one tab stop, ↑ ↓ Home End move, Enter, Delete asks, groups fold', async () => {
  await openListScreen('trash');
  const r = await win.evaluate(async () => {
    const box = document.querySelector('#ls-trash');
    const stops = () => [...box.querySelectorAll('.ls-row, .ls-group-head[role="button"]')].filter((e) => e.offsetParent);
    const key = (k, o = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
    const at = () => stops().indexOf(document.activeElement);
    box.querySelector('[tabindex="0"]').focus();
    const out = { first: at() };
    key('ArrowDown'); out.down = at();
    key('End'); out.end = at(); out.last = stops().length - 1;
    key('Home'); out.home = at();
    key('Enter'); await new Promise((res) => setTimeout(res, 50)); // a group head: Enter folds
    out.folded = !!box.querySelector('.ls-group.ls-folded');
    key('Enter'); await new Promise((res) => setTimeout(res, 50));
    out.unfolded = !box.querySelector('.ls-group.ls-folded');
    key('ArrowDown');
    key('Delete'); await new Promise((res) => setTimeout(res, 100));
    out.asked = !!document.getElementById('confirm-overlay');
    document.querySelector('#confirm-overlay .btn-s')?.click();
    return out;
  });
  assert.deepEqual(r, { first: 0, down: 1, end: r.last, last: r.last, home: 0, folded: true, unfolded: true, asked: true });
  // …and the same path on every other list screen: Tab lands once, the
  // arrows / Home / End walk it. (Ctrl+P keeps the focus in its input — a
  // combobox with its own keys — so it is not walked here.)
  const walked = [];
  for (const name of Object.keys(LIST_SCREENS).filter((n) => !['quickswitch', 'plugins'].includes(n))) {
    await openListScreen(name);
    const w = await win.evaluate(() => {
      const box = [...document.querySelectorAll('.ls-list')].find((b) => b.offsetParent && b.querySelector('.ls-row'));
      if (!box) return null;
      const stops = () => [...box.querySelectorAll('.ls-row, .ls-group-head[role="button"]')].filter((e) => e.offsetParent);
      const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const at = () => stops().indexOf(document.activeElement);
      box.querySelector('[tabindex="0"]').focus();
      const n = stops().length;
      key('Home'); const home = at();
      key('End'); const end = at();
      key('ArrowUp'); const up = at();
      return { n, ok: home === 0 && end === n - 1 && (n < 2 || up === n - 2) };
    });
    if (w && !w.ok) walked.push(`${name}: ${JSON.stringify(w)}`);
  }
  assert.deepEqual(walked, [], 'every list walks by keyboard');
  // The Nest shares the handler: Delete there sends to the trash with Undo (17 I3).
  const nest = await win.evaluate(async () => {
    showLeftDest('nest');
    await new Promise((res) => setTimeout(res, 300));
    const m = S.moduleTree.find((x2) => x2.kind !== 'collector') || flattenModulesByKind(S.moduleTree, []).find((x2) => x2.kind === 'drafter');
    const row = document.querySelector(`#nest-tree-body [data-mid="${m.id}"]`);
    row.focus();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 600));
    const undo = document.querySelector('#toast.has-action .toast-act');
    const gone = !findModuleNode(m.id);
    undo?.click();
    await new Promise((res) => setTimeout(res, 800));
    return { gone, undo: !!undo, back: flattenModulesByKind(S.moduleTree, []).some((x2) => x2.name === m.name) };
  });
  assert.deepEqual(nest, { gone: true, undo: true, back: true });
});

// ── Procress 22: the component gallery (APP docs/COMPONENTS.md) ─────────
// Every shared component, variant and state on one page (src/renderer/
// gallery.js, dev builds only), measured in each built-in theme: text and
// its layers (popover, menu, modal) ≥ 4.5:1, every control ≥ 24 × 24 px and
// named, and the keyboard path through the popover and the modal.
const openGalleryPage = async () => {
  await win.evaluate(async () => { closeModal(); closeAllPopups(); document.getElementById('confirm-overlay')?.remove(); await runCommand('dev.gallery'); });
  await win.waitForTimeout(400);
};
const GALLERY_CONTROLS = '#gallery :is(button, [role="button"], [role="link"], [role="tab"], a[href], input:not([type="hidden"]), select, textarea)';
const galleryTargets = () => win.evaluate((sel) => [...document.querySelectorAll(sel)]
  .filter((el) => el.offsetParent && !el.closest('.ls-row') && !el.closest('.gal-icons'))
  .map((el) => { const r = el.getBoundingClientRect(); return { r, el }; })
  .filter(({ r }) => r.width < 23.5 || r.height < 23.5)
  .map(({ r, el }) => `${el.outerHTML.replace(/\s+/g, ' ').slice(0, 70)} ${r.width.toFixed(0)}×${r.height.toFixed(0)}`), GALLERY_CONTROLS);

test('gallery: every component, every built-in theme — contrast, ≥ 24 px targets, names', async () => {
  const bad = [];
  for (const theme of ['midnight', 'moonlight', 'daylight']) {
    await win.evaluate((th) => setUiSetting('theme', th), theme);
    await openGalleryPage();
    assert.ok(await win.locator('#gallery .gal-sec').count() >= 8, 'the gallery renders (dev build)');
    for (const f of await win.evaluate(contrastProbe)) bad.push(`${theme} gallery: ${f.sel} "${f.text}" ${f.ratio}:1 (needs ${f.need}) ${f.fg} on ${f.bg}`);
    bad.push(...(await galleryTargets()).map((b) => `${theme} target under 24 px: ${b}`));
    const snap = await snapshot();
    bad.push(...snap.nameless.map((n) => `${theme} nameless: ${n}`), ...snap.white.map((w) => `${theme} white input: ${w}`));
    // the layers it opens
    for (const open of ['#gal-pop', '#gal-menu', '#gal-modal-md']) {
      await win.click(open); await win.waitForTimeout(250);
      for (const f of await win.evaluate(contrastProbe)) if (/popover|modal|ctx|kind-list/.test(f.sel) || f.sel.includes('#modal')) bad.push(`${theme} ${open}: ${f.sel} "${f.text}" ${f.ratio}:1`);
      await win.evaluate(() => { closeAllPopups(); closeModal(); });
    }
  }
  await win.evaluate(() => setUiSetting('theme', 'midnight'));
  assert.deepEqual([...new Set(bad)], []);
});

test('gallery keyboard: popover takes focus, traps Tab, Esc gives it back; modal foot and Esc', async () => {
  await openGalleryPage();
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const key = (k, o = {}) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
    const btn = document.querySelector('#gal-pop');
    btn.focus(); btn.click(); await wait(60);
    const pop = document.querySelector('.popover');
    const out = { opened: !!pop, role: pop?.getAttribute('role'), named: !!pop?.getAttribute('aria-label'), inside: !!pop?.contains(document.activeElement) };
    const stops = [...pop.querySelectorAll('button, input')].filter((e) => e.offsetParent);
    stops[stops.length - 1].focus(); key('Tab');
    out.trapped = document.activeElement === stops[0];
    key('Shift', {}); stops[0].focus(); key('Tab', { shiftKey: true });
    out.trappedBack = document.activeElement === stops[stops.length - 1];
    key('Escape'); await wait(30);
    out.closed = !document.querySelector('.popover');
    out.focusBack = document.activeElement === btn;
    document.querySelector('#gal-modal-md').click(); await wait(80);
    const foot = document.querySelector('#modal-foot');
    out.foot = !!foot && !foot.hidden && foot.querySelector('.btn-p') === foot.querySelector('.mfoot').lastElementChild;
    out.hint = !!document.querySelector('#modal-body > .modal-hint');
    out.size = document.querySelector('#modal').dataset.size;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(30);
    out.modalClosed = document.querySelector('#modal-overlay').classList.contains('hidden');
    return out;
  });
  assert.deepEqual(r, { opened: true, role: 'dialog', named: true, inside: true, trapped: true, trappedBack: true, closed: true, focusBack: true, foot: true, hint: true, size: 'md', modalClosed: true });
});

// ── Procress 23: Glass ───────────────────────────────────────────────────
// Real contrast on the glass style — the text glass puts on a translucent pane
// (chrome and overlays; the page itself stays opaque and is the contrast test
// above): every page × the built-in themes, plus the
// lightest and darkest theme packages and the one SDB had to raise most
// (applied as custom themes — CI has no package catalog), each measured over
// BOTH ends of the backdrop gradient (the probe composites a translucent pane
// over its ancestors' fills, so the frame's fill is set to each end in turn).
// Then the overlays a pane can be: Setting window, menu, popover, modal, toast.
// Every pane glass draws: what Reduce transparency must turn solid.
const GLASS_PANES = '#title-tab-bar, #nav-sidebar, #left-panel, #side-panel:not(.hidden), #status-bar, .popover, .floating-panel, #modal, #toast';
const GLASS_PALETTES = {
  atDay: { '--bg': '#fffaf0', '--surface': '#ffffff', '--raised': '#fff3d6', '--hover': '#ffe9b3', '--border': '#ffd97d', '--t1': '#4a3a12', '--t2': '#7a6230', '--t3': '#b39a63', '--t3-aa': '#826d3d', '--accent': '#e8a93c', '--accentH': '#ffcba4', '--button': '#d4a017', '--danger': '#dc2626', '--success': '#16a34a', '--on-accent': 'var(--ink-dark)', '--on-button': 'var(--ink-dark)' },
  atMidnight: { '--bg': '#050608', '--surface': '#0c0e14', '--raised': '#12151e', '--hover': '#191d29', '--border': '#232838', '--t1': '#e6ebf5', '--t2': '#8b93a8', '--t3': '#525a70', '--t3-aa': '#788093', '--accent': '#4f7cc4', '--accentH': '#6f9ce4', '--on-accent': '#000000', '--danger': '#ef4444', '--success': '#22c55e' },
  clearMeteor: { '--bg': '#0a0e1a', '--surface': '#111726', '--raised': '#182032', '--hover': '#212b40', '--border': '#2c374f', '--t1': '#eef2fb', '--t2': '#9aa6be', '--t3': '#5f6b83', '--t3-aa': '#7d879c', '--accent': '#fbbf24', '--accentH': '#fde68a', '--button': '#d97706', '--danger': '#f87171', '--success': '#34d399', '--on-accent': 'var(--ink-dark)' },
};
const glassThemes = async () => {
  await win.evaluate((pal) => {
    S.settings.customThemes = [...(S.settings.customThemes || []).filter((c) => !c.id.startsWith('glassaudit')),
      ...Object.entries(pal).map(([name, vars]) => ({ id: `glassaudit${name}`, name, vars }))];
  }, GLASS_PALETTES);
  return ['daylight', 'midnight', 'moonlight', 'rainbow', ...Object.keys(GLASS_PALETTES).map((n) => `custom:glassaudit${n}`)];
};
// What glass itself breaks: text under 4.5:1 on the glass pane that reads fine
// when the same pane is solid (Reduce transparency) — a theme's own weak colour
// (rainbow's gradient buttons, a package's white-on-amber button) is the
// contrast test's business above, not this one's.
const glassOnlyFailures = () => win.evaluate(async ([probeSrc, panes]) => {
  const probe = new Function(`return (${probeSrc})`)();
  const key = (f) => `${f.sel}|${f.text}`;
  const glass = probe(panes);
  document.body.dataset.reduceTransparency = '';
  await new Promise((r) => requestAnimationFrame(r));
  const solid = new Set(probe(panes).map(key));
  delete document.body.dataset.reduceTransparency;
  return glass.filter((f) => !solid.has(key(f)));
}, [contrastProbe.toString(), GLASS_PANES]);
const atBackdropEnd = (end) => win.evaluate((e) => {
  for (const el of [document.body, document.getElementById('window-frame')]) el.style.backgroundColor = e ? `var(--glass-backdrop-${e})` : '';
}, end);

test('glass: every page × 4 built-in + 3 package themes × both backdrop ends — text ≥ 4.5:1', async () => {
  const bad = [];
  const themes = await glassThemes();
  await win.evaluate(() => setUiSetting('uiStyle', 'glass'));
  const pages = await win.evaluate(() => [null, ...flattenModulesByKind(S.moduleTree, []).filter((m) => m.kind !== 'collector').map((m) => m.id)]);
  for (const theme of themes) {
    await win.evaluate((th) => setUiSetting('theme', th), theme);
    for (const id of pages) {
      await win.evaluate(async (mid) => { if (mid == null) await builderOpenPage(null); else await openModuleNode(mid); }, id);
      await win.waitForTimeout(250);
      for (const end of ['from', 'to']) {
        await atBackdropEnd(end);
        for (const f of await glassOnlyFailures()) bad.push(`${theme} ${end} page ${id ?? 'Home'}: ${f.sel} "${f.text}" ${f.ratio}:1 (needs ${f.need}) ${f.fg} on ${f.bg}`);
      }
      await atBackdropEnd(null);
    }
    // the overlays, over Home
    await win.evaluate(() => builderOpenPage(null));
    for (const open of ['settings', 'menu', 'modal']) {
      await win.evaluate(async (o) => {
        if (o === 'settings') openSettingWindow('workspace', 'theme');
        if (o === 'menu') { const r = document.querySelector('#left-panel-inner .li'); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 200 })); }
        if (o === 'modal') { openModal('Glass', '<p>Body text</p><div class="mfoot"><button class="btn btn-p">OK</button></div>'); toast('Saved', 'ok'); }
      }, open);
      await win.waitForTimeout(350);
      for (const end of ['from', 'to']) {
        await atBackdropEnd(end);
        for (const f of await glassOnlyFailures()) bad.push(`${theme} ${end} ${open}: ${f.sel} "${f.text}" ${f.ratio}:1 (needs ${f.need}) ${f.fg} on ${f.bg}`);
      }
      await atBackdropEnd(null);
      await win.evaluate(() => { closeFloatingPanel('setting-window'); closeModal(); closeAllPopups(); });
    }
  }
  await win.evaluate(() => { setUiSetting('theme', 'midnight'); setUiSetting('uiStyle', 'oldPlain'); });
  assert.deepEqual([...new Set(bad)], []);
});

const glassLeaks = () => win.evaluate((sel) => {
  const alpha = (c) => { const m = /\/\s*([\d.]+)\)|rgba\([^)]*,\s*([\d.]+)\)/.exec(c); return m ? Number(m[1] ?? m[2]) : 1; };
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (alpha(cs.backgroundColor) < 1) out.push(`${el.id || el.className} bg ${cs.backgroundColor}`);
  }
  for (const el of document.querySelectorAll('*')) if (getComputedStyle(el).backdropFilter !== 'none') out.push(`${el.id || el.className} blur ${getComputedStyle(el).backdropFilter}`);
  if (getComputedStyle(document.getElementById('window-frame')).backgroundImage !== 'none') out.push('backdrop gradient');
  return out;
}, GLASS_PANES);
const openGlassLayers = () => win.evaluate(() => {
  localStorage.setItem('dracondex-props-open', '1'); renderSidePanel(); // Properties
  openPopover(document.querySelector('#nav-sidebar .nav-btn'), '<div>menu</div>', { focus: false });
  openModal('Glass', '<p>x</p>'); toast('Saved', 'ok');
});
const closeGlassLayers = () => win.evaluate(() => { closeModal(); closeAllPopups(); localStorage.setItem('dracondex-props-open', '0'); renderSidePanel(); });

test('glass: Reduce transparency (the switch, and the OS setting) leaves no translucent layer and no blur', async () => {
  await win.evaluate(() => { setUiSetting('theme', 'daylight'); setUiSetting('uiStyle', 'glass'); });
  await openGlassLayers(); await win.waitForTimeout(300);
  const on = await glassLeaks();
  assert.ok(on.length > 0, 'glass draws translucent panes to begin with');
  await win.evaluate(() => setUiSetting('reduceTransparency', true));
  await openGlassLayers(); await win.waitForTimeout(300);
  const viaSwitch = await glassLeaks();
  await closeGlassLayers();
  await win.evaluate(() => setUiSetting('reduceTransparency', false));
  // the OS preference, emulated through the DevTools protocol
  const cdp = await win.context().newCDPSession(win);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await openGlassLayers(); await win.waitForTimeout(300);
  const viaOs = await glassLeaks();
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  await closeGlassLayers();
  await win.evaluate(() => { setUiSetting('theme', 'midnight'); setUiSetting('uiStyle', 'oldPlain'); });
  assert.deepEqual({ viaSwitch, viaOs }, { viaSwitch: [], viaOs: [] });
});

test('glass: forced colours (Windows high contrast) turn it off', async () => {
  await win.evaluate(() => setUiSetting('uiStyle', 'glass'));
  await win.emulateMedia({ forcedColors: 'active' });
  await openGlassLayers(); await win.waitForTimeout(300);
  const leaks = await glassLeaks();
  await win.emulateMedia({ forcedColors: 'none' });
  await closeGlassLayers();
  await win.evaluate(() => setUiSetting('uiStyle', 'oldPlain'));
  assert.deepEqual(leaks, []);
});

test('glass: at most 4 blurred layers, none mid-drag', async () => {
  await win.evaluate(() => setUiSetting('uiStyle', 'glass'));
  const r = await win.evaluate(async () => {
    const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const btn = document.querySelector('#nav-sidebar .nav-btn');
    openModal('Glass', '<p>x</p>'); toast('Saved', 'ok');
    for (let i = 0; i < 4; i++) openPopover(btn, `<div>p${i}</div>`, { focus: false, keep: true });
    await frame();
    const blurred = () => [...document.querySelectorAll('*')].filter((el) => el.getClientRects().length && getComputedStyle(el).backdropFilter !== 'none').length;
    const most = blurred();
    document.dispatchEvent(new Event('dragstart', { bubbles: true }));
    await frame();
    const dragging = blurred();
    document.dispatchEvent(new Event('dragend', { bubbles: true }));
    await frame();
    const after = blurred();
    closeModal(); closeAllPopups();
    return { most, dragging, after };
  });
  await win.evaluate(() => setUiSetting('uiStyle', 'oldPlain'));
  assert.ok(r.most <= 4 && r.most >= 2, `blurred at once: ${r.most}`);
  assert.equal(r.dragging, 0);
  assert.equal(r.after, r.most);
});

test('no page or console error anywhere above', () => {
  assert.deepEqual(pageErrors, []);
});

test('reflow at 960 px: Properties folds first, the sidebar narrows, the page keeps its primary button', async () => {
  // The window AND the viewport: launchWithVault pins the viewport to 1280 so
  // the layout does not follow the runner's screen, and a pinned viewport no
  // longer tracks the window — resizing the window alone would test nothing.
  const size = async (w, h) => {
    await ui.app.evaluate(({ BrowserWindow }, [w2, h2]) => {
      const bw = BrowserWindow.getAllWindows().find((x) => x.isVisible());
      bw.unmaximize(); bw.setContentSize(w2, h2);
    }, [w, h]);
    await win.setViewportSize({ width: w, height: h });
  };
  await win.evaluate(() => { localStorage.setItem('dracondex-props-open', '1'); });
  await size(960, 680); await win.waitForTimeout(500);
  const r = await win.evaluate(async () => {
    const m = flattenModulesByKind(S.moduleTree, []).find((x) => x.kind === 'classifier');
    await openModuleNode(m.id); await new Promise((res) => setTimeout(res, 400));
    const box = (s) => document.querySelector(s).getBoundingClientRect();
    const p = box('.navbar-acts .btn-p');
    return { folded: document.querySelector('#side-panel').classList.contains('hidden'), sidebar: box('#left-panel').width,
      primaryIn: p.width > 0 && p.right <= innerWidth, hscroll: document.documentElement.scrollWidth > innerWidth };
  });
  await size(1280, 800); await win.waitForTimeout(500);
  const back = await win.evaluate(() => !document.querySelector('#side-panel').classList.contains('hidden'));
  await win.evaluate(() => { localStorage.setItem('dracondex-props-open', '0'); renderSidePanel(); });
  assert.ok(r.folded, 'pinned Properties folds in a narrow window');
  assert.ok(r.sidebar <= 220, `sidebar narrows: ${r.sidebar}`);
  assert.ok(r.primaryIn && !r.hscroll, 'primary button on screen, no sideways scroll');
  assert.ok(back, 'and comes back when the window widens');
});
