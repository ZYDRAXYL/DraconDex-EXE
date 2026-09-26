// v5 Part 7 (V5.md §11.7–§11.8) — bundles. The two guides that ship with the
// app build completely: every kind once, every [[link]] on "Start here"
// resolves, the relation field and the Exhibitor point inside the bundle, and
// the Manager SELECTS the folder instead of holding children (§8.8). A spec
// that fails part-way leaves nothing behind — the reason it is one transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-bundle-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  mig.migrateInlineColumns(db); // creates idx_entity_relation_v5 on a fresh vault too
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

import { readFileSync } from 'node:fs';
const bundle = require('../src/db/bundle.js');
const { validateGuide } = require('../src/db/guide.js');
const guide = (loc) => JSON.parse(readFileSync(new URL(`../guide/${loc}.json`, import.meta.url), 'utf8'));

for (const loc of ['en', 'th']) {
  test(`the ${loc} guide builds whole, linked, and valid as a PKG payload`, () => {
    const g = guide(loc);
    assert.equal(validateGuide(g), null);
    freshVault();
    const r = bundle.createBundle(1, null, g.spec);
    assert.equal(r.ok, true, r.message);
    const kids = db.prepare(`SELECT id, kind, name FROM module WHERE parent_id=?`).all(r.folderId);
    assert.equal(kids.length, g.spec.modules.length + 1, 'every module plus the Manager');
    const kinds = new Set(kids.map((k) => k.kind));
    for (const k of ['manager', 'inspector', 'classifier', 'locator', 'chronicler', 'wanderer', 'narrator', 'author', 'scribe', 'drafter', 'exhibitor', 'sketcher', 'designer', 'diviner']) assert.ok(kinds.has(k), k);
    // "Start here" links every example, and none dangles
    const start = kids.find((k) => k.kind === 'drafter').id;
    const links = db.prepare(`SELECT target_key, target_text FROM wiki_link WHERE src_key=?`).all(`module_${start}`);
    assert.equal(links.length, 12);
    assert.deepEqual(links.filter((l) => !l.target_key).map((l) => l.target_text), []);
    // the Manager selects the folder; the Exhibitor selects the Classifier
    const ui = (id) => JSON.parse(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(id).ui_value);
    assert.equal(ui(r.managerId).groups[0].rules[0].moduleId, r.folderId);
    const cls = kids.find((k) => k.kind === 'classifier').id;
    assert.equal(ui(kids.find((k) => k.kind === 'exhibitor').id).groups[0].rules[0].moduleId, cls);
    // the relation field targets its own category; its values are rows
    const rel = db.prepare(`SELECT id, options FROM classifier_template WHERE module_ref=? AND attribute_type='relation'`).get(cls);
    assert.equal(JSON.parse(rel.options).targetModuleId, cls);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entity_relation WHERE rel_type=?`).get(`ctpl_${rel.id}`).n, 3);
    assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM diviner_entry`).get().n >= 4);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM timeline_event`).get().n, 3);
  });
}

test('a spec that fails part-way leaves nothing behind', () => {
  freshVault();
  const r = bundle.createBundle(1, null, { name: 'Broken', modules: [
    { kind: 'drafter', name: 'Fine' },
    { kind: 'classifier', name: 'Bad', fields: [{ name: 'X', type: 'select', options: '{not json' }] },
  ] });
  assert.equal(r.ok, false);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module`).get().n, 0);
  assert.deepEqual(bundle.createBundle(1, null, { name: '  ', modules: [] }), { ok: false, code: 'name_required' });
});

test('a guide naming a kind this app does not have is refused whole', () => {
  const g = guide('en');
  assert.match(validateGuide({ ...g, spec: { ...g.spec, modules: [...g.spec.modules, { kind: 'oracle', name: 'X' }] } }), /unknown module kind/);
  assert.match(validateGuide({ ...g, locale: 'EN!' }), /locale/);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));

