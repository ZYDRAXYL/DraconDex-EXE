// Procress 16 part 1 — the UI smoke suite: every check here CLICKS the real
// app (Playwright _electron, a real pointer), because 249 data-layer tests
// passed while the rail, the Create flyout, presets, Exhibitor and the tab
// strip were all broken. "Tests pass" has to mean "the buttons work".
//
//   node --test electron/test/ui-smoke.driver.mjs
//
// Not in the *.test.mjs glob: it needs a display (Windows CI has one; Linux
// needs Xvfb) and launches Electron (~20 s). One launch, one fresh vault with
// the sample content, subtests in order.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithVault } from './ui-app.mjs';

let ui, win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const row = (name) => win.locator(`#left-panel-inner .li:has-text('${name}')`).first();
const tabs = () => win.evaluate(() => { const p = builderState().panes[builderState().focused]; return { tabs: [...p.tabs], active: p.active }; });
// A real pointer move in steps, like a hand — :hover and hover-intent see it.
async function hover(locator, steps = 12) {
  const b = await locator.boundingBox();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps });
}

before(async () => { ui = await launchWithVault('Smoke'); win = ui.win; });
after(async () => { await ui?.close(); });

test('B1: every rail button does something, with no page error', async () => {
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  const dead = await win.evaluate(async () => {
    const out = [];
    for (const b of document.querySelectorAll('#nav-sidebar [data-cmd]')) {
      if (['app.nest', 'app.settings'].includes(b.dataset.cmd)) continue; // open already / a window of its own
      // a destination changes the left panel; Labels opens the category index in the workspace (16 part 5)
      const snap = () => `${document.querySelector('#left-panel-inner')?.innerHTML}|${document.querySelector('#main-inner')?.innerHTML}`;
      const before = snap();
      b.click();
      await new Promise((r) => setTimeout(r, 400));
      if (snap() === before) out.push(b.dataset.cmd);
    }
    return out;
  });
  assert.deepEqual(dead, [], 'rail buttons that changed nothing');
  assert.deepEqual(errors, []);
  await win.click('#nav-sidebar [data-cmd="app.nest"]');
});

// B4 + Procress 17 I2: Create opens the searchable kind picker on a click (it
// was a hover flyout that opened by itself); the hover flyouts that remain
// survive moving through them and a diagonal across a sibling with its own.
test('B4 / I2: Create is a click-opened picker; a hover flyout survives a diagonal across a sibling', async () => {
  await win.evaluate(async () => { await api.module.createMany(Array.from({ length: 12 }, (_, i) => ({ nexus_ref: S.nexus.id, name: 'Shelf ' + i, kind: 'collector' }))); await reloadModuleTree(); });
  await row('Guide').click({ button: 'right' });
  await hover(win.locator('.context-menu-popup .kind-list-item:has-text("Create")'));
  await sleep(400);
  assert.equal(await win.locator('.ctx-submenu').count(), 0, 'hovering Create opens nothing');
  await win.locator('.context-menu-popup .kind-list-item:has-text("Create")').click();
  await win.waitForSelector('.kind-list-popup .kind-search');
  await win.keyboard.press('Escape');
  await row('Guide').click({ button: 'right' });
  await hover(win.locator('.context-menu-popup .kli-submenu-parent:has-text("Move to")'));
  await sleep(400);
  const first = () => win.evaluate(() => [...document.querySelectorAll('.ctx-submenu')].map((s) => s.querySelector('.kind-list-item')?.textContent.trim().slice(0, 13)));
  const opened = await first();
  assert.equal(opened.length, 1);
  // the first fully visible flyout row whose straight path from "Move to…" really
  // crosses "Export ▸" (a sibling with its own flyout) inside the parent menu
  const pick = await win.evaluate(() => {
    const box = (e) => e.getBoundingClientRect();
    const menu = document.querySelector('.context-menu-popup'), sub = document.querySelector('.ctx-submenu');
    const parents = [...menu.querySelectorAll('.kli-submenu-parent')];
    const from = box(parents.find((e) => /Move to/.test(e.textContent)));
    const sib = box(parents.find((e) => /Export/.test(e.textContent)));
    const fx = (from.left + from.right) / 2, fy = (from.top + from.bottom) / 2, sb = box(sub), mr = box(menu).right;
    return [...sub.querySelectorAll('.kind-list-item')].findIndex((r) => {
      const k = box(r);
      const tx = k.left + 20, ty = (k.top + k.bottom) / 2;
      if (k.top < sb.top || k.bottom > sb.bottom) return false;
      const at = (y) => fx + (tx - fx) * ((y - fy) / (ty - fy));
      return ty > sib.bottom && at((sib.top + sib.bottom) / 2) < mr;
    });
  });
  assert.ok(pick >= 0, 'a row the diagonal reaches across "Export ▸"');
  const target = await win.locator('.ctx-submenu .kind-list-item').nth(pick).boundingBox();
  await win.mouse.move(target.x + 20, target.y + target.height / 2, { steps: 20 });
  await sleep(600);
  assert.deepEqual(await first(), opened, 'crossing a sibling on the way must not swap the flyout');
  for (const n of [3, 5, 1]) { await hover(win.locator('.ctx-submenu .kind-list-item').nth(n)); await sleep(450); }
  assert.deepEqual(await first(), opened, 'rows inside the flyout must not close it');
  await win.keyboard.press('Escape'); await win.keyboard.press('Escape');
});

