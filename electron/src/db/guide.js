'use strict';
// ═══ The in-app guide (v5 Part 7, APP docs/V5.md §11.8) ═════════════════
// The guide is a bundle (db/bundle.js) with real content — one example
// module per kind and a "Start here" page that [[links]] to every one —
// made as ordinary user data the user opens, edits and deletes (Notion's
// Getting Started pattern, the user's call). It is created once, in the
// first Nexus, when the "show me around" box is ticked; later from the
// template picker or the palette. The app never rewrites it: a newer guide
// is offered as a new folder, never merged into the user's copy.
//
// Where a locale's guide comes from, first match wins:
//   1. an installed + enabled PKG package of kind 'guide' for that locale
//   2. electron/guide/<locale>.json — Thai and English ship with the app
//   3. English, marked `fallback` so the UI can offer the download
const fs = require('fs');
const path = require('path');
const { getAppDB } = require('./core');

const GUIDE_DIR = path.join(__dirname, '..', '..', 'guide');
const GUIDE_KINDS = new Set(['manager', 'inspector', 'classifier', 'locator', 'chronicler', 'wanderer', 'narrator',
  'author', 'scribe', 'drafter', 'exhibitor', 'sketcher', 'designer', 'diviner']);

// Shared with db/pkg.js: a guide payload that names a kind this app does not
// have would build a folder of broken modules, so it is refused whole.
function validateGuide(p) {
  if (!p || typeof p !== 'object') return 'guide is not an object';
  if (p.format !== 'ddx-guide') return 'not a ddx-guide';
  if (typeof p.locale !== 'string' || !/^[a-z]{2,8}$/.test(p.locale)) return 'bad locale code';
  const s = p.spec;
  if (!s || typeof s.name !== 'string' || !s.name.trim()) return 'guide spec has no name';
  if (!Array.isArray(s.modules) || !s.modules.length || s.modules.length > 60) return 'guide spec needs 1–60 modules';
  for (const m of s.modules) {
    if (!GUIDE_KINDS.has(m?.kind)) return `unknown module kind "${m?.kind}"`;
    if (typeof m.name !== 'string' || !m.name.trim()) return 'a module has no name';
  }
  return null;
}

function readBundled(locale) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(GUIDE_DIR, `${locale}.json`), 'utf8'));
    return validateGuide(p) ? null : p;
  } catch (_) { return null; }
}

function readInstalled(locale) {
  try {
    for (const r of getAppDB().prepare(`SELECT payload_json FROM installed_package WHERE kind='guide' AND enabled=1`).all()) {
      const p = JSON.parse(r.payload_json);
      if (!validateGuide(p) && p.locale === locale) return p;
    }
  } catch (_) {}
  return null;
}

function guideSpec(locale) {
  const loc = String(locale || 'en').toLowerCase();
  const hit = readInstalled(loc) || readBundled(loc);
  if (hit) return { ok: true, locale: loc, version: hit.version ?? 1, spec: hit.spec, fallback: false };
  const en = readBundled('en');
  if (!en) return { ok: false, code: 'no_guide' };
  return { ok: true, locale: 'en', version: en.version ?? 1, spec: en.spec, fallback: loc !== 'en' };
}

module.exports = { guideSpec, validateGuide };
