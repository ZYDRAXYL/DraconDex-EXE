'use strict';
// ═══ The genre bundles, from DraconDex-SDB (Procress 12 part 0) ══════════
// templates/bundles.json is VENDORED from DraconDex-SDB (templates/, see its
// README) — do not hand-edit it here; `npm run sdb:vendor` replaces it. The
// phone reads the same file, so a bundle is the same project on both.
//
// Each user-visible string in it is { t: key } (or { t, suffix }), with the
// words for all 18 locales in `strings`. bundleCatalog() resolves them in
// the UI language — English when a locale lacks one, never the raw key — so
// what createBundle (db/bundle.js) makes is named in the user's language.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'templates', 'bundles.json');
let _cache = null;
function load() {
  if (!_cache) _cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return _cache;
}

const isT = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.t === 'string'
  && Object.keys(v).every((k) => k === 't' || k === 'suffix');

function resolve(v, strings, locale) {
  if (isT(v)) {
    const s = strings[v.t] || {};
    return (s[locale] ?? s.en ?? v.t) + (v.suffix || '');
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, strings, locale));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = resolve(x, strings, locale);
    return o;
  }
  return v;
}

// → [{ id, icon, name, description, spec }], every string in `locale`.
// bundles.json v2 (SDB 2.0.5, APP docs/TEMPLATES.md §4) adds `group`
// (classic | genre), folders, pages and samples — createBundle reads them;
// v1 had none of them, so both read the same way here.
function bundleCatalog(locale = 'en') {
  const { bundles, strings } = load();
  return [...bundles].sort((a, b) => (a.order ?? 99) - (b.order ?? 99)).map((b) => resolve(b, strings, locale));
}

module.exports = { bundleCatalog, resolve, isT };
