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
