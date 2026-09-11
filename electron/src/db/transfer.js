'use strict';
// DDX Transfer — hand a whole Nexus to another device through the service in
// ZYDRAXYL/DraconDex-TRX. This is the third way to move a vault, next to
// exporting a file (src/db/db-transfer.js) and Token Sync (src/db/sync.js),
// and the only one that needs neither a file the user has to carry themselves
// nor a Supabase project and a Google login.
//
// This file is the Node third of a THREE-WAY WIRE CONTRACT. The other two are
// public/assets/js/ddx-crypto.js in DraconDex-TRX (the source of truth) and
// lib/data/services/ddx_transfer_service.dart in DraconDex-APK. A mismatch
// between any two of them does not throw — it delivers a vault that imports
// as nonsense — so every parameter below is written out rather than left to a
// default that might differ across three runtimes:
//
//   key        32 random bytes, made here, NEVER uploaded
//   payload    gzip(snapshot JSON) -> split -> AES-256-GCM per chunk
//   chunk      [12-byte IV][ciphertext || 16-byte GCM tag]
//   manifest   AES-256-GCM over JSON, carried as { iv, ct } (base64)
//   pinWrap    AES-256-GCM over the key, under
//              PBKDF2-SHA256(code + ":" + pin, salt, 600000) -> 32 bytes
//
// Everything network- and crypto-shaped stays in the main process, like
// sync.js — the renderer gets handles (a transferId, a display code) and
// never the key. That is not ceremony: it is what lets the browser build in
// DraconDex-PWA run this code unchanged, since it touches `fetch` but never
// `http.createServer`, a file dialog, or `fs`.
const zlib = require('zlib');
const { getAppSetting, setAppSetting } = require('./versions');
const { serializeVault, applySnapshot } = require('./sync');
const {
  KEY_BYTES, IV_BYTES, TAG_BYTES,
  newKey, sealChunk, openChunk, sealJson, openJson,
  wrapKeyWithPin, unwrapKeyWithPin, splitChunks, canonicalCode, canonicalPin,
} = require('./transfer-crypto');

// Where the service lives. Overridable so a fork can point at its own deploy,
// and so a real app can be driven against a local `netlify dev`.
const DEFAULT_BASE = 'https://dracondex-transfer.netlify.app';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Same rule as sync.js's isAllowedSyncUrl, and for the same reason: whatever
// lands here is where an entire vault gets sent. https only, except loopback
// for a local `netlify dev`.
function isAllowedTransferUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
}

function getTransferConfig() {
  const stored = (getAppSetting('transfer:url') || '').replace(/\/+$/, '');
  return { url: stored || DEFAULT_BASE, custom: !!stored, default: DEFAULT_BASE };
}

