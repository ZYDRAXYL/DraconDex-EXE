// The DOM-walking translator (translateCommonUiText, core/chrome.js) swaps any
// text that exactly matches a COMMON_UI_TEXT key. It used to do that to user
// content too: a module named "Novel" showed as "นิยาย", and a Classifier text
// cell — which saved what it showed on blur — wrote "นิยาย" to the vault.
//
//   node --test electron/test/ui-i18n-user-content.driver.mjs
//
// Needs a display and launches Electron, like ui-smoke.driver.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchWithVault } from './ui-app.mjs';

let ui, win;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lang = async (code) => { await win.evaluate((c) => setUiSetting('language', c), code); await sleep(800); };

before(async () => { ui = await launchWithVault('I18n'); win = ui.win; });
after(async () => { await ui?.close(); });

test('the translator still translates chrome, and leaves user content alone', async () => {
  await lang('th');
  const r = await win.evaluate(async () => {
    const box = document.createElement('div');
    box.id = 'i18n-probe';
    box.innerHTML = `<button id="p-chrome">Save</button><span id="p-ph-host"><input id="p-ph" placeholder="Save"></span>
      <span class="name" id="p-name">Save</span><span id="p-noi18n" data-no-i18n>Save</span>
      <span id="p-ce" contenteditable="true">Save</span><div contenteditable="true"><p id="p-ce-inner">Save</p></div>
      <h2 class="navbar-h" id="p-title">Save</h2>`;
    document.body.appendChild(box);
    await new Promise((res) => setTimeout(res, 300));
    const txt = (id) => document.getElementById(id).textContent;
    const out = { chrome: txt('p-chrome'), ph: document.getElementById('p-ph').placeholder, name: txt('p-name'), noi18n: txt('p-noi18n'),
      ce: txt('p-ce'), ceInner: txt('p-ce-inner'), title: txt('p-title'), th: COMMON_UI_TEXT.Save?.th };
    box.remove();
    return out;
  });
  assert.equal(r.chrome, r.th, 'a chrome button is translated');
  assert.equal(r.ph, r.th, 'a placeholder is translated');
  for (const k of ['name', 'noi18n', 'ce', 'ceInner', 'title']) assert.equal(r[k], 'Save', `${k} is user content`);
});

test('a module named after a UI word keeps its name on screen and in the vault', async () => {
  await lang('th');
  const names = ['Characters', 'Novel', 'Delete'];
  const r = await win.evaluate(async (names) => {
    const ids = [];
    for (const n of names) ids.push(await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: `${n} x`, kind: 'classifier', cat_type: 'object' }));
    await reloadModuleTree();
    for (let i = 0; i < names.length; i++) await saveModuleRename(ids[i], names[i]);
    await openModuleNode(ids[1]);
    await new Promise((res) => setTimeout(res, 800));
    return {
      rows: ids.map((id) => document.querySelector(`#left-panel-inner .li[data-mid="${id}"] .name`)?.textContent),
      head: document.querySelector('.page-title .navbar-h')?.textContent.trim(),
      tab: document.querySelector('.project-tab.active .tab-name')?.textContent,
      tabTitle: document.querySelector('.project-tab.active')?.getAttribute('title'),
      db: await Promise.all(ids.map(async (id) => (await api.module.get(id)).name)),
    };
  }, names);
  assert.deepEqual(r.rows, names);
  assert.equal(r.head, 'Novel');
  assert.equal(r.tab, 'Novel');
  assert.equal(r.tabTitle, 'Novel');
  assert.deepEqual(r.db, names);
});

test('a Classifier text value "Novel" survives blur, reopen and click in-and-out', async () => {
  await lang('th');
  const { mid, tid, oid } = await win.evaluate(async () => {
    const mid = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: 'Cls i18n', kind: 'classifier', cat_type: 'object' });
    const tid = await api.classifier.createTemplate(mid, 'Genre', 'text', false, false, null, null);
    const oid = await api.classifier.createObject(mid, 'Book', null, null);
    await reloadModuleTree();
    return { mid, tid, oid };
  });
  const open = async () => { await win.evaluate(async ({ mid, oid }) => { await openModuleNode(mid); await openItemNode('classifier', mid, oid); }, { mid, oid }); await sleep(1200); };
  const cell = () => win.locator(`.pv[contenteditable][data-tid="${tid}"]`).first();
  const attr = () => win.evaluate(async ({ oid, tid }) => (await api.classifier.getAttrs(oid)).find((a) => a.template_ref === tid), { oid, tid });
  await open();
  await cell().click(); await win.keyboard.type('Novel'); await win.keyboard.press('Tab'); await sleep(400);
  const first = await attr();
  assert.equal(first.attribute_value, 'Novel');
  await open();
  assert.equal(await cell().textContent(), 'Novel', 'shown as typed after reopening');
  await sleep(1100); // update_at has 1-second resolution
  await cell().click(); await win.keyboard.press('Tab'); await sleep(400);
  const second = await attr();
  assert.equal(second.attribute_value, 'Novel');
  assert.equal(second.update_at, first.update_at, 'a blur with no edit writes nothing');
});

test('English UI: Thai content that is a Thai UI word stays Thai', async () => {
  await lang('en');
  const r = await win.evaluate(async () => {
    const id = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name: 'บันทึก', kind: 'collector' });
    await reloadModuleTree(); await openFolderPage(id); // a collector's row toggles; its page is the folder page
    await new Promise((res) => setTimeout(res, 800));
    return { row: document.querySelector(`#left-panel-inner .li[data-mid="${id}"] .name`)?.textContent,
      heads: [...document.querySelectorAll('.page-title .navbar-h')].map((h) => h.textContent.trim()), en: COMMON_UI_TEXT['บันทึก']?.en };
  });
  assert.equal(r.en, 'Save', 'the en table does map it');
  assert.equal(r.row, 'บันทึก');
  assert.ok(r.heads.some((h) => h.startsWith('บันทึก')), JSON.stringify(r.heads)); // + the kind chip
});
