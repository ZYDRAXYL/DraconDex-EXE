'use strict';
// Google Drive appdata backup. Independent of the Supabase Sync feature's
// Google login (src/db/sync.js) — its own Google OAuth client, its own
// "Connect Google Drive backup" consent, its own token storage. See
// docs/DRIVE.md for why: Supabase Auth never refreshes a third-party
// provider token for you, so refreshing Drive access later means talking to
// Google directly either way — bundling the drive.appdata scope into the
// Sync login would force every Sync-only user through an extra consent
// screen for no reuse benefit. All HTTP lives here in the main process
// (renderer never fetches).
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const { getAppSetting, setAppSetting } = require('./versions');
const { getSecret, setSecret } = require('./secret-store');
const { getAppDB } = require('./conn');
const { currentNexusId } = require('./vault-context');
const { exportDatabaseTo, importDatabaseMerge } = require('./import-merge');
const { makePkcePair, makeState, runOAuthLoopback } = require('./oauth-loopback');

// Build-mode gate: packaged builds talk to the real Google Drive API;
// unpackaged runs (`npm start`, drivers) use the in-process mock instead
// (src/db/drive-devserver.js) — zero setup, no Google account needed.
const IS_DEV = !app.isPackaged;
let devUrl = null;

async function ensureDevBackend() {
  if (!IS_DEV || devUrl) return;
  devUrl = await require('./drive-devserver').ensureDevDriveServer();
}

const apiBase = () => (IS_DEV ? devUrl : 'https://www.googleapis.com');

// ---------------------------------------------------------------------------
// Config (app_setting K/V) — a Google Cloud "Desktop app" OAuth client
// dedicated to the drive.appdata scope, entered once by the operator, same
// pattern as sync.js's sync:url/sync:anonKey.
// ---------------------------------------------------------------------------
function getDriveConfig() {
  const clientId = getSecret('drive:clientId') || '';
  const clientSecret = getSecret('drive:clientSecret') || '';
  return { clientId, clientSecret, configured: IS_DEV || !!(clientId && clientSecret), dev: IS_DEV };
}

function setDriveConfig(clientId, clientSecret) {
  setSecret('drive:clientId', String(clientId || '').trim());
  setSecret('drive:clientSecret', String(clientSecret || '').trim());
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Google OAuth — direct against Google (not through Supabase), PKCE +
// system-browser loopback redirect (shared helper with sync.js). Dev mode
// skips the browser entirely, same fabricated-session pattern as
// sync.js's syncGoogleLogin dev branch.
// ---------------------------------------------------------------------------
const DRIVE_REFRESH_KEY = 'drive:refreshToken';
const DRIVE_EMAIL_KEY = 'drive:email';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata email';

let memDriveToken = null; // { accessToken, exp (epoch ms or Infinity) }

async function driveConnect() {
  if (IS_DEV) {
    await ensureDevBackend();
    const email = 'dev-drive@local.test';
    setSecret(DRIVE_REFRESH_KEY, 'dev-drive-token');
    setAppSetting(DRIVE_EMAIL_KEY, email);
    memDriveToken = { accessToken: 'dev-drive-token', exp: Infinity };
    return { ok: true, email };
  }
  const { clientId, clientSecret, configured } = getDriveConfig();
  if (!configured) return { ok: false, code: 'no_config' };
  const { verifier, challenge } = makePkcePair();
  // Talking to Google's authorization endpoint directly, which echoes `state`
  // back on the redirect per RFC 6749 §4.1.2 — so the nonce round-trips and
  // runOAuthLoopback can enforce it.
  const state = makeState();
  let code, redirectUri;
  try {
    ({ code, redirectUri } = await runOAuthLoopback(
      (redirectTo) => `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(redirectTo)}&response_type=code`
        + `&scope=${encodeURIComponent(DRIVE_SCOPE)}`
        + `&access_type=offline&prompt=consent&code_challenge=${challenge}&code_challenge_method=S256`
        + `&state=${encodeURIComponent(state)}`,
      { state },
    ));
  } catch (e) {
    return { ok: false, code: e.message === 'login_timeout' ? 'login_timeout' : 'auth', error: String(e?.message || e) };
  }
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, code: 'auth', error: body.error_description || body.error || `HTTP ${res.status}` };
  }
  const data = await res.json();
  if (!data.refresh_token) return { ok: false, code: 'no_refresh_token' };
  memDriveToken = { accessToken: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  setSecret(DRIVE_REFRESH_KEY, data.refresh_token);

  let email = '';
  try {
    const ur = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (ur.ok) email = (await ur.json()).email || '';
  } catch (_) { /* best-effort — connection still succeeds without a display email */ }
  setAppSetting(DRIVE_EMAIL_KEY, email);
  return { ok: true, email };
}

