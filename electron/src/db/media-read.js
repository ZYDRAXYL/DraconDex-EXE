'use strict';
// ═══ Media a page draws in the renderer (Procress 14, MEDIA-EMBED M4/M5) ═
// A PDF (pdf.js) and a 3D model (three.js) are parsed in the page from
// their bytes — never fetched, since the CSP keeps connect-src 'none'. So
// main hands the bytes over, by id, for THIS vault's file rows only (the
// handler runs inside the window's vault), for those two kinds only, and
// under a cap: a 2 GB file is not something to copy through IPC.
//
// And back the other way: the first page / the model's first frame, drawn
// by the renderer, becomes the file's proxy — the same small JPEG an image
// has — so lists, the picker and exports have a picture of it.
const fs = require('fs');
const { getImportFile, getImportProxy, setImportProxy } = require('./importdock');
const { assetClassOf, PROXY_MAX_BYTES } = require('./asset-media');

const MAX_BINARY = 50 * 1024 * 1024;
const readable = (ext) => ext === 'pdf' || assetClassOf(ext) === 'model';

// → { ok, ext, name, data: Uint8Array } | { error }
function readBinary(id, maxBytes = MAX_BINARY) {
  const f = Number.isInteger(Number(id)) ? getImportFile(Number(id)) : null;
  if (!f) return { error: 'not_found' };
  if (f.source_kind !== 'file' || !f.file_path) return { error: 'not_file' };
  const ext = String(f.file_type || '').toLowerCase();
  if (!readable(ext)) return { error: 'type' };
  let st;
  try { st = fs.statSync(f.file_path); } catch (_) { return { error: 'missing' }; }
  if (!st.isFile()) return { error: 'missing' };
  if (st.size > maxBytes) return { error: 'too_large', size: st.size };
  return { ok: true, ext, name: f.file_name, data: new Uint8Array(fs.readFileSync(f.file_path)) };
}

// A poster from the renderer: a JPEG, under the proxy cap, for a PDF / a
// model / a video that has none yet (an image's proxy is main's own).
function setPoster(id, dataUrl) {
  const f = getImportFile(Number(id));
  const ext = String(f?.file_type || '').toLowerCase();
  if (!f || f.source_kind !== 'file' || !(readable(ext) || assetClassOf(ext) === 'video')) return false;
  if (getImportProxy(f.id)?.proxy) return false;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 4 || buf.length > PROXY_MAX_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  return setImportProxy(f.id, buf, 'image/jpeg');
}

module.exports = { readBinary, setPoster, MAX_BINARY };
