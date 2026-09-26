'use strict';
// ═══ Pictures in an export (Procress 14, APP docs/EXPORT-DECOR.md E7/E1) ══
// A page shows a Nexus image as ddx-file://<nexus>-<file id> — a URL that
// only means something inside the app. An export turns each one into a
// file the export carries (the HTML site: media/<id>.<ext>) or into the
// bytes themselves (a PDF: a data: URL, since the print window reads no
// files and fetches nothing). The original on disk when it is still there,
// else the cover proxy the vault keeps; neither → the URL is left as it
// was and counted as missing.
//
// Only ids of THIS Nexus are resolved: the HTML came from the renderer, and
// a URL naming another vault's file is not this export's to read.
const fs = require('fs');
const { getImportFile, getImportProxy } = require('./importdock');
const { assetClassOf, mimeOf } = require('./asset-media');

const URL_RE = /ddx-file:\/\/(\d+)-(\d+)(?:\?[^"'\s)]*)?/g;
const MAX_INLINE_FILE = 20 * 1024 * 1024;
const MAX_INLINE_TOTAL = 200 * 1024 * 1024;
const EXT_OF_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// file ids the HTML shows from this Nexus, in the order they first appear
function mediaIds(htmls, nexusId) {
  const ids = new Set();
  for (const h of htmls) {
    for (const m of String(h || '').matchAll(URL_RE)) if (Number(m[1]) === Number(nexusId)) ids.add(Number(m[2]));
  }
  return [...ids];
}

function originalOf(f) {
  const ext = String(f?.file_type || '').toLowerCase();
  if (!f || f.source_kind !== 'file' || assetClassOf(ext) !== 'image' || !f.file_path) return null;
  try {
    const st = fs.statSync(f.file_path);
    return st.isFile() ? { ext, size: st.size, file: f.file_path } : null;
  } catch (_) { return null; }
}

function proxyOf(id) {
  const p = getImportProxy(id);
  if (!p?.proxy) return null;
  const type = p.proxy_type || 'image/jpeg';
  return { type, ext: EXT_OF_TYPE[type] || 'jpg', data: Buffer.from(p.proxy) };
}

// → { entries: [{name, path} | {name, data}], urls: Map(id → 'media/…'), missing }
function mediaForSite(htmls, nexusId) {
  const entries = [];
  const urls = new Map();
  let missing = 0;
  for (const id of mediaIds(htmls, nexusId)) {
    const f = getImportFile(id);
    const orig = originalOf(f);
    if (orig) {
      const name = `media/${id}.${orig.ext}`;
      entries.push({ name, path: orig.file });
      urls.set(id, name);
      continue;
    }
    const px = f && proxyOf(id);
    if (px) {
      const name = `media/${id}.${px.ext}`;
      entries.push({ name, data: px.data });
      urls.set(id, name);
    } else missing++;
  }
  return { entries, urls, missing };
}

// → { urls: Map(id → 'data:…'), missing } — a file over the caps falls back
// to its proxy, so one huge scan cannot balloon the print document.
function mediaInline(htmls, nexusId) {
  const urls = new Map();
  let missing = 0;
  let left = MAX_INLINE_TOTAL;
  for (const id of mediaIds(htmls, nexusId)) {
    const f = getImportFile(id);
    const orig = originalOf(f);
    if (orig && orig.size <= MAX_INLINE_FILE && orig.size <= left) {
      try {
        const buf = fs.readFileSync(orig.file);
        left -= buf.length;
        urls.set(id, `data:${mimeOf(orig.ext)};base64,${buf.toString('base64')}`);
        continue;
      } catch (_) { /* fall through to the proxy */ }
    }
    const px = f && proxyOf(id);
    if (px && px.data.length <= left) {
      left -= px.data.length;
      urls.set(id, `data:${px.type};base64,${px.data.toString('base64')}`);
    } else missing++;
  }
  return { urls, missing };
}

function rewriteMedia(html, nexusId, urls) {
  return String(html || '').replace(URL_RE, (all, nx, id) =>
    (Number(nx) === Number(nexusId) && urls.has(Number(id)) ? urls.get(Number(id)) : all));
}

module.exports = { mediaIds, mediaForSite, mediaInline, rewriteMedia };