async function driveDisconnect() {
  if (!IS_DEV) {
    const refreshToken = getSecret(DRIVE_REFRESH_KEY);
    if (refreshToken) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
        });
      } catch (_) { /* best-effort */ }
    }
  }
  setSecret(DRIVE_REFRESH_KEY, '');
  setAppSetting(DRIVE_EMAIL_KEY, '');
  memDriveToken = null;
  return { ok: true };
}

// Refreshes the Google access token from the stored refresh token when
// needed. A network failure must NOT clear the stored refresh token — only
// an explicit 400/401 from Google's token endpoint does (mirrors sync.js's
// ensureAccessToken). Unlike GoTrue, Google normally does NOT rotate the
// refresh token on refresh — only overwrite the stored one if the response
// actually includes a new one.
async function driveEnsureAccessToken() {
  await ensureDevBackend();
  if (IS_DEV) return memDriveToken ? memDriveToken.accessToken : null;
  if (memDriveToken && memDriveToken.exp > Date.now() + 5000) return memDriveToken.accessToken;
  const refreshToken = getSecret(DRIVE_REFRESH_KEY);
  if (!refreshToken) { memDriveToken = null; return null; }
  const { clientId, clientSecret } = getDriveConfig();
  if (!clientId || !clientSecret) return null;
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) {
    return memDriveToken ? memDriveToken.accessToken : null; // network hiccup — stay connected
  }
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      setSecret(DRIVE_REFRESH_KEY, '');
      memDriveToken = null;
    }
    return null;
  }
  const data = await res.json();
  memDriveToken = { accessToken: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  if (data.refresh_token) setSecret(DRIVE_REFRESH_KEY, data.refresh_token);
  return memDriveToken.accessToken;
}

// ---------------------------------------------------------------------------
// Drive API calls (appDataFolder space only). One overwrite slot per
// artifact, no versioning — matches Plan.md's literal scope.
// ---------------------------------------------------------------------------
const LAYOUT_FILE = 'dracondex-layout-profile.json';
const DDX_FILE = 'dracondex-backup.ddx';
// Separate appdata file from LAYOUT_FILE (Setting window → User → User
// profile, Plan.md's "layout slot ของ account... เก็บกี่รูปแบบก็ได้"): the
// hourly auto-backup above always overwrites LAYOUT_FILE with the CURRENT
// layout as a single raw blob — sharing that file with a named multi-slot
// library would mean the two features stomp each other's format on every
// auto-backup tick. Kept as its own file instead: zero risk to the
// already-working BackupData feature, and "unlimited slots" only needs to
// mean "stored in appdata," not literally one physical file per slot.
const LAYOUT_SLOTS_FILE = 'dracondex-layout-slots.json';

const httpErr = (res) => (res.status === 401 || res.status === 403 ? 'auth' : 'server');

async function driveFindFile(name) {
  const token = await driveEnsureAccessToken();
  if (!token) return { ok: false, code: 'not_connected' };
  let res;
  try {
    res = await fetch(
      `${apiBase()}/drive/v3/files?spaces=appDataFolder&q=${encodeURIComponent(`name='${name}'`)}&fields=files(id,name,modifiedTime,size)`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20000) },
    );
  } catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: httpErr(res), error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ok: true, file: (data.files || [])[0] || null };
}

