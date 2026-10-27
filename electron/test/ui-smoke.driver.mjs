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
  await win.waitForSelector('.popover-menu .kind-search');
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
  await win.waitForSelector('.popover');
  assert.ok(await win.locator('.popover .kind-list-item').count() >= 1, '[▾] lists ways to add');
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
  const rows = () => win.locator('.cls-list .ls-row').count();
  const first = await rows();
  assert.ok(first >= 100 && first < 300, `first render ${first} rows`);
  for (let i = 0; i < 6; i++) { await win.evaluate(() => document.querySelector('.cls-list [data-lazy]')?.scrollIntoView()); await sleep(250); }
  const grown = await rows();
  assert.ok(grown > first, `more rows after scrolling (${first} → ${grown})`);
  // selecting a far row keeps it on screen through the re-render
  const far = await win.evaluate(async (id) => { const o = (await api.classifier.getObjects(id))[550]; const iid = document.querySelector('[onclick*="selectClassifierObject"]').getAttribute('onclick').match(/selectClassifierObject\(["']([^"']+)["']/)[1]; selectClassifierObject(iid, o.id); return o.name; }, cls);
  await sleep(300);
  assert.equal(await win.locator('.cls-list .ls-row.sel .ls-title').innerText(), far);
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
  // Procress 26 part 2: [+ New] opens the Create menu wherever you are —
  // on a Classifier's page too (it used to add an object there)
  await row('Characters').click(); await sleep(500);
  assert.deepEqual(await win.evaluate(() => ({ ...nestNewContext(), folder: nestNewContext().folder?.name })), { folder: 'Guide', sibling: true });
  await win.click('.nest-create .split-main'); await sleep(300);
  const pop = await win.evaluate(() => { const p = document.querySelector('.popover-xl'); return p && { fits: p.scrollHeight <= p.clientHeight + 1, rows: p.querySelectorAll('[data-kind-row]').length }; });
  assert.ok(pop?.rows > 10, 'the kind picker opened');
  assert.ok(pop.fits, 'every kind shows without scrolling at 1280x800');
  await win.fill('.popover-xl .kind-search', 'timeline');
  assert.ok(await win.locator('.popover-xl [data-kind-row]:visible').count() < pop.rows, 'the search narrows the rows');
  await win.keyboard.press('Escape');
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
// Procress 20: every Nexus is a folder, made by the app — never asked for.
test('20: a new Nexus is a folder from the start; its modal offers where · open · move, nothing to pick or forget', async () => {
  const n = await win.evaluate(async () => { await reloadNexuses(); return { dir: S.nexus.locate_dir, missing: S.nexus.locate_missing, data: await api.nexus.defaultPath() }; });
  assert.ok(n.dir, 'the Nexus has its folder');
  assert.equal(n.missing, 0);
  assert.match(n.dir, /[\\/]DraconDex[\\/]Smoke$/, '<root>/DraconDex/<name>');
  assert.ok(n.dir.startsWith(n.data.replace(/[\\/]vaults$/, '')), 'a test run keeps it under its data dir, never in the real Documents');
  const row = await win.evaluate(async () => { await openNexusModal(S.nexus.id); const fg = [...document.querySelectorAll('#modal .fg')].find((e) => e.querySelector('input')?.value === S.nexus.locate_dir); const out = fg ? [...fg.querySelectorAll('button')].map((b) => b.getAttribute('onclick')) : null; closeModal(); return out; });
  assert.ok(row, 'the Local folder row shows the folder');
  assert.ok(row.some((c) => /moveNexusLocate/.test(c)) && row.some((c) => /locateOpen/.test(c)));
  assert.ok(!row.some((c) => /pick|forget/i.test(c)), 'no Choose / Forget');
});

test('16 part 2: a real file dropped on a folder is copied into it on disk and filed; k: l: t: filter', async () => {
  const png = new URL('../../src/assets/brand/DraconDex_WhiteOut.png', import.meta.url);
  // Procress 20: nothing may ask anything on the way — count every question.
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 't-in'; document.body.appendChild(i); window.__asked = 0; const ask = window.uiConfirm; window.uiConfirm = async (...a) => { window.__asked++; return ask(...a); }; });
  await win.setInputFiles('#t-in', decodeURIComponent(png.pathname.replace(/^\/([A-Za-z]:)/, '$1')));
  const r = await win.evaluate(async () => {
    const files = document.getElementById('t-in').files;
    const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
    const row = document.querySelector('#left-panel-inner [data-mid="1"]'); // the Guide folder
    row.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    // Wait for the file to land rather than a fixed 3 s: the drop copies,
    // walks the folder, mirrors and reloads the tree — slow on a Windows
    // runner disk.
    for (let i = 0; i < 100 && !nestAssetsOf(1).length; i++) await new Promise((res) => setTimeout(res, 200));
    return nestAssetsOf(1).map((f) => f.file_path);
  });
  assert.equal(r.length, 1);
  assert.match(r[0], /[\\/]Guide[\\/]DraconDex_WhiteOut\.png$/,'copied into the folder of the collector it was dropped on');
  assert.equal(await win.evaluate(() => window.__asked), 0, 'no dialog on the way (Procress 20)');
  assert.ok(r[0].startsWith(await win.evaluate(() => S.nexus.locate_dir)), 'into the Nexus\'s own folder');
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
    const sub = { tab: builderState().panes[builderState().focused].active, members: [...document.querySelectorAll('[data-ls="cat-members"] .ls-title')].map((e) => e.textContent) };
    openCategoryPage('places'); await wait(500);
    return { bar, folder: folder.name, sub, subs: [...document.querySelectorAll('[data-ls="cat-subs"] .ls-title')].map((e) => e.textContent.trim()),
      members: [...document.querySelectorAll('[data-ls="cat-members"] .ls-title')].map((e) => e.textContent) };
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
    const run = async (qy) => { q('#left-search-q').value = qy; await runLeftSearch(qy); return [...document.querySelectorAll('#left-search-res .left-search-row .ls-title')].map((e) => e.textContent.trim()); };
    const all = await run('harbor');
    const cls = await run('harbor k:classifier');
    const onlyK = await run('k:chronicler');
    const inGuide = await run('k:classifier in:Guide');
    q('#left-search-q').value = ''; await runLeftSearch('');
    const hist = [...document.querySelectorAll('#left-search-res .ls-row .ls-title')].map((e) => e.textContent);
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
    return { secs: [...document.querySelectorAll('#home-portal h3')].length, changed: document.querySelectorAll("#home-portal .ls-row").length,
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
  // v5.1.1: the preview waits SETTING_PREVIEW_DELAY_MS of resting on the item
  // (a sweep across the grid must not flash every theme), and ends when the
  // pointer moves onto anything that is not a preview item.
  const theme = await win.evaluate(async () => {
    const el = document.createElement('button'); el.dataset.previewTheme = 'daylight'; document.body.appendChild(el);
    const was = document.body.dataset.theme;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const early = document.body.dataset.theme;
    await new Promise((r) => setTimeout(r, SETTING_PREVIEW_DELAY_MS + 200));
    const during = document.body.dataset.theme;
    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.remove();
    return { was, early, during, after: document.body.dataset.theme, saved: S.settings.theme };
  });
  assert.equal(theme.early, theme.was, 'not at once — a sweep across the grid shows nothing');
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

// ═══ Procress 25: the Create Nexus window ═══════════════════════════════════
// Welcome → New opens a CHILD window (Unity Hub's New project) that is allowed
// to be bigger than the 760-px Welcome; Create makes the Nexus there and the
// new vault's window adds the template and App Docs at boot. Last in this
// file: each test opens a Welcome window and leaves only `win` behind.
const winsInfo = () => ui.app.evaluate(({ BrowserWindow, screen }) => ({
  area: screen.getPrimaryDisplay().workArea,
  wins: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, url: w.webContents.getURL(), width: w.getBounds().width, parent: w.getParentWindow()?.id ?? null, modal: w.isModal() })),
}));
async function cnOpenWelcome() {
  const [w] = await Promise.all([ui.app.waitForEvent('window'), win.evaluate(() => api.window.openWelcome())]);
  await w.waitForSelector('.welcome-hero', { timeout: 20000 });
  return w;
}
// counts real pointer clicks on the path, for the depth budget (UX-LAYOUT §13)
let cnClicks = 0;
async function cnClick(page, sel) { cnClicks++; await page.locator(sel).first().click(); }
async function cnOpenCreate(welcome, pin = true) {
  const [c] = await Promise.all([ui.app.waitForEvent('window'), cnClick(welcome, "button.btn-p[onclick='welcomeCreateNexus()']")]);
  await c.waitForSelector('#cn-grid .home-tpl', { timeout: 20000 });
  if (pin) await c.setViewportSize({ width: 1120, height: 720 }); // a 1024-px runner would get the two-step layout (welcome.css < 1000 px)
  return c;
}
async function cnCreateFrom(create) {
  const [v] = await Promise.all([ui.app.waitForEvent('window'), cnClick(create, '#cn-create').catch(() => {})]);
  await v.waitForSelector('#hub-body', { timeout: 20000 });
  await v.waitForFunction(() => 'pendingCreate' in S, null, { timeout: 20000 });
  await v.evaluate(() => S.pendingCreate);
  return v;
}
const cnTop = (page) => page.evaluate(() => ({ top: S.moduleTree.map((m) => m.name), all: flattenModulesByKind(S.moduleTree, []).map((m) => m.name) }));