function setTransferConfig(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (clean && !isAllowedTransferUrl(clean)) return { ok: false, code: 'invalid_url' };
  setAppSetting('transfer:url', clean);
  return { ok: true, ...getTransferConfig() };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class TransferError extends Error {
  constructor(code, extra) {
    super(code);
    this.code = code;
    Object.assign(this, extra || {});
  }
}

async function call(path, { method = 'GET', token = null, json = null, body = null, raw = false } = {}) {
  const { url } = getTransferConfig();
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers['content-type'] = 'application/json';
  if (body) headers['content-type'] = 'application/octet-stream';

  let res;
  try {
    res = await fetch(`${url}${path}`, { method, headers, body: json ? JSON.stringify(json) : body });
  } catch (_) {
    // A dead network and a refusing server want different messages, so they
    // never collapse into one generic failure.
    throw new TransferError('network');
  }

  if (raw) {
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new TransferError(err?.code || 'server_error', err || {});
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const payload = await res.json().catch(() => null);
  if (!payload || payload.ok === false) throw new TransferError(payload?.code || 'server_error', payload || {});
  return payload;
}

// ---------------------------------------------------------------------------
// Sessions
//
// The transfer key never leaves this process, so it cannot be handed to the
// renderer and handed back. It lives here between the two halves of each
// flow, keyed by transferId; the renderer only ever holds that id.
// ---------------------------------------------------------------------------
const sending = new Map();   // transferId -> { key, uploadToken, code, pin, expiresAt }
const receiving = new Map(); // transferId -> { key, receiptToken, manifest, chunkCount }

/** Drops anything whose 30-minute window has closed, so the maps cannot grow. */
function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of sending) if (s.expiresAt && now > s.expiresAt) sending.delete(id);
  for (const [id, s] of receiving) if (s.expiresAt && now > s.expiresAt) receiving.delete(id);
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Serializes a Nexus, seals it, uploads it, and returns what the sender's
 * screen has to show. `allowTypedCode: false` withholds `pinWrap`, which is
 * what makes the transfer end-to-end: with no wrapped key on the service, the
 * QR/link fragment is the only copy of it in existence.
 */
async function transferSend(nexusId, { allowTypedCode = true, name = null } = {}) {
  sweepSessions();

  const snapshot = serializeVault(nexusId);
  if (!snapshot) return { ok: false, code: 'not_found' };
  const plain = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const gz = zlib.gzipSync(plain);

  const key = newKey();
  const created = await call('/api/create', { method: 'POST', json: { sizeBytes: gz.length } });

  // The framing costs an IV and a tag per chunk, so the plaintext slice has
  // to be smaller than the server's cap by exactly that much — otherwise the
  // last chunk of a large vault is the one thing that gets rejected.
  const slices = splitChunks(gz, created.maxChunkBytes - IV_BYTES - TAG_BYTES);
  if (slices.length > created.maxChunks) return { ok: false, code: 'too_large' };

  for (let i = 0; i < slices.length; i++) {
    await call(`/api/chunk/${created.transferId}/${i}`, {
      method: 'PUT', token: created.uploadToken, body: sealChunk(key, slices[i]),
    });
  }

  const manifest = {
    v: 1,
    name: String(name || snapshot?.nexus?.name || 'Nexus'),
    sizeBytes: plain.length,
    compression: 'gzip',
    createdAt: Date.now(),
    source: 'exe',
  };

  await call('/api/commit', {
    method: 'POST',
    token: created.uploadToken,
    json: {
      transferId: created.transferId,
      chunkCount: slices.length,
      sizeBytes: gz.length,
      manifestEnc: sealJson(key, manifest),
      pinWrap: allowTypedCode ? wrapKeyWithPin(key, created.code, created.pin) : null,
    },
  });

  sending.set(created.transferId, {
    key, uploadToken: created.uploadToken, code: created.code, pin: created.pin, expiresAt: created.expiresAt,
  });

  const { url } = getTransferConfig();
  return {
    ok: true,
    transferId: created.transferId,
    codeDisplay: created.codeDisplay,
    pinDisplay: created.pinDisplay,
    allowTypedCode,
    expiresAt: created.expiresAt,
    sizeBytes: plain.length,
    uploadedBytes: gz.length,
    // The secrets are after the '#', which is never sent to a server. The
    // renderer renders this into a QR and shows it; it is not the key itself
    // in any form the renderer can use for anything else.
    link: `${url}/t/${created.code}#k=${key.toString('base64url')}&p=${created.pin}`,
  };
}

async function transferStatus(transferId) {
  const s = sending.get(transferId);
  if (!s) return { ok: false, code: 'gone' };
  return call(`/api/status/${transferId}`, { token: s.uploadToken });
}

async function transferCancel(transferId) {
  const s = sending.get(transferId);
  if (!s) return { ok: true, status: 'gone' };
  sending.delete(transferId);
  return call(`/api/cancel/${transferId}`, { method: 'DELETE', token: s.uploadToken });
}

// ---------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------

/**
 * Step one: prove the code and PIN, open the manifest locally, and return
 * only what a person needs to decide with. No payload is fetched here — that
 * is the whole point of the two-step, and it is why a receiver can see
 * "My World, 2.4 MB" before anything touches their vault.
 */
async function transferVerify(code, pin, linkKeyB64 = null) {
  sweepSessions();
  const res = await call('/api/verify', { method: 'POST', json: { code, pin } });

  let key = null;
  if (linkKeyB64) {
    try { key = Buffer.from(String(linkKeyB64), 'base64url'); } catch (_) { key = null; }
    if (!key || key.length !== KEY_BYTES) return { ok: false, code: 'bad_key' };
  } else {
    // Nothing from a link and nothing wrapped on the service means the sender
    // chose QR-only. Typing the code is simply not a door into this one.
    if (!res.pinWrap) return { ok: false, code: 'qr_only' };
    try { key = unwrapKeyWithPin(res.pinWrap, canonicalCode(code), canonicalPin(pin)); }
    catch (_) { return { ok: false, code: 'bad_key' }; }
  }

  let manifest;
  // The service already accepted the PIN, so a manifest that will not open
  // means the KEY is wrong — a mangled fragment, not a mistyped PIN.
  try { manifest = openJson(key, res.manifestEnc); }
  catch (_) { return { ok: false, code: 'bad_key' }; }

  receiving.set(res.transferId, {
    key, receiptToken: res.receiptToken, manifest, chunkCount: res.chunkCount, expiresAt: res.expiresAt,
  });

  return {
    ok: true,
    transferId: res.transferId,
    name: manifest.name,
    sizeBytes: manifest.sizeBytes,
    createdAt: manifest.createdAt,
    source: manifest.source || null,
    expiresAt: res.expiresAt,
  };
}

/**
 * Step two: pull the payload and apply it.
 *
 * `targetNexusId` must be a nexus the CALLER created for this — applySnapshot
 * is wipe-and-rebuild, so aiming it at an existing vault destroys that
 * vault's contents. The renderer's default path creates an empty nexus first,
 * exactly like importAsNewNexus() in src/renderer/core/views.js.
 */
async function transferReceive(transferId, targetNexusId) {
  const s = receiving.get(transferId);
  if (!s) return { ok: false, code: 'gone' };

  const parts = [];
  for (let i = 0; i < s.chunkCount; i++) {
    const framed = await call(`/api/chunk/${transferId}/${i}`, { token: s.receiptToken, raw: true });
    parts.push(openChunk(s.key, framed));
  }

  const body = Buffer.concat(parts);
  let payload;
  try {
    const json = s.manifest.compression === 'gzip' ? zlib.gunzipSync(body) : body;
    payload = JSON.parse(json.toString('utf8'));
  } catch (_) {
    return { ok: false, code: 'bad_payload' };
  }

  const applied = applySnapshot(targetNexusId, payload);
  if (!applied || applied.ok === false) return applied || { ok: false, code: 'apply_failed' };

  receiving.delete(transferId);

  // Only now. Telling the service to purge any earlier would throw the vault
  // away on a failed gunzip with no way to ask for it again. A failure here
  // costs nothing — the sweeper is the backstop and the user has their data.
  try { await call('/api/complete', { method: 'POST', token: s.receiptToken, json: { transferId } }); }
  catch (_) { /* intentionally ignored */ }

  return { ok: true, name: s.manifest.name };
}

// ---------------------------------------------------------------------------
// Every op crosses IPC, so every op answers `{ ok, code }` and never throws —
// the same contract sync.js's ops keep. A raw Error escaping to the renderer
// would surface as an unhandled rejection with a stack in it, and there is no
// i18n key for a stack trace.
// ---------------------------------------------------------------------------
const guard = (fn) => async (...args) => {
  try { return await fn(...args); }
  catch (err) {
    if (err instanceof TransferError) return { ok: false, code: err.code, ...(err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : {}) };
    console.error('transfer op failed:', err);
    return { ok: false, code: 'server_error' };
  }
};

module.exports = {
  getTransferConfig, setTransferConfig, isAllowedTransferUrl,
  transferSend: guard(transferSend),
  transferStatus: guard(transferStatus),
  transferCancel: guard(transferCancel),
  transferVerify: guard(transferVerify),
  transferReceive: guard(transferReceive),
};
