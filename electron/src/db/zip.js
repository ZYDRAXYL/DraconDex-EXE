'use strict';
// A minimal ZIP writer on Node's own zlib (v5 Part 4, APP docs/V5.md §8.7).
// EXE ships one runtime dependency (node-sqlite3-wasm) and keeps it that way
// — the same call main.js made for .doc export — so this writes the subset
// of the format every unzipper reads: local headers, stored or deflated
// entries, a central directory, UTF-8 names (flag bit 11, so Thai names
// survive). No ZIP64: an archive that would pass 4 GiB or 65,535 entries is
// refused rather than written corrupt. The one zip read back is a .dxpack
// (APP docs/ASSET-PACK.md) — openZip below, the same subset in reverse.
//
// Entries are streamed from disk in chunks: a stored video is never held in
// memory whole. Deflate is for the entries that compress (the .ddx itself);
// images, audio and video are already compressed and go in stored.
const fs = require('fs');
const zlib = require('zlib');

const CHUNK = 1 << 20;
const LIMIT = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Read a file in chunks: its CRC and size, without holding it.
function scanFile(p) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let crc = 0, size = 0, n;
  try {
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) { crc = crc32(buf.subarray(0, n), crc); size += n; }
  } finally { fs.closeSync(fd); }
  return { crc, size };
}

// entries: [{ name, path, deflate? }] or [{ name, data, store? }] — name is the
// path inside the archive ('/' separated); `data` (a string or Buffer) is an
// entry made in memory, a deflate candidate unless `store` is set (EPUB's
// `mimetype` must be stored, not deflated — OCF §4.3).
// Returns { ok, entries, bytes } or { ok:false, code }.
function writeZip(outPath, entries) {
  if (entries.length > 0xfffe) return { ok: false, code: 'too_many' };
  const out = fs.openSync(outPath, 'w');
  let offset = 0;
  const central = [];
  const write = (b) => { fs.writeSync(out, b); offset += b.length; };
  try {
    for (const e of entries) {
      const name = Buffer.from(String(e.name).replace(/\\/g, '/'), 'utf8');
      const { time, date } = dosTime(e.mtime || new Date());
      let method = 0, crc, size, csize, data = null;
      if (e.deflate || e.data != null) {
        const raw = e.data != null ? Buffer.from(e.data) : fs.readFileSync(e.path);
        crc = crc32(raw); size = raw.length;
        data = e.store ? raw : zlib.deflateRawSync(raw, { level: 6 });
        if (!e.store && data.length < raw.length) { method = 8; csize = data.length; } else { data = raw; csize = size; }
      } else {
        ({ crc, size } = scanFile(e.path));
        csize = size;
      }
      if (offset + 30 + name.length + csize > LIMIT) return { ok: false, code: 'too_large' };
      const at = offset;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(method, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(size, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
      write(lh); write(name);
      if (data) write(data);
      else {
        const fd = fs.openSync(e.path, 'r');
        const buf = Buffer.allocUnsafe(CHUNK);
        let n, copied = 0;
        try {
          while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) { write(buf.subarray(0, n)); copied += n; }
        } finally { fs.closeSync(fd); }
        if (copied !== size) return { ok: false, code: 'changed_while_reading' };
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(method, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(size, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(at, 42);
      central.push(Buffer.concat([ch, name]));
    }
    const cdStart = offset;
    for (const c of central) write(c);
    const cdSize = offset - cdStart;
    if (offset > LIMIT) return { ok: false, code: 'too_large' };
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
    write(end);
    return { ok: true, entries: central.length, bytes: offset };
  } finally {
    fs.closeSync(out);
  }
}

// ── Reading (.dxpack, APP docs/ASSET-PACK.md) ───────────────────────────
// The central directory is the truth: a writer that streams (the APK's
// `archive` package) may leave sizes out of the local header and put them in
// a data descriptor, which the central directory always repeats. Entry data
// is read per entry through the fd, so a pack full of video is never held
// whole — only the one entry being read.
//
// safeEntryName is the zip-slip gate: an entry name is a relative '/' path
// with no '..', no empty or '.' segment, no drive letter and no leading
// slash. A name that fails it is not listed at all, so nothing downstream
// can write it anywhere.
function safeEntryName(name) {
  const n = String(name || '');
  if (!n || n.includes('\\') || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const segs = n.split('/');
  if (segs[segs.length - 1] === '') segs.pop(); // a directory entry
  if (!segs.length || segs.some((s) => !s || s === '.' || s === '..')) return null;
  return segs.join('/');
}

// Returns { ok, entries: Map(name -> entry), unsafe, read(name) -> Buffer|null,
// close() } or { ok:false, code }. Directory entries are skipped.
function openZip(zipPath) {
  let fd;
  try { fd = fs.openSync(zipPath, 'r'); } catch (_) { return { ok: false, code: 'bad_file' }; }
  const fail = (code) => { try { fs.closeSync(fd); } catch (_) {} return { ok: false, code }; };
  const size = fs.fstatSync(fd).size;
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return fail('bad_zip');
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdStart = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdStart === LIMIT || cdStart + cdSize > size) return fail('zip64_unsupported');
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdStart);
  const entries = new Map();
  let unsafe = 0;
  for (let p = 0, i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) return fail('bad_zip');
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const csize = cd.readUInt32LE(p + 20);
    const usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const at = cd.readUInt32LE(p + 42);
    const raw = cd.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (raw.endsWith('/')) continue;
    const name = safeEntryName(raw);
    if (!name) { unsafe++; continue; }
    entries.set(name, { name, method, crc, csize, size: usize, at });
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lh = Buffer.alloc(30);
    fs.readSync(fd, lh, 0, 30, e.at);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad_zip');
    const start = e.at + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    const data = Buffer.alloc(e.csize);
    fs.readSync(fd, data, 0, e.csize, start);
    let out;
    if (e.method === 0) out = data;
    else if (e.method === 8) out = zlib.inflateRawSync(data);
    else throw new Error('unsupported_method');
    if (out.length !== e.size || crc32(out) !== e.crc) throw new Error('bad_crc');
    return out;
  };
  return { ok: true, entries, unsafe, read, close: () => { try { fs.closeSync(fd); } catch (_) {} } };
}

module.exports = { writeZip, crc32, openZip, safeEntryName };
