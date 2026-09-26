// Procress 14 (APP docs/TEMPLATES.md §7) — the wiki components' link model
// and what backs it: main opens a web link only from the block's stored
// config (block:openUrl → blockLinkUrl), http/https only; a typed link
// parses to one of the known shapes; footnotes number across a page; and a
// container's children survive a page saved as a template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-wiki-'));
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
  db.exec(`CREATE TABLE IF NOT EXISTS app_setting (key TEXT PRIMARY KEY, value TEXT)`); // versions.js reads its limit
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const pb = require('../src/db/page-block.js');
const pt = require('../src/db/page-template.js');

// ── block:openUrl ───────────────────────────────────────────────────────
test('a web link opens only from the stored config, http/https only', () => {
  freshVault();
  const m = mkModule('Arin', 'classifier');
  const id = pb.addBlock(m, null, { component: 'core.linkbar', config: { opts: { links: [
    { to: 'url:https://example.com/wiki/Arin', label: 'Wiki' },
    { to: 'url:file:///etc/passwd' },
    { to: 'url:javascript:alert(1)' },
    { to: 'url:data:text/html,<b>x</b>' },
    { to: 'anchor:bio' },
    { to: 'url:http://example.org/a b' },
  ] } } });
  assert.equal(pb.blockLinkUrl(id, ['links', 0]), 'https://example.com/wiki/Arin');
  assert.equal(pb.blockLinkUrl(id, ['links', 1]), null, 'file:');
  assert.equal(pb.blockLinkUrl(id, ['links', 2]), null, 'javascript:');
  assert.equal(pb.blockLinkUrl(id, ['links', 3]), null, 'data:');
  assert.equal(pb.blockLinkUrl(id, ['links', 4]), null, 'an internal link is not a URL');
  assert.equal(pb.blockLinkUrl(id, ['links', 5]), 'http://example.org/a%20b', 'normalized on the way out');
  assert.equal(pb.blockLinkUrl(id, ['links', 9]), null, 'not in the config');
  assert.equal(pb.blockLinkUrl(id, ['links', '0']), null, 'an index must be a number');
  assert.equal(pb.blockLinkUrl(id, ['__proto__', 'x']), null);
  assert.equal(pb.blockLinkUrl(id, 'https://example.com'), null, 'a URL is never accepted in place of a path');
  assert.equal(pb.blockLinkUrl(999, ['links', 0]), null, 'no such block');
});

test('a template written before options keeps its links at the top of config', () => {
  freshVault();
  const m = mkModule('Arin', 'classifier');
  const id = pb.addBlock(m, null, { component: 'core.linkcard', config: { links: [{ to: 'url:https://a.example/' }] } });
  assert.equal(pb.blockLinkUrl(id, ['links', 0]), 'https://a.example/');
});

// ── containers in a template ────────────────────────────────────────────
test('tabs and toggle keep their children, by tab, when a page is captured and applied', () => {
  freshVault();
  const m = mkModule('Arin', 'classifier');
  const tabs = pb.addBlock(m, null, { component: 'core.tabs', config: { opts: { tabs: ['Bio', 'Powers', 'Trivia'] } } });
  pb.addBlock(m, null, { type: 'text', content: 'born', parentId: tabs, config: { col: 0 } });
  pb.addBlock(m, null, { type: 'text', content: 'fire', parentId: tabs, config: { col: 1 } });
  pb.addBlock(m, null, { type: 'heading', content: 'odd', parentId: tabs, config: { col: 2 } });
  const tog = pb.addBlock(m, null, { component: 'core.toggle', config: { opts: { title: 'Spoilers' } } });
  pb.addBlock(m, null, { type: 'text', content: 'secret', parentId: tog, config: { col: 0 } });
  const page = pt.capturePage(m, null);
  const t0 = page.find((b) => b.component === 'core.tabs');
  assert.deepEqual(t0.children.map((col) => col.map((b) => b.content)), [['born'], ['fire'], ['odd']]);
  assert.deepEqual(t0.config, { opts: { tabs: ['Bio', 'Powers', 'Trivia'] } });
  assert.deepEqual(page.find((b) => b.component === 'core.toggle').children, [[{ type: 'text', content: 'secret' }]]);
  // …and back onto another page
  const m2 = mkModule('Selene', 'classifier');
  const { rows } = pt.layoutRows(page);
  db.transaction(() => pt.insertRows(db, m2, null, rows))();
  const got = db.prepare(`SELECT * FROM page_block WHERE module_ref=? ORDER BY id`).all(m2);
  const tabs2 = got.find((r) => r.component === 'core.tabs');
  const kids = got.filter((r) => r.parent_id === tabs2.id).map((r) => [r.content, JSON.parse(r.config).col]);
  assert.deepEqual(kids, [['born', 0], ['fire', 1], ['odd', 2]]);
});

