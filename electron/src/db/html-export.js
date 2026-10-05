'use strict';
// ═══ Export as an HTML website (v5 Part 8, APP docs/V5.md §12.13) ═══════
// The user picks an INDEX page; the site is everything reachable from it
// within a chosen depth — its [[links]] (wiki_link), its relations
// (entity_relation), and what its components list (a module's elements, the
// modules a page borrows a view from; an element's own module). The
// renderer shows that list for the user to untick, renders each ticked page
// through the same components the app draws, and hands the HTML here.
//
// Here: the walk (collectPages) and the site (buildSite / exportHtmlSite).
// A link to a page that was not exported becomes plain text — the site has
// no dead links. There are no Secrets to leave out (V5.md §12.16: not
// chosen), so the list the user ticks is the only filter; the export modal
// says so.
const { getDB } = require('./core');
const wiki = require('./wiki');
const { writeZip } = require('./zip');
const { mediaForSite, rewriteMedia, mediaBytes } = require('./export-media');
const fsx = require('fs');
const pathx = require('path');

// Keys that have a page: a module, and the elements with element pages
// (renderer ITEM_KIND entries with a keyOf).
const PAGE_KEY = /^(module|cobj|tlev|bchp|chss)_(\d+)$/;
const MAX_PAGES = 500;
const MAX_DEPTH = 6;

const OWNER_SQL = {
  cobj: `SELECT module_ref AS m FROM classifier_object WHERE id=?`,
  tlev: `SELECT tl.module_ref AS m FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id WHERE te.id=?`,
  bchp: `SELECT module_ref AS m FROM book_chapter WHERE id=?`,
  chss: `SELECT module_ref AS m FROM chat_session WHERE id=?`,
};

// The module a page belongs to (itself, for a module), in this Nexus — or
// null: no such row, a collector (no page), or another vault's.
function pageModule(d, nexusId, key) {
  const m = PAGE_KEY.exec(String(key || ''));
  if (!m) return null;
  const id = Number(m[2]);
  const mid = m[1] === 'module' ? id : d.prepare(OWNER_SQL[m[1]]).get(id)?.m;
  if (mid == null) return null;
  const row = d.prepare(`SELECT id, kind, nexus_ref FROM module WHERE id=?`).get(mid);
  return row && row.nexus_ref === nexusId && row.kind !== 'collector' ? row.id : null;
}

