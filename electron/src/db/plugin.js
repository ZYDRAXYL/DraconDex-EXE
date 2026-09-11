'use strict';
// Plugins (renamed from "Github Extensions" in v4.2.0): download a plugin from
// a git repo URL, each declaring its own DB table(s) via a manifest. This file
// owns the DATA side only — repo resolution, install/uninstall, and the
// pluginApi.* query functions a sandboxed plugin window is allowed to call.
// Window creation/lifecycle (the actual sandboxing) is main.js's job, same as
// every other window in this app — see docs/PLUGINS.md for the full
// architecture and the security notes on what this design does and does NOT
// protect against.
//
// Identifier safety is the whole security boundary at this layer: no
// prepared-statement parameter can bind a table/column name, so every dynamic
// SQL identifier used here is checked against a strict whitelist regex (all of
// them live in ./plugin-manifest.js) before it ever reaches a query string —
// never a renderer/plugin-supplied string used directly. table_name in
// plugin_table is the ONLY identifier pluginApi ever resolves at runtime,
// always via a ?-bound lookup on (plugin_ref, local_name), never reconstructed
// by concatenation.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { getAppDB } = require('./core');
const {
  PLUGIN_TABLE_RE, FULL_TABLE_RE, MAX_FILE_BYTES,
  MANIFEST_NAMES, REF_CANDIDATES, isTemplateRepoName,
  validateManifest, parseRepoUrl, rawUrl,
  manifestPanels, manifestNetOrigins, manifestContextKinds, manifestDependencies, netOriginAllowed,
} = require('./plugin-manifest');

const dataRoot = () => path.dirname(app.getPath('userData'));
const pluginsRoot = () => path.join(dataRoot(), 'plugins');
const pluginDir = (pluginKey) => path.join(pluginsRoot(), pluginKey);

// One-time on-disk move for databases installed before the v4.2.0 rename —
// the DB half is handled by migratePluginV42() in schema/migrations.js. Called
// once from main.js at app.whenReady(); never throws (a failed move just means
// pre-rename plugins won't launch until reinstalled).
function migratePluginDir() {
  try {
    const oldDir = path.join(dataRoot(), 'extensions');
    if (fs.existsSync(oldDir) && !fs.existsSync(pluginsRoot())) fs.renameSync(oldDir, pluginsRoot());
  } catch (e) { console.error('plugin dir migration error:', e); }
}

// ---------------------------------------------------------------------------
// Download — one raw file at a time over global fetch(), buffer-then-write
// (matches drive.js's existing pattern exactly). No zip, no git, no octokit:
// this app has exactly one runtime dependency and this feature does not add
// a second. See docs/PLUGINS.md §2.5.
// ---------------------------------------------------------------------------
async function fetchText(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(15000) }); }
  catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: 'not_found', error: `HTTP ${res.status}` };
  return { ok: true, text: await res.text() };
}

async function fetchBuffer(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); }
  catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: 'not_found', error: `HTTP ${res.status}` };
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES) return { ok: false, code: 'too_large', error: `exceeds ${MAX_FILE_BYTES} bytes` };
  return { ok: true, buffer };
}