// Builds a multipart/related body (RFC 2387) for Drive's create endpoint.
// Used for BOTH the dev mock and the real API — one wire format, no
// simplified test-only variant, so the mock actually exercises what the
// real API receives.
function buildMultipartBody(metadata, mediaBuffer, mediaContentType) {
  const boundary = crypto.randomBytes(16).toString('hex');
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${mediaContentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--`);
  return { boundary, body: Buffer.concat([head, mediaBuffer, tail]) };
}

async function driveUpsertFile(name, buffer, contentType) {
  const token = await driveEnsureAccessToken();
  if (!token) return { ok: false, code: 'not_connected' };
  const found = await driveFindFile(name);
  if (!found.ok) return found;

  if (found.file) {
    let res;
    try {
      res = await fetch(`${apiBase()}/upload/drive/v3/files/${found.file.id}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
        body: buffer,
        signal: AbortSignal.timeout(60000),
      });
    } catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
    if (!res.ok) return { ok: false, code: httpErr(res), error: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, fileId: data.id };
  }

  const { boundary, body } = buildMultipartBody({ name, parents: ['appDataFolder'] }, buffer, contentType);
  let res;
  try {
    res = await fetch(`${apiBase()}/upload/drive/v3/files?uploadType=multipart`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: httpErr(res), error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ok: true, fileId: data.id };
}