test('the page ⋯ menu and the Nest [▾] open real menus', async () => {
  await row('Characters').click(); await sleep(600);
  const rows = () => win.locator('.context-menu-popup .kind-list-item').count();
  await win.click('.bpane-body button[aria-label="Page menu"], .bpane-body button[title="Page menu"]');
  await win.waitForSelector('.context-menu-popup');
  assert.ok(await rows() >= 4, 'page menu has its rows');
  await win.keyboard.press('Escape');
  await win.click('#left-panel button.split-more');
  await win.waitForSelector('.kind-popup');
  assert.ok(await win.locator('.kind-popup .kind-list-item').count() >= 1, '[▾] lists ways to add');
  await win.keyboard.press('Escape');
});

test('B5: a preset names the module, sets its type, adds one element and says so', async () => {
  const r = await win.evaluate(async () => {
    await quickCreateModule('classifier', null, 'b:character');
    await new Promise((res) => setTimeout(res, 500));
    const id = S.activeModuleNode.id, m = await api.module.get(id);
    return { name: m.name, cat: m.cat_type, objs: (await api.classifier.getObjects(id)).length, toast: document.querySelector('#toast')?.textContent };
  });
  assert.notEqual(r.name, 'New Classifier');
  assert.equal(r.cat, 'character');
  assert.equal(r.objs, 1);
  assert.match(r.toast, /4/);
});

test('B3: "Open in Exhibitor" three times = one Exhibitor; on an Exhibitor = itself', async () => {
  const r = await win.evaluate(async () => {
    const count = async () => { await reloadModuleTree(); let n = 0; const w = (ns) => ns.forEach((m) => { if (m.kind === 'exhibitor') n++; w(m.children || []); }); w(S.moduleTree); return n; };
    // a Classifier no Exhibitor covers yet (B5 made one): the first press creates, the next two reuse
    const id = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: 'Smoke cast', kind: 'classifier', cat_type: 'object' });
    await reloadModuleTree();
    await openExhibitorFor(id); closeAllPopups();
    const before = await count();
    for (let i = 0; i < 2; i++) { await openExhibitorFor(id); closeAllPopups(); }
    const ex = S.activeModuleNode.id;
    await openExhibitorFor(ex); // from the Exhibitor's own page
    return { before, after: await count(), self: S.activeModuleNode.id === ex };
  });
  assert.ok(r.before >= 1);
  assert.equal(r.after, r.before);
  assert.equal(r.self, true);
});

test('B2: middle/Ctrl-click and + open new tabs; clicking an open item focuses its tab', async () => {
  await row('Characters').click(); await sleep(600);
  const start = (await tabs()).tabs.length;
  const b = await row('Harbor map').boundingBox();
  await win.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'middle' }); await sleep(700);
  await row('History').click({ modifiers: ['Control'] }); await sleep(700);
  assert.equal((await tabs()).tabs.length, start + 2);
  await row('Characters').click(); await sleep(600);
  const t = await tabs();
  assert.equal(t.tabs.length, start + 2, 'no duplicate tab');
  assert.match(t.active, /^module:/);
  await win.click('.bpane-acts button[aria-label="New tab"]');
  await win.waitForSelector('#qs-list .qs-item');
  assert.equal(await win.evaluate(() => _qsShown.some((e) => e.cmd)), false, 'new tab lists pages, not commands');
  await win.keyboard.type('Rumors'); await sleep(400);
  await win.keyboard.press('Enter'); await sleep(800);
  assert.equal((await tabs()).tabs.length, start + 3);
});

// ── Procress 17 part 1 ───────────────────────────────────────────────────
test('R3: the rail follows a language switch; ⚙ has a name', async () => {
  const titles = () => win.evaluate(() => [...document.querySelectorAll('#nav-sidebar [data-cmd="app.searchPanel"], #nav-settings-btn')]
    .map((b) => b.getAttribute('aria-label') || b.title));
  const en = await titles();
  await win.evaluate(() => setUiSetting('language', 'th'));
  const th = await titles();
  await win.evaluate(() => setUiSetting('language', 'en'));
  assert.equal(en.length, 2);
  assert.ok(en.every(Boolean), 'every rail button is named');
  assert.notDeepEqual(th, en);
});

test('R4: Home clears the last page\'s words and save state', async () => {
  await row('Start here').click(); await sleep(700);
  await win.locator('.bpane-body textarea').first().click();
  await win.keyboard.type(' more words'); await sleep(1500);
  assert.match(await win.locator('#status-bar').innerText(), /\d+ words/);
  await win.evaluate(() => builderOpenPage(null)); await sleep(300);
  assert.doesNotMatch(await win.locator('#status-bar').innerText(), /words|Saved/);
});

test('R5: Esc while naming a just-created module cancels the create', async () => {
  const count = () => win.evaluate(() => { let n = 0; const w = (ns) => ns.forEach((m) => { if (m.kind === 'drafter') n++; w(m.children || []); }); w(S.moduleTree); return n; });
  const before = await count();
  await win.evaluate(() => quickCreateModule('drafter', null)); await sleep(800);
  assert.equal(await count(), before + 1);
  await win.keyboard.press('Escape'); await sleep(800);
  assert.equal(await count(), before);
});

// ── Procress 17 parts 2–3 ────────────────────────────────────────────────
test('P1: a long list renders its first rows and grows as it is scrolled', async () => {
  const cls = await win.evaluate(async () => {
    const id = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: 'Long list', kind: 'classifier', cat_type: 'object' });
    await api.classifier.createObjects(id, Array.from({ length: 600 }, (_, i) => ({ name: `Row ${i}` })));
    await reloadModuleTree();
    await openModuleNode(id);
    return id;
  });
  await sleep(300);
  const rows = () => win.locator('.cls-list .li').count();
  const first = await rows();
  assert.ok(first >= 100 && first < 300, `first render ${first} rows`);
  for (let i = 0; i < 6; i++) { await win.evaluate(() => document.querySelector('.cls-list [data-lazy]')?.scrollIntoView()); await sleep(250); }
  const grown = await rows();
  assert.ok(grown > first, `more rows after scrolling (${first} → ${grown})`);
  // selecting a far row keeps it on screen through the re-render
  const far = await win.evaluate(async (id) => { const o = (await api.classifier.getObjects(id))[550]; const iid = document.querySelector('[onclick*="selectClassifierObject"]').getAttribute('onclick').match(/selectClassifierObject\(["']([^"']+)["']/)[1]; selectClassifierObject(iid, o.id); return o.name; }, cls);
  await sleep(300);
  assert.equal(await win.locator('.cls-list .li.sel .name').innerText(), far);
});