test('25: Welcome → New opens a child window wider than Welcome; Cancel closes only the child', async () => {
  const welcome = await cnOpenWelcome();
  const create = await cnOpenCreate(welcome, false); // measured as the app sized it
  const { area, wins } = await winsInfo();
  const w = wins.find((x) => /createNexus=1/.test(x.url));
  const wel = wins.find((x) => /welcome=1/.test(x.url));
  assert.equal(wel.width, 760, 'Welcome keeps its size');
  assert.equal(w.parent, wel.id, 'a child of the Welcome window');
  if (process.platform !== 'darwin') assert.ok(w.modal, 'modal over Welcome');
  const want = area.width < 1000 ? area.width : Math.min(1120, area.width - 48);
  assert.equal(w.width, want, 'min(1120, workArea − 48)');
  if (area.width >= 1148) assert.ok(w.width >= 1100, `at least 1100 px wide (${w.width})`);
  await create.setViewportSize({ width: 1120, height: 720 }); // the rest drives the two-pane layout
  // Blank is the default, the name is filled in and free, the Locate folder follows it
  assert.equal(await create.locator('#cn-grid .home-tpl.on').getAttribute('data-cn-id'), '');
  assert.ok((await create.inputValue('#nx-name')).length > 0);
  assert.match(await create.inputValue('#cn-locate'), /DraconDex[\\/]/);
  // ←→ move the selection through the grid; the detail follows
  await create.focus('#cn-grid .home-tpl.on');
  await create.keyboard.press('ArrowRight');
  const second = await create.locator('#cn-grid .home-tpl').nth(1).getAttribute('data-cn-id');
  assert.equal(await create.locator('#cn-grid .home-tpl.on').getAttribute('data-cn-id'), second);
  assert.equal(await create.evaluate(() => document.activeElement?.dataset.cnId), second, 'focus moves with it');
  assert.ok((await create.locator('#cn-detail .ls-row').count()) > 0, 'the modules it makes');
  // a taken name is said under the field, not in a toast
  await create.fill('#nx-name', 'Smoke');
  assert.equal(await create.locator('#nx-name-err').isVisible(), true);
  // the page closes under the click, so the click itself may report a closed target
  await Promise.all([create.waitForEvent('close'), create.click('.cn-foot .btn-s:has-text("Cancel")').catch(() => {})]);
  await sleep(300);
  const after = (await winsInfo()).wins;
  assert.equal(after.some((x) => /createNexus=1/.test(x.url)), false, 'the child is gone');
  assert.equal(after.some((x) => /welcome=1/.test(x.url)), true, 'Welcome stays');
  await welcome.close();
});

// The click budget of this path (≤ 3 from Welcome) is ui-depth.driver.mjs's row now (Procress 24).
test('25: Fantasy + App Docs → the new window has the Fantasy modules and the Guide', async () => {
  const welcome = await cnOpenWelcome();
  cnClicks = 0;
  const create = await cnOpenCreate(welcome);              // 1 New
  await cnClick(create, '#cn-grid [data-cn-id="fantasy"]'); // 2 the card
  assert.equal(await create.isChecked('#cn-appdocs'), false, 'App Docs is off once a Nexus exists');
  await create.check('#cn-appdocs');                        // a value change, not a step on the path
  await create.fill('#nx-name', 'Smoke Fantasy');
  const v = await cnCreateFrom(create);                     // 3 Create
  const { top, all } = await cnTop(v);
  assert.ok(top.includes('Guide'), `the Guide folder (${top})`);
  assert.ok(all.includes('Characters'), 'the Fantasy modules');
  await sleep(500);
  assert.equal((await winsInfo()).wins.some((x) => /welcome=1/.test(x.url)), false, 'Welcome closed behind the new window');
  await v.close();
});

test('25: no App Docs → no Guide', async () => {
  const welcome = await cnOpenWelcome();
  const create = await cnOpenCreate(welcome);
  await create.click('#cn-grid [data-cn-id="fantasy"]');
  await create.fill('#nx-name', 'Smoke Plain');
  assert.equal(await create.isDisabled('#cn-tour'), true, 'the tour needs App Docs');
  const v = await cnCreateFrom(create);
  const { top, all } = await cnTop(v);
  assert.ok(all.includes('Characters'), 'the template is there');
  assert.equal(top.includes('Guide'), false, `no Guide folder (${top})`);
  await v.close();
});

test('25: a template that fails keeps the Nexus and offers the picker again', async () => {
  const r = await win.evaluate(async () => {
    localStorage.setItem(NEXUS_PENDING_GUIDE_KEY, JSON.stringify({ nexusId: S.nexus.id, template: { id: 'fantasy', group: 'genre', spec: {} }, appDocs: false, tour: false }));
    await runPendingCreate();
    const toastEl = document.querySelector('#toast');
    const out = { pending: localStorage.getItem(NEXUS_PENDING_GUIDE_KEY), text: toastEl.textContent, action: toastEl.classList.contains('has-action'), still: !!(await api.nexus.get(S.nexus.id)) };
    toastEl.querySelector('.toast-act')?.click();
    await new Promise((res) => setTimeout(res, 400));
    out.picker = !!document.querySelector('#modal-overlay:not(.hidden) .art-card.on');
    closeModal();
    return out;
  });
  assert.equal(r.pending, null, 'runs once');
  assert.ok(r.action && /template/i.test(r.text), `a toast with a retry (${r.text})`);
  assert.ok(r.still, 'the Nexus is still there');
  assert.ok(r.picker, 'retry opens the template picker on that template');
});

