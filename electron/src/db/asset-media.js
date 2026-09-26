'use strict';
// v5 Asset Nest (APP docs/V5.md §2.4 / §2.6) — pure helpers shared by the
// import IPC in main.js and the ddx-file:// protocol handler. No Electron, no
// database: kept requireable from plain Node so electron/test/ can pin the
// Range parser, which is the thing standing between a 2 GB mkv and a single
// in-memory Response.

// Extension -> asset class. These classes are the whole taxonomy the
// renderer switches on; IMPORT_EXTS / IMAGE_EXTS in main.js derive from it.
const ASSET_CLASS = Object.freeze({
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  md: 'doc', txt: 'doc', docx: 'doc', pdf: 'doc',
  // Procress 14 (APP docs/MEDIA-EMBED.md M1/M5): subtitles a video block
  // plays, and 3D models a model block draws. glTF must be one file (.glb,
  // or .gltf with its buffers embedded) — nothing outside it is ever read.
  vtt: 'track',
  glb: 'model', gltf: 'model', stl: 'model', obj: 'model',
});

const MIME = Object.freeze({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf', md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  vtt: 'text/vtt; charset=utf-8',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', stl: 'model/stl', obj: 'model/obj',
});

const assetClassOf = (ext) => ASSET_CLASS[String(ext || '').toLowerCase()] || null;
const mimeOf = (ext) => MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';

// Classes ddx-file:// will stream. md/txt/docx are read through
// importdock:readFile instead and never need a URL.
// A .vtt is streamed too: a <track> element can only take a URL.
const STREAMABLE = new Set(['image', 'audio', 'video', 'track']);
const isStreamable = (ext) => STREAMABLE.has(assetClassOf(ext)) || String(ext || '').toLowerCase() === 'pdf';

// Files above this are never read whole — hashed by stream only and given no
// proxy (§2.5 "large").
const LARGE_BYTES = 100 * 1024 * 1024;
// Proxy budget (§5.1): node-sqlite3-wasm holds the whole vault in memory, so
// thumbnails are capped per file AND per vault.
const PROXY_MAX_BYTES = 200 * 1024;
const PROXY_VAULT_BUDGET = 64 * 1024 * 1024;

// Parse a single-range `Range: bytes=…` header against a file of `size` bytes.
// Returns null when there is no usable Range header (serve 200 in full),
// { start, end } (inclusive) for a satisfiable range, or { invalid: true } for
// a syntactically valid but unsatisfiable one (serve 416). Multi-range
// requests are answered with the first range only — media elements never send
// them, and a multipart/byteranges body is not worth its complexity here.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*(?:,.*)?$/i.exec(String(header));
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start;
  let end;
  if (a === '') {
    // Suffix range: the last N bytes.
    const n = Number(b);
    if (n === 0) return { invalid: true };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return { invalid: true };
  }
  return { start, end };
}

// Only http(s) URLs may become assets — shell.openExternal on a file:,
// javascript: or custom-scheme URL would hand the renderer a launcher.
function normalizeAssetUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u.toString();
}

module.exports = {
  ASSET_CLASS, assetClassOf, mimeOf, isStreamable, parseRange, normalizeAssetUrl,
  LARGE_BYTES, PROXY_MAX_BYTES, PROXY_VAULT_BUDGET,
};
