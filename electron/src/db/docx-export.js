'use strict';
// ═══ DOCX — a real one (Procress 14, APP docs/EXPORT-DECOR.md E2) ══════
// Author's book used to leave as ".doc": HTML in Word's namespace, which
// Word opens with a warning and Google Docs / Pages misread. This writes
// Office Open XML through zip.js — no new dependency:
//   Title, Heading 1 per section (Word's Navigation pane lists them),
//   a property table, the page's pictures, the text, a page break between
//   chapters, links to the web as real hyperlinks.
const { writeZip } = require('./zip');
const { toDocx, xesc } = require('./doc-model');
const { moduleDocument } = require('./doc-source');
const { mediaBytes } = require('./export-media');

// Pixel size from the file's own header (PNG, JPEG, GIF, WebP) — a picture
// with no readable size is placed at a square default.
function imageSize(buf) {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const kind = buf.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) }; }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + len;
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

const EMU_PER_PX = 9525; // 96 dpi
const MAX_W = 6 * 914400; // six inches: a portrait page's text width

// Everything a document needs to point at: pictures and web links, each
// with a relationship id.
function makeCtx() {
  const rels = [];
  const media = [];
  const byFile = new Map();
  const byHref = new Map();
  return {
    rels, media,
    link(href) {
      if (!byHref.has(href)) { const id = `rId${100 + rels.length}`; rels.push({ id, type: 'hyperlink', target: href }); byHref.set(href, id); }
      return byHref.get(href);
    },
    image(fileId) {
      if (!byFile.has(fileId)) {
        const b = mediaBytes(fileId, ['png', 'jpg', 'gif']);
        if (!b) { byFile.set(fileId, null); return null; }
        const id = `rId${100 + rels.length}`;
        const name = `media/image${media.length + 1}.${b.ext}`;
        rels.push({ id, type: 'image', target: name });
        media.push({ name: `word/${name}`, data: b.data, ext: b.ext });
        const px = imageSize(b.data) || { w: 480, h: 480 };
        let cx = px.w * EMU_PER_PX, cy = px.h * EMU_PER_PX;
        if (cx > MAX_W) { cy = Math.round(cy * (MAX_W / cx)); cx = MAX_W; }
        byFile.set(fileId, { id, cx, cy, n: media.length });
      }
      return byFile.get(fileId);
    },
  };
}

function pictureXml(img, name) {
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">
<wp:extent cx="${img.cx}" cy="${img.cy}"/><wp:docPr id="${img.n}" name="${xesc(name)}"/>
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${img.n}" name="${xesc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="${img.id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>
</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function propsTable(props) {
  const cell = (text, w, bold) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${`<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xesc(text)}</w:t></w:r>`}</w:p></w:tc>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="PropTable"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr>
<w:tblGrid><w:gridCol w:w="2600"/><w:gridCol w:w="6400"/></w:tblGrid>
${props.map(([k, v]) => `<w:tr>${cell(k, 2600, true)}${cell(v, 6400, false)}</w:tr>`).join('')}</w:tbl><w:p/>`;
}

function documentXml(doc, ctx) {
  const body = [];
  body.push(`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${xesc(doc.title)}</w:t></w:r></w:p>`);
  if (doc.cover != null) { const img = ctx.image(doc.cover); if (img) body.push(pictureXml(img, 'cover')); }
  for (const f of doc.intro.images) { const img = ctx.image(f); if (img) body.push(pictureXml(img, `image ${img.n}`)); }
  body.push(toDocx(doc.intro.blocks, ctx));
  for (const s of doc.sections) {
    body.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/>${s.breakBefore ? '<w:pageBreakBefore/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${xesc(s.title)}</w:t></w:r></w:p>`);
    if (s.sub) body.push(`<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t xml:space="preserve">${xesc(s.sub)}</w:t></w:r></w:p>`);
    for (const f of s.images) { const img = ctx.image(f); if (img) body.push(pictureXml(img, `image ${img.n}`)); }
    if (s.props.length) body.push(propsTable(s.props));
    body.push(toDocx(s.blocks, ctx));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<w:body>${body.join('\n')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;
}

const FONTS = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Yu Gothic" w:cs="Leelawadee UI"/>';
const style = (id, name, pPr, rPr, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${extra}${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}<w:rPr>${rPr}</w:rPr></w:style>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${FONTS}<w:sz w:val="22"/><w:szCs w:val="28"/><w:lang w:val="en-US" w:bidi="th-TH"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${style('Title', 'Title', '<w:spacing w:after="240"/>', '<w:sz w:val="52"/><w:szCs w:val="52"/>')}
${style('Subtitle', 'Subtitle', '', '<w:i/><w:color w:val="666666"/>')}
${style('Heading1', 'heading 1', '<w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/>', '<w:b/><w:sz w:val="36"/><w:szCs w:val="36"/>')}
${style('Heading2', 'heading 2', '<w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="1"/>', '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/>')}
${style('Heading3', 'heading 3', '<w:keepNext/><w:spacing w:before="200" w:after="60"/><w:outlineLvl w:val="2"/>', '<w:b/><w:sz w:val="26"/><w:szCs w:val="26"/>')}
${style('Quote', 'Quote', '<w:ind w:left="567" w:right="567"/>', '<w:i/><w:color w:val="555555"/>')}
${style('Code', 'Code', '<w:spacing w:after="0"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/>')}
<w:style w:type="table" w:styleId="PropTable"><w:name w:val="Property Table"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>
</w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;

function docxEntries(doc) {
  const ctx = makeCtx();
  const document = documentXml(doc, ctx);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xesc(doc.title)}</dc:title><dc:creator>DraconDex</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>` },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${ctx.rels.map((r) => (r.type === 'hyperlink'
    ? `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xesc(r.target)}" TargetMode="External"/>`
    : `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`)).join('\n')}
</Relationships>` },
    ...ctx.media.map((m) => ({ name: m.name, data: m.data })),
  ];
}

function exportDocx(moduleId, outPath) {
  const doc = moduleDocument(moduleId);
  if (!doc) return { ok: false, code: 'not_doc' };
  const entries = docxEntries(doc);
  const r = writeZip(outPath, entries);
  return r.ok ? { ok: true, sections: doc.sections.length, pictures: entries.filter((e) => e.name.startsWith('word/media/')).length } : r;
}

module.exports = { docxEntries, exportDocx, imageSize };
