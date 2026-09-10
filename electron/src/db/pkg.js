'use strict';
// Packages — themes, locales and view presets fetched from
// ZYDRAXYL/DraconDex-PKG's releases and installed into this machine's app.ddx.
//
// Why this lives in main and not the renderer: electron/index.html sets
// `connect-src 'none'`, so the renderer cannot fetch anything at all, and
// `style-src 'self'` means a downloaded stylesheet could not be <link>ed even
// if it could be fetched. Both are deliberate (see the comment above the CSP).
// So the network happens here, and a theme reaches the UI as inline CSS
// variables on <body> — the path applyUiSettings() already uses for user-made
// custom themes.
//
// Why the release DOWNLOAD url and not api.github.com: anonymous API requests
// are capped at 60/hour per IP. Fine for one person, not fine for an office
// behind one NAT, and this is a path every install hits. The catalog is one
// static asset served by the same CDN that serves the payloads.
//
// The fetch/validate/rollback shape follows plugin.js deliberately — same
// buffer-then-write discipline, same "no zip, no git, no octokit" rule. This
// app has one runtime dependency and this feature does not add a second.

const { getAppDB } = require('./core');

const PKG_REPO = 'ZYDRAXYL/DraconDex-PKG';

// In dev, DRACONDEX_PKG_BASE points the fetch at a local catalog so the install
// path can be driven end-to-end without publishing a release — same shape and
// same reason as main.js's DRACONDEX_DATA_DIR.
//
// Gated on !app.isPackaged deliberately: a shipped build ignores the variable
// entirely, so it can never be used to point a real user's app at another host.
const RELEASE_BASE = (!require('electron').app.isPackaged && process.env.DRACONDEX_PKG_BASE)
  || `https://github.com/${PKG_REPO}/releases`;
const CATALOG_TIMEOUT_MS = 15000;
const PAYLOAD_TIMEOUT_MS = 30000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const KINDS = new Set(['theme', 'lang', 'view']);

// Must match DraconDex-PKG's tools/build-packages.mjs. Duplicated rather than
// shared because the app cannot read that repo at runtime — but the app is the
// side that must not be fooled, so it re-validates everything the catalog says
// rather than trusting it.
const THEME_TOKENS = new Set(['--bg','--surface','--raised','--hover','--border',
  '--t1','--t2','--t3','--accent','--accentH','--danger','--success',
  '--button','--on-accent','--on-button']);
const THEME_REQUIRED = ['--bg','--surface','--raised','--hover','--border',
  '--t1','--t2','--t3','--accent','--accentH','--danger','--success'];
const VIEW_SETTINGS = new Set(['size','fontScale','animationsEnabled','animationSpeed',
  'workspaceStyle','navOrientation','navHorizontalDisplay','navVerticalAlwaysLabel',
  'nameMode','nestShowItems','nestShowMajorIcon','nestShowMinorIcon','nestSignatureMode','dragonView']);