// ── Procress 18 part 1 + 16 B6/B8 ────────────────────────────────────────
test('18 part 1: Nest head order, Home phase A, Recent, / and [+ New] in context', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await sleep(300);
  const order = await win.evaluate(() => [...document.querySelector('#hub-body').children].map((e) => e.className.split(' ')[0]));
  assert.deepEqual(order.slice(0, 4), ['nest-head', 'nest-create', 'nest-filter', 'acc-body']);
  assert.equal(await win.evaluate(() => document.querySelector('#left-panel-foot').innerHTML.trim()), '', 'no second vault-name bar');
  assert.equal(await win.locator('[data-key="dock"]').count(), 0, 'no Import Dock section');
  assert.equal(await win.locator('.home-start h2').count(), 1);
  assert.equal(await win.locator('.home-actions .btn-p').count(), 1);
  // with nothing picked, [+ New] makes a folder at the root
  assert.match(await win.evaluate(() => nestNewHereLabel()), /folder/i);
  await row('Characters').click(); await sleep(500);
  assert.equal(await win.evaluate(() => nestNewContext().cmd), 'classifier.addObject');
  // Recent lists what was opened
  await win.click('#nav-sidebar [data-cmd="app.recent"]'); await sleep(500);
  assert.match(await win.locator('#left-recent').innerText(), /Characters/);
  await win.click('#nav-sidebar [data-cmd="app.nest"]'); await sleep(300);
  await win.evaluate(() => document.activeElement?.blur()); // nothing typed-into has focus
  await win.keyboard.press('/');
  assert.equal(await win.evaluate(() => document.activeElement?.id), 'nest-filter-q');
  await win.keyboard.press('Escape');
});

// ── Procress 16 part 2 ───────────────────────────────────────────────────
test('16 part 2: a real file dropped on a folder is copied into it on disk and filed; k: l: t: filter', async () => {
  const png = new URL('../../src/assets/brand/DraconDex_WhiteOut.png', import.meta.url);
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 't-in'; document.body.appendChild(i); window.uiConfirm = async () => true; });
  await win.setInputFiles('#t-in', decodeURIComponent(png.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const r = await win.evaluate(async () => {
    const files = document.getElementById('t-in').files;
    const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
    const row = document.querySelector('#left-panel-inner [data-mid="1"]'); // the Guide folder
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    await new Promise((res) => setTimeout(res, 3000));
    return nestAssetsOf(1).map((f) => f.file_path);
  });
  assert.equal(r.length, 1);
  assert.match(r[0], /[\\/]Guide[\\/]DraconDex_WhiteOut\.png$/,'copied into the folder of the collector it was dropped on');
  const hits = (q) => win.evaluate(async (qq) => { setNestFilter(qq); await new Promise((res) => setTimeout(res, 400)); return [...document.querySelectorAll('.nest-filter-hit .name')].map((e) => e.textContent); }, q);
  assert.deepEqual(await hits('t:image'), ['DraconDex_WhiteOut.png']);
  assert.ok((await hits('k:classifier')).includes('Characters'));
  assert.deepEqual(await hits('k:classifier t:image'), []);
  await win.evaluate(async () => { const id = (await api.hashtag.create('heroes', null)).lastInsertRowid; await api.module.setTags(3, [id]); await reloadModuleTree(); });
  assert.deepEqual(await hits('l:hero'), ['Characters']);
  await win.evaluate(() => setNestFilter(''));
});

test('16 part 2: two-column mode — a folder opens as a grid page with a size slider', async () => {
  await win.evaluate(() => { S.settings.nestTwoColumn = true; showLeftDest('nest'); });
  await win.locator('#left-panel-inner [data-mid="1"] .name').click(); await sleep(700);
  assert.equal(await win.evaluate(() => S.folderPage), 1);
  assert.ok(await win.locator('.folder-tile').count() >= 5);
  assert.equal(await win.evaluate(() => builderState().panes[builderState().focused].active), 'folder:1');
  await win.locator('.folder-tile:has-text("Characters")').click(); await sleep(600);
  assert.equal(await win.evaluate(() => S.activeModuleNode?.name), 'Characters');
  await win.evaluate(() => { S.settings.nestTwoColumn = false; });
});

// ── Procress 18 part 2 ───────────────────────────────────────────────────
test('18 part 2: the Nest is a keyboard tree; Properties opens with Ctrl+Alt+B and follows the page', async () => {
  await win.evaluate(() => { try { localStorage.setItem('dracondex-props-open', '0'); } catch (_) {} showLeftDest('nest'); return builderOpenPage(null); });
  await sleep(300);
  assert.equal(await win.locator('#nest-tree-body[role="tree"]').count(), 1);
  assert.equal(await win.locator('#nest-tree-body [role="treeitem"][tabindex="0"]').count(), 1, 'one tab stop');
  await win.locator('#nest-tree-body [data-mid="1"]').focus();
  await win.keyboard.press('ArrowDown');
  assert.equal(await win.evaluate(() => document.activeElement?.dataset.mid), '2');
  await win.keyboard.press('Enter'); await sleep(700);
  assert.equal(await win.evaluate(() => S.activeModuleNode?.id), 2);
  await win.keyboard.press('Control+Alt+b'); await sleep(500);
  assert.match(await win.locator('.sp-props').innerText(), /Doc|Drafter/);
  assert.equal(await win.locator('[aria-controls="side-panel"]').getAttribute('aria-expanded'), 'true');
  await row('Characters').click(); await sleep(700);
  assert.match(await win.locator('.sp-props').innerText(), /Classifier/, 'follows the page');
  await win.keyboard.press('Control+Alt+b'); await sleep(300);
  assert.equal(await win.evaluate(() => document.querySelector('#side-panel').classList.contains('hidden')), true);
});