// ── Procress 26 part 3 ───────────────────────────────────────────────────
test('26 part 3: add without a form, rename in place, edit a choice, reorder', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('Characters').click(); await sleep(600);
  const mid = await win.evaluate(() => S.activeModuleNode.id);
  const names = () => win.evaluate((m) => clsData(m).objects.map((o) => o.name), mid);
  const start = await names();
  await win.evaluate((m) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, 'table'), mid);
  await sleep(500);
  // [+ Add object]: no modal, the new row's name is already being typed into
  await win.click('.classifier-toolbar [data-cmd="classifier.addObject"]'); await sleep(600);
  assert.equal(await win.locator('#modal-overlay:not(.hidden)').count(), 0, 'no form');
  assert.match(await win.evaluate(() => document.activeElement?.id || ''), /^rename-cobj-/);
  await win.keyboard.type('Smoke Rook'); await win.keyboard.press('Enter'); await sleep(400);
  assert.deepEqual(await names(), [...start, 'Smoke Rook']);
  // Esc on one made a moment ago takes it back
  await win.click('.classifier-toolbar [data-cmd="classifier.addObject"]'); await sleep(600);
  await win.keyboard.press('Escape'); await sleep(500);
  assert.deepEqual(await names(), [...start, 'Smoke Rook']);
  // one click renames (Procress 29 part 6 — it was a double click); Esc keeps the old name
  await win.click('tr[data-cls-oid] .cls-name >> text=Smoke Rook'); await sleep(300);
  await win.keyboard.type('zz'); await win.keyboard.press('Escape'); await sleep(300);
  assert.ok((await names()).includes('Smoke Rook'));
  // a choice field is set in its cell
  const rook = await win.evaluate((m) => clsData(m).objects.find((o) => o.name === 'Smoke Rook').id, mid);
  const sel = win.locator(`tr[data-cls-oid="${rook}"] td.cls-cell-ctl select`).first();
  const choice = (await sel.locator('option').allInnerTexts()).at(-1);
  await sel.selectOption({ label: choice }); await sleep(300);
  const stored = await win.evaluate(([m, id]) => api.classifier.getObjectsFull(m).then((f) => f.objects.find((o) => o.id === id).attrMap), [mid, rook]);
  assert.ok(Object.values(stored).includes(choice), `saved (${JSON.stringify(stored)})`);
  // Alt+↑ from a cell moves the row and is saved
  await win.locator(`tr[data-cls-oid="${rook}"] td.cls-cell[contenteditable]`).first().click();
  await win.keyboard.press('Alt+ArrowUp'); await sleep(500);
  const moved = [...start.slice(0, -1), 'Smoke Rook', start.at(-1)];
  assert.deepEqual(await names(), moved);
  assert.deepEqual(await win.evaluate((m) => api.classifier.getObjects(m).then((r) => r.map((o) => o.name)), mid), moved);
  await win.evaluate((id) => api.classifier.deleteObject(id), rook);
  await win.evaluate(() => refreshClassifier());
});

// ── Procress 26 part 4 ───────────────────────────────────────────────────
test('26 part 4: [[ suggests an object with its module, asks which page, and the link opens it', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('Characters').click(); await sleep(600);
  const mid = await win.evaluate(() => S.activeModuleNode.id);
  const tpl = await win.evaluate(async (m) => { const id = await api.classifier.createTemplate(m, 'Smoke notes', 'text', false, false, null); await refreshClassifier(); return id; }, mid);
  await win.evaluate((m) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, 'table'), mid);
  await sleep(500);
  const [first, other] = await win.evaluate((m) => clsData(m).objects.slice(0, 2).map((o) => ({ id: o.id, name: o.name })), mid);
  const cell = win.locator(`td.cls-cell[data-oid="${first.id}"][data-tid="${tpl}"]`);
  await cell.click();
  await win.keyboard.type(`[[${other.name.slice(0, 3)}`); await sleep(500);
  const rows = () => win.locator('.wiki-field-ac .mded-ac-item').allInnerTexts();
  assert.ok((await rows()).some((r) => r.includes(other.name) && r.includes('Characters')), 'the object row names its module');
  while (!(await win.locator('.wiki-field-ac .mded-ac-item.active').innerText()).includes(other.name)) await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter'); await sleep(150);
  assert.equal((await rows()).length, 2, 'then: object page or module page');
  await win.keyboard.press('Enter'); await sleep(150);
  // a folder in front only while another "Characters" exists (an earlier test makes one)
  const typed = await cell.innerText();
  assert.match(typed, new RegExp(`^\\[\\[obj:(?:[^/\\]]+/)*Characters/${other.name}\\]\\]$`));
  assert.equal(await win.evaluate((t) => resolveWikiNameCached(t.slice(2, -2)), typed), `cobj_${other.id}`, 'and it names exactly that object');
  await win.keyboard.press('Tab'); await sleep(500);
  const out = await win.evaluate((id) => api.wiki.outgoing(`cobj_${id}`), first.id);
  assert.ok(out.some((e) => e.key === `cobj_${other.id}`), 'indexed to the object');
  // drawn as the object's name; a click opens the object's own page
  const html = await win.evaluate((t) => { const h = mdRender(t, { resolveLink: resolveWikiNameCached }); const a = document.createElement('div'); a.id = 'smoke-link'; a.innerHTML = h; document.querySelector('#main-inner').prepend(a); return a.textContent; }, typed);
  assert.equal(html, other.name);
  await win.click('#smoke-link .wikilink'); await sleep(800);
  assert.deepEqual(await win.evaluate(() => [S.activeItemNode?.itemKind, S.activeItemNode?.id]), ['classifier', other.id]);
  await win.evaluate(async ([m, t]) => { await api.classifier.deleteTemplate(t); await openModuleNode(m); }, [mid, tpl]);
});

// ── Procress 26 part 5: what the part 2 and 3 tests leave to the eye ─────
test('26 → 28 part 2: the address row stays pinned; a title with no icon has room under it', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('Characters').click(); await sleep(600);
  const r = await win.evaluate(() => {
    const bar = document.querySelector('.module-page .addr-bar');
    const h = document.querySelector('.module-page .page-title .navbar-h');
    const sc = bar.closest('.bpane-body');
    const at = (top) => { sc.scrollTop = top; const b = bar.getBoundingClientRect(), tt = h.getBoundingClientRect(); return b.bottom > tt.top + 1 && b.top < tt.bottom; };
    const out = { pos: getComputedStyle(bar).position, rest: at(0), small: at(30) };
    sc.scrollTop = 0;
    return out;
  });
  assert.equal(r.pos, 'sticky', 'pinned, as the user asked (28 part 2)');
  assert.equal(r.rest, false, 'nothing covers the title at rest');
  assert.equal(r.small, false, 'a short scroll does not slide the name under the bar');
});

test('26: drag a row by its grip and a column by its head — saved', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('Characters').click(); await sleep(600);
  const mid = await win.evaluate(() => S.activeModuleNode.id);
  await win.evaluate((m) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, 'table'), mid);
  await sleep(500);
  const db = (what) => win.evaluate(([m, w]) => (w === 'obj' ? api.classifier.getObjects(m) : api.classifier.getTemplates(m)).then((r) => r.map((x) => x.id)), [mid, what]);
  const objs = await db('obj');
  const rows = win.locator('tr[data-cls-oid]');
  await rows.last().locator('.nar-grip').dragTo(rows.first(), { targetPosition: { x: 40, y: 3 } }); await sleep(600);
  assert.deepEqual(await db('obj'), [objs.at(-1), ...objs.slice(0, -1)], 'last row first');
  const tpls = await db('tpl');
  const ths = win.locator('.cls-table th.cls-col-head');
  await ths.last().dragTo(ths.first(), { targetPosition: { x: 3, y: 5 } }); await sleep(600);
  assert.deepEqual(await db('tpl'), [tpls.at(-1), ...tpls.slice(0, -1)], 'last column first');
  // put both back for the suites after this one
  await win.evaluate(async ([m, o, t]) => { await api.classifier.moveObjects(m, o); await api.classifier.moveTemplates(m, t); await refreshClassifier(); }, [mid, objs, tpls]);
});