const CSS_VALUE = /^[#a-zA-Z0-9\s(),.%/-]{1,80}$/;

function assetUrl(release, asset) {
  // Every URL this module fetches is built here from an allowlisted shape.
  // Nothing downstream ever passes a URL in — a catalog that could name its own
  // download host would be a catalog that could point the app anywhere.
  return `${RELEASE_BASE}/download/${encodeURIComponent(release)}/${encodeURIComponent(asset)}`;
}

async function fetchJson(url, timeout, maxBytes) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(timeout) }); }
  catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: res.status === 404 ? 'not_found' : 'http', error: `HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) return { ok: false, code: 'too_large', error: `exceeds ${maxBytes} bytes` };
  try { return { ok: true, json: JSON.parse(buf.toString('utf8')), raw: buf }; }
  catch (e) { return { ok: false, code: 'bad_json', error: String(e?.message || e) }; }
}

function sha256(buf) {
  return require('node:crypto').createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Validation. The catalog is remote content: everything it claims is re-checked
// here before anything is written.
// ---------------------------------------------------------------------------
function validateEntry(e) {
  if (!e || typeof e !== 'object') return 'entry is not an object';
  // Mixed case is required, not tolerated: theme ids carry the app's own
  // camelCase theme names (clearAurora, atDusk, afterSunset), which come
  // straight from UI_THEME_OPTIONS. A lowercase-only rule silently dropped
  // them from the catalog and refused the install.
  if (typeof e.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(e.id)) return 'bad id';
  if (!KINDS.has(e.kind)) return `unknown kind "${e.kind}"`;
  if (typeof e.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(e.version)) return 'bad version';
  if (typeof e.asset !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(e.asset)) return 'bad asset name';
  if (typeof e.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(e.sha256)) return 'bad sha256';
  if (!e.displayName?.en || !e.displayName?.th) return 'displayName needs en and th';
  if (!Array.isArray(e.targets) || !e.targets.includes('exe')) return 'not targeted at exe';
  return null;
}

function validatePayload(kind, payload) {
  if (!payload || typeof payload !== 'object') return 'payload is not an object';
  if (kind === 'theme') {
    const vars = payload.vars;
    if (!vars || typeof vars !== 'object') return 'theme has no vars';
    for (const [k, v] of Object.entries(vars)) {
      if (!THEME_TOKENS.has(k)) return `unknown palette token "${k}"`;
      // These go straight into an inline style declaration. Anything outside a
      // colour-ish literal — a url(), a closing brace, a semicolon — has no
      // business in a palette value and is refused rather than sanitised.
      if (typeof v !== 'string' || !CSS_VALUE.test(v)) return `unsafe value for "${k}"`;
    }
    for (const req of THEME_REQUIRED) if (!vars[req]) return `missing required token ${req}`;
  } else if (kind === 'lang') {
    if (typeof payload.locale !== 'string' || !/^[a-z]{2,8}$/.test(payload.locale)) return 'bad locale code';
    const keys = payload.keys;
    if (!keys || typeof keys !== 'object') return 'lang has no keys';
    const n = Object.keys(keys).length;
    if (n < 100) return `only ${n} keys — a locale should carry the full key set`;
    for (const v of Object.values(keys)) if (typeof v !== 'string') return 'every locale value must be a string';
  } else if (kind === 'view') {
    const s = payload.settings;
    if (!s || typeof s !== 'object') return 'view has no settings';
    for (const k of Object.keys(s)) if (!VIEW_SETTINGS.has(k)) return `"${k}" is not a settable UI setting`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Everything installed on this machine, newest first. Read at boot. */
function pkgList() {
  return getAppDB().prepare(
    `SELECT id, pkg_id, kind, name, version, display_json, payload_json,
            source_repo, source_release, source_asset, enabled, installed_at, updated_at
       FROM installed_package ORDER BY kind, name`
  ).all().map(r => ({
    ...r,
    enabled: !!r.enabled,
    display: safeParse(r.display_json, {}),
    payload: safeParse(r.payload_json, {}),
  }));
}

function safeParse(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

/** Fetch the catalog and mark what is already installed. Never writes. */
async function pkgCatalog(release) {
  const tag = typeof release === 'string' && /^pkg-v\d+\.\d+\.\d+$/.test(release) ? release : 'latest';
  const url = tag === 'latest'
    ? `${RELEASE_BASE}/latest/download/index.json`
    : assetUrl(tag, 'index.json');
  const r = await fetchJson(url, CATALOG_TIMEOUT_MS, MAX_PAYLOAD_BYTES);
  if (!r.ok) return r;

  const cat = r.json;
  if (cat?.repo !== PKG_REPO) return { ok: false, code: 'bad_catalog', error: 'catalog names a different repo' };
  if (!Array.isArray(cat.packages)) return { ok: false, code: 'bad_catalog', error: 'catalog has no packages array' };

  const installed = new Map(pkgList().map(p => [p.pkg_id, p]));
  const packages = [];
  for (const e of cat.packages) {
    const bad = validateEntry(e);
    // A malformed entry is skipped, not fatal: one bad package should not hide
    // the whole catalog from the user.
    if (bad) { console.error(`pkg: skipping catalog entry (${bad})`); continue; }
    const have = installed.get(e.id);
    packages.push({
      id: e.id, kind: e.kind, version: e.version, displayName: e.displayName,
      description: e.description || null, minAppVersion: e.minAppVersion || null,
      bytes: e.bytes || null,
      installedVersion: have ? have.version : null,
      updateAvailable: !!have && have.version !== e.version,
    });
  }
  return { ok: true, release: cat.release || tag, packages };
}

/** Download one package, verify it against the catalog, and install it. */
async function pkgInstall(pkgId, release) {
  if (typeof pkgId !== 'string') return { ok: false, code: 'bad_request' };

  const tag = typeof release === 'string' && /^pkg-v\d+\.\d+\.\d+$/.test(release) ? release : 'latest';
  const catUrl = tag === 'latest'
    ? `${RELEASE_BASE}/latest/download/index.json`
    : assetUrl(tag, 'index.json');
  const cat = await fetchJson(catUrl, CATALOG_TIMEOUT_MS, MAX_PAYLOAD_BYTES);
  if (!cat.ok) return cat;

  // Re-resolve from the catalog rather than trusting anything the renderer
  // passed beyond the id — the same rule pluginInstall follows.
  const entry = (cat.json.packages || []).find(e => e && e.id === pkgId);
  if (!entry) return { ok: false, code: 'not_found', error: `${pkgId} is not in the catalog` };
  const badEntry = validateEntry(entry);
  if (badEntry) return { ok: false, code: 'invalid', error: badEntry };

  const actualRelease = cat.json.release || tag;
  const got = await fetchJson(assetUrl(actualRelease, entry.asset), PAYLOAD_TIMEOUT_MS, MAX_PAYLOAD_BYTES);
  if (!got.ok) return got;

  // The integrity check that makes the whole thing safe to serve over plain
  // HTTPS from a CDN: the payload must hash to what the catalog said.
  const digest = sha256(got.raw);
  if (digest !== entry.sha256) {
    return { ok: false, code: 'checksum', error: `payload hash ${digest} does not match the catalog's ${entry.sha256}` };
  }

  const { meta, payload } = got.json || {};
  if (!meta || meta.id !== pkgId || meta.kind !== entry.kind || meta.version !== entry.version) {
    return { ok: false, code: 'invalid', error: 'payload metadata disagrees with the catalog entry' };
  }
  const badPayload = validatePayload(entry.kind, payload);
  if (badPayload) return { ok: false, code: 'invalid', error: badPayload };

  const db = getAppDB();
  try {
    db.exec('BEGIN');
    db.prepare(
      `INSERT INTO installed_package
         (pkg_id, kind, name, version, display_json, payload_json,
          source_repo, source_release, source_asset, source_sha256, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(pkg_id) DO UPDATE SET
         kind=excluded.kind, name=excluded.name, version=excluded.version,
         display_json=excluded.display_json, payload_json=excluded.payload_json,
         source_repo=excluded.source_repo, source_release=excluded.source_release,
         source_asset=excluded.source_asset, source_sha256=excluded.source_sha256,
         updated_at=datetime('now')`
    ).run(pkgId, entry.kind, meta.name || pkgId, entry.version,
          JSON.stringify(entry.displayName), JSON.stringify(payload),
          PKG_REPO, actualRelease, entry.asset, entry.sha256);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, code: 'db', error: String(e?.message || e) };
  }
  return { ok: true, id: pkgId, kind: entry.kind, version: entry.version };
}

