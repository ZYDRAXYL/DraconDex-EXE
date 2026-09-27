'use strict';
// ═══ One small document model for DOCX and EPUB (Procress 14, E2 / E5) ══
// A chapter is Markdown (the app's own subset — markdown.js) or the HTML the
// Author editor writes (contenteditable + execCommand: <div>, <b>, <i>,
// <u>, lists, <br>, &emsp;). Both are read here into the same blocks, and
// the blocks are written out as XHTML (EPUB) or WordprocessingML (DOCX) —
// so each writer handles four block kinds, not two input languages.
//
//   block  { t:'h', level, runs } | { t:'p', runs } | { t:'li', ordered, depth, n, runs }
//          | { t:'quote', runs } | { t:'code', text } | { t:'hr' } | { t:'pagebreak' }
//   run    { text, b, i, u, s, code, href } | { br: true }
//
// Like markdown.js, a single newline inside a paragraph is a line break.
// [[Wikilink|alias]] becomes its text: a link to a page the file does not
// hold would go nowhere.

const WIKI = /\[\[([^[\]|]+?)(?:\|([^[\]]+?))?\]\]/g;

// ── Markdown → blocks ──────────────────────────────────────────────────
function inlineRuns(text) {
  const runs = [];
  const src = String(text).replace(WIKI, (_, name, alias) => (alias || name).trim());
  // tokens: `code`, [label](http…), **b**, *i* / _i_, ~~s~~
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|(?:^|(?<=[^*\w]))\*([^*\n]+)\*(?!\*)|(?:^|(?<=\W))_([^_\n]+)_(?!\w)/g;
  let at = 0, m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > at) runs.push({ text: src.slice(at, m.index) });
    if (m[1] != null) runs.push({ text: m[1], code: true });
    else if (m[2] != null) runs.push({ text: m[2], href: m[3] });
    else if (m[4] != null) runs.push(...inlineRuns(m[4]).map((r) => ({ ...r, b: true })));
    else if (m[5] != null) runs.push({ text: m[5], s: true });
    else runs.push(...inlineRuns(m[6] ?? m[7]).map((r) => ({ ...r, i: true })));
    at = m.index + m[0].length;
  }
  if (at < src.length) runs.push({ text: src.slice(at) });
  return runs.filter((r) => r.br || r.text);
}

const withBreaks = (lines) => lines.flatMap((l, i) => (i ? [{ br: true }, ...inlineRuns(l)] : inlineRuns(l)));

function fromMarkdown(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ t: 'p', runs: withBreaks(para) }); para = []; };
  let counters = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (/^\s*```/.test(line)) {
      flush();
      const buf = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i]);
      out.push({ t: 'code', text: buf.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); counters = []; continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push({ t: 'h', level: m[1].length, runs: inlineRuns(m[2]) }); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push({ t: 'hr' }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      const buf = [m[1]];
      while (i + 1 < lines.length && /^>/.test(lines[i + 1])) buf.push(lines[++i].replace(/^>\s?/, ''));
      out.push({ t: 'quote', runs: withBreaks(buf) });
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line))) {
      flush();
      const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
      const ordered = /\d/.test(m[2]);
      counters = counters.slice(0, depth + 1);
      counters[depth] = ordered ? (counters[depth] || 0) + 1 : 0;
      const task = m[3] != null ? [{ text: m[3] === ' ' ? '☐ ' : '☑ ' }] : [];
      out.push({ t: 'li', ordered, depth, n: counters[depth], runs: [...task, ...inlineRuns(m[4])] });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

// ── HTML (the Author editor's) → blocks ───────────────────────────────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', emsp: ' ', ensp: ' ', thinsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return ENT[e.toLowerCase()] ?? all;
});

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'section', 'article']);
function fromHtml(html) {
  const out = [];
  const style = { b: 0, i: 0, u: 0, s: 0, code: 0 };
  const lists = []; // [{ ordered, n }]
  let cur = null; // the block being filled
  let href = null;
  let pre = 0;
  const open = (t, extra = {}) => { close(); cur = { t, runs: [], ...extra }; };
  const close = () => {
    if (!cur) return;
    while (cur.runs.length && cur.runs[cur.runs.length - 1].br) cur.runs.pop();
    if (cur.t === 'code') out.push({ t: 'code', text: cur.runs.map((r) => (r.br ? '\n' : r.text)).join('') });
    else if (cur.runs.some((r) => r.text && r.text.trim())) out.push(cur);
    cur = null;
  };
  const text = (s) => {
    let v = decode(s);
    if (!pre) v = v.replace(/[ \t\r\n]+/g, ' ');
    if (!v) return;
    if (!cur) { if (!v.trim()) return; open(lists.length ? 'li' : 'p', lists.length ? { ordered: lists.at(-1).ordered, depth: lists.length - 1, n: lists.at(-1).n } : {}); }
    const run = { text: v };
    for (const k of ['b', 'i', 'u', 's', 'code']) if (style[k]) run[k] = true;
    if (href) run.href = href;
    cur.runs.push(run);
  };
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    if (m[4] != null) { text(m[4]); continue; }
    if (!m[2]) continue;
    const end = m[1] === '/';
    const tag = m[2].toLowerCase();
    const k = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', code: 'code' }[tag];
    if (k) { style[k] = Math.max(0, style[k] + (end ? -1 : 1)); continue; }
    if (tag === 'a') {
      const h = /\bhref\s*=\s*"(https?:\/\/[^"]+)"/i.exec(m[3] || '');
      href = end ? null : (h ? decode(h[1]) : null);
      continue;
    }
    if (tag === 'br') { if (cur) cur.runs.push({ br: true }); continue; }
    if (tag === 'hr') { close(); out.push({ t: 'hr' }); continue; }
    if (tag === 'ul' || tag === 'ol') {
      close();
      if (end) lists.pop(); else lists.push({ ordered: tag === 'ol', n: 0 });
      continue;
    }
    if (tag === 'pre') { if (end) { close(); pre = 0; } else { open('code'); pre = 1; } continue; }
    if (!BLOCK_TAGS.has(tag)) continue;
    if (end) { if (!pre) close(); continue; }
    if (/^h[1-6]$/.test(tag)) open('h', { level: Number(tag[1]) });
    else if (tag === 'li') { const l = lists.at(-1); if (l) l.n++; open('li', { ordered: !!l?.ordered, depth: Math.max(0, lists.length - 1), n: l?.n || 0 }); }
    else if (tag === 'blockquote') open('quote');
    else if (!pre) open(lists.length ? 'li' : 'p', lists.length ? { ordered: lists.at(-1).ordered, depth: lists.length - 1, n: lists.at(-1).n } : {});
  }
  close();
  return out;
}

// The Author rule (author.js authorLooksHtml): content that starts with a
// tag is the editor's HTML, anything else is Markdown.
const toBlocks = (content) => (/^\s*</.test(content || '') ? fromHtml(content) : fromMarkdown(content));

// ── blocks → XHTML (EPUB) ─────────────────────────────────────────────
const xesc = (s) => String(s ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function runsXhtml(runs) {
  return runs.map((r) => {
    if (r.br) return '<br/>';
    let h = xesc(r.text);
    if (r.code) h = `<code>${h}</code>`;
    if (r.s) h = `<del>${h}</del>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.href) h = `<a href="${xesc(r.href)}">${h}</a>`;
    return h;
  }).join('');
}