// ── Procress 27 ──────────────────────────────────────────────────────────
const openCharactersTable = async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('Characters').click(); await sleep(600);
  const mid = await win.evaluate(() => S.activeModuleNode.id);
  await win.evaluate((m) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, 'table'), mid);
  await sleep(500);
  return mid;
};

test('27 part 1: a field shows its [[link]] as the name, raw only while it is edited', async () => {
  const mid = await openCharactersTable();
  const tpl = await win.evaluate(async (m) => { const id = await api.classifier.createTemplate(m, 'Smoke links', 'text', false, false, null); await refreshClassifier(); return id; }, mid);
  await sleep(400);
  const [first, other] = await win.evaluate((m) => clsData(m).objects.slice(0, 2).map((o) => ({ id: o.id, name: o.name })), mid);
  const raw = `see [[obj:Characters/${other.name}]] now`;
  await win.evaluate(async ([o, t, v]) => { await api.classifier.upsertAttr(o, t, v); await refreshWikiCache(); await refreshClassifier(); }, [first.id, tpl, raw]);
  await sleep(500);
  const cell = win.locator(`td.cls-cell[data-oid="${first.id}"][data-tid="${tpl}"]`);
  assert.equal(await cell.innerText(), `see ${other.name} now`, 'the name, not [[obj:…]]');
  assert.equal(await cell.locator('a.wikilink').innerText(), other.name, 'highlighted as a link');
  // hovering the link shows its card
  await hover(cell.locator('a.wikilink')); await sleep(900);
  assert.equal(await win.locator('#pb-hover.on').count(), 1, 'hover card');
  await win.mouse.move(2, 400); await sleep(300);
  // clicking beside the link edits: the raw text is back, and saved unchanged on leaving
  const box = await cell.boundingBox();
  await win.mouse.click(box.x + box.width - 4, box.y + box.height / 2); await sleep(200);
  assert.equal(await cell.innerText(), raw);
  await win.keyboard.press('Tab'); await sleep(400);
  assert.equal(await cell.innerText(), `see ${other.name} now`);
  const stored = await win.evaluate(([m, o]) => api.classifier.getObjectsFull(m).then((f) => f.objects.find((x) => x.id === o).attrMap), [mid, first.id]);
  assert.equal(stored[tpl], raw);
  // a click on the link follows it
  await cell.locator('a.wikilink').click(); await sleep(800);
  assert.deepEqual(await win.evaluate(() => [S.activeItemNode?.itemKind, S.activeItemNode?.id]), ['classifier', other.id]);
  await win.evaluate(async ([m, t]) => { await api.classifier.deleteTemplate(t); await openModuleNode(m); }, [mid, tpl]);
});

test('27 part 2 + 3: "Fields of this category" reorders by its = grip; the table follows', async () => {
  const mid = await openCharactersTable();
  const tpls = await win.evaluate((m) => api.classifier.getTemplates(m).then((r) => r.map((x) => x.id)), mid);
  assert.ok(tpls.length >= 2, 'needs two fields');
  await win.evaluate((m) => openClassifierFieldsModal(m), mid); await sleep(400);
  const grips = win.locator('#modal-overlay [data-cls-tid] .nar-grip');
  assert.equal(await grips.first().locator('svg line').count(), 2, 'the grip is the two-bar icon (28 part 4)');
  await win.locator('#modal-overlay #ct-name').fill('half-typed');
  const target = win.locator('#modal-overlay [data-cls-tid]').first();
  await grips.last().dragTo(target, { targetPosition: { x: 40, y: 2 } }); await sleep(600);
  const want = [tpls.at(-1), ...tpls.slice(0, -1)];
  assert.deepEqual(await win.evaluate((m) => api.classifier.getTemplates(m).then((r) => r.map((x) => x.id)), mid), want, 'saved');
  assert.deepEqual(await win.locator('#modal-overlay [data-cls-tid]').evaluateAll((els) => els.map((e) => Number(e.dataset.clsTid))), want, 'the modal shows it');
  assert.equal(await win.locator('#modal-overlay #ct-name').inputValue(), 'half-typed', 'the form was not reset');
  // Alt+↓ on a focused row moves it back one
  await win.locator('#modal-overlay [data-cls-tid]').first().focus();
  await win.keyboard.press('Alt+ArrowDown'); await sleep(500);
  assert.deepEqual((await win.evaluate((m) => api.classifier.getTemplates(m).then((r) => r.map((x) => x.id)), mid)).slice(0, 2), [want[1], want[0]]);
  await win.keyboard.press('Escape'); await sleep(300);
  assert.deepEqual(await win.locator('.cls-table th[data-cls-tid]').evaluateAll((els) => els.map((e) => Number(e.dataset.clsTid))).then((r) => r.slice(0, 2)), [want[1], want[0]], 'the columns follow');
  await win.evaluate(async ([m, t]) => { await api.classifier.moveTemplates(m, t); await refreshClassifier(); }, [mid, tpls]);
});

test('27 part 5: a dragged row moves on one axis only, the others slide, Esc puts it back', async () => {
  const mid = await openCharactersTable();
  const objs = await win.evaluate((m) => api.classifier.getObjects(m).then((r) => r.map((x) => x.id)), mid);
  const rows = win.locator('tr[data-cls-oid]');
  const g = await rows.first().locator('.nar-grip').boundingBox();
  const second = await rows.nth(1).boundingBox();
  await win.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await win.mouse.down();
  await win.mouse.move(g.x + 120, g.y + second.height * 1.6, { steps: 12 }); await sleep(300);
  const [m0, m1] = await rows.evaluateAll((els) => els.slice(0, 2).map((e) => { const m = new DOMMatrix(getComputedStyle(e).transform); return { m41: m.m41, m42: m.m42 }; }));
  assert.equal(m0.m41, 0, 'no sideways movement — locked to the column');
  assert.ok(m0.m42 > 10, 'follows the pointer down');
  assert.ok(m1.m42 < 0, 'the next row slid up out of its way');
  await win.keyboard.press('Escape'); await win.mouse.up(); await sleep(400);
  assert.deepEqual(await win.evaluate((m) => api.classifier.getObjects(m).then((r) => r.map((x) => x.id)), mid), objs, 'Esc: nothing moved');
  assert.equal(await rows.first().evaluate((e) => e.style.transform), '', 'and nothing is left shifted');
});