function pkgUninstall(pkgId) {
  const r = getAppDB().prepare(`DELETE FROM installed_package WHERE pkg_id=?`).run(pkgId);
  return { ok: true, removed: r.changes > 0 };
}

function pkgSetEnabled(pkgId, enabled) {
  getAppDB().prepare(`UPDATE installed_package SET enabled=?, updated_at=datetime('now') WHERE pkg_id=?`)
    .run(enabled ? 1 : 0, pkgId);
  return { ok: true };
}

/**
 * What the renderer needs at boot to widen its theme and locale registries.
 * Deliberately a separate, cheap call from pkgList(): this one runs on every
 * start before first paint, and shipping the full payloads of every installed
 * locale (~55 KB each) through it would be paid on every launch.
 */
function pkgActive() {
  const rows = getAppDB().prepare(
    `SELECT pkg_id, kind, name, version, display_json, payload_json
       FROM installed_package WHERE enabled=1`
  ).all();
  const themes = [], langs = [], views = [];
  for (const r of rows) {
    const payload = safeParse(r.payload_json, null);
    if (!payload) continue;
    const display = safeParse(r.display_json, {});
    // Re-validate on the way out too. A row can only get here through
    // pkgInstall, but a payload that somehow became invalid on disk should
    // drop out of the registry rather than reach applyUiSettings().
    if (validatePayload(r.kind, payload)) continue;
    if (r.kind === 'theme') themes.push({ id: r.pkg_id, name: r.name, display, vars: payload.vars });
    else if (r.kind === 'lang') langs.push({ id: r.pkg_id, locale: payload.locale, label: payload.label || payload.locale, display, keys: payload.keys });
    else if (r.kind === 'view') views.push({ id: r.pkg_id, name: r.name, display, settings: payload.settings });
  }
  return { themes, langs, views };
}

module.exports = { pkgList, pkgCatalog, pkgInstall, pkgUninstall, pkgSetEnabled, pkgActive };
