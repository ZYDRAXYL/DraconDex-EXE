// v5 Part 4 (V5.md §8.7) — the hand-written ZIP writer. Checked with the
// system unzip when there is one (it is what a user's extractor would do),
// and always against the format's own fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { writeZip, crc32 } = require('../src/db/zip.js');
const tmp = mkdtempSync(join(tmpdir(), 'ddx-zip-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  if (typeof zlib.crc32 === 'function') {
    const b = Buffer.from('ตัวละคร and more');
    assert.equal(crc32(b), zlib.crc32(b));
  }
});

test('stored + deflated entries, UTF-8 names, readable by unzip', () => {
  const a = join(tmp, 'a.ddx'), b = join(tmp, 'b.png'), big = join(tmp, 'c.bin');
  writeFileSync(a, 'SQLite '.repeat(5000));
  writeFileSync(b, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  writeFileSync(big, Buffer.alloc(3 * 1024 * 1024 + 7, 7)); // spans several read chunks
  const out = join(tmp, 'out.zip');
  const r = writeZip(out, [
    { name: 'Nexus.ddx', path: a, deflate: true },
    { name: 'media/img/ภาพ.png', path: b },
    { name: 'media/vdo/c.bin', path: big },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.entries, 3);
  const z = readFileSync(out);
  // End of central directory: 3 entries, and the directory it points at is real.
  const end = z.length - 22;
  assert.equal(z.readUInt32LE(end), 0x06054b50);
  assert.equal(z.readUInt16LE(end + 10), 3);
  assert.equal(z.readUInt32LE(z.readUInt32LE(end + 16)), 0x02014b50);
  // First entry is deflated and inflates back to the source.
  assert.equal(z.readUInt16LE(8), 8);
  const nameLen = z.readUInt16LE(26), csize = z.readUInt32LE(18);
  const inflated = zlib.inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + csize));
  assert.equal(inflated.toString(), readFileSync(a, 'utf8'));
  let unzip = null;
  try { unzip = execFileSync('unzip', ['-t', out], { encoding: 'utf8' }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (unzip !== null) {
    assert.match(unzip, /No errors detected/);
    const list = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(list, ['Nexus.ddx', 'media/img/ภาพ.png', 'media/vdo/c.bin']);
  }
});