test('27 part 5: the Nest reorders by dragging a row, and nests on a folder\'s middle', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  const ids = await win.evaluate(async () => {
    const mk = (name, kind) => api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name, kind });
    const ids = [await mk('Smoke A', 'scribe'), await mk('Smoke B', 'scribe'), await mk('Smoke Box', 'collector')];
    await reloadModuleTree();
    return ids;
  });
  await sleep(500);
  const [a, b, f] = ids;
  const order = () => win.evaluate(() => S.moduleTree.map((m) => m.id));
  const before = await order();
  // B onto A's top edge → B before A
  await row('Smoke Box').scrollIntoViewIfNeeded();
  const ra = await row('Smoke A').boundingBox(), rb = await row('Smoke B').boundingBox();
  await win.mouse.move(rb.x + 40, rb.y + rb.height / 2); await win.mouse.down();
  await win.mouse.move(rb.x + 40, ra.y + 2, { steps: 15 }); await win.mouse.up(); await sleep(800);
  const after = await order();
  assert.ok(after.indexOf(b) < after.indexOf(a), `B before A (${before} → ${after})`);
  // A held over the folder's middle → inside it
  await row('Smoke Box').scrollIntoViewIfNeeded();
  const ra2 = await row('Smoke A').boundingBox(), rf = await row('Smoke Box').boundingBox();
  await win.mouse.move(ra2.x + 40, ra2.y + ra2.height / 2); await win.mouse.down();
  await win.mouse.move(ra2.x + 40, rf.y + rf.height / 2, { steps: 15 }); await sleep(200);
  assert.equal(await row('Smoke Box').evaluate((e) => e.classList.contains('drop-in')), true, 'the folder lights up');
  await win.mouse.up(); await sleep(800);
  assert.equal(await win.evaluate((id) => findModuleNode(id)?.parent_id, a), f, 'A is inside the folder');
  await win.evaluate(async (xs) => { for (const id of xs) await api.module.delete(id); await reloadModuleTree(); }, [a, b, f]);
});

test('27 part 4: hovering a titled control shows the themed guide text', async () => {
  await openCharactersTable();
  await win.evaluate(() => { const b = document.createElement('button'); b.id = 'smoke-tip'; b.className = 'btn btn-g btn-i'; b.title = 'Smoke guide'; b.innerHTML = I.plus; document.querySelector('#main-inner').prepend(b); });
  const btn = win.locator('#smoke-tip');
  await hover(btn); await sleep(700);
  assert.equal(await win.locator('#ui-tip.on').innerText(), 'Smoke guide');
  assert.equal(await btn.getAttribute('title'), null, 'the OS tooltip stays away');
  assert.equal(await btn.getAttribute('aria-label'), 'Smoke guide', 'an icon-only control keeps its name');
  await win.mouse.move(2, 400); await sleep(250);
  assert.equal(await win.locator('#ui-tip.on').count(), 0, 'gone when the pointer leaves');
  await win.evaluate(() => document.getElementById('smoke-tip')?.remove());
});

test('27 part 5: the Nexus list keeps the order it was dragged into', async () => {
  const r = await win.evaluate(() => {
    const list = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const was = localStorage.getItem(NEXUS_ORDER_KEY);
    localStorage.setItem(NEXUS_ORDER_KEY, '[3,1]');
    const out = orderedNexuses(list).map((n) => n.id);
    if (was == null) localStorage.removeItem(NEXUS_ORDER_KEY); else localStorage.setItem(NEXUS_ORDER_KEY, was);
    return out;
  });
  assert.deepEqual(r, [3, 1, 2], 'dragged order first, the rest after');
});

// ── Procress 28 ──────────────────────────────────────────────────────────
const openTwoTabs = () => win.evaluate(async () => {
  showLeftDest('nest');
  const ms = flattenModulesByKind(S.moduleTree, []);
  const b = builderState();
  b.panes[b.focused].tabs = [];
  await openModuleNode(ms.find((m) => m.name === 'History').id);
  await builderInNewTab(() => openModuleNode(ms.find((m) => m.name === 'Characters').id));
  await builderInNewTab(() => openModuleNode(ms.find((m) => m.name === 'Rumors').id));
});

test('28 part 1: the buttons on the title-bar tab group are not window-drag area', async () => {
  await openTwoTabs(); await sleep(400);
  const r = await win.evaluate(() => [...document.querySelectorAll('.bpane-head.tb-tabgroup button, .bpane-head.tb-tabgroup .tab-close')]
    .map((b) => {
      // app-region is not inherited: the nearest element that sets one decides
      let el = b, region = 'none';
      for (; el && region === 'none'; el = el.parentElement) region = getComputedStyle(el).getPropertyValue('-webkit-app-region') || 'none';
      return { name: b.getAttribute('aria-label') || b.title, region };
    }));
  assert.ok(r.length >= 2, 'the tab group sits on the title bar with its buttons');
  assert.deepEqual(r.filter((b) => b.region !== 'no-drag'), [], 'every button there takes clicks');
});

test('28 part 1: a tab\'s right-click — close others, close to the right; Ctrl+Shift+→ moves it', async () => {
  await openTwoTabs(); await sleep(400);
  const strip = '#main-inner .bpane-tabs[role="tablist"]';
  const names = () => win.locator(`${strip} [role="tab"]`).evaluateAll((els) => els.map((e) => e.title));
  assert.deepEqual(await names(), ['History', 'Characters', 'Rumors']);
  await win.locator(`${strip} [role="tab"][title="History"]`).focus();
  await win.keyboard.press('Control+Shift+ArrowRight'); await sleep(300);
  assert.deepEqual(await names(), ['Characters', 'History', 'Rumors'], 'moved one slot right');
  await win.locator(`${strip} [role="tab"][title="History"]`).click({ button: 'right' });
  await win.locator('.context-menu-popup .kind-list-item:has-text("Close tabs to the right")').click(); await sleep(400);
  assert.deepEqual(await names(), ['Characters', 'History']);
  await win.locator(`${strip} [role="tab"][title="Characters"]`).click({ button: 'right' });
  assert.equal(await win.locator('.context-menu-popup .kind-list-item:has-text("Close tabs to the right")').count(), 1);
  await win.locator('.context-menu-popup .kind-list-item:has-text("Close other tabs")').click(); await sleep(400);
  assert.deepEqual(await names(), ['Characters']);
  assert.equal(await win.evaluate(() => S.activeModuleNode?.name), 'Characters', 'the kept tab is the open page');
});

test('28 part 1: a tab sent back from a pop-out opens beside the open tab, not over it', async () => {
  await openTwoTabs(); await sleep(400);
  const key = await win.evaluate(() => `module:${flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'Harbor map').id}`);
  const nx = await win.evaluate(() => S.nexus.id);
  await ui.app.evaluate(({ BrowserWindow }, [n, k]) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('builder:tabInbound', n, k); }, [nx, key]);
  await sleep(800);
  const t = await tabs();
  assert.equal(t.tabs.length, 4, 'one tab more, none replaced');
  assert.equal(t.active, key);
  assert.equal(t.tabs.indexOf(key), 3, 'beside the active one (Rumors, last)');
});

test('28 part 1: holding a tab at a pane edge makes room before it splits', async () => {
  await openTwoTabs(); await sleep(400);
  const r = await win.evaluate(async () => {
    const pane = document.querySelector('#main-inner .bpane[data-pane]');
    const body = pane.querySelector('.bpane-body');
    const rect = body.getBoundingClientRect();
    S.dragTab = { key: pane.querySelector('.project-tab').dataset.tabKey, paneIdx: Number(pane.dataset.pane), armed: true };
    const over = (x) => { const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: rect.top + rect.height / 2 }); body.dispatchEvent(ev); };
    over(rect.right - 10);
    const early = pane.classList.contains('split-preview');
    await new Promise((res) => setTimeout(res, 450));
    over(rect.right - 10);
    const on = pane.classList.contains('split-preview-right');
    await new Promise((res) => setTimeout(res, 300));
    const shrunk = body.getBoundingClientRect().width;
    over(rect.left + rect.width / 2 - 40); // back to the middle (zones measured on the body as it was)
    const off = !pane.classList.contains('split-preview');
    clearDragReflow(); S.dragTab = null;
    return { early, on, ratio: shrunk / rect.width, off };
  });
  assert.equal(r.early, false, 'not at once');
  assert.equal(r.on, true, 'after the hold');
  assert.ok(r.ratio > 0.4 && r.ratio < 0.6, `the body gave up half (${r.ratio})`);
  assert.equal(r.off, true, 'leaving the edge puts it back');
});

