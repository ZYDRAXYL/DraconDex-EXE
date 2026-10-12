// Procress 20 — every Nexus is a Locate folder, made by the app: the folder
// exists from create (or the first open of an older Nexus), a sync redoes
// only what changed, and the folder follows a rename, comes back when it is
// deleted, stays put when its drive is gone, moves only when asked.
// Runs on the real data layer (conn.js + a real vault file per Nexus).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-locate-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: (k) => (k === 'documents' ? join(dir, 'REAL-DOCUMENTS') : join(dir, 'userData')), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = dir; // as the drivers and every test run set it

const conn = require('../src/db/conn.js');
const { runWithVault } = require('../src/db/vault-context.js');
const nexus = require('../src/db/nexus.js');
const vaults = require('../src/db/vaults.js');
const locate = require('../src/db/locate.js');
const { serializeVault } = require('../src/db/sync.js');
const { splitByModule } = require('../src/db/snapshot-split.js');
const { MANIFEST } = require('../src/db/mirror.js');
test.after(() => { locate.unwatchAll(); conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });

const inVault = (id, fn) => runWithVault(id, fn);
const sync = (id, reason = 'manual') => inVault(id, () => locate.syncLocate(id, { reason }));
const make = (name) => { const id = nexus.createNexus(name, '', null, null); sync(id, 'create'); return id; };
const v = (id) => conn.getVaultDB(id);
const ins = (id, sql, ...a) => Number(v(id).prepare(sql).run(...a).lastInsertRowid);
const mod = (id, name, kind, parent = null) => ins(id, `INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (?,?,?,?)`, id, parent, name, kind);
const dirOf = (id) => vaults.getVault(id).locate_dir;

test('the default root: <data dir>/Documents/DraconDex in a test run — never the real Documents', () => {
  assert.equal(locate.defaultLocateRoot(), join(dir, 'Documents', 'DraconDex'));
  process.env.DRACONDEX_LOCATE_ROOT = join(dir, 'elsewhere');
  assert.equal(locate.defaultLocateRoot(), join(dir, 'elsewhere'));
  delete process.env.DRACONDEX_LOCATE_ROOT;
  const was = process.env.DRACONDEX_DATA_DIR;
  delete process.env.DRACONDEX_DATA_DIR;
  assert.equal(locate.defaultLocateRoot(), join(dir, 'REAL-DOCUMENTS', 'DraconDex'), 'a packaged build: <Documents>/DraconDex');
  process.env.DRACONDEX_DATA_DIR = was;
});

test('a new Nexus has its folder at once, mirrored; a clashing name gets "(2)"', () => {
  const a = make('Atlas');
  assert.equal(dirOf(a), join(dir, 'Documents', 'DraconDex', 'Atlas'));
  assert.ok(existsSync(join(dirOf(a), MANIFEST)), 'mirrored at create');
  // a folder of that name already on disk (say, kept from a deleted Nexus)
  mkdirSync(join(dir, 'Documents', 'DraconDex', 'Borea'), { recursive: true });
  const b = make('Borea');
  assert.equal(basename(dirOf(b)), 'Borea (2)');
  assert.ok(!existsSync(join(dir, 'REAL-DOCUMENTS')), 'nothing in the real Documents');
});

test('a Nexus from before Procress 20 gets its folder the first time it opens', () => {
  const id = nexus.createNexus('Old World', '', null, null); // no sync: what an old install has
  mod(id, 'Notes', 'drafter');
  assert.equal(dirOf(id), null);
  const r = sync(id, 'open');
  assert.equal(r.ok, true);
  assert.equal(r.created, true, 'told once — the renderer toasts on created');
  assert.ok(existsSync(join(dirOf(id), 'Notes.ddata')));
  assert.equal(sync(id, 'open').created, false, 'and only once');
});

test('a sync with nothing changed writes nothing; one module edit writes its one file (+ the manifest)', () => {
  const id = make('Quiet');
  const world = mod(id, 'World', 'collector');
  const docs = Array.from({ length: 30 }, (_, i) => mod(id, `Doc ${i}`, 'drafter', world));
  let r = sync(id, 'open');
  assert.equal(r.written, 60);
  const manifest = join(dirOf(id), MANIFEST);
  const before = statSync(manifest).mtimeMs;
  for (const reason of ['open', 'tree', 'focus']) {
    r = sync(id, reason);
    assert.deepEqual([r.written, r.removed, r.manifestWritten], [0, 0, false], reason);
  }
  assert.equal(statSync(manifest).mtimeMs, before, 'the manifest untouched too');
  v(id).prepare(`UPDATE module SET description=? WHERE id=?`).run('changed', docs[4]);
  r = sync(id, 'tree');
  assert.equal(r.serialized, 1, 'only the edited module is serialized');
  assert.equal(r.written, 1, 'its .ddata — its page did not change');
  assert.equal(r.manifestWritten, true);
  assert.match(readFileSync(join(dirOf(id), 'World', 'Doc 4.ddata'), 'utf8'), /changed/);
});

