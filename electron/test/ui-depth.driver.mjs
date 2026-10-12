// Procress 24 — customisation depth (APP docs/UX-LAYOUT.md §13): from the
// Nexus's Home, every control a person changes the app with is at most 2
// clicks away when it is an everyday one, 3 when it is advanced. Measured by
// clicking the real buttons, never judged by eye.
//
// A row fails when
//   · the path takes more clicks than its budget
//   · a step is missing (the button was moved or removed)
//   · a step cannot be seen without hovering (UX-LAYOUT §12.1 / §13.1)
//   · a new window opened on the way (no step may switch windows)
//   · the path cannot be walked with the keyboard alone, focus + Enter, in
//     the same number of steps (a menu's rows count as reachable: they are a
//     roving list, ↑↓ inside one tab stop)
// and the printed table is the "EXE" column of APP Plan.md's Procress 24 table.
//
//   node --test electron/test/ui-depth.driver.mjs      (needs a display, like ui-smoke)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithVault } from './ui-app.mjs';

let ui, win;
const results = [];

before(async () => {
  ui = await launchWithVault('Depth');
  win = ui.win;
  // a label to colour — the sample vault has none
  await win.evaluate(async () => { if (!(await api.hashtag.getAll()).some((h) => h.tag_name === 'harbor')) await api.hashtag.create('harbor', null); });
});
after(async () => {
  console.log(`\n${'task'.padEnd(46)} ${'budget'.padEnd(7)} clicks  path`);
  for (const r of results) console.log(`${r.task.padEnd(46)} ${String(r.budget).padEnd(7)} ${String(r.clicks).padEnd(7)} ${r.path}`);
  await ui?.close();
});

const nestRow = (name) => `#left-panel-inner .li:has(> .name:text-is("${name}"))`;
const menuItem = (text) => `.context-menu-popup .kind-list-item:has-text("${text}")`;
const SETTINGS = '#nav-sidebar [data-cmd="app.settings"]';
const settingNav = (page) => `#setting-window .ls-row[onclick*="'${page}')"]`;
const PAGE_MENU = '#main-inner button.bnav[aria-haspopup="menu"]';