async function driveDownloadFile(name) {
  const found = await driveFindFile(name);
  if (!found.ok) return found;
  if (!found.file) return { ok: false, code: 'not_found' };
  const token = await driveEnsureAccessToken();
  if (!token) return { ok: false, code: 'not_connected' };
  let res;
  try {
    res = await fetch(`${apiBase()}/drive/v3/files/${found.file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: httpErr(res), error: `HTTP ${res.status}` };
  return { ok: true, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function driveGetQuota() {
  const token = await driveEnsureAccessToken();
  if (!token) return { ok: false, code: 'not_connected' };
  let res;
  try {
    res = await fetch(`${apiBase()}/drive/v3/about?fields=storageQuota`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { return { ok: false, code: 'network', error: String(e?.message || e) }; }
  if (!res.ok) return { ok: false, code: httpErr(res), error: `HTTP ${res.status}` };
  const data = await res.json();
  const usage = Number(data.storageQuota?.usage || 0);
  const limitRaw = data.storageQuota?.limit;
  const limit = limitRaw != null ? Number(limitRaw) : null; // absent = unlimited (e.g. Workspace accounts)
  const pct = limit ? usage / limit : 0;
  const state = limit == null ? 'ok' : pct >= 1 ? 'full' : pct >= 0.9 ? 'near_full' : 'ok';
  return { ok: true, usage, limit, state };
}

// ---------------------------------------------------------------------------
// Public ops (IPC surface)
// ---------------------------------------------------------------------------
function pushBackupLog(entry) {
  let log = [];
  try { log = JSON.parse(getAppSetting('drive:backupLog') || '[]'); } catch (_) { log = []; }
  log.unshift(entry);
  if (log.length > 20) log.length = 20;
  setAppSetting('drive:backupLog', JSON.stringify(log));
}

// Setting window → Appdata → BackupData "history" list — pushBackupLog()
// above has always written this, nothing ever read it back until now.
function driveGetBackupLog() {
  try { return JSON.parse(getAppSetting('drive:backupLog') || '[]'); } catch (_) { return []; }
}

async function driveStatus() {
  const { configured } = getDriveConfig();
  const connected = IS_DEV ? !!memDriveToken : !!getSecret(DRIVE_REFRESH_KEY);
  const out = {
    ok: true, configured, dev: IS_DEV, connected,
    email: connected ? (getAppSetting(DRIVE_EMAIL_KEY) || '') : '',
    autoBackup: getAppSetting('drive:autoBackup') === '1',
    backupLayout: getAppSetting('drive:backupLayout') === '1',
    backupDdx: getAppSetting('drive:backupDdx') === '1',
    lastBackupAt: getAppSetting('drive:lastBackupAt') || null,
    storage: null,
  };
  if (!connected) return out;
  const q = await driveGetQuota();
  if (q.ok) out.storage = { usage: q.usage, limit: q.limit, state: q.state };
  else out.storageError = q.code;
  return out;
}

function driveSetAutoBackup(enabled) { setAppSetting('drive:autoBackup', enabled ? '1' : '0'); return { ok: true }; }
function driveSetBackupLayout(enabled) { setAppSetting('drive:backupLayout', enabled ? '1' : '0'); return { ok: true }; }
function driveSetBackupDdx(enabled) { setAppSetting('drive:backupDdx', enabled ? '1' : '0'); return { ok: true }; }

// Both layout and .ddx are independent opt-in toggles (Plan.md hedges both
// bullets with "if the user wants") — connecting alone uploads nothing.
async function driveBackupNow(layoutJson) {
  const backupLayout = getAppSetting('drive:backupLayout') === '1';
  const backupDdx = getAppSetting('drive:backupDdx') === '1';
  if (!backupLayout && !backupDdx) return { ok: false, code: 'nothing_enabled' };

  const fail = (code) => {
    pushBackupLog({ at: new Date().toISOString(), ok: false, code, layout: false, ddx: false });
    return { ok: false, code };
  };

  const quota = await driveGetQuota();
  if (!quota.ok) return fail(quota.code);
  if (quota.state === 'full') return fail('drive_full');

  const done = { layout: false, ddx: false };
  if (backupLayout && layoutJson) {
    const r = await driveUpsertFile(LAYOUT_FILE, Buffer.from(String(layoutJson), 'utf8'), 'application/json');
    if (!r.ok) return fail(r.code);
    done.layout = true;
  }
  if (backupDdx) {
    // v4.9.0: "the database" is now app.ddx plus one file per Nexus, so a
    // single appdata slot no longer covers it. This backs up the vault the
    // window is currently in, under a name derived from that vault, so several
    // vaults accumulate side by side instead of overwriting each other.
    // app.ddx is NOT uploaded: it holds the OAuth refresh token that reaches
    // this very Drive account, and a backup that can restore its own
    // credentials onto another machine is a bigger promise than "backup".
    // Restoring settings is a separate feature; the layout profile above
    // already covers the part users actually miss.
    const tmpPath = path.join(os.tmpdir(), `dracondex-drive-backup-${Date.now()}.ddx`);
    try {
      await exportDatabaseTo(tmpPath);
      const bytes = fs.readFileSync(tmpPath);
      const r = await driveUpsertFile(vaultBackupFileName(), bytes, 'application/octet-stream');
      if (!r.ok) return fail(r.code);
      done.ddx = true;
    } finally {
      try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
    }
  }
  const now = new Date().toISOString();
  setAppSetting('drive:lastBackupAt', now);
  pushBackupLog({ at: now, ok: true, layout: done.layout, ddx: done.ddx });
  return { ok: true, backedUpAt: now, ...done };
}

// One appdata file per vault. Falls back to the historical single name when
// there is no vault context, so a pre-v4.9 backup is still found and restored.
function vaultBackupFileName() {
  const id = currentNexusId();
  if (!id) return DDX_FILE;
  const name = getAppDB().prepare(`SELECT name FROM nexus_file WHERE id=?`).get(id)?.name || `vault-${id}`;
  const slug = String(name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || `vault-${id}`;
  return `dracondex-backup-${slug}-${id}.ddx`;
}

async function driveRestoreLayoutProfile() {
  const r = await driveDownloadFile(LAYOUT_FILE);
  if (!r.ok) return r;
  return { ok: true, json: r.buffer.toString('utf8') };
}

// Reuses importDatabaseMerge exactly as the manual "Import Database" menu
// action does — a natural-key MERGE into the live vault set, not a wipe-
// and-replace. Callers must word their confirm dialog as "merge," not
// "overwrite."
async function driveRestoreDatabase() {
  // Prefer this vault's own backup; fall back to the pre-v4.9 single-file name
  // so an older backup still restores.
  let r = await driveDownloadFile(vaultBackupFileName());
  if (!r.ok && vaultBackupFileName() !== DDX_FILE) r = await driveDownloadFile(DDX_FILE);
  if (!r.ok) return r;
  const tmpPath = path.join(os.tmpdir(), `dracondex-drive-restore-${Date.now()}.ddx`);
  try {
    fs.writeFileSync(tmpPath, r.buffer);
    const summary = importDatabaseMerge(tmpPath);
    return { ok: true, summary };
  } catch (e) {
    return { ok: false, code: 'bad_backup', error: String(e?.message || e) };
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Layout profile SLOTS (Setting window → User → User profile). Independent
// of the single-blob auto-backup above — see LAYOUT_SLOTS_FILE comment.
// Read-modify-write against one small JSON file; a lost race between two
// windows saving at once is the same acceptable risk driveBackupNow already
// has against LAYOUT_FILE (last write wins, no locking anywhere in this
// module today).
// ---------------------------------------------------------------------------
async function driveReadSlotsFile() {
  const r = await driveDownloadFile(LAYOUT_SLOTS_FILE);
  if (!r.ok) return r.code === 'not_found' ? { ok: true, data: { slots: [] } } : r;
  try {
    const data = JSON.parse(r.buffer.toString('utf8'));
    return { ok: true, data: Array.isArray(data.slots) ? data : { slots: [] } };
  } catch (e) {
    return { ok: false, code: 'bad_backup', error: String(e?.message || e) };
  }
}
async function driveWriteSlotsFile(data) {
  return driveUpsertFile(LAYOUT_SLOTS_FILE, Buffer.from(JSON.stringify(data), 'utf8'), 'application/json');
}

async function driveListLayoutSlots() {
  const r = await driveReadSlotsFile();
  if (!r.ok) return r;
  return { ok: true, slots: r.data.slots.map((s) => ({ id: s.id, name: s.name, updatedAt: s.updatedAt })) };
}

async function driveSaveLayoutSlot(name, json) {
  const r = await driveReadSlotsFile();
  if (!r.ok) return r;
  const id = crypto.randomBytes(6).toString('hex');
  r.data.slots.push({ id, name: String(name || '').slice(0, 80) || 'Layout', updatedAt: new Date().toISOString(), json: String(json || '{}') });
  const up = await driveWriteSlotsFile(r.data);
  if (!up.ok) return up;
  return { ok: true, id };
}

async function driveRestoreLayoutSlot(id) {
  const r = await driveReadSlotsFile();
  if (!r.ok) return r;
  const slot = r.data.slots.find((s) => s.id === id);
  if (!slot) return { ok: false, code: 'not_found' };
  return { ok: true, json: slot.json };
}

async function driveDeleteLayoutSlot(id) {
  const r = await driveReadSlotsFile();
  if (!r.ok) return r;
  const before = r.data.slots.length;
  r.data.slots = r.data.slots.filter((s) => s.id !== id);
  if (r.data.slots.length === before) return { ok: false, code: 'not_found' };
  const up = await driveWriteSlotsFile(r.data);
  if (!up.ok) return up;
  return { ok: true };
}

module.exports = {
  getDriveConfig, setDriveConfig, driveConnect, driveDisconnect, driveStatus,
  driveSetAutoBackup, driveSetBackupLayout, driveSetBackupDdx,
  driveBackupNow, driveRestoreLayoutProfile, driveRestoreDatabase, driveGetBackupLog,
  driveListLayoutSlots, driveSaveLayoutSlot, driveRestoreLayoutSlot, driveDeleteLayoutSlot,
};
