'use strict';
// ═══ PDF (Procress 14, APP docs/EXPORT-DECOR.md E1) ════════════════════
// The renderer draws the pages the way the HTML site export does (hub/
// html-export.js: the app's own components in a hidden pane, canvases as
// PNG, navigation as <a data-key>) and hands them here. Main makes ONE
// print document — a page break between pages, links between them kept as
// anchors, the Nexus's pictures inlined — and main.js prints it in a hidden
// window with JavaScript off, through webContents.printToPDF.
//
// The document fetches nothing: its CSP allows data: images and inline
// style only, and every picture is already bytes (export-media.js). So the
// print window has nothing to reach even if the HTML tried.
const { PAGE_KEY, rewriteLinks } = require('./html-export');
const { mediaInline, rewriteMedia } = require('./export-media');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const anchorOf = (key) => `p-${key}`;
const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

const PRINT_CSS = `
body.ddx-print{margin:0;background:var(--bg);color:var(--t1);overflow:visible;height:auto}
/* the print colours: the paper is the page — no theme background boxed inside the margins */
body.ddx-print[data-print-theme]{background:transparent}
.print-page{padding:0 2px;break-after:page}
.print-page:last-child{break-after:auto}
.print-toc{break-after:page}
.print-toc h1{font-size:1.6em;margin:0 0 16px}
.print-toc ol{margin:0;padding-left:1.4em;line-height:1.9}
.print-toc a{color:inherit;text-decoration:none}
.ddx-print .bpane-body,.ddx-print .module-page{overflow:visible!important;height:auto!important;max-height:none!important}
.ddx-print img{max-width:100%;break-inside:avoid}
.ddx-print figure,.ddx-print .pblock{break-inside:avoid-page}
.ddx-print a.xl{color:var(--accentH);text-decoration:none}`;

// payload: { title, css, theme: 'print'|'current', toc, pages: [{ key, name, html }], images: [{ name, base64 }] }
// → { ok, html, pages, missing }
function buildPrintHtml(payload, nexusId) {
  const pages = (payload?.pages || []).filter((p) => PAGE_KEY.test(p.key));
  if (!pages.length) return { ok: false, code: 'empty' };
  const inDoc = new Set(pages.map((p) => p.key));
  const media = mediaInline(pages.map((p) => p.html), nexusId);
  const canvases = new Map((payload.images || []).filter((im) => /^img\/[\w.-]+\.png$/.test(im.name))
    .map((im) => [im.name, `data:image/png;base64,${String(im.base64 || '').replace(/[^A-Za-z0-9+/=]/g, '')}`]));
  const body = (html) => rewriteLinks(rewriteMedia(html, nexusId, media.urls), inDoc, null, (k) => `#${anchorOf(k)}`)
    .replace(/\bsrc="(img\/[\w.-]+\.png)"/g, (all, name) => (canvases.has(name) ? `src="${canvases.get(name)}"` : all));
  const title = String(payload.title || pages[0].name || '');
  const toc = payload.toc && pages.length > 1
    ? `<nav class="print-toc"><h1>${esc(title)}</h1><ol>${pages.map((p) => `<li><a href="#${esc(anchorOf(p.key))}">${esc(p.name)}</a></li>`).join('')}</ol></nav>`
    : '';
  const css = String(payload.css || '').replace(/<\/style/gi, '<\\/style');
  const theme = payload.theme === 'current' ? '' : ' data-print-theme="daylight"';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${esc(title)}</title><style>${css}\n${PRINT_CSS}</style></head>
<body class="ddx-site ddx-print"${theme}>${toc}${pages.map((p) => `<section class="print-page" id="${esc(anchorOf(p.key))}">${body(p.html)}</section>`).join('\n')}</body></html>`;
  return { ok: true, html, pages: pages.length, missing: media.missing };
}

// printToPDF's options from the modal's (sizes in inches, as Electron takes them).
const PAPER = new Set(['A4', 'Letter', 'A5']);
function pdfOptions(opts = {}, title = '') {
  const small = 'font-size:8px;width:100%;padding:0 12mm;color:#777;font-family:sans-serif';
  const headerFooter = opts.headerFooter !== false;
  return {
    pageSize: PAPER.has(opts.paper) ? opts.paper : 'A4',
    landscape: opts.orientation === 'landscape',
    printBackground: true,
    margins: { top: 0.6, bottom: 0.6, left: 0.5, right: 0.5 },
    displayHeaderFooter: headerFooter,
    headerTemplate: headerFooter ? `<div style="${small};text-align:left">${esc(title)}</div>` : '<span></span>',
    footerTemplate: headerFooter ? `<div style="${small};text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>` : '<span></span>',
    generateDocumentOutline: true,
  };
}

module.exports = { buildPrintHtml, pdfOptions, CSP };