test('28 part 2: "icon above the title" shows the module\'s own icon; the 🔗 links and unlinks a module', async () => {
  await win.evaluate(() => { showLeftDest('nest'); return builderOpenPage(null); });
  await row('History').click(); await sleep(600);
  const mid = await win.evaluate(() => S.activeModuleNode.id);
  await win.evaluate((m) => setPageHeadLayout(m, null, { icon: true }), mid); await sleep(400);
  const icon = await win.evaluate(() => ({ big: !!document.querySelector('.module-page .page-title .ph-icon svg'),
    small: !!document.querySelector('.module-page .page-title .navbar-h .kicon'), text: document.querySelector('.module-page .ph-icon')?.textContent.trim() }));
  assert.deepEqual(icon, { big: true, small: false, text: '' }, 'the module icon, large, once — no emoji');
  // an older emoji value still reads as on
  await win.evaluate((m) => api.module.setUi(m, 'pageHead', JSON.stringify({ align: 'left', icon: '🐉' })).then(() => { pageOf(m).props.ui.pageHead = JSON.stringify({ align: 'left', icon: '🐉' }); }), mid);
  assert.equal(await win.evaluate((m) => pageHeadLayout(m).icon, mid), true);
  await win.evaluate((m) => setPageHeadLayout(m, null, { icon: false }), mid); await sleep(300);
  assert.equal(await win.locator('.module-page .ph-icon').count(), 0);

  const linked = () => win.evaluate((m) => api.module.linked(m).then((ls) => ls.map((e) => e.id)), mid);
  const before = await linked();
  await win.locator('.module-page .ph-links-open').click();
  await win.waitForSelector('.ph-links-pop .ph-link-q');
  await win.keyboard.type('Rumo'); await sleep(400);
  await win.locator('.ph-links-pop [data-link-mid]:has-text("Rumors")').click(); await sleep(500);
  const rumors = await win.evaluate(() => flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'Rumors').id);
  assert.deepEqual((await linked()).sort(), [...before, rumors].sort(), 'linked');
  assert.equal(await win.locator('.module-page .ph-link-n').textContent(), String(before.length + 1), 'the count follows');
  assert.equal(await win.locator('.ph-links-pop .ph-link-q').inputValue(), 'Rumo', 'what was typed stays');
  await win.locator(`.ph-links-pop [data-link-mid="${rumors}"] .ls-act`).click(); await sleep(500);
  assert.deepEqual((await linked()).sort(), before.sort(), 'unlinked');
  await win.keyboard.press('Escape');
});

const openCharactersView = async (view) => {
  const mid = await openCharactersTable();
  await win.evaluate(([m, v]) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, v), [mid, view]);
  await sleep(900);
  return mid;
};

test('28 part 3: the relation view shows every object — its icon or a dot — and hovering one shows its card', async () => {
  const mid = await openCharactersTable();
  const ids = await win.evaluate(async (m) => {
    const objs = await api.classifier.getObjects(m);
    await api.classifier.updateObject(objs[0].id, objs[0].name, null, 'svg:star');
    const lone = await api.classifier.createObject(m, 'Smoke loner');
    await refreshClassifier();
    return { star: objs[0].id, lone, all: (await api.classifier.getObjects(m)).length };
  }, mid);
  await openCharactersView('relationCat');
  const g = await win.evaluate(() => ({
    nodes: [...document.querySelectorAll('.cls-rel-graph g[data-id^="cobj_"]')].map((e) => e.dataset.id),
    icons: [...document.querySelectorAll('.cls-rel-graph .graph-node-icon')].map((e) => e.closest('g').dataset.id),
  }));
  assert.equal(g.nodes.length, ids.all, 'every object, linked or not');
  assert.ok(g.nodes.includes(`cobj_${ids.lone}`), 'an object with no relation is there');
  assert.deepEqual(g.icons, [`cobj_${ids.star}`], 'the one with an icon draws it; the rest are dots');
  await sleep(3500); // the force layout settles (~220 frames) — a moving node slips from under the pointer
  await hover(win.locator(`.cls-rel-graph g[data-id="cobj_${ids.star}"]`));
  await win.waitForSelector('#pb-hover.on', { timeout: 3000 });
  assert.match(await win.locator('#pb-hover').textContent(), /Mira|Tobin|Sela/);
  await win.mouse.move(5, 5);
  await win.evaluate(async ([m, o, l]) => { const objs = await api.classifier.getObjects(m); await api.classifier.updateObject(o, objs.find((x) => x.id === o).name, null, null); await api.classifier.deleteObject(l); await refreshClassifier(); }, [mid, ids.star, ids.lone]);
});

test('28 part 3: a linked module\'s elements join the relation view by its checkbox, and the choice is kept', async () => {
  const mid = await openCharactersTable();
  const hist = await win.evaluate(() => flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'History').id);
  await win.evaluate(([m, h]) => api.viewer.createRelation(S.nexus.id, `module_${m}`, `module_${h}`, null, null, {}), [mid, hist]);
  await openCharactersView('relationCat');
  const cb = win.locator(`.cls-rel-graph .sage-graph-mod-cb[data-mod="m${hist}"]`);
  assert.equal(await cb.isChecked(), false, 'off until asked');
  const visibleEvents = () => win.evaluate(() => [...document.querySelectorAll('.cls-rel-graph g[data-id^="tlev_"]')].filter((e) => e.style.display !== 'none').length);
  assert.equal(await visibleEvents(), 0);
  await cb.check(); await sleep(400);
  assert.ok(await visibleEvents() >= 1, 'History\'s events are drawn');
  await openCharactersView('relationCat');
  assert.equal(await win.locator(`.cls-rel-graph .sage-graph-mod-cb[data-mod="m${hist}"]`).isChecked(), true, 'remembered');
  await win.evaluate(async ([m, h]) => { const r = (await api.module.linked(m)).find((e) => e.id === h); if (r?.relationId) await api.viewer.deleteRelation(r.relationId); await api.module.setUi(m, 'clsRelInclude', '[]'); }, [mid, hist]);
});

test('28 part 3: the field form\'s Level & Condition is always open, two checkboxes that save', async () => {
  const mid = await openCharactersTable();
  await win.evaluate((m) => openClassifierFieldsModal(m), mid); await sleep(400);
  assert.equal(await win.locator('#modal-overlay details.cls-adv').count(), 0, 'not folded away');
  assert.equal(await win.locator('#modal-overlay .cls-flags input[type="checkbox"]').count(), 2);
  assert.equal(await win.locator('#modal-overlay .cls-flags .cls-flag-hint').count(), 2, 'each says what it does');
  await win.locator('#modal-overlay #ct-name').fill('Smoke levels');
  await win.locator('#modal-overlay #ct-lv').check();
  await win.locator('#modal-overlay .mfoot .btn-p').click(); await sleep(500);
  const tpl = await win.evaluate((m) => api.classifier.getTemplates(m).then((r) => r.find((x) => x.description === 'Smoke levels')), mid);
  assert.ok(tpl && tpl.levelable && !tpl.has_condition, 'levelable saved, condition not');
  await win.keyboard.press('Escape');
  await win.evaluate(async ([m, id]) => { await api.classifier.deleteTemplate(id); await refreshClassifier(); }, [mid, tpl.id]);
});

const openBook = async () => {
  await win.evaluate(async () => { showLeftDest('nest'); await builderOpenPage(null); const m = flattenModulesByKind(S.moduleTree, []).find((x) => x.kind === 'author'); await openModuleNode(m.id); if (S.authorData?.view !== 'editor') await setAuthorView('editor'); });
  await sleep(700);
  return win.evaluate(() => S.authorData.moduleId);
};

