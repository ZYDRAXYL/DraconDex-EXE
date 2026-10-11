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
};
const openListScreen = async (name) => {
  await win.evaluate(() => { closeFloatingPanel('setting-window'); closeSidePanel(); closeModal(); S.leftTool = null; });
  await win.evaluate(`(${LIST_SCREENS[name]})()`);
  await win.waitForTimeout(500);
};
const rowAudit = () => win.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  const zoom = Number(getComputedStyle(document.body).zoom) || 1;
  const h = { compact: parseFloat(cs.getPropertyValue('--row-compact')), comfy: parseFloat(cs.getPropertyValue('--row-comfy')) };
  const rows = [...document.querySelectorAll('.ls-row')].filter((r) => r.offsetParent && r.getBoundingClientRect().height);
  const bad = [];
  for (const r of rows) {
    const want = (r.classList.contains('ls-compact') ? h.compact : h.comfy) * zoom;
    const got = r.getBoundingClientRect().height;
    const name = r.getAttribute('aria-label') || '';
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
      if (name !== 'plugins' && !r.n) bad.push(`${name}: no rows to measure`);
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
