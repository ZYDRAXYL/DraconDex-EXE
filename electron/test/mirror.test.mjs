// v5 Part 4 (V5.md §8.5–§8.6, §8.11.4) — the folder mirror. Pure file work:
// collectors become folders, other modules become a .ddata + .dpage pair
// (Procress 16 part 3a — they were one .mddx), and the
// mirror only ever removes what it wrote itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { dirNameOf, collectorNameOfDir, planMirror, writeMirror } = require('../src/db/mirror.js');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-mirror-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
const fresh = (name) => { const d = join(tmp, name); mkdirSync(d); return d; };
const mod = (id, name, kind, parent_id = null, display_order = 0) => ({ id, name, kind, parent_id, display_order });
const snap = (id) => ({ module: id });

test('folder name <-> collector name: one rule, both directions', () => {
  for (const n of ['Chapter 1', 'ตัวละคร', 'Maps & Places', 'a.b']) {
    assert.equal(dirNameOf(collectorNameOfDir(n)), n); // a folder imported, then mirrored, lands on itself
  }
  assert.equal(dirNameOf('a/b:c?'), 'a_b_c_');
  assert.equal(dirNameOf('CON'), '_CON');
  assert.equal(dirNameOf('trailing. '), 'trailing');
  assert.equal(dirNameOf(''), '_');
});

test('plan: collectors are folders, modules are .ddata + .dpage, clashes keep apart by id', () => {
  const p = planMirror([
    mod(1, 'World', 'collector'), mod(2, 'Cast', 'classifier', 1), mod(3, 'Cast', 'drafter', 1, 1),
    mod(4, 'Maps', 'collector', 1, 2), mod(5, 'Top', 'inspector'),
  ]);
  assert.deepEqual(p.dirs.map((d) => d.rel), ['World', 'World/Maps']);
  assert.deepEqual(p.files.map((f) => f.rel).sort(), ['Top.ddata', 'Top.dpage', 'World/Cast (3).ddata', 'World/Cast (3).dpage', 'World/Cast.ddata', 'World/Cast.dpage']);
});

test('write: creates the tree, rewrites only what changed, never touches user files', () => {
  const root = fresh('w1');
  const mods = [mod(1, 'World', 'collector'), mod(2, 'Cast', 'classifier', 1)];
  let r = writeMirror(root, mods, snap);
  assert.deepEqual([r.ok, r.dirs, r.files, r.written], [true, 1, 2, 2]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'World', 'Cast.ddata'), 'utf8')), { module: 2, file: 'ddata', fileVersion: 1, pageBlocks: [] });
  assert.equal(JSON.parse(readFileSync(join(root, 'World', 'Cast.dpage'), 'utf8')).file, 'dpage');
  writeFileSync(join(root, 'World', 'notes.txt'), 'mine');
  r = writeMirror(root, mods, snap);
  assert.equal(r.written, 0); // unchanged
  // Module deleted: its pair goes, the user's file and the folder stay.
  r = writeMirror(root, [mod(1, 'World', 'collector')], snap);
  assert.equal(r.removed, 2);
  assert.equal(existsSync(join(root, 'World', 'Cast.ddata')), false);
  assert.equal(readFileSync(join(root, 'World', 'notes.txt'), 'utf8'), 'mine');
});

test('a renamed collector moves its folder, contents and all', () => {
  const root = fresh('w2');
  writeMirror(root, [mod(1, 'Old', 'collector'), mod(2, 'Inner', 'collector', 1), mod(3, 'Doc', 'drafter', 2)], snap);
  writeFileSync(join(root, 'Old', 'Inner', 'photo.png'), 'px');
  const r = writeMirror(root, [mod(1, 'New', 'collector'), mod(2, 'Inner', 'collector', 1), mod(3, 'Doc', 'drafter', 2)], snap);
  assert.equal(r.moved.length, 1);
  assert.equal(existsSync(join(root, 'Old')), false);
  assert.equal(readFileSync(join(root, 'New', 'Inner', 'photo.png'), 'utf8'), 'px');
  assert.ok(existsSync(join(root, 'New', 'Inner', 'Doc.ddata')));
});

test('an emptied folder the mirror made is removed; one the user filled is kept', () => {
  const root = fresh('w3');
  writeMirror(root, [mod(1, 'A', 'collector'), mod(2, 'B', 'collector')], snap);
  writeFileSync(join(root, 'B', 'keep.txt'), 'x');
  writeMirror(root, [], snap);
  assert.equal(existsSync(join(root, 'A')), false);
  assert.ok(existsSync(join(root, 'B', 'keep.txt')));
});

test('a manifest cannot reach outside the folder', () => {
  const root = fresh('w4');
  const outside = join(tmp, 'victim.mddx');
  writeFileSync(outside, 'keep');
  writeFileSync(join(root, '.dracondex-mirror.json'), JSON.stringify({ files: ['../victim.mddx'], dirs: [{ rel: '..', id: 9 }] }));
  writeMirror(root, [], snap);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
  assert.ok(readdirSync(tmp).includes('w4'));
});

test('a missing folder is reported, not created', () => {
  assert.deepEqual(writeMirror(join(tmp, 'nope'), [], snap), { ok: false, code: 'missing' });
});

// Procress 16 part 3a: a mirror written before the split listed .mddx files.
test('an older mirror\'s .mddx is replaced by the pair, not left behind', () => {
  const root = fresh('w5');
  mkdirSync(join(root, 'World'));
  writeFileSync(join(root, 'World', 'Cast.mddx'), '{}');
  writeFileSync(join(root, '.dracondex-mirror.json'), JSON.stringify({ files: ['World/Cast.mddx'], dirs: [{ rel: 'World', id: 1 }] }));
  writeMirror(root, [mod(1, 'World', 'collector'), mod(2, 'Cast', 'classifier', 1)], snap);
  assert.equal(existsSync(join(root, 'World', 'Cast.mddx')), false);
  assert.ok(existsSync(join(root, 'World', 'Cast.ddata')) && existsSync(join(root, 'World', 'Cast.dpage')));
});

test('module files: split + join give the snapshot back; a .dpage alone is refused', () => {
  const mf = require('../src/db/module-files.js');
  const snapshot = { format: 'dracondex-snapshot', version: 2, modules: [{ id: 7, name: 'Cast', kind: 'classifier' }], pageBlocks: [{ id: 1, block_type: 'text' }], classifierObjects: [{ id: 3 }] };
  const base = join(fresh('mf'), 'Cast');
  mf.writeModuleFiles(base, snapshot);
  const back = mf.readModuleFile(`${base}.dpage`); // either file of the pair
  assert.deepEqual(back.pageBlocks, snapshot.pageBlocks);
  assert.deepEqual(back.classifierObjects, snapshot.classifierObjects);
  assert.deepEqual(JSON.parse(readFileSync(`${base}.ddata`, 'utf8')).pageBlocks, [], 'the data file carries no page');
  rmSync(`${base}.ddata`);
  assert.throws(() => mf.readModuleFile(`${base}.dpage`));
});