test('28 part 5: the chapter name is typed in place; synopsis and status sit above the text and save', async () => {
  const mid = await openBook();
  const ch = await win.evaluate(() => S.authorData.chapters.find((c) => c.id === S.authorData.selectedId));
  const title = win.locator('#author-editor .au-title');
  await title.fill('Renamed in place'); await win.keyboard.press('Enter'); await sleep(400);
  const fresh = () => win.evaluate((m) => api.author.getChapters(m), mid);
  assert.equal((await fresh()).find((c) => c.id === ch.id).name, 'Renamed in place');
  assert.match(await win.locator(`.author-chapters [data-chid="${ch.id}"]`).textContent(), /Renamed in place/, 'the column follows');
  await title.fill('thrown away'); await win.keyboard.press('Escape'); await sleep(200);
  assert.equal(await title.inputValue(), 'Renamed in place', 'Esc puts it back');
  await win.locator('#author-editor .au-meta-syn').fill('Smoke synopsis');
  await win.locator('#author-editor .au-meta-status').selectOption('revised'); await sleep(900); // the synopsis saves as it is typed (debounced)
  const after = (await fresh()).find((c) => c.id === ch.id);
  assert.equal(after.synopsis, 'Smoke synopsis');
  assert.equal(after.status, 'revised');
  await win.evaluate(async ([c]) => { await api.author.renameChapter(c.id, c.name); await api.author.setChapterMeta(c.id, { synopsis: c.synopsis || '', status: c.status || '' }); }, [ch]);
});

test('28 part 5: the point of view lists only objects of a Classifier linked to the book', async () => {
  const mid = await openBook();
  const cast = await win.evaluate(() => flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'Characters').id);
  const unlinkAll = () => win.evaluate(async (m) => { for (const e of await api.module.linked(m)) if (e.relationId) await api.viewer.deleteRelation(e.relationId); }, mid);
  const was = await win.evaluate((m) => api.module.linked(m), mid);
  const options = async () => {
    await win.evaluate(() => openAuthorChapterModal(S.authorData.moduleId, S.authorData.selectedId)); await sleep(500);
    const r = await win.locator('#modal-overlay #ac-pov option').evaluateAll((os) => os.map((o) => o.textContent).filter((s) => s !== '—'));
    const hint = await win.locator('#modal-overlay .drafter-hint:has(button)').count();
    await win.keyboard.press('Escape'); await sleep(200);
    return { r, hint };
  };
  const pov = await win.evaluate(() => S.authorData.chapters.find((c) => c.id === S.authorData.selectedId).pov_key);
  await win.evaluate((id) => api.author.setChapterMeta(id, { povKey: '' }), await win.evaluate(() => S.authorData.selectedId));
  await unlinkAll();
  // the sample book [[links]] Tobin, so Characters stays linked that way — check it is the only source
  const viaWiki = (await win.evaluate((m) => api.module.linked(m), mid)).some((e) => e.id === cast);
  const one = await options();
  if (!viaWiki) { assert.deepEqual(one.r, [], 'nothing linked → no one to pick'); assert.equal(one.hint, 1, 'and a way to link'); }
  await win.evaluate(([m, c]) => api.viewer.createRelation(S.nexus.id, `module_${m}`, `module_${c}`, null, null, {}), [mid, cast]);
  const two = await options();
  assert.ok(two.r.length >= 3 && two.r.every((s) => /Characters/.test(s)), `only the linked Classifier's characters: ${two.r}`);
  await unlinkAll();
  await win.evaluate(async ([m, list]) => { for (const e of list) if (e.relationId) await api.viewer.createRelation(S.nexus.id, `module_${m}`, `module_${e.id}`, null, null, {}); }, [mid, was]);
  await win.evaluate(([id, k]) => api.author.setChapterMeta(id, { povKey: k || '' }), [await win.evaluate(() => S.authorData.selectedId), pov]);
});

test('28 part 5: a Part divider is added, named, dragged between chapters and kept', async () => {
  const mid = await openBook();
  const add = win.locator('.author-chapters .ls-add').last();
  await add.click(); await sleep(300);
  await win.keyboard.type('Smoke part'); await win.keyboard.press('Enter'); await sleep(400);
  const order = () => win.locator('.author-chapters [data-chid], .author-chapters .au-part').evaluateAll((els) => els.map((e) => (e.dataset.partId ? `P:${e.textContent.trim()}` : 'C')));
  const o1 = await order();
  assert.ok(o1.includes('P:Smoke part'), 'shown with its name');
  const part = win.locator('.author-chapters .au-part').first();
  const first = win.locator('.author-chapters [data-chid]').first();
  const pb = await part.boundingBox(), fb = await first.boundingBox();
  await win.mouse.move(pb.x + 20, pb.y + pb.height / 2); await win.mouse.down();
  await win.mouse.move(pb.x + 20, fb.y + 2, { steps: 12 }); await win.mouse.up(); await sleep(600);
  assert.equal((await order())[0], 'P:Smoke part', 'dragged above the first chapter');
  const kept = await win.evaluate((m) => api.module.getUi(m).then((u) => JSON.parse(u.authorParts)), mid);
  assert.deepEqual(kept.map((p) => [p.label, p.at]), [['Smoke part', 0]], 'stored by position');
  assert.ok(await win.evaluate(() => getComputedStyle(document.querySelector('.au-part'), '::before').borderTopWidth) !== '0px', 'drawn as a rule');
  await win.locator('.author-chapters .au-part').first().focus();
  await win.keyboard.press('Delete'); await sleep(400);
  assert.equal(await win.locator('.author-chapters .au-part').count(), 0, 'Delete removes it');
});

// ── Procress 29 ────────────────────────────────────────────────────────
const firstModuleId = (kind) => win.evaluate((k) => flattenModulesByKind(S.moduleTree, []).find((m) => m.kind === k)?.id, kind);

test('29 part 5: a colour pick keeps the icon, an icon pick keeps the colour, two pickers never mix', async () => {
  const mid = await win.evaluate(async () => { const id = await api.module.create({ nexus_ref: S.nexus.id, name: 'Smoke icon', kind: 'scribe' }); await api.module.update(id, { icon: 'svg:sword' }); await reloadModuleTree(); renderNexusHome(); return id; });
  // a second picker is in the DOM first (a modal) — the popup must not read or write it
  await win.evaluate(async () => openModal('x', await iconPicker('svg:star', null, 'other')));
  await win.evaluate((id) => openModuleIconPopup(id, document.querySelector(`[data-mid="${id}"] .kicon`) || document.body), mid);
  await win.waitForSelector('.icon-edit-popup .cswatch');
  await win.locator('.icon-edit-popup .cswatch').nth(3).click(); await sleep(400);
  let m = await win.evaluate((id) => api.module.get(id), mid);
  assert.equal(m.icon, 'svg:sword', 'colour pick left the icon alone');
  assert.ok(m.color, 'colour saved');
  const color = m.color;
  await win.locator('.icon-edit-popup [data-ipktab="emoji"]').click();
  await win.locator('.icon-edit-popup .ipk-pane[data-pane="emoji"] .ipk-cell').first().click(); await sleep(400);
  m = await win.evaluate((id) => api.module.get(id), mid);
  assert.match(m.icon, /^sym:/, 'icon pick saved');
  assert.equal(m.color, color, 'icon pick left the colour alone');
  assert.equal(await win.evaluate(() => getIconPickerValue(q('#modal'))), 'svg:star', 'the modal picker untouched');
  // one size for every tab, only the grid scrolls, never sideways
  const sizes = await win.evaluate(() => { const p = q('.icon-edit-popup'); return ['icons', 'emoji', 'symbols', 'uploaded'].map((t) => { p.querySelector(`[data-ipktab=${t}]`).click(); const sc = p.querySelector('.ipk-pane:not([hidden]) .ipk-scroll') || p.querySelector('.ipk-pane.ipk-scroll:not([hidden])'); return [p.offsetWidth, p.offsetHeight, sc.scrollWidth <= sc.clientWidth]; }); });
  assert.ok(sizes.every((s) => s[0] === sizes[0][0] && s[1] === sizes[0][1] && s[2]), `fixed size, no x-scroll: ${JSON.stringify(sizes)}`);
  await win.evaluate(() => { closeAllPopups(); closeModal(); });
});

