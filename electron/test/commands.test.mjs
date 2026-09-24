// v5 Part 6 (V5.md §10.1–10.2) — core/commands.js is the one registry the
// context menus, the kind toolbars and Ctrl+P read. check.mjs 2d proves the
// wiring statically; this runs the registry itself in a sandbox with the
// renderer globals stubbed, and checks what each surface would actually get.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/commands.js', import.meta.url), 'utf8');

function load({ active = null, tree = [], drake = true } = {}) {
  const nodes = new Map();
  const walk = (list) => { for (const m of list) { nodes.set(m.id, m); walk(m.children || []); } };
  walk(tree);
  const calls = [];
  const ctx = {
    S: { activeModuleNode: active, settings: { workspaceStyle: drake ? 'drake' : 'wyvern' }, moduleTree: tree, importFiles: [], nexus: { id: 1 } },
    L: { en: { rename: 'Rename', settingWindowTitle: 'Setting', settingPageAppearance: 'Appearance' } },
    I: { edit: '<i-edit>', plus: '<i-plus>', settings: '<i-set>' },
    t: (k) => `T(${k})`,
    x: (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    SETTING_PAGE_LABEL_KEY: new Proxy({}, { get: (_, p) => `settingPage_${String(p)}` }),
    settingGroupPages: () => ['theme', 'tooltoggle', 'style', 'startup', 'account', 'transfer', 'database', 'cloudstorage', 'versions', 'extension', 'plugin', 'packages'],
    findModuleNode: (id) => nodes.get(id) || null,
    startRenameModule: (id) => calls.push(['rename', id]),
    window: { innerWidth: 1000, innerHeight: 800 },
    document: { contains: () => true },
  };
  ctx.xj = (v) => ctx.x(JSON.stringify(String(v ?? '')));
  vm.createContext(ctx);
  const api = vm.runInContext(`${src}\n;({ COMMANDS, cmdItem, cmdBtn, paletteCommands, runCommand })`, ctx);
  return { ...api, calls };
}

const folder = { id: 1, kind: 'collector', name: 'Folder', children: [] };
const chron = { id: 2, kind: 'chronicler', name: 'Line', parent_id: 1, children: [] };
folder.children.push(chron);

test('every command has a unique id, a label, a scope and a surface besides the palette', () => {
  const { COMMANDS } = load();
  const ids = Object.keys(COMMANDS);
  assert.ok(ids.length > 50, `expected the full registry, got ${ids.length}`);
  for (const [id, def] of Object.entries(COMMANDS)) {
    assert.match(id, /^[a-z]+\.[A-Za-z]+$/, id);
    assert.ok(def.label, `${id} has no label`);
    assert.ok(def.scope, `${id} has no scope`);
    assert.ok(Array.isArray(def.surfaces) && def.surfaces.length, `${id} names no surface`);
    assert.ok(typeof def.run === 'function' || def.sub || def.subHtml, `${id} does nothing`);
    if (def.sub || def.subHtml) assert.ok(def.sub || def.palette, `${id} has a hand-built submenu but no palette action`);
  }
});

test('module menu: folder-only rows appear on a folder and not on a module', () => {
  const { cmdItem } = load({ tree: [folder] });
  assert.ok(cmdItem('module.create', { moduleId: 1 })?.subHtml, 'create is a flyout on a folder');
  assert.equal(cmdItem('module.create', { moduleId: 2 }), null);
  assert.equal(cmdItem('module.openTab', { moduleId: 1 }), null, 'a folder has no page to open');
  assert.ok(cmdItem('module.openTab', { moduleId: 2 }));
  assert.equal(cmdItem('module.rename', { moduleId: 99 }), null, 'unknown module → no row');
});

test('a menu row and a palette row run the same command', () => {
  const { cmdItem, paletteCommands, runCommand, calls } = load({ active: chron, tree: [folder] });
  cmdItem('module.rename', { moduleId: 2 }).onClick();
  const row = paletteCommands().find((c) => c.id === 'module.rename');
  assert.ok(row, 'rename is in the palette while a module is open');
  assert.equal(row.crumb, 'Line');
  runCommand(row.id, row.ctx);
  assert.deepEqual(calls, [['rename', 2], ['rename', 2]]);
});

test('palette: kind commands only for the open kind; app commands always; English alias', () => {
  const none = load().paletteCommands().map((c) => c.id);
  assert.ok(none.includes('app.kindBrowser'));
  assert.ok(!none.some((id) => id.startsWith('module.')), 'no module open → no module commands');
  assert.ok(!none.some((id) => id.startsWith('chronicler.')));
  const onChron = load({ active: chron, tree: [folder] }).paletteCommands().map((c) => c.id);
  assert.ok(!onChron.some((id) => id.startsWith('classifier.')), 'a Classifier command never shows on a Chronicler');
  const theme = load().paletteCommands().find((c) => c.id === 'setting.theme');
  assert.equal(theme.name, 'T(settingWindowTitle): T(settingPage_theme)');
});

test('toolbar button carries data-cmd and an escaped context', () => {
  const { cmdBtn } = load({ tree: [folder] });
  const html = cmdBtn('module.rename', { moduleId: 2 }, { iconOnly: true });
  assert.match(html, /data-cmd="module\.rename"/);
  assert.match(html, /runCommand\(&quot;module\.rename&quot;,\{&quot;moduleId&quot;:2\},this\)/);
  assert.match(html, /title="T\(rename\)"/);
  assert.equal(cmdBtn('module.rename', { moduleId: 99 }), '', 'hidden when it cannot run');
});