// { task, budget, path: [selector…], target: selector | (() => bool) in page, setup?, keyboard? }
const TASKS = [
  { task: 'Theme', budget: 1, path: [SETTINGS], target: '#setting-window .prefs-theme-grid' },
  { task: 'UI style', budget: 1, path: [SETTINGS], target: '#setting-window .ls-row[onclick*="uiStyle"]' },
  { task: 'Reduce transparency', budget: 1, path: [SETTINGS], target: '#setting-window [role="switch"]' },
  { task: 'Language · font size', budget: 2, path: [SETTINGS, settingNav('textsize')], target: '#setting-window .lang-list' },
  { task: 'Workspace style · UI size · animation', budget: 2, path: [SETTINGS, settingNav('style')], target: () => S.settingPage === 'style' && !!document.querySelector('#setting-window input[type="range"]') },
  { task: 'Make your own theme', budget: 2, path: [SETTINGS, '#setting-window .prefs-theme-add'], target: '#ctm-panel #ctm-name' },
  { task: 'Nest display options', budget: 1, path: ['#hub-body .nest-head button[onclick*="openNestOptionsPopup"]'], target: '.nest-options-popup' },
  // keyboard: the icon is not a tab stop of its own — the row's Shift+F10 → "Colour & icon" (2 steps)
  { task: 'Module icon · colour', budget: 1, path: [`${nestRow('Characters')} .kicon`], target: '.icon-edit-popup', keyboard: false },
  { task: 'Field values of an element', budget: 1, path: [nestRow('Mira')], target: '#main-inner .module-page input, #main-inner .module-page select' },
  { task: 'Change view', budget: 1, path: [nestRow('Characters')], target: '#main-inner .viewbar' },
  { task: 'Add a field', budget: 2, path: [nestRow('Characters'), '#main-inner button[onclick^="pageAddAttribute"]'], target: '#modal-overlay:not(.hidden) #ct-name' },
  { task: 'Field type (Structure tab)', budget: 3, path: [nestRow('Characters'), '#main-inner .page-tab[onclick*="structure"]', '#main-inner .page-structure .pk-link'], target: '#modal-overlay:not(.hidden) #ct-disptype' },
  { task: 'Field type (table column head)', budget: 3, setup: 'table',
    path: [nestRow('Characters'), '#main-inner .cls-table th button[aria-haspopup="menu"]', menuItem('Change type')], target: '#modal-overlay:not(.hidden) #ct-disptype' },
  { task: 'Layout (Workspace style), from Settings', budget: 2, path: [SETTINGS, settingNav('style')], target: () => S.settingPage === 'style' },
  { task: 'Layout, from the page ⋯ (View)', budget: 3, path: [nestRow('Characters'), PAGE_MENU, menuItem('Choose layout')], target: () => S.settingPage === 'style' && !!document.getElementById('setting-window') },
  { task: 'Title layout (align · icon · cover)', budget: 3, path: [nestRow('Characters'), PAGE_MENU, menuItem('Title layout')], target: '.ph-pop' },
  { task: 'Block look', budget: 3, path: [nestRow('Start here'), '#main-inner [data-cmd="page.arrange"]', '#main-inner .pb-gear'], target: '#pb-pop' },
  { task: 'Publish as website (Nexus menu)', budget: 2, path: ['#hub-body .nexus-switch', '.nexus-switcher-publish'], target: '#modal-overlay:not(.hidden) #hx-index' },
  { task: 'Publish as website (page ⋯)', budget: 3, path: [nestRow('Characters'), PAGE_MENU, menuItem('Publish as website')], target: '#modal-overlay:not(.hidden) #hx-index' },
  { task: 'This Nexus: name · colour · Locate (menu)', budget: 2, path: ['#hub-body .nexus-switch', '.nexus-switcher-edit'], target: '#modal-overlay:not(.hidden) #nx-name' },
  { task: 'This Nexus (status bar → Settings)', budget: 1, path: ['#status-bar .sb-nexus'], target: '#setting-thisnexus #nx-name' },
  { task: 'Label colour', budget: 2, path: ['#nav-sidebar [data-cmd="app.labels"]', '#main-inner .cat-page .ls-row button.btn-i'], target: '.tag-color-pop .cswatch' },
];

async function home() {
  await win.keyboard.press('Escape').catch(() => {});
  await win.evaluate(async () => {
    closeAllPopups(); closeModal();
    for (const p of document.querySelectorAll('.floating-panel')) closeFloatingPanel(p.id);
    if (typeof pageArrangingNow === 'function' && pageArrangingNow()) togglePageArrange();
    for (const k of Object.keys(PAGE_TAB)) delete PAGE_TAB[k]; // every page back on Overview
    showLeftDest('nest'); await builderOpenPage(null);
  });
  await win.mouse.move(2, 400); // over nothing that reacts to hover
  await win.waitForTimeout(250);
}

// Not counted: the state a row starts from (the Classifier showing its table).
async function setup(kind) {
  if (kind === 'table') {
    await (await pick(nestRow('Characters'))).click();
    await win.waitForTimeout(400);
    await win.locator('#main-inner .viewbar .seg-opt:has-text("Table")').first().click();
    await win.waitForTimeout(400);
  }
}

// The step's element as it is now, judged without any hover: there, visible
// (not display/visibility/opacity-hidden, not zero-sized, not covered), and
// reachable by the keyboard.
async function pick(sel) {
  const all = win.locator(sel);
  const n = await all.count();
  for (let i = 0; i < n; i++) if (await all.nth(i).boundingBox()) return all.nth(i);
  return n ? all.first() : null;
}
const inspect = async (sel) => {
  const loc = await pick(sel);
  if (!loc) return { found: false };
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const visible = el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && r.width > 0 && r.height > 0;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const role = el.getAttribute('role');
    return { found: true, visible, covered: !!hit && !el.contains(hit) && !hit.contains(el), hit: hit ? hit.outerHTML.slice(0, 120) : null, box: [r.x, r.y, r.width, r.height].map(Math.round),
      keyboard: el.tabIndex >= 0 || ['menuitem', 'option', 'treeitem'].includes(role) };
  });
};

