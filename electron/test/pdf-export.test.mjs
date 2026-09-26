// Procress 14 (APP docs/EXPORT-DECOR.md E1) — PDF. main makes one print
// document from the pages the renderer drew: a section per page, links
// between them as anchors, the Nexus's pictures and the canvases inlined as
// data: so the print window (JavaScript off, a CSP of data: images and
// inline style) fetches nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-pdf-'));
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
test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const pdf = require('../src/db/pdf-export.js');

test('one print document: CSP, a section per page, anchors between them, pictures inlined', () => {
  freshVault();
  const png = join(tmp, 'a.png');
  writeFileSync(png, Buffer.from('PNGBYTES'));
  const f = db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type) VALUES (1,'a.png',?,'png')`).run(png).lastInsertRowid;
  const doc = pdf.buildPrintHtml({
    title: 'Saga <1>', css: 'body{color:red}</style><script>x</script>', toc: true,
    pages: [
      { key: 'module_1', name: 'Home', html: `<h1>Home</h1><a data-key="cobj_2">Two</a><a data-key="cobj_9">Nine</a><img src="ddx-file://1-${f}"><img src="img/1.png">` },
      { key: 'cobj_2', name: 'Two & more', html: '<p>2</p>' },
      { key: 'file_3', name: 'not a page', html: '' },
    ],
    images: [{ name: 'img/1.png', base64: Buffer.from('CANVAS').toString('base64') }],
  }, 1);
  assert.equal(doc.ok, true);
  assert.equal(doc.pages, 2);
  const h = doc.html;
  assert.ok(h.includes(`content="${pdf.CSP}"`));
  assert.ok(!/<\/style><script>/.test(h), 'the stylesheet cannot close itself');
  assert.equal((h.match(/<section class="print-page"/g) || []).length, 2);
  assert.match(h, /<nav class="print-toc"><h1>Saga &lt;1&gt;<\/h1><ol><li><a href="#p-module_1">Home<\/a><\/li><li><a href="#p-cobj_2">Two &amp; more<\/a>/);
  assert.match(h, /<a class="xl" href="#p-cobj_2">Two<\/a><span class="xl-text">Nine<\/span>/);
  assert.ok(h.includes(`src="data:image/png;base64,${Buffer.from('PNGBYTES').toString('base64')}"`));
  assert.ok(h.includes(`src="data:image/png;base64,${Buffer.from('CANVAS').toString('base64')}"`));
  assert.ok(!h.includes('ddx-file://'));
  assert.match(h, /<body class="ddx-site ddx-print" data-print-theme="daylight">/);
  assert.equal(pdf.buildPrintHtml({ pages: [] }, 1).code, 'empty');
});

test('printToPDF options: paper, orientation, header and footer', () => {
  const o = pdf.pdfOptions({ paper: 'Letter', orientation: 'landscape' }, 'A <b>');
  assert.equal(o.pageSize, 'Letter');
  assert.equal(o.landscape, true);
  assert.match(o.headerTemplate, /A &lt;b&gt;/);
  assert.match(o.footerTemplate, /class="pageNumber"/);
  const plain = pdf.pdfOptions({ paper: 'B9', headerFooter: false });
  assert.equal(plain.pageSize, 'A4');
  assert.equal(plain.displayHeaderFooter, false);
});