function toXhtml(blocks) {
  const out = [];
  let list = null; // 'ul' | 'ol' at depth 0; deeper items indent by class
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const b of blocks) {
    if (b.t === 'li') {
      const tag = b.ordered ? 'ol' : 'ul';
      if (list !== tag) { endList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li${b.depth ? ` class="d${b.depth}"` : ''}>${runsXhtml(b.runs)}</li>`);
      continue;
    }
    endList();
    if (b.t === 'h') out.push(`<h${Math.min(6, b.level + 1)}>${runsXhtml(b.runs)}</h${Math.min(6, b.level + 1)}>`);
    else if (b.t === 'p') out.push(`<p>${runsXhtml(b.runs)}</p>`);
    else if (b.t === 'quote') out.push(`<blockquote><p>${runsXhtml(b.runs)}</p></blockquote>`);
    else if (b.t === 'code') out.push(`<pre><code>${xesc(b.text)}</code></pre>`);
    else if (b.t === 'hr') out.push('<hr/>');
  }
  endList();
  return out.join('\n');
}

// ── blocks → WordprocessingML (DOCX) ──────────────────────────────────
// Styles named here are defined in docx-export.js's styles.xml. A list item
// is a paragraph with its bullet or number written in and a hanging indent —
// the one list shape every word processor shows the same without a
// numbering part.
function runsDocx(runs, ctx) {
  return runs.map((r) => {
    if (r.br) return '<w:r><w:br/></w:r>';
    const pr = [r.b && '<w:b/>', r.i && '<w:i/>', r.u && '<w:u w:val="single"/>', r.s && '<w:strike/>',
      r.code && '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>',
      r.href && '<w:color w:val="0563C1"/><w:u w:val="single"/>'].filter(Boolean).join('');
    const run = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${xesc(r.text)}</w:t></w:r>`;
    return r.href && ctx ? `<w:hyperlink r:id="${ctx.link(r.href)}">${run}</w:hyperlink>` : run;
  }).join('');
}

const para = (style, body, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>${body}</w:p>`;

function toDocx(blocks, ctx) {
  return blocks.map((b) => {
    if (b.t === 'h') return para(`Heading${Math.min(3, b.level + 1)}`, runsDocx(b.runs, ctx));
    if (b.t === 'p') return para('', runsDocx(b.runs, ctx));
    if (b.t === 'quote') return para('Quote', runsDocx(b.runs, ctx));
    if (b.t === 'li') {
      const left = 360 * (b.depth + 1);
      const mark = b.ordered ? `${b.n}.` : ['•', '◦', '▪'][b.depth % 3];
      return para('', `<w:r><w:t xml:space="preserve">${mark}\t</w:t></w:r>${runsDocx(b.runs, ctx)}`,
        `<w:tabs><w:tab w:val="left" w:pos="${left}"/></w:tabs><w:ind w:left="${left}" w:hanging="360"/>`);
    }
    if (b.t === 'code') {
      return b.text.split('\n').map((l) => para('Code', `<w:r><w:t xml:space="preserve">${xesc(l)}</w:t></w:r>`)).join('');
    }
    if (b.t === 'hr') return para('', '', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>');
    if (b.t === 'pagebreak') return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    return '';
  }).join('');
}

module.exports = { fromMarkdown, fromHtml, toBlocks, toXhtml, toDocx, runsDocx, xesc, decode };