// ── Procress 16 part 4 · 17 part 4 · 18 part 3 ───────────────────────────
test('16 B11–B12 / 18 part 3: Overview·Structure tabs, Properties is one row, the view bar opens its options', async () => {
  await row('Characters').click(); await sleep(700);
  assert.equal(await win.locator('.module-page .page-tab').count(), 2);
  assert.equal(await win.locator('.module-page .page-blocks .pb-desc').count(), 0, 'no description editor on the page');
  const h = await win.evaluate(() => [...document.querySelectorAll('.module-page .viewbar .vitem:not(.vgear)')].map((e) => e.getBoundingClientRect().height));
  assert.ok(h.length && h.every((v) => v >= 28), `view bar ≥ 28 px: ${h}`);
  await win.locator('.module-page .viewbar .vitem.act').first().click(); await sleep(300);
  assert.equal(await win.locator('#pb-pop').count(), 1, 'a click on the view that is on opens its options');
  await win.evaluate(() => closePbStyle());
  await win.locator('.page-tab:has-text("Structure")').click(); await sleep(500);
  assert.ok(await win.locator('.page-structure .insp-attr').count() >= 1, 'the fields');
  assert.equal(await win.locator('.page-structure .pb-props').count(), 1, 'the properties editor');
  await win.locator('.page-tab:has-text("Overview")').click(); await sleep(300);
});