// Everything one click away from a page.
function neighbours(d, nexusId, key) {
  const out = new Set();
  for (const r of d.prepare(`SELECT target_key FROM wiki_link WHERE src_key=? AND target_key IS NOT NULL`).all(key)) out.add(r.target_key);
  for (const r of d.prepare(`SELECT to_key AS k FROM entity_relation WHERE nexus_ref=? AND from_key=?
    UNION SELECT from_key AS k FROM entity_relation WHERE nexus_ref=? AND to_key=?`).all(nexusId, key, nexusId, key)) out.add(r.k);
  const m = PAGE_KEY.exec(key);
  if (m && m[1] === 'module') {
    const id = Number(m[2]);
    for (const r of d.prepare(`SELECT id FROM classifier_object WHERE module_ref=?`).all(id)) out.add(`cobj_${r.id}`);
    for (const r of d.prepare(`SELECT te.id FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id WHERE tl.module_ref=?`).all(id)) out.add(`tlev_${r.id}`);
    for (const r of d.prepare(`SELECT id FROM book_chapter WHERE module_ref=?`).all(id)) out.add(`bchp_${r.id}`);
    for (const r of d.prepare(`SELECT id FROM chat_session WHERE module_ref=?`).all(id)) out.add(`chss_${r.id}`);
    for (const r of d.prepare(`SELECT DISTINCT source_key FROM page_block WHERE module_ref=? AND source_key IS NOT NULL`).all(id)) out.add(r.source_key);
    // A Manager's selection is on its page as rows that open each module.
    try {
      const ui = d.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='managerPicks'`).get(id);
      for (const p of JSON.parse(ui?.ui_value || '[]')) out.add(`module_${Number(p)}`);
    } catch (_) {}
  } else if (m) {
    const owner = pageModule(d, nexusId, key);
    if (owner != null) out.add(`module_${owner}`);
  }
  return out;
}

// Breadth first from the index page. → [{ key, name, depth, moduleId }],
// index first, then by depth.
function collectPages(nexusId, indexKey, depth = 2) {
  const d = getDB();
  const maxDepth = Math.max(0, Math.min(MAX_DEPTH, Math.trunc(Number(depth) || 0)));
  if (pageModule(d, nexusId, indexKey) == null) return [];
  const seen = new Map([[indexKey, 0]]);
  let frontier = [indexKey];
  for (let level = 1; level <= maxDepth && frontier.length && seen.size < MAX_PAGES; level++) {
    const next = [];
    for (const k of frontier) {
      for (const n of neighbours(d, nexusId, k)) {
        if (seen.has(n) || seen.size >= MAX_PAGES || pageModule(d, nexusId, n) == null) continue;
        seen.set(n, level);
        next.push(n);
      }
    }
    frontier = next;
  }
  const keys = [...seen.keys()];
  const names = new Map(wiki.resolveEntityKeys(keys).map((e) => [e.key, e.name]));
  return keys.map((key) => ({ key, name: names.get(key) || key, depth: seen.get(key), moduleId: pageModule(d, nexusId, key) }));
}

// ── the site ────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fileOf = (key, indexKey) => (key === indexKey ? 'index.html' : `${key}.html`);

// Every <a … data-key="K">…</a> the renderer left: a link when K was
// exported, its text when not. hrefOf: where K lives (a file of the site;
// an anchor in the one PDF document).
function rewriteLinks(html, exported, indexKey, hrefOf = (key) => fileOf(key, indexKey)) {
  return String(html || '').replace(/<a\b([^>]*?)\bdata-key="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_, pre, key, post, inner) => (
    exported.has(key)
      ? `<a class="xl" href="${esc(hrefOf(key))}">${inner}</a>`
      : `<span class="xl-text">${inner}</span>`));
}

// Procress 16 part 6 — the user's CSS goes through this before it reaches
// a page: no markup (a </style> could open a <script>), no @import, no
// url() but the site's own media/ and img/ files, no old-IE script hooks.
// What is left is plain CSS: it can restyle a page, never run or fetch.
const MAX_CSS = 50000;
function sanitizeCss(css) {
  let s = String(css || '').slice(0, MAX_CSS);
  s = s.replace(/<[^>]*>?/g, '');                          // tags, </style>, <script
  s = s.replace(/@import[^;]*;?/gi, '');
  s = s.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, q, u) => (/^(media|img)\/[\w.-]+$/.test(u.trim()) ? `url("${u.trim()}")` : 'none'));
  s = s.replace(/expression\s*\(|javascript:|behavior\s*:|-moz-binding/gi, '');
  return s;
}

function pageShell(title, siteTitle, body, menu, o = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — ${esc(siteTitle)}</title><link rel="stylesheet" href="style.css">${o.favicon ? `<link rel="icon" href="${esc(o.favicon)}">` : ''}
${o.css ? `<style>${o.css}</style>` : ''}</head>
<body class="ddx-site"><header class="site-head"><a href="index.html">${esc(siteTitle)}</a></header>
${menu ? `<nav class="site-menu">${menu}</nav>` : ''}<main class="site-page">${body}</main>
${o.search ? '<script src="search-index.js"></script><script src="site.js"></script>' : ''}</body></html>`;
}

// A menu shaped like the Nest: payload.nav = [{ key, name, children }],
// exported pages only (a folder with none under it goes), the open page marked.
function navHtml(nav, exported, here, hrefOf) {
  const walk = (list) => {
    const items = (list || []).map((n) => {
      const kids = walk(n.children);
      const self = exported.has(n.key) ? `<a href="${esc(hrefOf(n.key))}"${n.key === here ? ' aria-current="page"' : ''}>${esc(n.name)}</a>` : (kids ? `<span>${esc(n.name)}</span>` : '');
      return self ? `<li>${self}${kids}</li>` : '';
    }).join('');
    return items ? `<ul>${items}</ul>` : '';
  };
  return walk(nav);
}

// The site's own script — not the user's (they write CSS only): it runs the
// search boxes against search-index.js, which a file:// page can load.
const SITE_JS = `(function(){var D=window.DDX_SEARCH||[];
document.querySelectorAll('.pc-search').forEach(function(box){var inp=box.querySelector('input');var res=box.querySelector('.pc-search-res');if(!inp||!res)return;
function go(){var q=inp.value.trim().toLowerCase();res.innerHTML='';if(q.length<2)return;
D.filter(function(p){return p.t.toLowerCase().indexOf(q)>=0||p.x.toLowerCase().indexOf(q)>=0;}).slice(0,12).forEach(function(p){
var a=document.createElement('a');a.className='pc-search-hit';a.href=p.h;var b=document.createElement('span');b.textContent=p.t;a.appendChild(b);
var i=p.x.toLowerCase().indexOf(q);if(i>=0){var s=document.createElement('small');s.textContent=(i>30?'…':'')+p.x.slice(Math.max(0,i-30),i+60)+'…';a.appendChild(s);}res.appendChild(a);});}
inp.addEventListener('input',go);inp.addEventListener('keydown',function(e){if(e.key==='Enter'){var a=res.querySelector('a');if(a)location.href=a.href;}});});})();`;

const README = (title) => `${title} — a website made by DraconDex

Open index.html in a browser to read it here.

To put it online (free):
  Netlify      app.netlify.com/drop — drag this whole folder (or the .zip) onto the page.
  GitHub Pages make a repository, upload these files, then Settings → Pages → Deploy from branch.
Any static web host works: upload the files as they are; index.html is the front page.
`;

// payload: { title, indexKey, css, pages: [{ key, name, html }], images: [{ name, base64 }] }
// → zip entries. The index page carries the site's menu: every page.
// Canvases arrive rendered (img/N.png); the Nexus's own pictures are read
// here, from the vault's files, into media/ (export-media.js).
// payload, Procress 16 part 6 additions: siteCss (sanitized), pageCss
// { key: css }, nav (the Nest-shaped menu, on every page), favicon (a file
// id of this Nexus), search (write the index + site.js).
function buildSite(payload, nexusId = null) {
  const pages = (payload?.pages || []).filter((p) => PAGE_KEY.test(p.key));
  const indexKey = payload?.indexKey;
  if (!pages.some((p) => p.key === indexKey)) return { ok: false, code: 'no_index' };
  const exported = new Set(pages.map((p) => p.key));
  const siteTitle = payload.title || pages.find((p) => p.key === indexKey).name;
  const hrefOf = (key) => fileOf(key, indexKey);
  const flatMenu = `<ul>${pages.filter((p) => p.key !== indexKey)
    .map((p) => `<li><a href="${esc(hrefOf(p.key))}">${esc(p.name)}</a></li>`).join('')}</ul>`;
  const media = nexusId == null ? { entries: [], urls: new Map(), missing: 0 } : mediaForSite(pages.map((p) => p.html), nexusId);
  let favicon = null;
  if (payload.favicon != null && nexusId != null) {
    const b = mediaBytes(Number(payload.favicon));
    if (b) { favicon = `favicon.${b.ext}`; media.entries.push({ name: favicon, data: b.data }); }
  }
  const search = !!payload.search;
  const entries = pages.map((p) => {
    const html = rewriteLinks(rewriteMedia(p.html, nexusId, media.urls), exported, indexKey);
    const menu = Array.isArray(payload.nav) ? navHtml(payload.nav, exported, p.key, hrefOf) : (p.key === indexKey ? flatMenu : '');
    const css = sanitizeCss(payload.pageCss?.[p.key] || '');
    return { name: hrefOf(p.key), data: pageShell(p.name, siteTitle, html, menu, { favicon, css, search }), text: html };
  });
  if (search) {
    const text = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000);
    const index = pages.map((p, i) => ({ h: hrefOf(p.key), t: p.name, x: text(entries[i].text) }));
    entries.push({ name: 'search-index.js', data: `window.DDX_SEARCH=${JSON.stringify(index).replace(/</g, '\\u003c')};` });
    entries.push({ name: 'site.js', data: SITE_JS });
  }
  for (const e of entries) delete e.text;
  entries.push(...media.entries);
  entries.push({ name: 'README.txt', data: README(siteTitle) });
  entries.push({ name: 'style.css', data: `${String(payload.css || '')}\n${sanitizeCss(payload.siteCss || '')}` });
  for (const img of payload.images || []) {
    if (!/^img\/[\w.-]+\.png$/.test(img.name)) continue;
    entries.push({ name: img.name, data: Buffer.from(String(img.base64 || ''), 'base64') });
  }
  return { ok: true, entries, media: media.entries.length, missing: media.missing };
}

// Procress 16 part 6: a folder as well as a zip — ready to drop on a host
function writeFolder(dir, entries) {
  try {
    fsx.mkdirSync(dir, { recursive: true });
    for (const e of entries) {
      const to = pathx.join(dir, ...String(e.name).split('/'));
      if (!to.startsWith(pathx.resolve(dir))) continue; // never outside the folder
      fsx.mkdirSync(pathx.dirname(to), { recursive: true });
      if (e.path) fsx.copyFileSync(e.path, to); else fsx.writeFileSync(to, e.data);
    }
    return { ok: true };
  } catch (err) { return { ok: false, code: 'write_failed', message: err.message }; }
}

function exportHtmlSite(outPath, payload, nexusId = null, { folder = false } = {}) {
  const site = buildSite(payload, nexusId);
  if (!site.ok) return site;
  const r = folder ? writeFolder(outPath, site.entries) : writeZip(outPath, site.entries);
  return r.ok ? { ok: true, pages: payload.pages.length, bytes: r.bytes, media: site.media, missing: site.missing, out: outPath, folder } : r;
}

module.exports = { collectPages, buildSite, exportHtmlSite, rewriteLinks, sanitizeCss, PAGE_KEY };
