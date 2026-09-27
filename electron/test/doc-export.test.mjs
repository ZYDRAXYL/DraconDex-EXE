// Procress 14 (APP docs/EXPORT-DECOR.md E2, E3, E5) — documents. Markdown
// and the Author editor's HTML read into one block model; DOCX and EPUB are
// real packages built through zip.js (EPUB's mimetype first and stored);
// Markdown of one module carries the pictures its pages show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-doc-'));
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
const mkModule = (name, kind) => db.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (1,?,?)`).run(name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const zlib = require('node:zlib');
function readZip(p) {
  const z = readFileSync(p);
  const eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = z.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < z.readUInt16LE(eocd + 10); i++) {
    const method = z.readUInt16LE(at + 10), csize = z.readUInt32LE(at + 20), nlen = z.readUInt16LE(at + 28), off = z.readUInt32LE(at + 42);
    const name = z.subarray(at + 46, at + 46 + nlen).toString('utf8');
    const start = off + 30 + z.readUInt16LE(off + 26) + z.readUInt16LE(off + 28);
    const raw = z.subarray(start, start + csize);
    out.set(name, (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8'));
    at += 46 + nlen + z.readUInt16LE(at + 30) + z.readUInt16LE(at + 32);
  }
  return out;
}


const dm = require('../src/db/doc-model.js');
const docx = require('../src/db/docx-export.js');
const epub = require('../src/db/epub-export.js');
const { exportNexusMarkdown } = require('../src/db/md-export.js');

// A 2×1 PNG: signature, IHDR with width 2 and height 1.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 1]), Buffer.alloc(20)]);

function book() {
  freshVault();
  const au = mkModule('หนังสือ <1>', 'author');
  const ch = (name, content, order, label = null) => db.prepare(`INSERT INTO book_chapter (module_ref, name, chapter_content, chapter_order, chapter_label) VALUES (?,?,?,?,?)`)
    .run(au, name, content, order, label).lastInsertRowid;
  ch('เริ่ม', '# ฉากแรก\nอารินออกเดินทาง **ทันที** กับ [[Tarven|ทาร์เวน]]\nบรรทัดสอง\n\n- หนึ่ง\n- สอง\n\n[site](https://example.com)', 1, '1');
  ch('Two & more', '<div>Hello <b>bold</b><br>next</div><ul><li>a</li></ul>', 2);
  const png = join(tmp, 'cover.png');
  writeFileSync(png, PNG);
  const sha = 'a'.repeat(64);
  const f = db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, sha256) VALUES (1,'cover.png',?,'png',?)`).run(png, sha).lastInsertRowid;
  db.prepare(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?,?,?)`).run(au, 'pageHead', JSON.stringify({ align: 'center', cover: sha }));
  return { au, f };
}

test('Markdown and the Author editor HTML read into the same blocks', () => {
  const md = dm.fromMarkdown('# T\none **b** [[A|alias]]\ntwo\n\n1. x\n2. y\n\n> q');
  assert.deepEqual(md.map((b) => b.t), ['h', 'p', 'li', 'li', 'quote']);
  assert.deepEqual(md[1].runs, [{ text: 'one ' }, { text: 'b', b: true }, { text: ' alias' }, { br: true }, { text: 'two' }]);
  assert.equal(md[3].n, 2);
  const html = dm.fromHtml('<div>Hi <b>b</b>&amp;<i>i</i><br>n</div><div><br></div><ol><li>one</li><li>two</li></ol><p>&#3585;</p>');
  assert.deepEqual(html.map((b) => b.t), ['p', 'li', 'li', 'p']);
  assert.deepEqual(html[0].runs, [{ text: 'Hi ' }, { text: 'b', b: true }, { text: '&' }, { text: 'i', i: true }, { br: true }, { text: 'n' }]);
  assert.equal(html[2].n, 2);
  assert.equal(html[3].runs[0].text, 'ก');
  assert.match(dm.toXhtml(dm.fromMarkdown('a < b & "c"')), /<p>a &lt; b &amp; &quot;c&quot;<\/p>/);
});

test('DOCX: a real package — title, a heading per chapter, page breaks, hyperlinks, the cover', () => {
  const { au } = book();
  const out = join(tmp, 'b.docx');
  const r = docx.exportDocx(au, out);
  assert.equal(r.ok, true);
  assert.equal(r.sections, 2);
  assert.equal(r.pictures, 1);
  const z = readZip(out);
  assert.deepEqual([...z.keys()].slice(0, 6), ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels']);
  assert.ok(z.has('word/media/image1.png'));
  const doc = z.get('word/document.xml');
  assert.match(doc, /<w:pStyle w:val="Title"\/><\/w:pPr><w:r><w:t xml:space="preserve">หนังสือ &lt;1&gt;<\/w:t>/);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:t xml:space="preserve">1\. เริ่ม<\/w:t>/);
  assert.match(doc, /<w:pStyle w:val="Heading1"\/><w:pageBreakBefore\/><\/w:pPr><w:r><w:t xml:space="preserve">Two &amp; more/);
  assert.match(doc, /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">ฉากแรก/, 'a # inside a chapter sits under the chapter heading');
  assert.match(doc, /<w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">ทันที<\/w:t><\/w:r>/);
  assert.match(doc, /<w:hyperlink r:id="(rId\d+)">/);
  assert.match(doc, /<wp:extent cx="19050" cy="9525"\/>/, 'the picture keeps its own proportions');
  assert.match(z.get('word/_rels/document.xml.rels'), /Target="https:\/\/example\.com" TargetMode="External"/);
  assert.deepEqual(docx.imageSize(PNG), { w: 2, h: 1 });
  assert.equal(docx.exportDocx(mkModule('m', 'locator'), out).code, 'not_doc');
});

test('EPUB: mimetype first and stored, a package with an id and a date, a nav, a chapter file each', () => {
  const { au } = book();
  const out = join(tmp, 'b.epub');
  const r = epub.exportEpub(au, out, { lang: 'th' });
  assert.equal(r.ok, true);
  assert.equal(r.chapters, 2);
  const raw = readFileSync(out);
  assert.equal(raw.readUInt16LE(8), 0, 'mimetype is stored');
  assert.equal(raw.toString('utf8', 30, 38), 'mimetype', 'and is the first entry');
  assert.equal(raw.toString('utf8', 38, 58), 'application/epub+zip');
  const z = readZip(out);
  const opf = z.get('OEBPS/content.opf');
  assert.match(opf, /<dc:identifier id="bookid">urn:uuid:[0-9a-f-]{36}<\/dc:identifier>/);
  assert.match(opf, /<meta property="dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/meta>/);
  assert.match(opf, /<dc:language>th<\/dc:language>/);
  assert.match(opf, /properties="cover-image"/);
  assert.match(opf, /<itemref idref="cover" linear="yes"\/>\n<itemref idref="ch001"\/>\n<itemref idref="ch002"\/>/);
  assert.match(z.get('OEBPS/nav.xhtml'), /<a href="ch-002\.xhtml">Two &amp; more<\/a>/);
  const ch1 = z.get('OEBPS/ch-001.xhtml');
  assert.match(ch1, /<h1>1\. เริ่ม<\/h1>/);
  assert.match(ch1, /<h2>ฉากแรก<\/h2>/);
  assert.match(ch1, /<br\/>บรรทัดสอง/);
  assert.match(z.get('OEBPS/ch-002.xhtml'), /<p>Hello <strong>bold<\/strong><br\/>next<\/p>/);
  assert.equal(epub.exportEpub(mkModule('c', 'classifier'), out).code, 'not_book');
});

test('Markdown of one module: only what is inside it, pictures in assets/ embedded on their page', () => {
  freshVault();
  const world = mkModule('World', 'collector');
  const other = mkModule('Elsewhere', 'drafter');
  const cls = db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(world, 'People', 'classifier').lastInsertRowid;
  db.prepare(`UPDATE module SET description='outside' WHERE id=?`).run(other);
  const o = db.prepare(`INSERT INTO classifier_object (module_ref, name, note) VALUES (?,?,?)`).run(cls, 'Arin', 'the hero').lastInsertRowid;
  const png = join(tmp, 'arin face.png');
  writeFileSync(png, PNG);
  const f = db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type) VALUES (1,'arin face.png',?,'png')`).run(png).lastInsertRowid;
  const gone = db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type) VALUES (1,'x.png',?,'png')`).run(join(tmp, 'nope.png')).lastInsertRowid;
  const block = (item, src) => db.prepare(`INSERT INTO page_block (module_ref, item_key, block_type, source_key) VALUES (?,?,'image',?)`).run(cls, item, src);
  block(`cobj_${o}`, `file_${f}`); block(null, `file_${f}`); block(`cobj_${o}`, `file_${gone}`);
  const out = join(tmp, 'w.zip');
  const r = exportNexusMarkdown(1, out, { moduleId: world });
  assert.equal(r.ok, true);
  assert.equal(r.pictures, 1);
  assert.equal(r.missing, 1);
  const z = readZip(out);
  assert.deepEqual([...z.keys()].sort(), [`World/People/Arin.md`, `World/People/People.md`, `World/assets/${f}-arin face.png`]);
  assert.match(z.get('World/People/Arin.md'), new RegExp(`the hero\\n\\n!\\[\\[assets/${f}-arin face\\.png\\]\\]\\n$`));
  assert.match(z.get('World/People/People.md'), /!\[\[assets\//);
  assert.equal(exportNexusMarkdown(1, out, { moduleId: 999 }).code, 'not_found');
});
