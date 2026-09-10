'use strict';
// Dev-mode Token Sync server. In an unpackaged run (`npm start`, drivers) the
// real Supabase backend is replaced by this in-process HTTP server: the same
// 5 RPC endpoints with the same auth/tier-quota/expiry/lockout rules as
// supabase/migrations/20260730000000_dracondex_token_sync.sql, so the whole
// sync flow is testable with zero Supabase/Google setup. There is no /auth
// endpoint here — src/db/sync.js's syncGoogleLogin() fabricates a fake
// session entirely client-side in dev mode and sends `<uid>:<tier>` as the
// bearer token; this server just trusts that pair (fine for a loopback-only
// dev mock, never reachable from a packaged build — real tier lookups happen
// server-side against public.sync_account there). State persists as JSON
// next to novel-manager.db in the dev data dir. Loopback only; never started
// in a packaged build (src/db/sync.js gates on app.isPackaged).
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const EXPIRES_MS = 72 * 60 * 60 * 1000; // 72h
const LOCKOUT_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const STATE_SCHEMA = 3; // bump if the shape below changes; mismatched dev state is discarded

const maxBytes = (tier) => (tier === 'pro' ? 20971520 : 10485760); // pro 20MB / free 10MB
const maxSlots = (tier) => (tier === 'pro' ? 3 : 1); // pro 3 slots / free 1 slot

let state = null;   // { schema, vaults: {vaultId: {...}}, tokens: {tokenHash: vaultId} }
let stateFile = null;
let serverUrl = null;
let starting = null;

function loadState() {
  stateFile = path.join(path.dirname(app.getPath('userData')), 'dev-sync-server.json');
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { state = null; }
  if (!state || typeof state !== 'object' || state.schema !== STATE_SCHEMA) {
    state = { schema: STATE_SCHEMA, vaults: {}, tokens: {} };
  }
  state.vaults = state.vaults || {};
  state.tokens = state.tokens || {};
}

function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) {
    console.error('dev-sync-server: persist failed:', e);
  }
}

const hashKey = (k) => crypto.createHash('sha256').update(String(k || ''), 'utf8').digest('hex');
// ponytail: plain sha256 for the mock password compare, not bcrypt — this is
// a loopback-only dev double, only behavior parity with the real RPCs
// (hashed, never stored/compared in the clear) matters here.
const hashPw = (pw) => crypto.createHash('sha256').update(String(pw || ''), 'utf8').digest('hex');

const err = (code) => new Error(code);

function checkSize(snapshot, tier) {
  if (Buffer.byteLength(JSON.stringify(snapshot ?? null)) > maxBytes(tier)) throw err('too_large');
}

// Deletes any of an owner's vaults (and frees their token slots) past expiry.
function reapExpiredForOwner(ownerId) {
  let changed = false;
  for (const [id, v] of Object.entries(state.vaults)) {
    if (v.owner_id === ownerId && new Date(v.expires_at).getTime() < Date.now()) {
      delete state.tokens[v.token_hash];
      delete state.vaults[id];
      changed = true;
    }
  }
  if (changed) saveState();
}

