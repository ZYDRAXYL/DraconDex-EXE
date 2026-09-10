'use strict';
// "Bring your own Supabase project" — the setup half of Cloud Sync.
//
// The user pastes their own project's URL and publishable (anon) key; this
// module then answers two questions entirely on its own:
//
//   1. checkSupabaseProject()   — is the project reachable, is the key valid,
//                                 and which of the tables/functions Cloud Sync
//                                 needs are actually there?
//   2. installSupabaseSchema()  — put the missing ones there.
//
// Why (2) needs more than the publishable key: a publishable key is a PUBLIC
// credential by design and PostgREST exposes no DDL through it, so no amount
// of cleverness lets it create a table. There are exactly two doors, and this
// module drives both:
//
//   * automatic  — the user pastes a Supabase personal access token (sbp_…)
//                  once; the schema goes in through the Management API
//                  (POST /v1/projects/{ref}/database/query) and the token is
//                  used for that one request and never stored anywhere.
//   * assisted   — no token: the app hands over the exact SQL plus a deep link
//                  to that project's SQL editor, and check() verifies the
//                  result afterwards. Same end state, one paste of manual work.
//
// Checking, unlike installing, works off the publishable key alone — see the
// dracondex_schema_status() probe in src/supabase/setup/dracondex_setup.sql.
//
// Config is stored in the SAME app_setting rows Cloud Sync already reads
// (sync:url + the encrypted sync:anonKey), so a completed setup makes
// src/db/sync.js work with no further wiring.
const { shell } = require('electron');
const { getAppSetting, setAppSetting } = require('./versions');
const { getSecret, setSecret } = require('./secret-store');
const { isAllowedSyncUrl } = require('./sync');
const {
  SUPABASE_SCHEMA_VERSION,
  SUPABASE_REQUIRED_TABLES,
  SUPABASE_REQUIRED_FUNCTIONS,
  SUPABASE_SETUP_SQL,
} = require('./supabase-schema');

const URL_KEY = 'sync:url';
const KEY_KEY = 'sync:anonKey';
const VERSION_KEY = 'supabase:schemaVersion'; // last version check() actually saw
const CHECKED_KEY = 'supabase:checkedAt';

const MGMT_API = 'https://api.supabase.com';
const REQUEST_TIMEOUT_MS = 20000;
const INSTALL_TIMEOUT_MS = 60000; // DDL on a cold project can be slow

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Project ref = the subdomain of a hosted project (https://<ref>.supabase.co).
// Self-hosted / custom-domain projects have none, which costs them only the
// two conveniences that need supabase.com itself: the Management API install
// and the dashboard deep links. The assisted path still works for them.
function projectRefFromUrl(url) {
  try {
    const host = new URL(String(url)).hostname;
    const m = /^([a-z0-9]{16,40})\.supabase\.(co|in|red)$/.exec(host);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

function getSupabaseSetup() {
  const url = (getAppSetting(URL_KEY) || '').replace(/\/+$/, '');
  const key = getSecret(KEY_KEY) || '';
  return {
    url,
    // Never hand the renderer the key itself — it only needs to know one is
    // stored, and enough of a tail to recognise WHICH one.
    keySet: !!key,
    keyPreview: key ? `••••••••${key.slice(-6)}` : '',
    projectRef: projectRefFromUrl(url),
    configured: !!(url && key),
    schemaVersion: Number(getAppSetting(VERSION_KEY) || 0),
    requiredVersion: SUPABASE_SCHEMA_VERSION,
    checkedAt: getAppSetting(CHECKED_KEY) || null,
  };
}

// An empty `key` means "keep whatever is stored" — the setup page never
// pre-fills the key input (it shows a masked tail as the placeholder instead),
// so a blank field on save is the user leaving it alone, not erasing it.
// clearSupabaseSetup() is the only way to remove one.
function setSupabaseSetup(url, key) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  const cleanKey = String(key || '').trim() || getSecret(KEY_KEY) || '';
  if (!clean || !cleanKey) return { ok: false, code: 'no_config' };
  // Same rule sync.js enforces: this URL is where auth tokens and whole vault
  // snapshots get sent, so https only (loopback excepted for the dev server).
  if (!isAllowedSyncUrl(clean)) return { ok: false, code: 'invalid_url' };
  setAppSetting(URL_KEY, clean);
  setSecret(KEY_KEY, cleanKey);
  // A different project is a different schema state — forget what the last one
  // reported rather than showing a stale "ready" against the new URL.
  setAppSetting(VERSION_KEY, '0');
  setAppSetting(CHECKED_KEY, '');
  return { ok: true, ...getSupabaseSetup() };
}

function clearSupabaseSetup() {
  setAppSetting(URL_KEY, '');
  setSecret(KEY_KEY, '');
  setAppSetting(VERSION_KEY, '0');
  setAppSetting(CHECKED_KEY, '');
  return { ok: true };
}

function getSupabaseSetupSql() {
  return { sql: SUPABASE_SETUP_SQL, version: SUPABASE_SCHEMA_VERSION };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// Every network failure below collapses to one shape — { ok:false, code } —
// because the renderer maps codes to toasts and nothing else.
async function req(url, opts, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return { ok: true, res: await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) }) };
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
}