test('changes reach the module that owns them, through any depth (attribute → object → module)', () => {
  const id = make('Deep');
  const cls = mod(id, 'Cast', 'classifier');
  const other = mod(id, 'Other', 'classifier');
  const obj = ins(id, `INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Ann')`, cls);
  const tpl = ins(id, `INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Age', 'text')`, cls);
  sync(id, 'open');
  v(id).prepare(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?,?)`).run(obj, tpl, '31');
  const d = locate.takeDirty(id);
  assert.equal(d.all, false);
  assert.deepEqual([...d.ids], [cls]);
  assert.ok(!d.ids.has(other));
});

test('a file deleted on disk is written back on the next open; a user file is never touched', () => {
  const id = make('Disk');
  mod(id, 'Page', 'drafter');
  sync(id, 'open');
  writeFileSync(join(dirOf(id), 'mine.txt'), 'keep');
  rmSync(join(dirOf(id), 'Page.dpage'));
  const r = sync(id, 'open');
  assert.equal(r.written, 1);
  assert.ok(existsSync(join(dirOf(id), 'Page.dpage')));
  assert.equal(readFileSync(join(dirOf(id), 'mine.txt'), 'utf8'), 'keep');
});

test('rename: an app-named folder follows (assets re-pointed); a folder the user moved does not', () => {
  const id = make('Before');
  const from = dirOf(id);
  writeFileSync(join(from, 'map.png'), 'px');
  sync(id, 'manual'); // files map.png as an asset
  inVault(id, () => nexus.updateNexus(id, 'After', '', null));
  const r = locate.followRename(id);
  assert.deepEqual(r, { from, to: join(dirname(from), 'After') });
  assert.ok(!existsSync(from) && existsSync(join(dirOf(id), 'map.png')));
  const asset = v(id).prepare(`SELECT file_path FROM import_file WHERE file_name='map.png'`).get();
  assert.equal(asset.file_path, join(dirOf(id), 'map.png'));

  const dest = join(dir, 'picked');
  mkdirSync(dest);
  const m = locate.moveLocate(id, dest);
  assert.equal(m.ok, true);
  assert.equal(dirOf(id), join(dest, 'After'));
  assert.equal(v(id).prepare(`SELECT file_path FROM import_file WHERE file_name='map.png'`).get().file_path, join(dest, 'After', 'map.png'));
  inVault(id, () => nexus.updateNexus(id, 'Renamed Again', '', null));
  assert.equal(locate.followRename(id), null, 'the user chose the place');
  assert.equal(dirOf(id), join(dest, 'After'));
});

test('folder deleted → made again and mirrored back; drive gone → not made, reported', () => {
  const id = make('Gone');
  mod(id, 'Chapter', 'drafter');
  sync(id, 'open');
  rmSync(dirOf(id), { recursive: true, force: true });
  const r = sync(id, 'focus');
  assert.equal(r.ok, true);
  assert.equal(r.recreated, true);
  assert.ok(existsSync(join(dirOf(id), 'Chapter.ddata')), 'rebuilt from the .ddx');

  // a folder on a USB stick that is not plugged in
  const usb = process.platform === 'win32' ? 'Q:\\DraconDex\\Gone' : '/media/nobody/NO-SUCH-STICK/DraconDex/Gone';
  if (process.platform === 'win32' && existsSync('Q:\\')) return;
  vaults.setVaultLocateDir(id, usb);
  assert.equal(locate.driveAvailable(usb), false);
  const g = sync(id, 'open');
  assert.equal(g.ok, false);
  assert.equal(g.driveGone, true);
  assert.ok(!existsSync(usb), 'nothing made where the drive was');
  assert.equal(locate.locateRootOf(id), null, 'a drop / .dxpack has nowhere to go — no_dir, not a dialog');
});

test('a drop or a .dxpack into a Nexus with no folder makes one — nothing is asked', () => {
  const id = nexus.createNexus('Dropzone', '', null, null);
  const src = join(dir, 'src.png');
  writeFileSync(src, 'png');
  const c = inVault(id, () => locate.copyIntoFolder(id, [src], null));
  assert.equal(c.ok, true);
  assert.equal(c.copied[0], join(dirOf(id), 'src.png'));
  const p = nexus.createNexus('Packed', '', null, null);
  assert.equal(inVault(p, () => locate.locateRootOf(p)), join(dir, 'Documents', 'DraconDex', 'Packed'));
});

test('gather copies outside asset files in — the originals stay', () => {
  const id = make('Gather');
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'face.jpg'), 'jpg');
  const world = mod(id, 'World', 'collector');
  inVault(id, () => v(id).prepare(`INSERT INTO import_file (nexus_ref, file_name, file_path, file_type, file_size, source_kind, module_ref) VALUES (?,?,?,?,?,'file',?)`)
    .run(id, 'face.jpg', join(outside, 'face.jpg'), 'jpg', 3, world));
  sync(id, 'open');
  assert.equal(locate.outsideAssets(id).length, 1);
  const r = locate.gatherAssets(id);
  assert.deepEqual([r.copied, r.failed], [1, 0]);
  assert.ok(existsSync(join(outside, 'face.jpg')), 'original kept');
  assert.ok(existsSync(join(dirOf(id), 'World', 'face.jpg')), 'copy in its collector\'s folder');
  assert.equal(locate.outsideAssets(id).length, 0);
});

test('the per-module cut of one pass equals serializeVault(nexus, [id]) for every kind', () => {
  const id = make('Every kind');
  const w = (sql, ...a) => ins(id, sql, ...a);
  const tag = w(`INSERT INTO hashtag (tag_name) VALUES ('hero')`);
  const cls = mod(id, 'Cast', 'classifier');
  const o1 = w(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Ann')`, cls);
  const o2 = w(`INSERT INTO classifier_object (module_ref, name) VALUES (?, 'Bo')`, cls);
  const tp = w(`INSERT INTO classifier_template (module_ref, description, attribute_type) VALUES (?, 'Age', 'text')`, cls);
  w(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?, '9')`, o2, tp);
  w(`INSERT INTO classifier_attribute (object_ref, template_ref, attribute_value) VALUES (?,?, '7')`, o1, tp);
  w(`INSERT INTO module_hashtag (module_ref, hashtag_id) VALUES (?,?)`, cls, tag);
  w(`INSERT INTO module_ui (module_ref, ui_key, ui_value) VALUES (?, 'view', 'grid')`, cls);
  w(`INSERT INTO page_block (module_ref, block_type, block_order) VALUES (?, 'text', 0)`, cls);
  const loc = mod(id, 'Map', 'locator');
  const mp = w(`INSERT INTO map (module_ref, map_name) VALUES (?, 'M')`, loc);
  const ar = w(`INSERT INTO map_area (map_id, area_name) VALUES (?, 'A')`, mp);
  w(`INSERT INTO map_point (area_id, point_order, x, y) VALUES (?, 0, 1, 2)`, ar);
  const chr = mod(id, 'Time', 'chronicler');
  const tl = w(`INSERT INTO timeline (module_ref, line_name) VALUES (?, 'T')`, chr);
  const d1 = w(`INSERT INTO timeline_date (day, month, years) VALUES (1, 2, 300)`);
  w(`INSERT INTO timeline_event (timeline_id, event_name, start_at) VALUES (?, 'E', ?)`, tl, d1);
  const nar = mod(id, 'Talk', 'narrator');
  const dl = w(`INSERT INTO story_dialogue (module_ref, name) VALUES (?, 'D')`, nar);
  const tk = w(`INSERT INTO story_talk (dialogue_ref, speaker, talk_sentence, talk_order) VALUES (?, 'S', 'hi', 0)`, dl);
  w(`INSERT INTO story_choice_option (talk_ref, option_text, option_order) VALUES (?, 'yes', 0)`, tk);
  const sk = mod(id, 'Sketch', 'sketcher');
  const pg = w(`INSERT INTO sketch_page (module_ref, name, page_order) VALUES (?, 'P', 0)`, sk);
  w(`INSERT INTO sketch_stroke (page_ref, color, width, points) VALUES (?, '#fff', 2, '[]')`, pg);
  const dv = mod(id, 'Dice', 'diviner');
  const dt = w(`INSERT INTO diviner_table (module_ref, name) VALUES (?, 'Loot')`, dv);
  w(`INSERT INTO diviner_entry (table_ref, entry_text) VALUES (?, 'gold')`, dt);
  const au = mod(id, 'Book', 'author');
  w(`INSERT INTO book_chapter (module_ref, name, chapter_order) VALUES (?, 'One', 0)`, au);
  const cs = mod(id, 'Chat', 'scribe');
  const ss = w(`INSERT INTO chat_session (module_ref, name) VALUES (?, 'S1')`, cs);
  w(`INSERT INTO chat_message (session_ref, message) VALUES (?, 'yo')`, ss);
  const ex = mod(id, 'Stage', 'exhibitor');
  w(`INSERT INTO exhibit_node (module_ref, node_type, label) VALUES (?, 'text', 'L')`, ex);

  const cut = splitByModule(serializeVault(id));
  for (const m of [cls, loc, chr, nar, sk, dv, au, cs, ex]) {
    const one = serializeVault(id, [m]);
    delete one.exportedAt;
    one.classifier.attributes.sort((a, b) => a.objectId - b.objectId || a.templateId - b.templateId);
    assert.deepEqual(JSON.parse(JSON.stringify(cut.get(m))), JSON.parse(JSON.stringify(one)), `module ${m}`);
  }
});
