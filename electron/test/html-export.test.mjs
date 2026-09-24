// v5 Part 8 (V5.md §12.13) — export as an HTML website. The walk stops at
// the chosen depth and only at pages (a collector is not one); a link to a
// page the user unticked becomes its text, never a dead link; the zip holds
// index.html, one file per other page, style.css and the canvases' PNGs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-html-'));
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
  mig.migrateInlineColumns(db);
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;
const link = (src, target) => db.prepare(`INSERT INTO wiki_link (src_key, target_key, target_text) VALUES (?,?,?)`).run(src, target, target);

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const hx = require('../src/db/html-export.js');

test('the walk follows links, relations and elements to the chosen depth', () => {
  freshVault();
  const folder = mkModule('F', 'collector');
  const a = mkModule('A', 'inspector', folder);
  const b = mkModule('B', 'classifier', folder);
  const c = mkModule('C', 'inspector', folder);
  const obj = db.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Obj')`).run(b).lastInsertRowid;
  link(`module_${a}`, `module_${b}`);
  link(`module_${a}`, `module_${folder}`); // a collector has no page
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type, directed) VALUES (1,?,?,'x',1)`).run(`cobj_${obj}`, `module_${c}`);

  const d0 = hx.collectPages(1, `module_${a}`, 0);
  assert.deepEqual(d0.map((p) => p.key), [`module_${a}`]);
  const d1 = hx.collectPages(1, `module_${a}`, 1);
  assert.deepEqual(d1.map((p) => p.key), [`module_${a}`, `module_${b}`]);
  const d3 = hx.collectPages(1, `module_${a}`, 3);
  assert.deepEqual(d3.map((p) => [p.key, p.depth]), [[`module_${a}`, 0], [`module_${b}`, 1], [`cobj_${obj}`, 2], [`module_${c}`, 3]]);
  assert.equal(d3.find((p) => p.key === `cobj_${obj}`).name, 'Obj');
  assert.deepEqual(hx.collectPages(1, `module_${folder}`, 2), [], 'a collector is not an index page');
});

test('a link to a page that was not exported becomes its text', () => {
  const html = '<p>See <a class="wikilink" data-name="B" data-key="module_2">B</a> and <a data-key="module_3" class="xl"><b>C</b></a>.</p>';
  const out = hx.rewriteLinks(html, new Set(['module_1', 'module_2']), 'module_1');
  assert.match(out, /<a class="xl" href="module_2\.html">B<\/a>/);
  assert.match(out, /<span class="xl-text"><b>C<\/b><\/span>/);
  assert.doesNotMatch(out, /module_3/);
  assert.match(hx.rewriteLinks('<a data-key="module_1">Home</a>', new Set(['module_1']), 'module_1'), /href="index\.html"/);
});

test('the site is index.html, a file per page, style.css and the images', () => {
  const payload = {
    indexKey: 'module_1', css: 'body{}',
    pages: [{ key: 'module_1', name: 'Home', html: '<a data-key="cobj_4">Four</a>' }, { key: 'cobj_4', name: 'Four', html: '<p>4</p>' }],
    images: [{ name: 'img/1.png', base64: Buffer.from('png').toString('base64') }, { name: '../evil.png', base64: '' }],
  };
  const site = hx.buildSite(payload);
  assert.equal(site.ok, true);
  assert.deepEqual(site.entries.map((e) => e.name), ['index.html', 'cobj_4.html', 'style.css', 'img/1.png']);
  const index = site.entries[0].data;
  assert.match(index, /<nav class="site-menu"><ul><li><a href="cobj_4\.html">Four<\/a><\/li><\/ul><\/nav>/);
  assert.match(index, /<a class="xl" href="cobj_4\.html">Four<\/a>/);
  assert.equal(hx.buildSite({ ...payload, indexKey: 'module_9' }).code, 'no_index');

  const out = join(tmp, 'site.zip');
  const r = hx.exportHtmlSite(out, payload);
  assert.equal(r.ok, true);
  const zip = readFileSync(out);
  for (const name of ['index.html', 'cobj_4.html', 'style.css', 'img/1.png']) assert.ok(zip.includes(Buffer.from(name)), name);
});