const rpcs = {
  token_sync_push(p, caller) {
    const { uid, tier } = caller;
    if (!uid) throw err('not_authenticated');
    checkSize(p.p_snapshot, tier);
    const token = String(p.p_token || '');
    if (!/^[0-9]{16}$/.test(token)) throw err('bad_token');
    const tokenHash = hashKey(token);

    let vaultId = p.p_vault_id || null;
    if (vaultId) {
      const existing = state.vaults[vaultId];
      if (!existing || existing.owner_id !== uid) throw err('not_owner');
    } else {
      const count = Object.values(state.vaults).filter((v) => v.owner_id === uid).length;
      if (count >= maxSlots(tier)) throw err('quota_exceeded');
      vaultId = crypto.randomUUID();
    }

    const collidingOwner = state.tokens[tokenHash];
    if (collidingOwner && collidingOwner !== vaultId) throw err('token_collision');

    const prev = state.vaults[vaultId];
    if (prev) delete state.tokens[prev.token_hash]; // free this slot's old token

    const now = new Date().toISOString();
    const v = {
      id: vaultId,
      owner_id: uid,
      name: p.p_name || 'vault',
      snapshot: p.p_snapshot,
      snapshot_at: now,
      token_hash: tokenHash,
      password_hash: p.p_password ? hashPw(p.p_password) : null,
      expires_at: new Date(Date.now() + EXPIRES_MS).toISOString(),
      pull_fail_count: 0,
      pull_locked_until: null,
    };
    state.vaults[vaultId] = v;
    state.tokens[tokenHash] = vaultId;
    saveState();
    return { vault_id: vaultId, snapshot_at: v.snapshot_at, expires_at: v.expires_at };
  },

  token_sync_status(p, caller) {
    const { uid, tier } = caller;
    if (!uid) throw err('not_authenticated');
    reapExpiredForOwner(uid);
    const uploads = Object.values(state.vaults)
      .filter((v) => v.owner_id === uid)
      .sort((a, b) => (a.snapshot_at < b.snapshot_at ? 1 : -1))
      .map((v) => ({
        vault_id: v.id, name: v.name, snapshot_at: v.snapshot_at, expires_at: v.expires_at,
        size_bytes: Buffer.byteLength(JSON.stringify(v.snapshot)), has_password: !!v.password_hash,
      }));
    return { tier, max_slots: maxSlots(tier), max_bytes: maxBytes(tier), uploads };
  },

  token_sync_delete(p, caller) {
    if (!caller.uid) throw err('not_authenticated');
    const v = state.vaults[p.p_vault_id];
    if (v && v.owner_id === caller.uid) {
      delete state.tokens[v.token_hash];
      delete state.vaults[p.p_vault_id];
      saveState();
    }
    return { ok: true };
  },

  token_sync_pull_own(p, caller) {
    if (!caller.uid) throw err('not_authenticated');
    reapExpiredForOwner(caller.uid);
    const v = state.vaults[p.p_vault_id];
    if (!v || v.owner_id !== caller.uid) throw err('no_upload');
    return { name: v.name, snapshot: v.snapshot, snapshot_at: v.snapshot_at };
  },

  token_sync_pull_by_token(p, caller) {
    const vaultId = state.tokens[hashKey(p.p_token)];
    const v = vaultId ? state.vaults[vaultId] : null;
    if (!v) throw err('bad_token');
    if (new Date(v.expires_at).getTime() < Date.now()) {
      delete state.tokens[v.token_hash];
      delete state.vaults[vaultId];
      saveState();
      throw err('bad_token');
    }
    if (v.pull_locked_until && new Date(v.pull_locked_until).getTime() > Date.now()) throw err('locked');
    if (caller.uid && caller.uid === v.owner_id) {
      return { vault_id: v.id, name: v.name, snapshot: v.snapshot, snapshot_at: v.snapshot_at };
    }
    if (v.password_hash) {
      if (!p.p_password || hashPw(p.p_password) !== v.password_hash) {
        v.pull_fail_count = (v.pull_fail_count || 0) + 1;
        if (v.pull_fail_count >= LOCKOUT_ATTEMPTS) v.pull_locked_until = new Date(Date.now() + LOCKOUT_MS).toISOString();
        saveState();
        throw err('bad_password');
      }
    }
    v.pull_fail_count = 0;
    v.pull_locked_until = null;
    saveState();
    return { vault_id: v.id, name: v.name, snapshot: v.snapshot, snapshot_at: v.snapshot_at };
  },
};

const KNOWN = [
  'not_authenticated', 'bad_token', 'bad_password', 'locked',
  'token_collision', 'no_upload', 'too_large', 'quota_exceeded', 'not_owner',
];

// Bearer token is `<uid>:<tier>` in this mock (see file header) — the anon
// key ('dev-local', from getSyncConfig()'s dev branch) means logged out.
function getCaller(req) {
  const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '');
  if (!m || m[1] === 'dev-local') return { uid: null, tier: 'free' };
  const [uid, tier] = m[1].split(':');
  return { uid, tier: tier === 'pro' ? 'pro' : 'free' };
}

function handle(req, res) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(req.url);
  if (!m || req.method !== 'POST') return send(404, { message: 'not found' });
  if (!req.headers.apikey) return send(401, { message: 'No API key found in request' });
  const fn = rpcs[m[1]];
  if (!fn) return send(404, { message: `function ${m[1]} not found` });
  const caller = getCaller(req);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let params;
    try { params = JSON.parse(body || '{}'); } catch (_) { return send(400, { message: 'bad json' }); }
    try {
      send(200, fn(params, caller));
    } catch (e) {
      const msg = String(e.message || e);
      send(KNOWN.includes(msg) ? 400 : 500, { message: msg });
    }
  });
}

// Starts once per process on an ephemeral loopback port; the URL is injected
// into the sync client at runtime and never persisted.
function ensureDevSyncServer() {
  if (serverUrl) return Promise.resolve(serverUrl);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    loadState();
    const srv = http.createServer(handle);
    srv.on('error', (e) => { starting = null; reject(e); });
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${srv.address().port}`;
      console.log(`dev-sync-server: token sync backend at ${serverUrl} (state: ${stateFile})`);
      resolve(serverUrl);
    });
  });
  return starting;
}

module.exports = { ensureDevSyncServer };