// A repo opts into the recommend list below by carrying this file at its
// root (docs/PLUGINS.md, DraconDex-PGI-Template's README) — it is not
// part of the install flow and is never fetched by resolveRepo/pluginInstall,
// only checked for existence here. Any fetch failure (network, rate limit,
// 404) is treated as "not a plugin repo" — fail closed, matching the rest of
// this function's silent-advisory behavior.
async function repoHasDracondexMarker(repoName) {
  try {
    const res = await fetch(`https://api.github.com/repos/ZYDRAXYL/${encodeURIComponent(repoName)}/contents/.dracondex`, {
      headers: { 'User-Agent': 'DraconDex', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch (e) { return false; }
}

// Plan part2 #5 — default "install from @ZYDRAXYL" list on the Plugin page, so
// a user doesn't need to already have a repo URL in hand. Read-only and
// advisory: on any failure the renderer just shows nothing rather than an
// error toast, same as the silent auto-preview-on-type path below. Unlike
// fetchText/fetchBuffer above, api.github.com (unlike raw.githubusercontent.com)
// rejects requests with no User-Agent header, so this sets one explicitly.
// The /users/:name/repos endpoint lists public repos for both org and user
// accounts, so there's no need to know which kind of account ZYDRAXYL is.
//
// Process 1 part 2 — narrowed to repos that actually carry a `.dracondex`
// marker file at their root (repoHasDracondexMarker above), and the template
// repos are excluded by name unconditionally (isTemplateRepoName): they carry
// the marker too, on purpose, so that a repo made from one already opts in —
// which is why the marker cannot be what filters them back out. Recommending
// a template back to the user would be nonsensical.
async function pluginListOrgRepos() {
  let res;
  try {
    res = await fetch('https://api.github.com/users/ZYDRAXYL/repos?per_page=100&sort=updated', {
      headers: { 'User-Agent': 'DraconDex', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { ok: false }; }
  if (!res.ok) return { ok: false };
  let repos;
  try { repos = await res.json(); } catch (e) { return { ok: false }; }
  if (!Array.isArray(repos)) return { ok: false };
  const candidates = repos.filter((repo) =>
    !repo.is_template && !repo.archived && !isTemplateRepoName(repo.name));
  const marked = await Promise.all(candidates.map((repo) => repoHasDracondexMarker(repo.name)));
  return {
    ok: true,
    repos: candidates
      .filter((_, i) => marked[i])
      .map((repo) => ({ name: repo.name, description: repo.description || '', url: repo.clone_url, stars: repo.stargazers_count || 0 })),
  };
}

// Turns one pasted URL into a concrete {host,owner,repo,ref} + parsed manifest.
// When the URL names no branch we try REF_CANDIDATES (main, then master) and,
// per ref, both manifest filenames — so "paste the .git link" works without the
// user knowing either. A network failure is reported as `network`, not
// `no_manifest`, so the UI can tell "wrong repo" from "no internet".
async function resolveRepo(url) {
  const parsed = parseRepoUrl(url);
  if (!parsed.ok) return { ok: false, code: parsed.code };

  const refs = parsed.ref ? [parsed.ref] : REF_CANDIDATES;
  let sawNetworkError = null;
  for (const ref of refs) {
    const repoRef = { host: parsed.host, owner: parsed.owner, repo: parsed.repo, ref };
    for (const manifestName of MANIFEST_NAMES) {
      const res = await fetchText(rawUrl(repoRef, manifestName));
      if (res.ok) {
        let manifest;
        try { manifest = JSON.parse(res.text); }
        catch (_) { return { ok: false, code: 'bad_manifest', error: 'manifest is not valid JSON' }; }
        return { ok: true, ...repoRef, manifestName, manifest };
      }
      if (res.code === 'network') sawNetworkError = res.error;
    }
  }
  return sawNetworkError
    ? { ok: false, code: 'network', error: sawNetworkError }
    : { ok: false, code: 'no_manifest' };
}

// Resolves one dependency URL to a preview-shaped summary, for the "also
// installs" block on the preview card. Never rejects — a dependency that
// fails to resolve is reported as its own { ok:false } entry so the rest of
// the preview still renders; pluginInstall is what actually enforces it.
async function previewDependency(depUrl, selfId) {
  const depR = await resolveRepo(depUrl);
  if (!depR.ok) return { url: depUrl, ok: false, code: depR.code };
  const valid = validateManifest(depR.manifest);
  if (!valid.ok) return { url: depUrl, ok: false, code: 'bad_manifest' };
  if (depR.manifest.id === selfId) return { url: depUrl, ok: false, code: 'self_dependency' };

  const installed = getAppDB().prepare(`SELECT id FROM plugin WHERE plugin_key=?`).get(depR.manifest.id);
  return {
    url: depUrl, ok: true,
    id: depR.manifest.id, name: depR.manifest.name, version: depR.manifest.version || null,
    alreadyInstalled: !!installed,
  };
}

// Read-only dry run behind the "paste a link" field: resolve + validate and
// report exactly what installing would create, WITHOUT touching disk or the DB.
// The renderer shows this for confirmation only — pluginInstall() below never
// trusts any of it and re-resolves everything itself.
async function pluginPreview(url) {
  const r = await resolveRepo(url);
  if (!r.ok) return r;

  const valid = validateManifest(r.manifest);
  if (!valid.ok) return { ok: false, code: 'bad_manifest', error: valid.error };

  const installed = getAppDB().prepare(`SELECT id FROM plugin WHERE plugin_key=?`).get(r.manifest.id);
  const dependencies = [];
  for (const depUrl of manifestDependencies(r.manifest)) {
    dependencies.push(await previewDependency(depUrl, r.manifest.id));
  }

  return {
    ok: true,
    url: String(url || '').trim(),
    host: r.host, owner: r.owner, repo: r.repo, ref: r.ref,
    manifestName: r.manifestName,
    alreadyInstalled: !!installed,
    manifest: {
      id: r.manifest.id, name: r.manifest.name, version: r.manifest.version || null,
      entry: r.manifest.entry, files: r.manifest.files,
      tables: (r.manifest.tables || []).map((t) => ({ name: t.name, columns: t.columns })),
      // v4.3.0 — surfaced so the preview card can warn about the two things
      // that are NOT just "files and tables": a panel embeds the plugin's page
      // inside the main window, and netOrigins is outbound network access the
      // plugin gets through pluginApi.net.*. Shown before install, by design.
      panels: manifestPanels(r.manifest),
      netOrigins: manifestNetOrigins(r.manifest),
      contextKinds: manifestContextKinds(r.manifest),
      // v4.8.0 — other plugins this one will pull in alongside itself. Each
      // entry already carries whether it's installed yet, so the preview card
      // can say "already have it" instead of a bare list of names.
      dependencies,
    },
  };
}

// Fetches every file a resolved+validated manifest declares and writes the
// plugin's files + DB rows as one unit. Shared by pluginInstall (the plugin
// the user asked for) and installDependencyIfMissing (a manifest-declared
// dependency of it) so both go through the exact same fetch/write/cleanup
// path — a dependency is a real, independently-valid plugin install, not a
// special case.
async function installResolvedPlugin(host, owner, repo, ref, manifest, deps = []) {
  const db = getAppDB();

  // Fetch every declared file fully into memory before writing anything.
  const fileBuffers = {};
  for (const relPath of manifest.files) {
    const res = await fetchBuffer(rawUrl({ host, owner, repo, ref }, relPath));
    if (!res.ok) return { ok: false, code: res.code === 'not_found' ? 'missing_file' : res.code, error: `${relPath}: ${res.error}` };
    fileBuffers[relPath] = res.buffer;
  }

  const dir = pluginDir(manifest.id);
  try {
    for (const [relPath, buf] of Object.entries(fileBuffers)) {
      const target = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
    }

    db.transaction(() => {
      const res = db.prepare(`
        INSERT INTO plugin (plugin_key, name, version, repo_host, repo_owner, repo_name, repo_ref, entry_html, manifest_json)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(manifest.id, manifest.name, manifest.version || null, host, owner, repo, ref, manifest.entry, JSON.stringify(manifest));
      const pluginRowId = res.lastInsertRowid;

      for (const t of manifest.tables || []) {
        const tableName = `plg_${manifest.id}_${t.name}`;
        if (!FULL_TABLE_RE.test(tableName)) throw new Error(`invalid composed table name: ${tableName}`);
        const colDefs = t.columns.map((c) => `${c.name} ${String(c.type).toUpperCase()}`).join(', ');
        // Dynamic DDL via prepare().run(), matching the exact convention
        // migrations.js already uses for ALTER TABLE — never db.exec() from
        // outside conn.js/schema/*.
        db.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${colDefs})`).run();
        db.prepare(`
          INSERT INTO plugin_table (plugin_ref, local_name, table_name, columns_json)
          VALUES (?,?,?,?)
        `).run(pluginRowId, t.name, tableName, JSON.stringify(t.columns));
      }

      // Written in the same transaction as the plugin row so a plugin can
      // never exist without its dependency record — that record is what
      // pluginMissingDeps (and therefore the launch gate) reads.
      for (const d of deps) {
        db.prepare(`
          INSERT INTO plugin_dependency (plugin_ref, dep_url, dep_key, dep_name, fail_code)
          VALUES (?,?,?,?,?)
        `).run(pluginRowId, d.url, d.key || null, d.name || null, d.failCode || null);
      }
    })();
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, code: 'install_failed', error: String(e?.message || e) };
  }

  return { ok: true, pluginKey: manifest.id };
}

// Resolves + validates one manifest-declared dependency and installs it if no
// plugin with that id exists yet. Always resolves to the row shape stored in
// `plugin_dependency` — { url, key, name, failCode } — and never throws: a
// dependency that can't be resolved or installed is a recorded failure, not
// an aborted install (v4.9.0; before that a single bad dependency killed the
// whole install with `dependency_failed`).
//
// `failCode` null means "the dependency is present" — either it was already
// installed, or this call installed it. Anything else is why it isn't, and
// the settings row turns that into a Download button.
//
// A dependency that resolves to the SAME id as the plugin being installed is
// rejected rather than silently overwriting it — see previewDependency.
async function installDependency(depUrl, selfId) {
  const depR = await resolveRepo(depUrl);
  if (!depR.ok) return { url: depUrl, key: null, name: null, failCode: depR.code };
  const valid = validateManifest(depR.manifest);
  if (!valid.ok) return { url: depUrl, key: null, name: null, failCode: 'bad_manifest' };
  if (depR.manifest.id === selfId) return { url: depUrl, key: null, name: null, failCode: 'self_dependency' };

  const key = depR.manifest.id;
  const name = depR.manifest.name;
  if (getAppDB().prepare(`SELECT id FROM plugin WHERE plugin_key=?`).get(key)) {
    return { url: depUrl, key, name, failCode: null };
  }

  // One level deep, as before: the dependency's OWN dependencies are recorded
  // (so the user can see and fetch them) but never fetched here, which is what
  // keeps a dependency chain from resolving itself recursively.
  const nested = manifestDependencies(depR.manifest)
    .map((u) => ({ url: u, key: null, name: null, failCode: 'unresolved' }));
  const res = await installResolvedPlugin(depR.host, depR.owner, depR.repo, depR.ref, depR.manifest, nested);
  if (!res.ok) return { url: depUrl, key, name, failCode: res.code || 'install_failed' };
  return { url: depUrl, key, name, failCode: null };
}

// Takes the pasted URL and nothing else. Everything — repo coordinates, ref,
// manifest — is re-fetched and re-validated here; the preview above is a UI
// hint, never an input. This is the one trust boundary for the whole feature.
async function pluginInstall(url) {
  const r = await resolveRepo(url);
  if (!r.ok) return r;
  const { host, owner, repo, ref, manifest } = r;

  const valid = validateManifest(manifest);
  if (!valid.ok) return { ok: false, code: 'bad_manifest', error: valid.error };

  const db = getAppDB();
  if (db.prepare(`SELECT id FROM plugin WHERE plugin_key=?`).get(manifest.id)) {
    return { ok: false, code: 'already_installed' };
  }

  // Dependencies land first, each individually skipped if already installed —
  // so by the time the plugin the user actually asked for is written, every
  // plugin it declared as required is usually already there (the "auto pull
  // AI Native the first time an AI plugin installs" path).
  //
  // v4.9.0: a dependency that fails NO LONGER aborts this install. The
  // outcome of every dependency is recorded alongside the plugin instead, and
  // a plugin with an unmet dependency installs but cannot be launched until
  // the user fetches what it needs (pluginMissingDeps + the Download button in
  // the settings row). Aborting was worse in both directions: it blocked a
  // perfectly good plugin over a transient network failure, and it did nothing
  // at all for the case where a dependency is uninstalled later.
  const deps = [];
  for (const depUrl of manifestDependencies(manifest)) {
    deps.push(await installDependency(depUrl, manifest.id));
  }

  return installResolvedPlugin(host, owner, repo, ref, manifest, deps);
}

// The dependency rows this plugin still needs: either the URL never resolved
// (dep_key IS NULL) or it resolved to a plugin id that isn't installed right
// now — which also covers "the user uninstalled it afterwards", the case the
// install-time check alone could never catch. Pure local SQL, no network, so
// it is cheap enough to run on every list render and every launch.
function pluginMissingDeps(pluginRowId) {
  return getAppDB().prepare(`
    SELECT dep_url AS url, dep_key AS key, dep_name AS name, fail_code AS failCode
    FROM plugin_dependency
    WHERE plugin_ref=?
      AND (dep_key IS NULL OR dep_key NOT IN (SELECT plugin_key FROM plugin))
    ORDER BY id
  `).all(pluginRowId);
}

// Installs ONE recorded dependency on demand — what the Download button on a
// blocked plugin's row calls. The URL is not taken from the caller: it is
// looked up in plugin_dependency by (plugin_ref, dep_url), so the renderer
// cannot use this as a second, unvetted install door for an arbitrary repo.
// The resolution is written back, so a row that failed with `network` earlier
// becomes a proper key/name once it succeeds.
async function pluginInstallDependency(pluginRowId, depUrl) {
  const db = getAppDB();
  const self = db.prepare(`SELECT plugin_key FROM plugin WHERE id=?`).get(pluginRowId);
  if (!self) return { ok: false, code: 'not_found' };
  const row = db.prepare(`SELECT id, dep_url FROM plugin_dependency WHERE plugin_ref=? AND dep_url=?`)
    .get(pluginRowId, String(depUrl || ''));
  if (!row) return { ok: false, code: 'not_found' };

  const res = await installDependency(row.dep_url, self.plugin_key);
  db.prepare(`UPDATE plugin_dependency SET dep_key=?, dep_name=?, fail_code=? WHERE id=?`)
    .run(res.key, res.name, res.failCode, row.id);
  if (res.failCode) return { ok: false, code: res.failCode };
  return { ok: true, pluginKey: res.key };
}

function pluginUninstall(id) {
  const db = getAppDB();
  const plugin = db.prepare(`SELECT * FROM plugin WHERE id=?`).get(id);
  if (!plugin) return { ok: false, code: 'not_found' };
  const tables = db.prepare(`SELECT table_name FROM plugin_table WHERE plugin_ref=?`).all(id);

  db.transaction(() => {
    for (const t of tables) {
      if (!FULL_TABLE_RE.test(t.table_name)) continue; // defensive — these are always DB-stored, already-validated names
      db.prepare(`DROP TABLE IF EXISTS ${t.table_name}`).run();
    }
    db.prepare(`DELETE FROM plugin WHERE id=?`).run(id); // cascades plugin_table
  })();

  try { fs.rmSync(pluginDir(plugin.plugin_key), { recursive: true, force: true }); } catch (_) {}
  return { ok: true };
}

// manifest_json holds the installed manifest verbatim, so the v4.3.0 fields
// need no columns of their own and no migration — they are simply read back
// out here. A pre-v4.3.0 install just has no `panels`/`permissions` key and
// falls out as empty arrays.
function parseManifestJson(row) {
  try { return JSON.parse(row.manifest_json); } catch (_) { return null; }
}

function pluginList() {
  const db = getAppDB();
  const plugins = db.prepare(`
    SELECT id, plugin_key, name, version, repo_host, repo_owner, repo_name, repo_ref, entry_html, installed_at, manifest_json
    FROM plugin ORDER BY installed_at DESC
  `).all();
  const tables = db.prepare(`SELECT plugin_ref, local_name, columns_json FROM plugin_table`).all();
  // Both dependency tables are read once and filtered in JS rather than
  // per-plugin subqueries — same shape as `tables` above, and it keeps the
  // "is this key installed?" test to a single Set built from the list we
  // already have.
  const deps = db.prepare(`SELECT plugin_ref, dep_url, dep_key, dep_name, fail_code FROM plugin_dependency`).all();
  const installedKeys = new Set(plugins.map((p) => p.plugin_key));
  return plugins.map(({ manifest_json, ...p }) => {
    const manifest = parseManifestJson({ manifest_json });
    return {
      ...p,
      // Everything this plugin declared but doesn't have. Non-empty means the
      // renderer blocks Launch and offers a Download button per entry.
      missingDeps: deps
        .filter((d) => d.plugin_ref === p.id && (!d.dep_key || !installedKeys.has(d.dep_key)))
        .map((d) => ({ url: d.dep_url, key: d.dep_key, name: d.dep_name, failCode: d.fail_code })),
      tables: tables.filter((t) => t.plugin_ref === p.id).map((t) => ({ localName: t.local_name, columns: JSON.parse(t.columns_json) })),
      // The renderer needs an absolute on-disk path to point a <webview> at.
      // It is composed here (not in the renderer) so the plugins root stays a
      // main-process fact — the renderer never learns the data dir layout.
      dir: pluginDir(p.plugin_key),
      panels: manifest ? manifestPanels(manifest) : [],
      netOrigins: manifest ? manifestNetOrigins(manifest) : [],
      contextKinds: manifest ? manifestContextKinds(manifest) : [],
    };
  });
}

function pluginGetById(id) {
  return getAppDB().prepare(`SELECT * FROM plugin WHERE id=?`).get(id) || null;
}

// Resolve the plugin that owns an on-disk path, used by main.js to decide
// whether a <webview> src is a legitimate plugin panel. Returns the plugin row
// or null. Path containment is checked with path.relative rather than a string
// prefix so `<plugins>/foo-evil` can't satisfy `<plugins>/foo`.
// Containment only: which installed plugin's directory does this path live
// in? Returns { row, relInPlugin } or null. Split out from pluginByPanelPath
// because the two callers need different strictness — see below.
function resolvePluginPath(filePath) {
  let rel;
  try { rel = path.relative(pluginsRoot(), path.resolve(filePath)); } catch (_) { return null; }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const key = rel.split(path.sep)[0];
  if (!key) return null;
  const row = getAppDB().prepare(`SELECT * FROM plugin WHERE plugin_key=?`).get(key) || null;
  if (!row) return null;
  return { row, relInPlugin: rel.split(path.sep).slice(1).join('/') };
}

function pluginByPanelPath(filePath) {
  const hit = resolvePluginPath(filePath);
  if (!hit) return null;
  // The path must additionally be one of the panel entries this plugin
  // declared — a plugin can't get its arbitrary files embedded in the dock.
  const manifest = parseManifestJson(hit.row);
  const entries = new Set(manifestPanels(manifest || {}).map((p) => p.entry));
  if (!entries.has(hit.relInPlugin)) return null;
  return hit.row;
}

// Looser sibling used by main.js's will-navigate guard: a plugin may move
// between its OWN installed files (a multi-page plugin navigating from
// index.html to settings.html is legitimate), but may not leave the plugin
// directory or reach a remote origin. Panel embedding stays on the stricter
// pluginByPanelPath above.
function pluginByOwnedPath(filePath) {
  return resolvePluginPath(filePath)?.row || null;
}

// The allowlist gate for pluginapi:net:* . pluginId comes from the calling
// webContents' own identity (main.js), never from an argument.
function pluginNetAllowed(pluginId, url) {
  const row = getAppDB().prepare(`SELECT manifest_json FROM plugin WHERE id=?`).get(pluginId);
  if (!row) return false;
  const manifest = parseManifestJson(row);
  return !!manifest && netOriginAllowed(manifest, url);
}

// ---------------------------------------------------------------------------
// pluginApi.net.* / pluginApi.oauth.* (v4.3.0)
//
// BE HONEST ABOUT WHAT THIS IS. A plugin page could already reach the network
// on its own — it's a web page. What running the request HERE adds is the
// ability to read a cross-origin response, which CORS would otherwise deny.
// That is a real capability increase, and it is why every call is gated on the
// origin allowlist the manifest declared and the install preview showed. It is
// NOT a general-purpose proxy: no cookie jar is attached (Node's fetch has no
// access to the Electron session), the method set is fixed, and the response is
// size-capped. See docs/PLUGINS.md §2.4.
// ---------------------------------------------------------------------------
const NET_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const NET_TIMEOUT_MS = 120000;
const NET_MAX_BYTES = 8 * 1024 * 1024;

// Headers a plugin must not be able to set: they either impersonate a browser
// context the plugin doesn't have, or let it forge the request's origin.
const NET_BLOCKED_HEADERS = new Set(['cookie', 'host', 'origin', 'referer', 'content-length']);

function sanitizeNetInit(init) {
  const method = String(init?.method || 'GET').toUpperCase();
  if (!NET_METHODS.has(method)) throw new Error(`method not allowed: ${method}`);
  const headers = {};
  for (const [k, v] of Object.entries(init?.headers || {})) {
    if (typeof v !== 'string') continue;
    if (NET_BLOCKED_HEADERS.has(String(k).toLowerCase())) continue;
    headers[k] = v;
  }
  const body = init?.body;
  if (body != null && typeof body !== 'string') throw new Error('body must be a string');
  return { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body };
}

// Reads at most NET_MAX_BYTES so a hostile or broken endpoint can't balloon the
// main process. Returns what it got plus `truncated`, rather than throwing --
// the plugin can then decide whether a partial body is usable.
async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), truncated: false };
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > NET_MAX_BYTES) { await reader.cancel(); return { text, truncated: true }; }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

async function pluginNetFetch(pluginId, url, init) {
  if (!pluginNetAllowed(pluginId, url)) throw new Error('origin not allowed by this plugin\'s manifest');
  const opts = sanitizeNetInit(init);
  let res;
  try {
    res = await fetch(url, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  // A redirect could land off-allowlist; re-check where we actually ended up.
  if (res.redirected && !pluginNetAllowed(pluginId, res.url)) {
    return { ok: false, code: 'redirect_blocked', error: 'redirected to a disallowed origin' };
  }
  const { text, truncated } = await readCapped(res);
  return {
    ok: true, status: res.status, statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: text, truncated,
  };
}

// Streaming (SSE) sibling of pluginNetFetch. The caller supplies onChunk /
// onEnd because delivering bytes back to a specific webContents is main.js's
// job, not the data layer's. Returns an abort function.
async function pluginNetStream(pluginId, url, init, { onChunk, onEnd }) {
  if (!pluginNetAllowed(pluginId, url)) throw new Error('origin not allowed by this plugin\'s manifest');
  const opts = sanitizeNetInit(init);
  const ctrl = new AbortController();
  (async () => {
    let res;
    try {
      res = await fetch(url, { ...opts, redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      onEnd({ ok: false, code: ctrl.signal.aborted ? 'aborted' : 'network', error: String(e?.message || e) });
      return;
    }
    if (res.redirected && !pluginNetAllowed(pluginId, res.url)) {
      ctrl.abort();
      onEnd({ ok: false, code: 'redirect_blocked', error: 'redirected to a disallowed origin' });
      return;
    }
    // A non-2xx SSE request returns a normal JSON error body — read it whole
    // and hand it back as the end payload so the plugin can surface the real
    // message instead of "stream failed".
    if (!res.ok) {
      const { text } = await readCapped(res);
      onEnd({ ok: false, code: 'http', status: res.status, error: text });
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) { onEnd({ ok: false, code: 'network', error: 'no response body' }); return; }
    const decoder = new TextDecoder();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > NET_MAX_BYTES) { await reader.cancel(); onEnd({ ok: false, code: 'too_large', error: 'stream exceeded size cap' }); return; }
        onChunk(decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) onChunk(tail);
      onEnd({ ok: true, status: res.status });
    } catch (e) {
      onEnd({ ok: false, code: ctrl.signal.aborted ? 'aborted' : 'network', error: String(e?.message || e) });
    }
  })();
  return () => ctrl.abort();
}

// Generic OAuth 2.0 + PKCE authorization for a plugin, reusing the same
// loopback receiver Drive and Supabase login already use. The host owns the
// PKCE pair and the redirect capture (a plugin page can't listen on a port);
// the plugin does the token exchange itself with pluginApi.net.fetch, so no
// client secret ever has to be handed to the main process.
async function pluginOAuthAuthorize(pluginId, opts) {
  const authorizeUrl = String(opts?.authorizeUrl || '');
  if (!pluginNetAllowed(pluginId, authorizeUrl)) throw new Error('authorize URL not allowed by this plugin\'s manifest');
  const clientId = String(opts?.clientId || '');
  if (!clientId) throw new Error('clientId is required');

  const { makePkcePair, makeState, runOAuthLoopback } = require('./oauth-loopback');
  const { verifier, challenge } = makePkcePair();
  // Standard OAuth2 authorization endpoint (the plugin names its own provider,
  // and the URL is manifest-allowlisted), so `state` round-trips and is
  // enforced on the callback rather than just handed back to the plugin.
  const state = makeState();

  const { code, redirectUri } = await runOAuthLoopback((redirect) => {
    const u = new URL(authorizeUrl);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirect);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    if (opts?.scope) u.searchParams.set('scope', String(opts.scope));
    for (const [k, v] of Object.entries(opts?.extraParams || {})) {
      if (typeof v === 'string') u.searchParams.set(k, v);
    }
    return u.toString();
  }, { state });

  return { code, redirectUri, verifier, state };
}

// ---------------------------------------------------------------------------
// pluginApi.* — called only from main.js's raw ipcMain.handle('pluginapi:table:*')
// registrations, which resolve pluginId from the CALLING WINDOW's identity
// (never renderer-supplied) before reaching these functions. Every op
// resolves table_name via a ?-bound lookup scoped to that one plugin,
// validates row-object keys against that row's own columns_json, and only
// then composes SQL using the DB-returned identifiers.
// ---------------------------------------------------------------------------
function resolveOwnedTable(pluginId, localName) {
  if (!PLUGIN_TABLE_RE.test(String(localName || ''))) return null;
  const row = getAppDB().prepare(`
    SELECT table_name, columns_json FROM plugin_table WHERE plugin_ref=? AND local_name=?
  `).get(pluginId, localName);
  if (!row) return null;
  return { tableName: row.table_name, columns: JSON.parse(row.columns_json) };
}

function validateRowKeys(row, columns) {
  const allowed = new Set(columns.map((c) => c.name));
  for (const k of Object.keys(row || {})) {
    if (!allowed.has(k)) throw new Error(`unknown column: ${k}`);
  }
}

function pluginApiGetSchema(pluginId, localName) {
  const t = resolveOwnedTable(pluginId, localName);
  if (!t) throw new Error('not an owned table');
  return { columns: t.columns };
}

function pluginApiQuery(pluginId, localName, filter) {
  const t = resolveOwnedTable(pluginId, localName);
  if (!t) throw new Error('not an owned table');
  const f = filter && typeof filter === 'object' ? filter : {};
  validateRowKeys(f, t.columns);
  const keys = Object.keys(f);
  const where = keys.length ? `WHERE ${keys.map((k) => `${k}=?`).join(' AND ')}` : '';
  return getAppDB().prepare(`SELECT * FROM ${t.tableName} ${where} ORDER BY id DESC`).all(...keys.map((k) => f[k]));
}

function pluginApiInsert(pluginId, localName, row) {
  const t = resolveOwnedTable(pluginId, localName);
  if (!t) throw new Error('not an owned table');
  const r = row && typeof row === 'object' ? row : {};
  validateRowKeys(r, t.columns);
  const keys = Object.keys(r);
  if (!keys.length) {
    const res = getAppDB().prepare(`INSERT INTO ${t.tableName} DEFAULT VALUES`).run();
    return { id: res.lastInsertRowid };
  }
  const cols = keys.join(', ');
  const qs = keys.map(() => '?').join(', ');
  const res = getAppDB().prepare(`INSERT INTO ${t.tableName} (${cols}) VALUES (${qs})`).run(...keys.map((k) => r[k]));
  return { id: res.lastInsertRowid };
}

function pluginApiUpdate(pluginId, localName, rowId, row) {
  const t = resolveOwnedTable(pluginId, localName);
  if (!t) throw new Error('not an owned table');
  const r = row && typeof row === 'object' ? row : {};
  validateRowKeys(r, t.columns);
  const keys = Object.keys(r);
  if (!keys.length) return { changes: 0 };
  const set = keys.map((k) => `${k}=?`).join(', ');
  const res = getAppDB().prepare(`UPDATE ${t.tableName} SET ${set} WHERE id=?`).run(...keys.map((k) => r[k]), rowId);
  return { changes: res.changes };
}

function pluginApiDelete(pluginId, localName, rowId) {
  const t = resolveOwnedTable(pluginId, localName);
  if (!t) throw new Error('not an owned table');
  const res = getAppDB().prepare(`DELETE FROM ${t.tableName} WHERE id=?`).run(rowId);
  return { changes: res.changes };
}

module.exports = {
  pluginList, pluginGetById, pluginPreview, pluginInstall, pluginUninstall,
  pluginListOrgRepos, pluginMissingDeps, pluginInstallDependency,
  migratePluginDir, pluginByPanelPath, pluginByOwnedPath, pluginNetAllowed,
  pluginNetFetch, pluginNetStream, pluginOAuthAuthorize,
  pluginApiGetSchema, pluginApiQuery, pluginApiInsert, pluginApiUpdate, pluginApiDelete,
  // re-exported so the run-dracondex `evalmain` checks can reach them through
  // database.js without knowing about the electron-free split
  validateManifest, parseRepoUrl,
};