// ── the renderer side: link parsing and footnotes ───────────────────────
const root = new URL('..', import.meta.url).pathname;
const ctx = {
  S: { nexus: { id: 1 } }, COMPONENTS: {}, PB_TYPE_KEY: {}, I: {}, t: (k) => k, x: (s) => String(s ?? ''), xj: JSON.stringify, xv: JSON.stringify,
  findModuleNode: (id) => (id === 3 ? { id: 3, name: 'Map' } : null), componentOf: () => null, componentLabel: () => '',
  document: { addEventListener() {} }, window: { addEventListener() {} }, CSS: { escape: (s) => s }, URL,
};
vm.createContext(ctx);
for (const f of ['src/renderer/markdown.js', 'src/renderer/page/style.js', 'src/renderer/page/links.js']) vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx);
vm.runInContext(`
  var _wikiCache = new Map([['selene', 'cobj_12'], ['map', 'module_3']]);
  var _wikiCacheList = [{ key: 'cobj_12', name: 'Selene' }, { key: 'module_3', name: 'Map' }];
  var resolveWikiNameCached = (n) => _wikiCache.get(String(n).toLowerCase()) || null;
  this.api = { pbLinkParseInput, pbLinkResolve, pbLinkLabel, mdRender, mdFootnotes };`, ctx);
const L = ctx.api;

test('a typed link becomes one of the known shapes; anything else is refused', () => {
  assert.equal(L.pbLinkParseInput('[[Selene]]'), 'item:cobj_12');
  assert.equal(L.pbLinkParseInput('[[Selene]]#Early-life'), 'item:cobj_12#early-life');
  assert.equal(L.pbLinkParseInput('[[Map]]'), 'module:3');
  assert.equal(L.pbLinkParseInput('[[Tarven]]'), 'wiki:Tarven', 'not there yet: resolved by name each time');
  assert.equal(L.pbLinkParseInput('#Bio'), 'anchor:bio');
  assert.equal(L.pbLinkParseInput('https://example.com/x'), 'url:https://example.com/x');
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'ftp://example.com', 'mailto:a@b.c', '']) {
    assert.equal(L.pbLinkParseInput(bad), null, bad);
  }
});

test('a link resolves, and one whose page is gone reads as dangling', () => {
  assert.equal(L.pbLinkResolve({ to: 'module:3' }).name, 'Map');
  assert.equal(L.pbLinkResolve({ to: 'module:4' }).dangling, true);
  assert.equal(L.pbLinkResolve({ to: 'item:cobj_12' }).name, 'Selene');
  assert.equal(L.pbLinkResolve({ to: 'item:cobj_99' }).dangling, true);
  assert.equal(L.pbLinkResolve({ to: 'wiki:Selene' }).key, 'cobj_12', 'created later, the link mends');
  assert.equal(L.pbLinkResolve({ to: 'url:https://www.example.com/a' }).host, 'example.com');
  assert.equal(L.pbLinkResolve({ to: 'url:javascript:x' }).kind, 'bad');
  assert.equal(L.pbLinkLabel({ to: 'item:cobj_12', label: 'the [[Selene|witch]]' }), 'the witch');
  assert.equal(L.pbLinkLabel({ to: 'item:cobj_12' }), 'Selene');
});

test('footnotes: numbered by first reference, notes carried for the hover card, code left alone', () => {
  const f = L.mdFootnotes('A[^b] B[^a] again[^b]\n\n[^a]: first note\n[^b]: second\n```\n[^c]\n```');
  assert.deepEqual([...f.order], ['b', 'a']);
  assert.equal(f.notes.get('a'), 'first note');
  const html = L.mdRender('A[^b] B[^a]\n\n[^a]: first\n[^b]: **second**');
  assert.match(html, /<sup class="fn-ref" data-fn="b" data-note="\*\*second\*\*" tabindex="0">1<\/sup>/);
  assert.match(html, /<ol class="md-footnotes"><li data-fn="b" value="1"><strong>second<\/strong><\/li><li data-fn="a" value="2">first<\/li><\/ol>/);
  assert.doesNotMatch(html, /\[\^a\]:/, 'a definition line is not drawn as text');
  const paged = L.mdRender('C[^a]\n\n[^a]: x', { footnotes: { num: () => 4, hideDefs: true } });
  assert.match(paged, />4<\/sup>/);
  assert.doesNotMatch(paged, /md-footnotes/, 'a References block lists them instead');
  assert.equal(L.mdRender('no notes here'), '<p>no notes here</p>');
  assert.match(L.mdRender('x[^<img>]'), /x\[\^&lt;img&gt;\]/, 'not an id: left as escaped text');
});
