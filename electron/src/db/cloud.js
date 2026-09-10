'use strict';
// ═══ Cloud storage registry (v4.9.0) ═══════════════════════════════════════
// The seam for "bring your own cloud storage". THIS FILE CONNECTS NOTHING.
// It writes down the contract that Google Drive backup (src/db/drive.js) and
// the disabled Token Sync (src/db/sync.js) already follow by hand, so that
// adding a real second backend later is one new cloud-<id>.js file plus one
// line in PROVIDERS below — not a refactor of every call site.
//
// Why a registry at all, when there is exactly one working provider today:
// the app's own storage story is "your data is yours, on your disk" (see the
// per-Nexus .ddx work), and the cloud half of that has to be "your storage
// account, your credentials". Hard-coding Google was fine while Drive was the
// only option; it is the wrong shape for a user pointing the app at their own
// Dropbox, OneDrive, WebDAV server or S3 bucket.
//
// ─── The provider contract ─────────────────────────────────────────────────
// A provider module exports one object:
//
//   id            string, /^[a-z0-9_]+$/ — the app_setting key prefix too
//   labelKey      i18n key for the display name (never a literal string)
//   availability  'available' | 'planned'   (NOT `status` — that name is the
//                 live-state METHOD below, and an object literal declaring both
//                 silently keeps only the last one)
//   capabilities  { backup: boolean, sync: boolean }
//   needsConfig   boolean — does the user have to paste client credentials?
//
//   getConfig()                -> { configured, ...non-secret fields }
//   setConfig(cfg)             -> { ok }
//   connect()                  -> { ok } | { ok:false, code }
//   disconnect()               -> { ok }
//   status()                   -> { ok, configured, connected, email?, storage? }
//
// Every method returns the `{ ok:true, ... }` / `{ ok:false, code }` shape the
// rest of the codebase already uses, and every failure code is mapped to an
// i18n key by the renderer (cloudErrToast in src/renderer/cloud.js) — a raw
// error string must never reach the UI.
//
// A provider does NOT own its OAuth plumbing: src/db/oauth-loopback.js
// (makePkcePair / makeState / runOAuthLoopback) is already provider-agnostic
// and is what drive.js, sync.js and pluginOAuthAuthorize all use. A new
// provider supplies a buildAuthUrl callback, nothing more.
const { getAppSetting, setAppSetting } = require('./versions');
const driveProvider = require('./cloud-drive');
const { PLANNED_SPECS, plannedProvider } = require('./cloud-planned');

const ACTIVE_KEY = 'cloud:provider';

// Order is display order. A provider graduating from planned to available
// means writing ./cloud-<id>.js, requiring it here, and deleting its entry
// from PLANNED_SPECS — the settings page, IPC surface and settings keys all
// follow automatically.
const PROVIDERS = [driveProvider, ...PLANNED_SPECS.map(plannedProvider)];
const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

function getProvider(id) {
  return BY_ID.get(String(id || '')) || null;
}

// Per-provider, non-secret settings. Credentials never come through here —
// those go through secret-store.js, which recognises the `cloud:<id>:` prefix.
const roleKey = (id) => `cloud:${id}:role`;
const enabledKey = (id) => `cloud:${id}:enabled`;

function providerPrefs(id) {
  return {
    enabled: getAppSetting(enabledKey(id)) === '1',
    // How the user wants this backend used once it is connected. Stored now so
    // the choice survives into whatever actually implements it.
    role: getAppSetting(roleKey(id)) || 'backup', // 'backup' | 'sync' | 'both'
  };
}

// The list the settings page renders. Deliberately does NOT call each
// provider's async status() — that would mean a network round trip per
// provider every time the page opens. Connection state comes from the local
// config/settings only; the page fetches live status for the active provider
// alone.
function cloudListProviders() {
  return {
    ok: true,
    active: getAppSetting(ACTIVE_KEY) || null,
    providers: PROVIDERS.map((p) => ({
      id: p.id,
      labelKey: p.labelKey,
      availability: p.availability,
      capabilities: p.capabilities,
      needsConfig: !!p.needsConfig,
      ...providerPrefs(p.id),
      configured: !!p.getConfig().configured,
    })),
  };
}

function cloudSetActive(id) {
  if (id === null || id === '') { setAppSetting(ACTIVE_KEY, ''); return { ok: true, active: null }; }
  const p = getProvider(id);
  if (!p) return { ok: false, code: 'unknown_provider' };
  // A provider that isn't implemented can be inspected but not made active —
  // otherwise the rest of the app would start routing backups into a stub.
  if (p.availability !== 'available') return { ok: false, code: 'not_implemented' };
  setAppSetting(ACTIVE_KEY, p.id);
  return { ok: true, active: p.id };
}

function cloudSetProviderPrefs(id, prefs) {
  const p = getProvider(id);
  if (!p) return { ok: false, code: 'unknown_provider' };
  if (prefs && 'enabled' in prefs) setAppSetting(enabledKey(id), prefs.enabled ? '1' : '0');
  if (prefs && 'role' in prefs) {
    const role = String(prefs.role);
    if (!['backup', 'sync', 'both'].includes(role)) return { ok: false, code: 'bad_role' };
    // Refuse a role the provider doesn't claim to support, so the stored value
    // is always something the eventual implementation can honour.
    if (role !== 'backup' && !p.capabilities.sync) return { ok: false, code: 'unsupported_role' };
    if (role !== 'sync' && !p.capabilities.backup) return { ok: false, code: 'unsupported_role' };
    setAppSetting(roleKey(id), role);
  }
  return { ok: true, ...providerPrefs(id) };
}

// The four pass-throughs. Each resolves the provider by id and delegates; a
// planned provider's own methods answer `not_implemented`, so there is no
// special-casing here and the renderer sees one consistent shape.
const cloudGetConfig = (id) => {
  const p = getProvider(id);
  return p ? { ok: true, config: p.getConfig() } : { ok: false, code: 'unknown_provider' };
};
const cloudSetConfig = (id, cfg) => {
  const p = getProvider(id);
  return p ? p.setConfig(cfg) : { ok: false, code: 'unknown_provider' };
};
const cloudConnect = (id) => {
  const p = getProvider(id);
  return p ? p.connect() : { ok: false, code: 'unknown_provider' };
};
const cloudDisconnect = (id) => {
  const p = getProvider(id);
  return p ? p.disconnect() : { ok: false, code: 'unknown_provider' };
};
const cloudStatus = (id) => {
  const p = getProvider(id);
  return p ? p.status() : { ok: false, code: 'unknown_provider' };
};

module.exports = {
  cloudListProviders, cloudSetActive, cloudSetProviderPrefs,
  cloudGetConfig, cloudSetConfig, cloudConnect, cloudDisconnect, cloudStatus,
};