// ── Procress 16 part 3b ──────────────────────────────────────────────────
test('16 part 3b: a row on the 12 grid nests a row and its border drags (snap, Alt = free)', async () => {
  const r = await win.evaluate(async () => {
    await quickCreateModule('page', null);
    await new Promise((res) => setTimeout(res, 500));
    const id = S.activeModuleNode.id;
    const row = await api.block.add(id, null, { type: 'columns', config: { widths: [8, 4], n: 2 } });
    const rid = row?.id ?? row;
    const inner = await api.block.add(id, null, { type: 'columns', parentId: rid, config: { col: 0, widths: [4, 4, 4] } });
    await api.block.add(id, null, { type: 'heading', content: 'Deep', parentId: inner?.id ?? inner, config: { col: 1 } });
    await reloadModulePage(id, null);
    runCommand('page.arrange');
    await new Promise((res) => setTimeout(res, 500));
    const outerOf = () => document.querySelector(`.pblock[data-block="${rid}"] > .pb-body > .pb-cols`);
    const widths = [...outerOf().children].map((c) => Math.round(c.getBoundingClientRect().width));
    const drag = async (alt) => {
      const outer = outerOf(); // the page redraws after each save
      const g = outer.querySelector(':scope > .pb-col > .pb-col-grip');
      const box = outer.getBoundingClientRect();
      g.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + box.width / 2 }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: box.left + box.width * 0.29, altKey: alt }));
      document.dispatchEvent(new PointerEvent('pointerup', {}));
      await new Promise((res) => setTimeout(res, 600));
      return pageOf(id, null).blocks.find((b) => b.id === rid).config.widths;
    };
    const snap = await drag(false);
    const free = await drag(true);
    runCommand('page.arrange');
    return { widths, nested: !!document.querySelector('.pb-cols .pb-cols'), snap, free };
  });
  assert.ok(r.widths[0] > r.widths[1] * 1.8, `8/4 draws two to one: ${r.widths}`);
  assert.ok(r.nested, 'a row inside a column');
  assert.deepEqual(r.snap, [3, 9]);
  assert.deepEqual(r.free, [3.5, 8.5]);
});
test('16 B10: arranging swaps the Nest for the component collection; a card drops onto the page', async () => {
  await win.evaluate(async () => {
    await quickCreateModule('page', null);
    await new Promise((res) => setTimeout(res, 500));
    await api.block.add(S.activeModuleNode.id, null, { type: 'heading', content: 'Alpha' });
    await reloadModulePage(S.activeModuleNode.id, null);
    runCommand('page.arrange');
  });
  await sleep(500);
  assert.ok(await win.locator('#left-panel-inner .pbc-card').count() > 20, 'the collection is in the left panel');
  await win.locator('#left-panel-inner #pbc-q').fill('callout');
  assert.equal(await win.locator('#left-panel-inner .pbc-card').count(), 1, 'search narrows it');
  await win.locator('#left-panel-inner .pbc-card[data-key="c:core.callout"]').dragTo(win.locator('.pblock:has(input[value="Alpha"])'), { targetPosition: { x: 4, y: 20 } });
  await sleep(800);
  const kids = await win.evaluate(() => pageOf(S.activeModuleNode.id, null).blocks.map((b) => [b.block_type, b.component, b.parent_id != null]));
  assert.ok(kids.some(([tp]) => tp === 'columns'), `dropped on the left edge → a row: ${JSON.stringify(kids)}`);
  assert.ok(kids.some(([, c, inRow]) => c === 'core.callout' && inRow));
  await win.evaluate(() => { _pbcQuery = ''; runCommand('page.arrange'); });
  await sleep(400);
  assert.equal(await win.locator('#left-panel-inner .pbc-card').count(), 0, 'Done → the Nest again');
});
test('16 part 3b: page size — Phone stacks a row, keeps its own widths, hides a block', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await quickCreateModule('page', null); await wait(500);
    const id = S.activeModuleNode.id;
    const row = await api.block.add(id, null, { type: 'columns', config: { widths: [8, 4], n: 2 } });
    const rid = row?.id ?? row;
    for (const col of [0, 1]) await api.block.add(id, null, { type: 'heading', content: `C${col}`, parentId: rid, config: { col } });
    await api.block.add(id, null, { type: 'heading', content: 'Wide', config: { style: { hideOn: 'phone' } } });
    await reloadModulePage(id, null);
    runCommand('page.arrange'); await wait(400);
    const cols = () => [...document.querySelector(`.pblock[data-block="${rid}"] .pb-cols`).children].map((e) => Math.round(e.getBoundingClientRect().width));
    setPageFrame('phone'); await wait(300);
    const stacked = cols();
    await pbColsSet(document.querySelector(`.pblock[data-block="${rid}"]`).dataset.iid, 'widths', '6,6'); await wait(300);
    const phone = cols();
    setPageFrame('pc'); await wait(300);
    const pc = cols();
    runCommand('page.arrange'); await wait(300);
    const pb = document.querySelector('.page-blocks');
    pb.style.width = '400px'; await wait(100); // a narrow page, not arranging
    const hidden = getComputedStyle(document.querySelector('.pblock[data-hide]')).display;
    pb.style.width = '';
    return { stacked, phone, pc, hidden, cfg: pageOf(id, null).blocks.find((b) => b.id === rid).config };
  });
  assert.equal(r.stacked[0], r.stacked[1], `phone stacks by default: ${r.stacked}`);
  assert.deepEqual(r.cfg.widthsBy, { phone: [6, 6] });
  assert.ok(Math.abs(r.phone[0] - r.phone[1]) <= 1 && r.phone[0] < r.stacked[0], `phone 50/50: ${r.phone}`);
  assert.ok(r.pc[0] > r.pc[1] * 1.8, `PC keeps 8/4: ${r.pc}`);
  assert.equal(r.hidden, 'none', 'hidden on a phone-width page');
});
test('16 part 3b components: data table (sort, rows), link text (red when gone), scoped search box', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const all = flattenModulesByKind(S.moduleTree, []);
    const chars = all.find((m) => m.name === 'Characters');
    const hist = all.find((m) => m.name === 'History');
    await quickCreateModule('page', null); await wait(500);
    const id = S.activeModuleNode.id;
    await api.block.add(id, null, { type: 'component', component: 'core.datatable', config: { source: chars.id, sortDir: 'desc', rows: 2 } });
    await api.block.add(id, null, { type: 'component', component: 'core.linktext', config: { links: [{ to: `module:${hist.id}` }, { to: 'wiki:Nowhere Land' }] } });
    await api.block.add(id, null, { type: 'component', component: 'core.search', config: { scope: chars.id } });
    await reloadModulePage(id, null); await wait(1200);
    renderNexusHome(); await wait(300);
    const inp = document.querySelector('.pc-search input');
    inp.value = 'Harbor'; inp.dispatchEvent(new Event('input')); await wait(900);
    return {
      rows: [...document.querySelectorAll('.pc-datatable tbody tr td:first-child')].map((e) => e.textContent.trim()),
      red: [...document.querySelectorAll('.pc-linktext .pb-link')].map((e) => e.classList.contains('pb-link-dangling')),
      hits: [...document.querySelectorAll('.pc-search-hit')].map((e) => /"([a-z]+_\d+)"/.exec(e.getAttribute('onclick'))?.[1]),
      everywhere: (await api.search.query(S.nexus.id, 'Harbor')).map((h) => h.key),
      charsKey: `module_${chars.id}`,
    };
  });
  assert.deepEqual(r.rows, ['Tobin', 'Sela'], 'Z → A, two rows');
  assert.deepEqual(r.red, [false, true]);
  assert.ok(r.hits.length < r.everywhere.length, `scoped is narrower than the whole Nexus: ${r.hits} vs ${r.everywhere}`);
  assert.ok(r.hits.every((k) => k === r.charsKey || /^cobj_/.test(k)), `only Characters and its elements: ${r.hits}`);
});

// ── Procress 18 part 4 ───────────────────────────────────────────────────
test('18 part 4: Ctrl+P creates in context; a rename shows at once and is announced', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await openQuickSwitcher('>');
    await wait(300);
    const keys = _qsItems.map((e) => e.key);
    document.getElementById('qs-overlay')?.remove();
    const m = flattenModulesByKind(S.moduleTree, []).find((x) => x.name === 'Travels');
    const p = saveModuleRename(m.id, 'Journeys');
    const immediate = findModuleNode(m.id).name; // before the save returns
    await p; await wait(400); // announce() writes a frame later
    const said = document.getElementById('sr-live').textContent;
    await saveModuleRename(m.id, 'Travels');
    return { hasNew: keys.includes('new:classifier'), immediate, said };
  });
  assert.ok(r.hasNew, 'a "New Classifier" row');
  assert.equal(r.immediate, 'Journeys');
  assert.match(r.said, /Journeys/);
});

// ── Procress 18 part 5 ───────────────────────────────────────────────────
test('18 part 5: the tab strip from the keyboard — ← moves, Enter opens, Delete closes', async () => {
  await win.evaluate(async () => {
    const ms = flattenModulesByKind(S.moduleTree, []);
    await openModuleNode(ms.find((m) => m.name === 'History').id);
    await builderInNewTab(() => openModuleNode(ms.find((m) => m.name === 'Characters').id));
  });
  await sleep(500);
  const strip = '#main-inner .bpane-tabs[role="tablist"]';
  assert.equal(await win.locator(`${strip} [role="tab"][tabindex="0"]`).count(), 1, 'one tab stop');
  await win.locator(`${strip} [role="tab"][aria-selected="true"]`).focus();
  await win.keyboard.press('ArrowLeft');
  const focused = await win.evaluate(() => document.activeElement?.getAttribute('title'));
  await win.keyboard.press('Enter'); await sleep(500);
  assert.equal(await win.evaluate(() => S.activeModuleNode?.name), focused, 'Enter opened the tab focus moved to');
  const before = await win.locator(`${strip} [role="tab"]`).count();
  await win.locator(`${strip} [role="tab"][aria-selected="true"]`).focus();
  await win.keyboard.press('Delete'); await sleep(400);
  assert.equal(await win.locator(`${strip} [role="tab"]`).count(), before - 1, 'Delete closed it');
});

