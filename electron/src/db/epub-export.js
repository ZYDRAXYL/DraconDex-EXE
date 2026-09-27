'use strict';
// ═══ EPUB 3 — an Author book (Procress 14, APP docs/EXPORT-DECOR.md E5) ═
// For Apple Books, Calibre, Kindle (Send to Kindle takes EPUB) and Sigil.
// The container rules readers are strict about:
//   - `mimetype` is the FIRST entry and STORED, not deflated (OCF §4.3) —
//     zip.js's `store` option exists for this
//   - META-INF/container.xml points at the package document
//   - the package has a dcterms:modified, a unique identifier and a nav
// One XHTML file per chapter; the cover is the book page's title cover.
const crypto = require('crypto');
const { writeZip } = require('./zip');
const { toXhtml, xesc } = require('./doc-model');
const { moduleDocument } = require('./doc-source');
const { mediaBytes } = require('./export-media');

const CSS = `body{font-family:serif;line-height:1.6;margin:0 5%}
h1{font-size:1.6em;margin:1.5em 0 1em;text-align:center}
h2,h3,h4{margin:1.2em 0 .5em}
p{margin:0 0 .8em;text-indent:0}
blockquote{margin:1em 2em;font-style:italic}
pre{white-space:pre-wrap;font-size:.9em}
li.d1{margin-left:1.5em} li.d2{margin-left:3em} li.d3{margin-left:4.5em}
.sub{text-align:center;font-style:italic;color:#666}
figure{margin:1em 0;text-align:center} figure img{max-width:100%}
.cover{text-align:center;margin:0} .cover img{max-width:100%;max-height:100vh}`;

const page = (title, lang, body, extraNs = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"${extraNs} xml:lang="${lang}" lang="${lang}">
<head><meta charset="UTF-8"/><title>${xesc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>${body}</body>
</html>`;

// opts: { lang }  → zip entries, or null when the module is not a book
function epubEntries(moduleId, opts = {}) {
  const doc = moduleDocument(moduleId);
  if (!doc || doc.kind !== 'author') return null;
  const lang = /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(opts.lang || '') ? opts.lang : 'en';
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const manifest = [];
  const spine = [];
  const files = [];
  const pictures = new Map(); // file id → href
  const picture = (fileId) => {
    if (!pictures.has(fileId)) {
      const b = mediaBytes(fileId, ['png', 'jpg', 'gif', 'webp', 'svg']);
      if (!b) { pictures.set(fileId, null); return null; }
      const href = `images/img${pictures.size + 1}.${b.ext}`;
      files.push({ name: `OEBPS/${href}`, data: b.data });
      manifest.push(`<item id="img${pictures.size + 1}" href="${href}" media-type="${b.mime}"/>`);
      pictures.set(fileId, href);
    }
    return pictures.get(fileId);
  };

  const coverHref = doc.cover != null ? picture(doc.cover) : null;
  if (coverHref) {
    manifest[manifest.length - 1] = manifest[manifest.length - 1].replace('/>', ' properties="cover-image"/>');
    files.push({ name: 'OEBPS/cover.xhtml', data: page(doc.title, lang, `<section class="cover" epub:type="cover"><img src="${coverHref}" alt="${xesc(doc.title)}"/></section>`) });
    manifest.push('<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    spine.push('<itemref idref="cover" linear="yes"/>');
  }
  const figs = (list) => list.map(picture).filter(Boolean).map((h) => `<figure><img src="${h}" alt=""/></figure>`).join('');
  const width = String(doc.sections.length).length;
  const chapters = doc.sections.map((s, i) => {
    const n = String(i + 1).padStart(Math.max(3, width), '0');
    const href = `ch-${n}.xhtml`;
    files.push({ name: `OEBPS/${href}`, data: page(s.title, lang,
      `<section epub:type="chapter"><h1>${xesc(s.title)}</h1>${s.sub ? `<p class="sub">${xesc(s.sub)}</p>` : ''}${figs(s.images)}\n${toXhtml(s.blocks)}</section>`) });
    manifest.push(`<item id="ch${n}" href="${href}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch${n}"/>`);
    return { href, title: s.title };
  });
  if (!chapters.length) return { empty: true };

  const nav = page(doc.title, lang, `<nav epub:type="toc" id="toc"><h1>${xesc(doc.title)}</h1><ol>
${chapters.map((c) => `<li><a href="${c.href}">${xesc(c.title)}</a></li>`).join('\n')}
</ol></nav>`);
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="bookid">${id}</dc:identifier>
<dc:title>${xesc(doc.title)}</dc:title>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
${manifest.join('\n')}
</manifest>
<spine>
${spine.join('\n')}
</spine>
</package>`;
  return [
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/style.css', data: CSS },
    ...files,
  ];
}

function exportEpub(moduleId, outPath, opts = {}) {
  const entries = epubEntries(moduleId, opts);
  if (!entries) return { ok: false, code: 'not_book' };
  if (entries.empty) return { ok: false, code: 'empty' };
  const r = writeZip(outPath, entries);
  return r.ok ? { ok: true, chapters: entries.filter((e) => /^OEBPS\/ch-\d+\.xhtml$/.test(e.name)).length } : r;
}

module.exports = { epubEntries, exportEpub };
