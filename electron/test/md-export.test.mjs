// v5 Part 7 (V5.md §11.4) — Markdown export. The zip is read back with a
// minimal central-directory reader so the test needs no unzip binary: the
// frontmatter, [[links]] and folder layout are what a user opens in Obsidian.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-md-'));
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

const zlib = require('node:zlib');
const { readFileSync } = require('node:fs');
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

const { exportNexusMarkdown } = require('../src/db/md-export.js');

test('classifier objects, fields and relations become frontmatter; [[links]] survive', () => {
  freshVault();
  const world = mkModule('โลก', 'collector');
  const cls = mkModule('ตัวละคร', 'classifier', world);
  const tpl = (name, type, options = null) =>
    db.prepare(`INSERT INTO classifier_template (module_ref, description, attribute_type, options) VALUES (?,?,?,?)`).run(cls, name, type, options).lastInsertRowid;
  const tStr = tpl('Strength', 'number'), tTags = tpl('Tags', 'multi'), tAlive = tpl('Alive', 'checkbox'),
    tFriend = tpl('Friend', 'relation'), tPow = tpl('Power', 'formula', JSON.stringify({ expr: '{Strength} * 2' }));
  const obj = (name, note) => db.prepare(`INSERT INTO classifier_object (module_ref, name, note) VALUES (?,?,?)`).run(cls, name, note).lastInsertRowid;
  const a = obj('อลิซ', 'รู้จัก [[บ็อบ]] มานาน'), b = obj('บ็อบ', '');
  const val = (o, t, v) => db.prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(o, t, v);
  val(a, tStr, '7'); val(a, tTags, JSON.stringify(['hero', 'mage: fire'])); val(a, tAlive, '1');
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type) VALUES (1,?,?,?)`).run(`cobj_${a}`, `cobj_${b}`, `ctpl_${tFriend}`);
  db.prepare(`INSERT INTO entity_relation (nexus_ref, from_key, to_key, rel_type) VALUES (1,?,?,?)`).run(`cobj_${b}`, `cobj_${a}`, 'rival');
  const au = mkModule('เล่ม 1', 'author', world);
  db.prepare(`INSERT INTO book_chapter (module_ref, name, chapter_content, chapter_order, status, pov_key) VALUES (?,?,?,?,?,?)`).run(au, 'เปิดเรื่อง', 'ข้อความ', 0, 'draft', `cobj_${a}`);
  db.prepare(`INSERT INTO note (nexus_ref, title, content) VALUES (1, 'x/y', 'n')`).run();

  const out = join(tmp, 'md.zip');
  const r = exportNexusMarkdown(1, out);
  assert.equal(r.ok, true);
  const files = readZip(out);
  assert.deepEqual([...files.keys()].sort(), ['N/Notes/x_y.md', 'N/โลก/ตัวละคร/บ็อบ.md', 'N/โลก/ตัวละคร/อลิซ.md', 'N/โลก/เล่ม 1/1 เปิดเรื่อง.md'].sort());
  const alice = files.get('N/โลก/ตัวละคร/อลิซ.md');
  assert.match(alice, /^---\ncategory: "\[\[ตัวละคร\]\]"\n/);
  assert.match(alice, /\nStrength: 7\n/);
  assert.match(alice, /\nTags:\n  - "hero"\n  - "mage: fire"\n/);
  assert.match(alice, /\nAlive: true\n/);
  assert.match(alice, /\nFriend:\n  - "\[\[บ็อบ\]\]"\n/);
  assert.match(alice, /\nPower: "= \{Strength\} \* 2"\n/);
  assert.match(alice, /\nrelated:\n  - "\[\[บ็อบ\]\]"\n---\n\nรู้จัก \[\[บ็อบ\]\] มานาน$/);
  assert.match(files.get('N/โลก/เล่ม 1/1 เปิดเรื่อง.md'), /status: "draft"\npov: "\[\[อลิซ\]\]"\n---\n\nข้อความ$/);
});

test('an empty Nexus refuses rather than writing an empty zip', () => {
  freshVault();
  assert.deepEqual(exportNexusMarkdown(1, join(tmp, 'e.zip')), { ok: false, code: 'empty' });
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