// ── Procress 16 part 5 ───────────────────────────────────────────────────
test('16 part 5: a red link is red, and creates its page with a chosen kind and folder', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await builderOpenPage(null); await wait(200);
    await quickCreateModule('drafter', null); await wait(500);
    const id = S.activeModuleNode.id;
    await api.module.updateDescription(id, 'See [[Nowhere Land]].');
    findModuleNode(id).description = 'See [[Nowhere Land]].';
    await openModuleNode(id); await wait(600);
    document.querySelector('#main-inner .mded-toggle')?.click(); await wait(300); // to the preview
    const a = document.querySelector('#main-inner .wikilink-unresolved');
    return { found: !!a, color: a && getComputedStyle(a).color, danger: getComputedStyle(document.body).getPropertyValue('--danger').trim() };
  });
  assert.ok(r.found, 'the unresolved link is drawn');
  await win.locator('#main-inner .wikilink-unresolved').first().click(); await sleep(300);
  assert.equal(await win.locator('#wl-name').inputValue(), 'Nowhere Land');
  await win.selectOption('#wl-kind', 'page');
  await win.click('button.btn-p[onclick="pbLinkCreateGo()"]'); await sleep(800);
  const made = await win.evaluate(() => ({ name: S.activeModuleNode?.name, kind: S.activeModuleNode?.kind }));
  assert.deepEqual(made, { name: 'Nowhere Land', kind: 'page' });
});
test('16 part 5: links resolve from the first page drawn; an element previews as its own infobox', async () => {
  const r = await win.evaluate(async () => {
    const m = flattenModulesByKind(S.moduleTree, []).find((x) => x.kind === 'scribe');
    await openModuleNode(m.id); await new Promise((res) => setTimeout(res, 600));
    const a = document.querySelector('#main-inner .chs-text .wikilink');
    _pbSummary.clear();
    const s = await pbEntitySummary(a?.dataset.key);
    return { key: a?.dataset.key, red: a?.classList.contains('wikilink-unresolved'), s };
  });
  assert.match(r.key, /^cobj_\d+$/);
  assert.equal(r.red, false);
  assert.equal(r.s.name, 'Sela');
  assert.equal(r.s.fields.length, 3, 'three facts, from its fields');
  assert.ok(r.s.first, 'and the first line of its note');
});
test('16 part 5: a label is a category — its page lists members and subcategories; a new page ends with its categories', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const ms = flattenModulesByKind(S.moduleTree, []);
    const ida = (await api.hashtag.create('places', null)).lastInsertRowid;
    const idb = (await api.hashtag.create('places/ports', null)).lastInsertRowid;
    await api.module.setTags(ms.find((m) => m.name === 'Harbor map').id, [ida]);
    const folder = ms.find((m) => m.kind === 'collector');
    await quickCreateModule('drafter', folder.id); await wait(500);
    const id = S.activeModuleNode.id;
    await api.module.setTags(id, [idb]);
    await openModuleNode(id); await wait(500);
    const bar = [...document.querySelectorAll('.pc-cats .pc-cat')].map((e) => e.textContent.trim());
    document.querySelector('.pc-cats .pc-cat')?.click(); await wait(600);
    const sub = { tab: builderState().panes[builderState().focused].active, members: [...document.querySelectorAll('.cat-members .name')].map((e) => e.textContent) };
    openCategoryPage('places'); await wait(500);
    return { bar, folder: folder.name, sub, subs: [...document.querySelectorAll('.cat-subs .pc-cat')].map((e) => e.textContent.trim()),
      members: [...document.querySelectorAll('.cat-members .name')].map((e) => e.textContent) };
  });
  assert.deepEqual(r.bar, ['#places/ports', r.folder], 'the bar: its label, then its folder');
  assert.equal(r.sub.tab, 'category:places/ports');
  assert.equal(r.sub.members.length, 1);
  assert.deepEqual(r.members, ['Harbor map']);
  assert.match(r.subs[0], /^#places\/ports/);
});
test('16 part 5: search narrows with k: / l: / in:, and remembers what was searched', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    showLeftDest('search'); await wait(300);
    const run = async (qy) => { q('#left-search-q').value = qy; await runLeftSearch(qy); return [...document.querySelectorAll('#left-search-res .left-search-row .name')].map((e) => e.firstChild.textContent.trim()); };
    const all = await run('harbor');
    const cls = await run('harbor k:classifier');
    const onlyK = await run('k:chronicler');
    const inGuide = await run('k:classifier in:Guide');
    q('#left-search-q').value = ''; await runLeftSearch('');
    const hist = [...document.querySelectorAll('#left-search-res .li .name')].map((e) => e.textContent);
    showLeftDest('nest');
    return { all, cls, onlyK, inGuide, hist };
  });
  assert.ok(r.all.length > r.cls.length && r.cls.length >= 1, `k: narrows: ${r.all} → ${r.cls}`);
  assert.deepEqual(r.onlyK, ['History'], 'a filter alone lists its modules');
  assert.ok(r.inGuide.includes('Characters'));
  assert.equal(r.hist[0], 'k:classifier in:Guide', 'the latest search first');
});
test('16 part 5: an element\'s infobox shows its page picture over its fields', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const ch = flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'Characters');
    await openModuleNode(ch.id); await wait(400);
    const o = clsData(ch.id).objects.find((x) => x.name === 'Tobin');
    const img = nestAssetsOf(1)[0]; // the PNG the 16 part 2 test dropped on Guide
    await api.module.setUi(ch.id, `pageHead:cobj_${o.id}`, JSON.stringify({ cover: `file_${img.id}` }));
    _pbSummary.clear();
    await api.block.add(ch.id, '*', { type: 'component', component: 'core.infobox' }); // as the article + infobox template does
    await openItemNode('classifier', ch.id, o.id); await wait(1200);
    const box = document.querySelector('.pc-infobox');
    return { box: !!box, pic: !!box?.querySelector('.pc-ib-pic'), rows: box?.querySelectorAll('.pc-ib-row, .pc-ib-stack').length || 0 };
  });
  assert.ok(r.box, 'the element page has an infobox');
  assert.ok(r.pic, 'with the picture');
  assert.ok(r.rows >= 3, 'over its fields');
});
test('16 part 5: Home phase B — the most linked page, what changed, counts and a random page', async () => {
  const r = await win.evaluate(async () => {
    await builderOpenPage(null); await new Promise((res) => setTimeout(res, 1200));
    return { secs: [...document.querySelectorAll('#home-portal h3')].length, changed: document.querySelectorAll('#home-portal .home-list .li').length,
      featured: !!document.querySelector('#home-portal .home-featured'), random: !!document.querySelector('#home-portal [onclick="openRandomPage()"]') };
  });
  assert.ok(r.featured && r.changed > 0 && r.random, JSON.stringify(r));
});

