'use strict';
// A minimal ZIP writer on Node's own zlib (v5 Part 4, APP docs/V5.md §8.7).
// EXE ships one runtime dependency (node-sqlite3-wasm) and keeps it that way
// — the same call main.js made for .doc export — so this writes the subset
// of the format every unzipper reads: local headers, stored or deflated
// entries, a central directory, UTF-8 names (flag bit 11, so Thai names
// survive). No ZIP64: an archive that would pass 4 GiB or 65,535 entries is
// refused rather than written corrupt. Nothing here reads a zip back — the
// user opens it with Explorer / 7-Zip / Finder.
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

// entries: [{ name, path, deflate? }] — name is the path inside the archive
// ('/' separated). Returns { ok, entries, bytes } or { ok:false, code }.
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
      if (e.deflate) {
        const raw = fs.readFileSync(e.path);
        crc = crc32(raw); size = raw.length;
        data = zlib.deflateRawSync(raw, { level: 6 });
        if (data.length < raw.length) { method = 8; csize = data.length; } else { data = raw; csize = size; }
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

module.exports = { writeZip, crc32 };
