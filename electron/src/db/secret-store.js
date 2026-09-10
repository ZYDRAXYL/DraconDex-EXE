'use strict';
// Encryption-at-rest for the handful of app_setting rows that hold real
// credentials — Google refresh tokens and OAuth client secrets. Everything
// else in app_setting is ordinary preference data and keeps using
// getAppSetting/setAppSetting directly.
//
// Storage stays the same app_setting K/V table (src/db/versions.js); only the
// value is wrapped. A stored secret looks like:
//
//   enc:v1:<base64 of safeStorage.encryptString(plaintext)>
//
// The marker is what makes migration free: a value WITHOUT it is a legacy
// plaintext row from before this change, so getSecret returns it as-is and
// rewrites it encrypted on the spot. No migration step, no re-login, and a
// downgrade still finds a readable row until the first re-encrypt.
const { safeStorage } = require('electron');
const { getAppSetting, setAppSetting } = require('./versions');

const ENC_PREFIX = 'enc:v1:';

// The single source of truth for "this key holds a credential". Both this
// module and main.js's setting:get/set allowlist read it, so the two cannot
// drift apart and quietly re-expose a key.
const SECRET_KEYS = new Set([
  'drive:refreshToken',
  'drive:clientSecret',
  'drive:clientId',
  'google:refreshToken',
  'sync:anonKey',
]);

// Cloud-provider credentials (src/db/cloud.js) are keyed by provider id, so they
// cannot be enumerated in the set above without this file having to know every
// provider that will ever exist. Matched by shape instead: the credential
// fields are a fixed, closed list, so a non-secret per-provider setting like
// `cloud:webdav:role` is deliberately NOT matched and keeps using plain
// getAppSetting/setAppSetting.
const CLOUD_SECRET_RE = /^cloud:[a-z0-9_]+:(clientId|clientSecret|refreshToken|token|password|secretKey)$/;

// The single "does this key hold a credential" test. Use this rather than
// SECRET_KEYS.has() directly — the set alone no longer answers the question.
const isSecretKey = (key) => SECRET_KEYS.has(key) || CLOUD_SECRET_RE.test(String(key || ''));

let _warned = false;
function encryptionAvailable() {
  let ok = false;
  try { ok = safeStorage.isEncryptionAvailable(); } catch (_) { ok = false; }
  if (!ok && !_warned) {
    _warned = true;
    // Headless Linux with no keyring, mainly. Failing the login outright
    // would be worse than the status quo, so fall back to today's behaviour
    // (plaintext) rather than locking the user out of Drive/Sync.
    console.warn('[secret-store] OS encryption unavailable — credentials stored unencrypted');
  }
  return ok;
}

function setSecret(key, value) {
  const v = String(value ?? '');
  // Clearing a secret (logout) must not write an encrypted empty string —
  // callers test truthiness of the raw value.
  if (!v) return setAppSetting(key, '');
  if (!encryptionAvailable()) return setAppSetting(key, v);
  try {
    return setAppSetting(key, ENC_PREFIX + safeStorage.encryptString(v).toString('base64'));
  } catch (_) {
    return setAppSetting(key, v);
  }
}

function getSecret(key) {
  const raw = getAppSetting(key);
  if (!raw) return raw;
  if (!String(raw).startsWith(ENC_PREFIX)) {
    // Legacy plaintext — hand it back and upgrade it in place.
    if (encryptionAvailable()) { try { setSecret(key, raw); } catch (_) { /* best effort */ } }
    return raw;
  }
  try {
    return safeStorage.decryptString(Buffer.from(String(raw).slice(ENC_PREFIX.length), 'base64'));
  } catch (_) {
    // Wrong machine / rotated OS key / corrupted row. Treat as "not set" so
    // the caller re-authenticates instead of throwing on every read.
    return null;
  }
}

module.exports = { SECRET_KEYS, isSecretKey, getSecret, setSecret };