// ── Procress 16 part 6 ───────────────────────────────────────────────────
test('16 part 6: publish to a folder — profile, search box live, secret block and #draft page out', async () => {
  const { mkdtempSync, readFileSync, existsSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const out = mkdtempSync(join(tmpdir(), 'ddx-pub-'));
  await ui.app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, out);
  const keys = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const ms = flattenModulesByKind(S.moduleTree, []);
    await quickCreateModule('page', null); await wait(400);
    const home = S.activeModuleNode.id;
    await api.block.add(home, null, { type: 'heading', content: 'Welcome aboard' });
    await api.block.add(home, null, { type: 'text', content: 'Private plans', config: { secret: true } });
    await api.block.add(home, null, { type: 'component', component: 'core.search' });
    await api.block.add(home, null, { type: 'columns', config: { widths: [8, 4], n: 2, widthsBy: { phone: [6, 6] } } });
    const hist = ms.find((m) => m.name === 'History');
    const chars = ms.find((m) => m.name === 'Characters');
    await api.block.add(home, null, { type: 'text', content: `See [[History]] and [[Characters]].` });
    const draft = (await api.hashtag.create('draft', null)).lastInsertRowid;
    await api.module.setTags(chars.id, [draft]);
    await openModuleNode(home); await wait(400);
    await openHtmlExportModal(); await wait(800);
    q('#hx-title').value = 'Harbor Wiki'; q('#hx-target').value = 'folder'; q('#hx-css').value = 'body{outline:1px solid red}<script>';
    await runHtmlExport(); await wait(1500);
    return { home, hist: hist.id, chars: chars.id };
  });
  const dir = join(out, readdirSync(out)[0]);
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  assert.match(index, /<title>.* — Harbor Wiki<\/title>/);
  assert.match(index, /class="pc-search"[\s\S]*<input/, 'the search box is still a search box');
  assert.ok(existsSync(join(dir, 'site.js')) && existsSync(join(dir, 'search-index.js')) && existsSync(join(dir, 'README.txt')));
  assert.doesNotMatch(index, /Private plans/, 'a secret block never goes out');
  assert.ok(existsSync(join(dir, `module_${keys.hist}.html`)), 'a linked page goes out');
  assert.ok(!existsSync(join(dir, `module_${keys.chars}.html`)), 'a #draft page does not');
  assert.match(index, /<nav class="site-menu">/);
  const css = readFileSync(join(dir, 'style.css'), 'utf8');
  assert.match(css, /body\{outline:1px solid red\}/);
  assert.doesNotMatch(css, /<script/);
  // the page grid travels 1:1 — the same widths, the same breakpoints as the app
  assert.match(index, /--w-pc:\s*minmax\(0,\s*8fr\) minmax\(0,\s*4fr\);\s*--w-tablet:[^;]+;\s*--w-phone:\s*minmax\(0,\s*6fr\) minmax\(0,\s*6fr\)/);
  assert.match(css, /@container \(max-width: ?560px\)/);
});

