// Procress 14 (APP docs/TEMPLATES.md §3–§4) — page templates and the user's
// own bundles. A ★ per kind, a template laying out a new module (fields with
// keys, its page, its element page), Use template… undone exactly, an
// unbound borrow dropped and counted, and a page or a folder saved and
// applied again coming back the same.
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
const pt = require('../src/db/page-template.js');
const pb = require('../src/db/page-block.js');
const preset = require('../src/db/preset.js');
const bundle = require('../src/db/bundle.js');
const cap = require('../src/db/bundle-capture.js');
const stack = (mid, itemKey = null) => db.prepare(`SELECT id, parent_id, block_type, component, source_key, config FROM page_block
  WHERE module_ref=? AND ${itemKey == null ? 'item_key IS NULL' : 'item_key=?'} AND block_type<>'property' ORDER BY parent_id IS NOT NULL, block_order`)
  .all(...(itemKey == null ? [mid] : [mid, itemKey]));

test('every ★ is in the catalog, one per kind (per catType for a Classifier)', () => {
  const { templates } = pt.pageCatalog('en');
  assert.equal(templates.length, 41);
  assert.equal(pt.defaultTemplate('classifier', 'character').id, 'classifier.characterWiki');
  assert.equal(pt.defaultTemplate('classifier', 'element').id, 'classifier.list');
  assert.equal(pt.defaultTemplate('classifier', null).id, 'classifier.encyclopedia');
  assert.equal(pt.defaultTemplate('author').id, 'author.manuscript');
  assert.equal(pt.findTemplate('author.reader', 'th').name, JSON.parse(readFileSync(new URL('../templates/pages.json', import.meta.url), 'utf8')).strings.tplAutReader.th);
});

test('a template lays out a new Classifier: fields with keys, its page and its element page', () => {
  freshVault();
  const mid = mkModule('Cast', 'classifier');
  const r = pt.applyTemplate(mid, 'classifier.characterWiki', { locale: 'en' });
  assert.equal(r.ok, true);
  assert.equal(r.fields, 4);
  const keys = db.prepare(`SELECT options FROM classifier_template WHERE module_ref=? ORDER BY display_order`).all(mid).map((f) => JSON.parse(f.options).key);
  assert.deepEqual(keys, ['role', 'age', 'personality', 'goal']);
  const page = stack(mid);
  assert.deepEqual(page.filter((b) => b.parent_id == null).map((b) => b.component || b.block_type), ['classifier.spotlight', 'columns', 'core.related']);
  const cols = page.filter((b) => b.parent_id != null).map((b) => [b.component, JSON.parse(b.config)]);
  assert.deepEqual(cols, [['classifier.view', { preset: 'grid', col: 0 }], ['classifier.breakdown', { field: 'role', col: 1 }]]);
  assert.equal(JSON.parse(page.find((b) => b.block_type === 'columns').config).n, 2);
  assert.deepEqual(stack(mid, '*').map((b) => b.component), ['core.infobox', 'item.body', 'core.related']);
  assert.equal(pb.ensurePage(mid, null, [{ component: 'x' }]), false, 'the template counts as laid out');
  assert.equal(pt.applyTemplate(mid, 'classifier.characterSheet', { locale: 'en' }).fields, 0, 'never adds fields to a shaped module');
});

test('Use template… is undone exactly', () => {
  freshVault();
  const mid = mkModule('Book', 'author');
  pb.ensurePage(mid, null, [{ component: 'core.properties' }, { component: 'author.view' }, { component: 'core.related' }]);
  const before = stack(mid).map((b) => [b.id, b.component]);
  const r = pt.applyTemplate(mid, 'author.corkboard');
  assert.deepEqual(stack(mid).map((b) => b.component), ['author.progress', 'author.view']);
  pt.restorePageLayout(mid, r.old);
  assert.deepEqual(stack(mid).map((b) => [b.id, b.component]), before);
});