async function jsonBody(res) {
  try { return await res.json(); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

// `url`/`key` are optional overrides so the setup page can validate what the
// user has TYPED before committing it to storage.
async function checkSupabaseProject(url, key) {
  const stored = getSupabaseSetup();
  const base = String(url || stored.url || '').trim().replace(/\/+$/, '');
  const apikey = String(key || '').trim() || (url ? '' : getSecret(KEY_KEY) || '');
  if (!base || !apikey) return { ok: false, code: 'no_config' };
  if (!isAllowedSyncUrl(base)) return { ok: false, code: 'invalid_url' };

  // Step 1 — reachable + key accepted. PostgREST's root document is also the
  // fallback source for "which RPCs exist" when the status probe below is not
  // installed yet (a project set up from the old migration files has the RPCs
  // but not the probe).
  const root = await req(`${base}/rest/v1/`, { headers: { apikey, Accept: 'application/openapi+json' } });
  if (!root.ok) return { ...root, url: base };
  if (root.res.status === 401 || root.res.status === 403) return { ok: false, code: 'bad_key', url: base };
  if (!root.res.ok) return { ok: false, code: 'unreachable', status: root.res.status, url: base };
  const openapi = await jsonBody(root.res);
  const exposedRpc = new Set(
    Object.keys(openapi?.paths || {})
      .filter((p) => p.startsWith('/rpc/'))
      .map((p) => p.slice(5)),
  );

  // Step 2 — the probe. Its absence is itself the answer ("nothing installed
  // yet"), so a 404 here is an expected result, not an error.
  let status = null;
  const probe = await req(`${base}/rest/v1/rpc/dracondex_schema_status`, {
    method: 'POST',
    headers: { apikey, Authorization: `Bearer ${apikey}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!probe.ok) return { ...probe, url: base };
  if (probe.res.ok) status = await jsonBody(probe.res);

  const tables = status?.tables || {};
  const functions = status?.functions || {};
  const items = [
    ...SUPABASE_REQUIRED_TABLES.map((name) => ({
      id: name, kind: 'table', ok: tables[name] === true,
    })),
    ...SUPABASE_REQUIRED_FUNCTIONS.map((name) => ({
      // Two independent sources of truth, either of which is proof enough:
      // the probe's catalog lookup, or PostgREST advertising the endpoint.
      id: name, kind: 'function', ok: functions[name] === true || exposedRpc.has(name),
    })),
    { id: 'dracondex_schema_status', kind: 'function', ok: !!status },
  ];

  const installedVersion = Number(status?.schema_version || 0);
  const missing = items.filter((i) => !i.ok).length;
  const ready = missing === 0 && installedVersion >= SUPABASE_SCHEMA_VERSION;

  // Advisory only — Cloud Sync signs in with Google, which is a dashboard
  // toggle no SQL can set. Reported so the setup page can say so out loud
  // instead of letting the user discover it at the login button.
  let googleProvider = null;
  const settings = await req(`${base}/auth/v1/settings`, { headers: { apikey } });
  if (settings.ok && settings.res.ok) {
    const s = await jsonBody(settings.res);
    if (s && s.external && typeof s.external.google === 'boolean') googleProvider = s.external.google;
  }

  // Only persist a verdict for the CONFIGURED project — a pre-save trial run
  // of some other URL must not overwrite it.
  if (!url || base === stored.url) {
    setAppSetting(VERSION_KEY, String(installedVersion));
    setAppSetting(CHECKED_KEY, new Date().toISOString());
  }

  return {
    ok: true,
    url: base,
    projectRef: projectRefFromUrl(base),
    ready,
    missing,
    items,
    installedVersion,
    requiredVersion: SUPABASE_SCHEMA_VERSION,
    googleProvider,
  };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

// accessToken is a Supabase personal access token (sbp_…). It is read from the
// argument, used for exactly one request, and never written to app_setting,
// the secret store, or a log line.
async function installSupabaseSchema(accessToken, url, key) {
  const stored = getSupabaseSetup();
  const base = String(url || stored.url || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, code: 'no_config' };
  const token = String(accessToken || '').trim();
  if (!token) return { ok: false, code: 'needs_manual' };

  const ref = projectRefFromUrl(base);
  // Self-hosted has no Management API to talk to; the assisted path is the
  // only one, and saying so beats a confusing 404 from api.supabase.com.
  if (!ref) return { ok: false, code: 'no_project_ref' };

  const r = await req(`${MGMT_API}/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SUPABASE_SETUP_SQL }),
  }, INSTALL_TIMEOUT_MS);
  if (!r.ok) return r;
  if (r.res.status === 401) return { ok: false, code: 'bad_access_token' };
  if (r.res.status === 403) return { ok: false, code: 'forbidden' };
  if (r.res.status === 404) return { ok: false, code: 'no_project_ref' };
  if (r.res.status === 429) return { ok: false, code: 'rate_limited' };
  if (!r.res.ok) {
    const body = await jsonBody(r.res);
    return { ok: false, code: 'sql_error', error: String(body?.message || body?.error || `HTTP ${r.res.status}`) };
  }

  // Trust nothing: the install is only "done" once the same probe the check
  // button uses says every object is there.
  const verify = await checkSupabaseProject(url, key);
  if (!verify.ok) return verify;
  return { ...verify, installed: true };
}

// ---------------------------------------------------------------------------
// Dashboard deep links (assisted path)
// ---------------------------------------------------------------------------
const DASHBOARD_PAGES = {
  sql: (ref) => `https://supabase.com/dashboard/project/${ref}/sql/new`,
  auth: (ref) => `https://supabase.com/dashboard/project/${ref}/auth/providers`,
  api: (ref) => `https://supabase.com/dashboard/project/${ref}/settings/api`,
  tokens: () => 'https://supabase.com/dashboard/account/tokens',
};

// An allowlist of page ids, not a URL the renderer passes — openExternal will
// launch anything, including non-http schemes, and the renderer is the last
// place that should get to choose.
async function openSupabaseDashboard(page) {
  const build = DASHBOARD_PAGES[String(page)];
  if (!build) return { ok: false, code: 'bad_page' };
  const ref = getSupabaseSetup().projectRef;
  if (!ref && page !== 'tokens') return { ok: false, code: 'no_project_ref' };
  await shell.openExternal(build(ref));
  return { ok: true };
}

module.exports = {
  getSupabaseSetup,
  setSupabaseSetup,
  clearSupabaseSetup,
  getSupabaseSetupSql,
  checkSupabaseProject,
  installSupabaseSchema,
  openSupabaseDashboard,
};