// v5 Part 8 (§12.13): the Manager's page is the project page — laid out at
// creation, so ensurePage (db/page-block.js) never replaces it with the
// kind default on the first open.
test('a bundle Manager opens on a project page of borrowed views', () => {
  freshVault();
  const r = bundle.createBundle(1, null, { name: 'P', modules: [
    { ref: 'a', kind: 'classifier', name: 'Cast' },
    { ref: 'b', kind: 'chronicler', name: 'When' },
    { ref: 'c', kind: 'wanderer', name: 'Walk' },
  ] });
  assert.equal(r.ok, true, r.message);
  const pb = require('../src/db/page-block.js');
  assert.equal(pb.ensurePage(r.managerId, null, [{ component: 'manager.view' }]), false, 'already laid out');
  const { blocks } = pb.listBlocks(r.managerId, null);
  assert.deepEqual(blocks.map((b) => [b.component, b.source_key]), [
    ['core.properties', null],
    ['manager.view', null],
    ['classifier.view', `module_${r.moduleIds[0]}`],
    ['chronicler.view', `module_${r.moduleIds[1]}`],
    ['core.related', null],
  ]);
});

// Procress 12 part 0: the genre bundles are vendored from DraconDex-SDB
// (templates/bundles.json) and resolved per UI language. Every one must come
// out fully named in every locale — no { t } left, no raw key — and build.
test('every genre bundle resolves and builds in every locale', () => {
  const { bundleCatalog } = require('../src/db/bundle-catalog.js');
  const { locales } = JSON.parse(readFileSync(new URL('../templates/bundles.json', import.meta.url), 'utf8'));
  assert.equal(locales.length, 18);
  for (const loc of locales) {
    const cat = bundleCatalog(loc);
    assert.deepEqual(cat.map((b) => b.id), ['fantasy', 'ttrpg', 'rpg', 'mystery', 'webnovel', 'vn', 'comic', 'scifi', 'romance',
      'classicDirector', 'classicNavigator', 'classicHero', 'classicWriter']);
    for (const b of cat) {
      const flat = JSON.stringify(b);
      assert.doesNotMatch(flat, /"t":/, `${loc}/${b.id} left a string key unresolved`);
      assert.ok(b.name && b.description, `${loc}/${b.id} name`);
      freshVault();
      const r = bundle.createBundle(1, null, { name: b.name, icon: b.icon, ...b.spec });
      assert.equal(r.ok, true, `${loc}/${b.id}: ${r.message || r.code}`);
      assert.equal(r.moduleIds.length, b.spec.modules.length);
    }
  }
  const th = bundleCatalog('th').find((b) => b.id === 'fantasy');
  const en = bundleCatalog('en').find((b) => b.id === 'fantasy');
  assert.notEqual(th.spec.modules[0].name, en.spec.modules[0].name, 'names follow the language');
  assert.equal(bundleCatalog('xx')[0].name, bundleCatalog('en')[0].name, 'an unknown locale falls back to English');
});

// Procress 14 part 2 (APP docs/TEMPLATES.md §4): bundle v2 — nested folders,
// pages from templates with borrows, values by field key, samples, home.
const director = () => require('../src/db/bundle-catalog.js').bundleCatalog('en').find((b) => b.id === 'classicDirector');
const childNames = (id) => db.prepare(`SELECT name, kind FROM module WHERE parent_id=? ORDER BY id`).all(id);

