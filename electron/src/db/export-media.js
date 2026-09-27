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

// The file on disk, when it is one of `classes`. A site carries a page's
// video, sound and subtitles too (MEDIA-EMBED M8) — as files, played by the
// browser's own <video>/<audio>; a PDF or DOCX only ever holds pictures.
function originalOf(f, classes = ['image']) {
  const ext = String(f?.file_type || '').toLowerCase();
  if (!f || f.source_kind !== 'file' || !classes.includes(assetClassOf(ext)) || !f.file_path) return null;
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
    const orig = originalOf(f, ['image', 'video', 'audio', 'track']);
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

// One picture's bytes, for a writer that embeds (DOCX, EPUB): the original
// when it is there, not over the per-file cap and of a type the writer can
// hold (accept: extensions, e.g. DOCX takes no WebP), else the proxy.
// → { data, ext, mime } | null
function mediaBytes(id, accept = null) {
  const f = getImportFile(id);
  const orig = originalOf(f);
  const ok = (ext) => !accept || accept.includes(ext === 'jpeg' ? 'jpg' : ext);
  if (orig && orig.size <= MAX_INLINE_FILE && ok(orig.ext)) {
    try { return { data: fs.readFileSync(orig.file), ext: orig.ext === 'jpeg' ? 'jpg' : orig.ext, mime: mimeOf(orig.ext) }; } catch (_) { /* the proxy */ }
  }
  const px = f && proxyOf(id);
  return px && ok(px.ext) ? { data: px.data, ext: px.ext, mime: px.type } : null;
}

// One picture as a zip entry source, streamed from disk when the original
// is there: { path } or { data }, plus its extension and file name.
function mediaSource(id) {
  const f = getImportFile(id);
  const orig = originalOf(f);
  if (orig) return { path: orig.file, ext: orig.ext, fileName: f.file_name };
  const px = f && proxyOf(id);
  return px ? { data: px.data, ext: px.ext, fileName: f.file_name } : null;
}

function rewriteMedia(html, nexusId, urls) {
  return String(html || '').replace(URL_RE, (all, nx, id) =>
    (Number(nx) === Number(nexusId) && urls.has(Number(id)) ? urls.get(Number(id)) : all));
}

module.exports = { mediaIds, mediaForSite, mediaInline, mediaBytes, mediaSource, rewriteMedia };