// ── Procress 16 part 7 ───────────────────────────────────────────────────
test('16 part 7: "what for" puts its kinds first in [+ New] and picks its words', async () => {
  const r = await win.evaluate(() => {
    const before = t('homeCreate');
    setUiSetting('purpose', 'web');
    const html = buildKindListHtml(null, false, true);
    const box = document.createElement('div'); box.innerHTML = html;
    const heads = [...box.querySelectorAll('.kind-list-head')].map((h) => h.textContent);
    const after = t('homeCreate');
    setUiSetting('purpose', undefined);
    return { before, after, heads, firstPage: html.indexOf("quickCreateModule('page'") < html.indexOf("quickCreateModule('manager'") };
  });
  assert.ok(r.heads.includes('A website or wiki'), r.heads.join(' | '));
  assert.ok(r.firstPage, 'its kinds come before the usual groups');
  assert.equal(r.after, 'Create page');
  assert.notEqual(r.before, r.after);
});
test('16 part 7: a new Nexus starts at a template gallery, the "what for" ones first', async () => {
  const r = await win.evaluate(async () => {
    const tree = S.moduleTree;
    setUiSetting('purpose', 'game');
    await builderOpenPage(null);
    S.moduleTree = tree.slice(0, 1); // as a fresh Nexus: its one folder
    await fillHomeTemplates();
    const cards = [...document.querySelectorAll('#home-templates .home-tpl')].map((b) => ({ name: b.querySelector('.kli-name').textContent, pic: b.querySelectorAll('.home-tpl-pic i').length }));
    S.moduleTree = tree; setUiSetting('purpose', undefined);
    return cards;
  });
  assert.ok(r.length >= 3, 'a gallery');
  assert.equal(r[0].name, 'RPG game', 'the purpose\'s templates first');
  assert.ok(r.every((c) => c.pic > 0), 'each with a picture of what it makes');
});
test('16 part 7: with Properties open, a selected block\'s settings dock in the panel', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await quickCreateModule('page', null); await wait(400);
    const id = S.activeModuleNode.id;
    await api.block.add(id, null, { type: 'heading', content: 'Docked' });
    await reloadModulePage(id, null);
    togglePropsPanel(true); runCommand('page.arrange'); await wait(400);
    const el = [...document.querySelectorAll('.pblock')].find((b) => b.querySelector('input')?.value === 'Docked');
    el.querySelector('.pb-name').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(400);
    const sec = document.querySelector('#side-panel #pb-pop.pb-pop-docked');
    const out = { docked: !!sec, tall: sec ? sec.getBoundingClientRect().height > 100 : false, floating: !!document.querySelector('body > #pb-pop') };
    runCommand('page.arrange'); togglePropsPanel(false); await wait(200);
    return out;
  });
  assert.deepEqual(r, { docked: true, tall: true, floating: false });
});
test('16 part 7: Quick Access — a command pinned from Ctrl+P becomes a rail button; right-click takes it off', async () => {
  await win.evaluate(() => openQuickSwitcher('>Colo'));
  await sleep(400);
  const star = win.locator('#qs-overlay .qs-qa').first();
  const id = await star.getAttribute('data-qa');
  await star.click(); await sleep(200);
  await win.keyboard.press('Escape');
  assert.equal(await win.locator(`#nav-sidebar .qa-btn[data-qa="${id}"]`).count(), 1, 'on the rail');
  await win.locator(`#nav-sidebar .qa-btn[data-qa="${id}"]`).click({ button: 'right' }); await sleep(200);
  assert.equal(await win.locator(`#nav-sidebar .qa-btn[data-qa="${id}"]`).count(), 0, 'right-click took it off');
});
test('16 part 7: live preview — pointing at a theme or a block look shows it, leaving puts it back, nothing saved', async () => {
  const theme = await win.evaluate(() => {
    const el = document.createElement('button'); el.dataset.previewTheme = 'daylight'; document.body.appendChild(el);
    const was = document.body.dataset.theme;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const during = document.body.dataset.theme;
    el.dispatchEvent(new MouseEvent('mouseleave'));
    el.remove();
    return { was, during, after: document.body.dataset.theme, saved: S.settings.theme };
  });
  assert.equal(theme.during, 'daylight');
  assert.equal(theme.after, theme.was);
  assert.equal(theme.saved, theme.was);
  const id = await win.evaluate(async () => {
    await quickCreateModule('page', null); await new Promise((r) => setTimeout(r, 400));
    const b = await api.block.add(S.activeModuleNode.id, null, { type: 'heading', content: 'Look' });
    await reloadModulePage(S.activeModuleNode.id, null);
    runCommand('page.arrange'); await new Promise((r) => setTimeout(r, 400));
    openPbStyle(document.querySelector(`.pblock[data-block="${b?.id ?? b}"]`).dataset.iid, 'style', { toggle: false });
    await new Promise((r) => setTimeout(r, 300));
    return b?.id ?? b;
  });
  await win.locator('#pb-pop [data-pv-key="variant"][data-pv-val="card"]').hover();
  assert.equal(await win.locator(`.pblock[data-block="${id}"].pb-v-card`).count(), 1, 'the card look, on the block');
  await win.mouse.move(5, 5);
  assert.equal(await win.locator(`.pblock[data-block="${id}"].pb-v-card`).count(), 0, 'back as it was');
  assert.equal(await win.evaluate((bid) => pageOf(S.activeModuleNode.id, null).blocks.find((b) => b.id === bid).config?.style?.variant ?? null, id), null, 'nothing saved');
  await win.evaluate(() => { closePbStyle(); runCommand('page.arrange'); });
});
test('16 part 7: the game line — a play session logged against the world\'s own calendar', async () => {
  const r = await win.evaluate(async () => {
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const hist = flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'History');
    await openModuleNode(hist.id); await wait(500);
    runCommand('chronicler.logSession', { moduleId: hist.id }); await wait(300);
    q('#chr-ps-d').value = '3'; q('#chr-ps-m').value = '4'; q('#chr-ps-y').value = '1050';
    q('#chr-ps-min').value = '90'; q('#chr-ps-note').value = 'The crew reached the reef.';
    await savePlaySession(hist.id); await wait(600);
    const line = (await api.timeline.getModuleTimelines(hist.id)).find((l) => l.line_name === 'Play log');
    const evs = line ? await api.timeline.getEvents(line.id) : [];
    return { line: !!line, ev: evs[0] && { name: evs[0].event_name, y: evs[0].s_years, story: evs[0].story } };
  });
  assert.ok(r.line, 'a Play log timeline');
  assert.equal(r.ev.name, 'Session 1');
  assert.equal(r.ev.y, 1050, 'the in-game date');
  assert.match(r.ev.story, /^\d{4}-\d\d-\d\d \d\d:\d\d · 90 min/, 'the real time beside it');
});