test('Classic Director builds its folders, pages, keyed values and home', () => {
  const b = director();
  freshVault();
  const r = bundle.createBundle(1, null, { name: b.name, icon: b.icon, ...b.spec });
  assert.equal(r.ok, true, r.message);
  const top = childNames(r.folderId);
  assert.deepEqual(top.filter((x) => x.kind === 'collector').map((x) => x.name), ['Data', 'Story'], 'nested folders under the project');
  const ref = (i) => r.moduleIds[b.spec.modules.findIndex((m) => m.ref === i)];
  assert.equal(r.homeId, ref('project'), 'opens on the project page');
  assert.equal(r.managerId, ref('project'), 'its own Manager — no second one');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module WHERE kind='manager'`).get().n, 1);
  const def = JSON.parse(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(ref('project')).ui_value);
  const folderOf = (name) => db.prepare(`SELECT id FROM module WHERE kind='collector' AND name=?`).get(name).id;
  assert.deepEqual(def.groups.map((g) => g.rules[0].moduleId), [folderOf('Data'), folderOf('Story')], 'the project page selects the folders its modules sit in');
  // chars sit in Data
  const data = db.prepare(`SELECT id FROM module WHERE parent_id=? AND name='Data'`).get(r.folderId).id;
  assert.equal(db.prepare(`SELECT parent_id FROM module WHERE id=?`).get(ref('chars')).parent_id, data);
  // the project page borrows the timeline and the map through columns
  const pb = require('../src/db/page-block.js');
  const rows = db.prepare(`SELECT id, parent_id, block_type, component, source_key, config FROM page_block WHERE module_ref=? AND item_key IS NULL ORDER BY parent_id IS NOT NULL, block_order`).all(ref('project'));
  assert.deepEqual(rows.filter((x) => x.parent_id == null).map((x) => x.component || x.block_type), ['manager.dashboard', 'columns', 'manager.recent']);
  const kids = rows.filter((x) => x.parent_id != null);
  assert.deepEqual(kids.map((x) => [x.component, x.source_key, JSON.parse(x.config).col]),
    [['chronicler.eras', `module_${ref('timeline')}`, 0], ['locator.pinlist', `module_${ref('map')}`, 1]]);
  assert.equal(pb.ensurePage(ref('project'), null, [{ component: 'manager.view' }]), false, 'laid out at creation');
  // a character's page is the Character wiki's element page
  const item = db.prepare(`SELECT component FROM page_block WHERE module_ref=? AND item_key='*' ORDER BY block_order`).all(ref('chars')).map((x) => x.component);
  assert.deepEqual(item, ['core.infobox', 'item.body', 'core.related']);
  // values and links by field key; the key rides in the field's options
  const age = db.prepare(`SELECT id, options FROM classifier_template WHERE module_ref=? AND description='Age'`).get(ref('chars'));
  assert.equal(JSON.parse(age.options).key, 'age');
  const arin = db.prepare(`SELECT id FROM classifier_object WHERE module_ref=? AND name='Arin'`).get(ref('chars')).id;
  assert.equal(db.prepare(`SELECT attribute_value AS v FROM classifier_attribute WHERE object_ref=? AND template_ref=?`).get(arin, age.id).v, '19');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entity_relation WHERE from_key=?`).get(`cobj_${arin}`).n, 2, 'home + weapon');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM timeline_event`).get().n, 3);
});

test('without samples a bundle keeps its structure and drops the examples', () => {
  const b = director();
  freshVault();
  const r = bundle.createBundle(1, null, { name: b.name, ...b.spec, includeSamples: false });
  assert.equal(r.ok, true, r.message);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM classifier_object`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM timeline_event`).get().n, 0);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM classifier_template`).get().n >= 7, 'fields stay');
  const fantasy = require('../src/db/bundle-catalog.js').bundleCatalog('en').find((x) => x.id === 'fantasy');
  freshVault();
  const f = bundle.createBundle(1, null, { name: fantasy.name, ...fantasy.spec, includeSamples: false });
  assert.equal(f.ok, true, f.message);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM book_chapter`).get().n, 3, 'skeleton chapters are structure');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM classifier_object`).get().n, 0);
});

test('a Wanderer is wired to the Locator and Chronicler it uses', () => {
  const nav = require('../src/db/bundle-catalog.js').bundleCatalog('en').find((b) => b.id === 'classicNavigator');
  freshVault();
  const r = bundle.createBundle(1, null, { name: nav.name, ...nav.spec });
  assert.equal(r.ok, true, r.message);
  const ref = (i) => r.moduleIds[nav.spec.modules.findIndex((m) => m.ref === i)];
  const ui = Object.fromEntries(db.prepare(`SELECT ui_key, ui_value FROM module_ui WHERE module_ref=?`).all(ref('journey')).map((x) => [x.ui_key, x.ui_value]));
  assert.equal(ui.mapModule, String(ref('map')));
  assert.equal(ui.timelineModule, String(ref('history')));
});
