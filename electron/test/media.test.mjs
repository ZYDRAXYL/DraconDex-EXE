// Procress 14 (APP docs/MEDIA-EMBED.md M4/M5/M7) — the bytes a page parses
// itself (a PDF, a 3D model) come from main only for this vault's own file
// rows, only for those kinds, and under a cap; a poster must be a small
// JPEG; a glTF that reaches outside itself is refused; and the new asset
// classes are what the two sides agree on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-media-'));
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
import { writeFileSync, readFileSync } from 'node:fs';
import vm from 'node:vm';
const media = require('../src/db/media-read.js');
const am = require('../src/db/asset-media.js');

function addFile(name, type, path, kind = 'file') {
  return db.prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, source_kind) VALUES (1,?,?,?,0,?)`)
    .run(name, path, type, kind).lastInsertRowid;
}

test('readBinary: this vault’s PDFs and models only, and never a big one', () => {
  freshVault();
  const pdf = join(tmp, 'a.pdf');
  writeFileSync(pdf, '%PDF-1.4 tiny');
  const glb = join(tmp, 'a.glb');
  writeFileSync(glb, Buffer.from('glTF____'));
  const png = join(tmp, 'a.png');
  writeFileSync(png, Buffer.from([0x89, 0x50]));
  const idPdf = addFile('a.pdf', 'pdf', pdf);
  const idGlb = addFile('a.glb', 'glb', glb);
  const r = media.readBinary(idPdf);
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.data).toString(), '%PDF-1.4 tiny');
  assert.equal(media.readBinary(idGlb).ext, 'glb');
  assert.equal(media.readBinary(99999).error, 'not_found', 'an id this vault does not have');
  assert.equal(media.readBinary('1; DROP').error, 'not_found');
  assert.equal(media.readBinary(addFile('b.png', 'png', png)).error, 'type', 'a picture streams; its bytes are not handed over');
  assert.equal(media.readBinary(addFile('web', 'pdf', 'https://example.com/x.pdf', 'url')).error, 'not_file', 'a URL asset');
  assert.equal(media.readBinary(addFile('gone.pdf', 'pdf', join(tmp, 'gone.pdf'))).error, 'missing');
  assert.equal(media.readBinary(idPdf, 4).error, 'too_large', 'over the cap');
  assert.equal(media.MAX_BINARY, 50 * 1024 * 1024);
});

test('setPoster: a small JPEG, once, for a PDF / model / video', () => {
  freshVault();
  const idPdf = addFile('a.pdf', 'pdf', join(tmp, 'a.pdf'));
  const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64')}`;
  assert.equal(media.setPoster(idPdf, 'data:image/png;base64,iVBORw0KGgo='), false, 'not a JPEG');
  assert.equal(media.setPoster(idPdf, `data:image/jpeg;base64,${Buffer.from('<svg>').toString('base64')}`), false, 'a JPEG in name only');
  assert.notEqual(media.setPoster(idPdf, jpeg), false);
  assert.equal(media.setPoster(idPdf, jpeg), false, 'the first one stays');
  assert.equal(media.setPoster(addFile('b.png', 'png', 'x'), jpeg), false, 'a picture’s proxy is main’s own');
  const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(300 * 1024)]).toString('base64')}`;
  assert.equal(media.setPoster(addFile('c.glb', 'glb', 'x'), big), false, 'over the proxy cap');
});

test('the new classes: subtitles stream, models do not; a poster is served for any file', () => {
  assert.equal(am.assetClassOf('vtt'), 'track');
  for (const e of ['glb', 'gltf', 'stl', 'obj']) assert.equal(am.assetClassOf(e), 'model');
  assert.equal(am.isStreamable('vtt'), true);
  assert.equal(am.isStreamable('glb'), false);
  const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');
  assert.match(main, /if \(!proxyOnly && !isStreamable\(ext\)\) return new Response\(null, \{ status: 404 \}\);/);
});

test('a glTF that names a file outside itself is refused', () => {
  const ctx = { I: {}, t: String, document: {}, window: {}, atob: (s) => Buffer.from(s, 'base64').toString('binary') };
  vm.createContext(ctx);
  vm.runInContext(`${readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/renderer/page/media-load.js'), 'utf8')}
this.api = { pbGltfExternalUris, pbDataUriBytes };`, ctx);
  const { pbGltfExternalUris, pbDataUriBytes } = ctx.api;
  assert.deepEqual([...pbGltfExternalUris({ buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ bufferView: 0 }] })], []);
  assert.deepEqual([...pbGltfExternalUris({ buffers: [{ uri: 'scene.bin' }] })], ['scene.bin']);
  assert.deepEqual([...pbGltfExternalUris({ images: [{ uri: 'https://example.com/t.png' }, { uri: 'tex/wood.jpg' }] })], ['https://example.com/t.png', 'tex/wood.jpg']);
  assert.deepEqual([...pbGltfExternalUris({ buffers: [{ uri: 'file:///etc/passwd' }] })], ['file:///etc/passwd']);
  assert.equal(pbDataUriBytes('data:application/octet-stream;base64,AQID').byteLength, 3);
  assert.equal(pbDataUriBytes('scene.bin'), null);
});