const targetUp = (target) => (typeof target === 'function'
  ? win.evaluate(target)
  : win.evaluate((s) => [...document.querySelectorAll(s)].some((e) => e.getClientRects().length), target));

async function walk(t, how) {
  await home();
  if (t.setup) { await setup(t.setup); await home(); }
  const windows = ui.app.windows().length;
  let clicks = 0;
  for (const sel of t.path) {
    const st = await inspect(sel);
    assert.ok(st.found, `${t.task}: step "${sel}" is missing`);
    assert.ok(st.visible && !st.covered, `${t.task}: step "${sel}" cannot be seen without hovering (${JSON.stringify(st)})`);
    if (how === 'keyboard') {
      assert.ok(st.keyboard, `${t.task}: step "${sel}" is not reachable by keyboard`);
      await (await pick(sel)).focus();
      await win.keyboard.press('Enter');
    } else {
      await (await pick(sel)).click();
      await win.mouse.move(2, 400);
    }
    clicks++;
    await win.waitForTimeout(350);
  }
  for (let i = 0; i < 10 && !(await targetUp(t.target)); i++) await win.waitForTimeout(150);
  assert.ok(await targetUp(t.target), `${t.task}: the control did not appear (${how})`);
  assert.equal(ui.app.windows().length, windows, `${t.task}: a new window opened`);
  return clicks;
}

for (const t of TASKS) {
  test(`depth: ${t.task} — ≤ ${t.budget}`, async () => {
    const clicks = await walk(t, 'mouse');
    results.push({ task: t.task, budget: t.budget, clicks, path: t.path.length });
    assert.ok(clicks <= t.budget, `${t.task}: ${clicks} clicks, budget ${t.budget}`);
    if (t.keyboard !== false) assert.equal(await walk(t, 'keyboard'), clicks, `${t.task}: keyboard takes another number of steps`);
  });
}

// Procress 25: a Nexus from a template is ≤ 3 clicks from the Welcome window
// (New · the template · Create). Windows are this path's point — the one row
// where opening one is the task itself.
test('depth: a new Nexus from a template, from Welcome — ≤ 3', async () => {
  let clicks = 0;
  const [welcome] = await Promise.all([ui.app.waitForEvent('window'), win.evaluate(() => api.window.openWelcome())]);
  await welcome.waitForSelector('.welcome-hero', { timeout: 20000 });
  const [create] = await Promise.all([ui.app.waitForEvent('window'), welcome.locator("button.btn-p[onclick='welcomeCreateNexus()']").first().click().then(() => clicks++)]);
  await create.waitForSelector('#cn-grid .home-tpl', { timeout: 20000 });
  await create.locator('#cn-grid [data-cn-id="fantasy"]').click(); clicks++;
  await create.fill('#nx-name', 'Depth Fantasy'); // typing a value is not a step
  const [v] = await Promise.all([ui.app.waitForEvent('window'), create.click('#cn-create').catch(() => {}).then(() => clicks++)]);
  await v.waitForSelector('#hub-body', { timeout: 20000 });
  await v.waitForFunction(() => 'pendingCreate' in S, null, { timeout: 20000 });
  await v.evaluate(() => S.pendingCreate);
  const made = await v.evaluate(() => flattenModulesByKind(S.moduleTree, []).some((m) => m.name === 'Characters'));
  results.push({ task: 'New Nexus from a template (from Welcome)', budget: 3, clicks, path: 3 });
  await v.close();
  assert.ok(made, 'the template made its modules');
  assert.ok(clicks <= 3, `${clicks} clicks`);
});
