// Procress 14 (APP docs/EXPORT-DECOR.md E4) — a Classifier or a Chronicler
// out as CSV / XLSX. The CSV goes back in through CSV import unchanged
// (the name first, BOM, true/false, ISO dates); a text cell a spreadsheet
// would run as a formula is defused, a number is not; XLSX is one sheet
// per table with a bold, frozen header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-table-'));
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

const tx = require('../src/db/table-export.js');
const csv = require('../src/db/csv-import.js');

function characters() {
  freshVault();
  const cls = mkModule('ตัวละคร', 'classifier');
  const tpl = (name, type, order) => db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, display_order) VALUES (?,?,?,?)`)
    .run(cls, name, type, order).lastInsertRowid;
  const t = {
    age: tpl('อายุ', 'number', 1), alive: tpl('ยังมีชีวิต', 'checkbox', 2), born: tpl('เกิด', 'date', 3),
    tags: tpl('แท็ก', 'multi', 4), motto: tpl('คติ', 'text', 5), friend: tpl('เพื่อน', 'relation', 6), power: tpl('พลัง', 'formula', 7),
  };
  const obj = (name) => db.prepare(`INSERT INTO classifier_object (module_ref, name) VALUES (?,?)`).run(cls, name).lastInsertRowid;
  const a = obj('อลิซ'), b = obj('Bob, the "Brave"');
  const val = (o, k, v) => db.prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(o, t[k], v);
  val(a, 'age', '-5'); val(a, 'alive', '1'); val(a, 'born', '3-7-1990 08:30'); val(a, 'tags', JSON.stringify(['hero', 'mage']));
  val(a, 'motto', '=HYPERLINK("http://x")');
  val(b, 'age', '40'); val(b, 'alive', '0'); val(b, 'born', '1-1-12'); val(b, 'motto', 'line one\nline two');
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type) VALUES (1,?,?,?)`).run(`cobj_${a}`, `cobj_${b}`, `ctpl_${t.friend}`);
  return cls;
}

test('a Classifier becomes a table: name first, fields in order, a formula named and left out', () => {
  const tb = tx.classifierTable(characters());
  assert.deepEqual(tb.columns.map((c) => c.name), ['name', 'อายุ', 'ยังมีชีวิต', 'เกิด', 'แท็ก', 'คติ', 'เพื่อน']);
  assert.deepEqual(tb.skipped, ['พลัง']);
  assert.deepEqual(tb.rows[0], ['อลิซ', '-5', 'true', '1990-07-03', 'hero, mage', '=HYPERLINK("http://x")', 'Bob, the "Brave"']);
  assert.deepEqual(tb.rows[1].slice(1, 4), ['40', 'false', '1-1-12'], "a story's own year stays as it was");
});

test('the CSV has a BOM, quotes what needs it, defuses formulas and reads back through CSV import', () => {
  const tb = tx.classifierTable(characters());
  const text = tx.toCsv(tb);
  assert.ok(text.startsWith('﻿'));
  assert.ok(text.includes(`"'=HYPERLINK(""http://x"")"`), 'a text formula gets a quote in front');
  assert.ok(text.includes(',-5,'), 'a number column is not defused');
  const back = csv.decodeCsvBuffer(Buffer.from(text, 'utf8'));
  assert.equal(back.encoding, 'utf-8');
  const { rows } = csv.parseCsv(back.text);
  assert.deepEqual(rows[0], tb.columns.map((c) => c.name));
  assert.equal(rows[2][0], 'Bob, the "Brave"');
  assert.equal(rows[2][5], 'line one\nline two');
  const col = (i) => rows.slice(1).map((r) => r[i]);
  assert.equal(csv.guessColumnType(col(1)), 'number');
  assert.equal(csv.guessColumnType(col(2)), 'checkbox');
  assert.equal(csv.guessColumnType([col(3)[0]]), 'date');
});

test('XLSX: one sheet per table, a bold frozen header, numbers as numbers, text escaped', () => {
  const cls = characters();
  const out = join(tmp, 'c.xlsx');
  const r = tx.exportTable(cls, 'xlsx', out);
  assert.equal(r.ok, true);
  assert.equal(r.rows, 2);
  const z = readZip(out);
  assert.deepEqual([...z.keys()], ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  const sheet = z.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">name<\/t>/);
  assert.match(sheet, /<c r="B2"><v>-5<\/v><\/c>/);
  assert.match(sheet, /Bob, the &quot;Brave&quot;/);
  assert.match(z.get('xl/workbook.xml'), /<sheet name="ตัวละคร" sheetId="1" r:id="rId1"\/>/);
  assert.deepEqual(tx.sheetNames([{ name: 'a/b' }, { name: 'A B' }, { name: 'x'.repeat(40) }]), ['a b', 'A B 2', 'x'.repeat(31)]);
});

test('a Chronicler: a sheet per timeline, dates as y.mm.dd; CSV takes the first and says how many more', () => {
  freshVault();
  const ch = mkModule('ไทม์ไลน์', 'chronicler');
  const line = (n) => db.prepare(`INSERT INTO timeline (line_name, module_ref) VALUES (?,?)`).run(n, ch).lastInsertRowid;
  const date = (d, m, y, h = 0) => db.prepare(`INSERT INTO timeline_date (day, month, years, hour) VALUES (?,?,?,?)`).run(d, m, y, h).lastInsertRowid;
  const ev = (tl, name, s, e = null) => db.prepare(`INSERT INTO timeline_event (timeline_id, event_name, start_at, end_at) VALUES (?,?,?,?)`).run(tl, name, s, e);
  const main = line('หลัก'), side = line('รอง');
  ev(main, 'ออกเดินทาง', date(1, 3, 12), date(5, 3, 12, 9));
  ev(side, '+danger', date(2, 2, 2));
  const tables = tx.tablesFor(ch);
  assert.deepEqual(tables.map((tb) => tb.name), ['รอง', 'หลัก']);
  assert.deepEqual(tables[1].rows[0].slice(0, 3), ['ออกเดินทาง', '12.03.01', '12.03.05 09:00']);
  const out = join(tmp, 't.csv');
  const r = tx.exportTable(ch, 'csv', out);
  assert.equal(r.more, 1);
  assert.ok(readFileSync(out, 'utf8').includes("'+danger"));
  assert.equal(tx.exportTable(mkModule('โน้ต', 'drafter'), 'csv', out).code, 'not_table');
});