test('an unbound borrow is left out and counted; a bound one keeps its source', () => {
  const { rows, dropped } = pt.layoutRows([{ component: 'chronicler.eras', borrow: true }, { component: 'locator.pinlist', borrow: 'map' }, { component: 'core.related' }], new Map([['map', 7]]));
  assert.equal(dropped, 1);
  assert.deepEqual(rows.map((r) => [r.component, r.sourceKey]), [['locator.pinlist', 'module_7'], ['core.related', null]]);
});

test('Save this page as template… captures the layout and a preset applies it again', () => {
  freshVault();
  const a = mkModule('Cast', 'classifier');
  const other = mkModule('When', 'chronicler');
  pt.applyTemplate(a, 'classifier.characterWiki');
  pb.addBlock(a, null, { component: 'chronicler.eras', sourceKey: `module_${other}` });
  preset.savePreset(1, a, 'My wiki');
  const saved = preset.listPresets(1, 'classifier').find((p) => p.name === 'My wiki').spec;
  assert.equal(saved.page.at(-1).borrow, true, 'a borrow is saved unbound');
  assert.deepEqual(saved.page[1].children[1], [{ component: 'classifier.breakdown', config: { field: 'role' } }]);
  assert.ok(saved.fields.every((f) => f.key), 'fields keep their keys');
  const b = mkModule('Cast 2', 'classifier');
  const r = preset.applyPreset(b, saved);
  assert.equal(r.page.dropped, 1);
  assert.deepEqual(stack(b).filter((x) => x.parent_id == null).map((x) => x.component || x.block_type), ['classifier.spotlight', 'columns', 'core.related']);
  assert.deepEqual(stack(b, '*').map((x) => x.component), ['core.infobox', 'item.body', 'core.related']);
});

test('a folder saved as an Artisan bundle makes the same project again', () => {
  freshVault();
  const dir = require('../src/db/bundle-catalog.js').bundleCatalog('en').find((x) => x.id === 'classicDirector');
  const r = bundle.createBundle(1, null, { name: 'Saga', ...dir.spec });
  assert.equal(r.ok, true, r.message);
  cap.saveBundle(1, r.folderId, 'Saga kit', { data: 'samples' });
  const [mine] = cap.listBundles(1);
  assert.equal(mine.name, 'Saga kit');
  const spec = mine.spec;
  assert.equal(spec.folders.length, 3);
  const chars = spec.modules.find((m) => m.name === 'Characters');
  assert.equal(chars.fields.find((f) => f.key === 'home').relTo, spec.modules.find((m) => m.name === 'Locations').ref);
  assert.ok(chars.objects.length <= 3);
  assert.equal(chars.objects[0].values.age, '19');
  assert.equal(chars.objects[0].links.home.length, 1);
  const project = spec.modules.find((m) => m.kind === 'manager');
  assert.equal(spec.home, project.ref);
  const borrows = project.page[1].children.flat().map((b) => b.borrow);
  assert.ok(borrows.length === 2 && borrows.every((x) => spec.modules.some((m) => m.ref === x)), 'borrows stay bound inside the bundle');
  assert.deepEqual([...project.selects].sort(), spec.folders.filter((f) => f.parent).map((f) => f.ref).sort(), 'the project page still selects its two folders');
  freshVault();
  const again = bundle.createBundle(1, null, spec);
  assert.equal(again.ok, true, again.message);
  assert.equal(again.moduleIds.length, spec.modules.length);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM module WHERE kind='manager'`).get().n, 1);
  assert.ok(db.prepare(`SELECT COUNT(*) AS n FROM entity_relation`).get().n > 0);
  const mgr = again.moduleIds[spec.modules.indexOf(project)];
  const def = JSON.parse(db.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='filterDef'`).get(mgr).ui_value);
  const kinds = def.groups.map((g) => db.prepare(`SELECT kind FROM module WHERE id=?`).get(g.rules[0].moduleId).kind);
  assert.deepEqual(kinds, ['collector', 'collector']);
});