test('29 part 1: a popup that grows after it opens stays 8 px inside the window', async () => {
  await win.setViewportSize({ width: 900, height: 520 });
  const mid = await win.evaluate(async () => { const nx = S.nexus.id; await api.module.createMany(Array.from({ length: 30 }, (_, i) => ({ nexus_ref: nx, name: 'Edge ' + i, kind: 'scribe' }))); await reloadModuleTree(); return flattenModulesByKind(S.moduleTree, []).find((m) => m.name === 'Edge 0').id; });
  await win.evaluate((id) => openModuleNode(id), mid); await sleep(500);
  await win.locator('.module-page .ph-links-open').first().click();
  await win.locator('.ph-links-pop .ph-link-q').fill('Edge'); await sleep(700);
  const r = await win.evaluate(() => { const b = q('.ph-links-pop').getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: innerWidth, h: innerHeight }; });
  assert.ok(r.l >= 8 && r.t >= 8 && r.r <= r.w - 8 && r.b <= r.h - 8, `inside the window: ${JSON.stringify(r)}`);
  await win.keyboard.press('Escape');
  await win.setViewportSize({ width: 1280, height: 800 });
});

test('29 part 4: rename in the Nest while the module is open; one click renames on the page; the handle after the title', async () => {
  const mid = await win.evaluate(async () => { const id = await api.module.create({ nexus_ref: S.nexus.id, name: 'Rename me', kind: 'scribe' }); await reloadModuleTree(); await openModuleNode(id); return id; });
  await sleep(400);
  await win.locator(`[data-mid="${mid}"] .name`).dblclick(); await sleep(300);
  assert.equal(await win.locator(`#rename-head-${mid}`).count(), 0, 'one box only — in the Nest');
  const box = win.locator(`#rename-nest-${mid}`);
  await box.click({ position: { x: 4, y: 6 } }); await sleep(200);
  assert.equal(await win.evaluate(() => document.activeElement.id), `rename-nest-${mid}`, 'a click places the caret, the box stays');
  await win.keyboard.press('End'); await win.keyboard.type('d'); await win.keyboard.press('Enter'); await sleep(400);
  assert.equal((await win.evaluate((id) => api.module.get(id), mid)).name, 'Rename med');
  await win.locator('.module-page .ph-name').click(); await sleep(200);
  assert.equal(await win.evaluate(() => document.activeElement.id), `rename-head-${mid}`, 'one click on the title renames');
  await win.keyboard.press('Escape'); await sleep(300);
  await win.locator('.module-page .navbar-h .module-handle-add').click(); await sleep(200);
  await win.keyboard.type('renamemed'); await win.keyboard.press('Enter'); await sleep(500);
  assert.equal((await win.evaluate((id) => api.module.get(id), mid)).handle, 'renamemed');
  assert.match(await win.locator('.module-page .navbar-h .module-handle').innerText(), /@renamemed/, 'shown after the title');
});

test('29 part 6: Classifier — the dot opens the icon popup, the name renames on one click, no object form left', async () => {
  const mid = await win.evaluate(async () => { const id = await api.module.create({ nexus_ref: S.nexus.id, name: 'Smoke cls', kind: 'classifier' }); await api.classifier.createObject(id, 'Rook', null, null); await api.module.setUi(id, 'activeView', 'table'); await reloadModuleTree(); await openModuleNode(id); return id; });
  await sleep(700);
  assert.equal(await win.locator('.module-page .cls-rowacts').count(), 0, 'no ✎ / 🗑 at the row end');
  assert.equal(await win.evaluate(() => typeof openClassifierObjectModal), 'undefined', 'the object form is gone');
  await win.locator('tr[data-cls-oid] .cls-name >> text=Rook').click(); await sleep(250);
  await win.keyboard.type('s'); await win.keyboard.press('Enter'); await sleep(400);
  const o = () => win.evaluate((m) => api.classifier.getObjects(m).then((l) => l[0]), mid);
  assert.equal((await o()).name, 'Rooks', 'one click, caret at the end');
  await win.locator('tr[data-cls-oid] .cls-obj-icon').first().click(); await sleep(400);
  await win.locator('.icon-edit-popup .ipk-icon-grid .ipk-cell[data-name="sword"]').click(); await sleep(500);
  assert.equal((await o()).icon, 'svg:sword');
  assert.equal(await win.locator('tr[data-cls-oid] .cls-obj-icon .cls-obj-ico').count(), 1, 'the icon replaces the dot');
  await win.keyboard.press('Escape');
  // the detail view's name renames on a click too
  await win.evaluate((m) => setClassifierView(Object.values(PB_INST).find((i) => i.component === 'classifier.view' && i.sourceId === m).iid, 'listDetail'), mid); await sleep(500);
  await win.locator('.cls-listdetail .ls-row').first().click(); await sleep(400);
  await win.locator('.cls-detail-name .cls-name').click(); await sleep(250);
  await win.keyboard.type('!'); await win.keyboard.press('Enter'); await sleep(400);
  assert.equal((await o()).name, 'Rooks!');
});

test('29 part 3: delete and Undo on a long page keep the page where it was, with no frame at the top', async () => {
  const mid = await win.evaluate(async () => { const id = await api.module.create({ nexus_ref: S.nexus.id, name: 'Smoke long', kind: 'classifier' }); await api.classifier.createObjects(id, Array.from({ length: 150 }, (_, i) => ({ name: 'Row ' + i }))); await api.module.setUi(id, 'activeView', 'table'); await reloadModuleTree(); await openModuleNode(id); return id; });
  await sleep(900);
  const body = '.bpane-body';
  await win.evaluate((b) => { q(b).scrollTop = 1500; }, body); await sleep(300);
  await win.evaluate(() => { window._p29 = []; const b = q('.bpane-body'); (function f() { window._p29.push(b.scrollTop); if (window._p29.length < 300) requestAnimationFrame(f); })(); });
  await win.locator('tr[data-cls-oid] >> nth=40').click({ button: 'right' });
  await win.locator('.context-menu-popup [data-cmd="classifier.deleteObject"], .context-menu-popup .kind-list-item:has-text("Delete"), .context-menu-popup .kind-list-item:has-text("ลบ")').first().click(); await sleep(700);
  assert.ok(Math.abs(await win.evaluate((b) => q(b).scrollTop, body) - 1500) <= 1, 'still there after the delete');
  await win.locator('#toast .toast-act').click(); await sleep(800);
  assert.equal(await win.evaluate((m) => clsData(m).objects.length, mid), 150, 'undone');
  assert.ok(Math.abs(await win.evaluate((b) => q(b).scrollTop, body) - 1500) <= 1, 'still there after Undo');
  assert.ok(!(await win.evaluate(() => window._p29)).some((v) => v < 1400), 'never drawn at the top in between');
});
