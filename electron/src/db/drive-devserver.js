'use strict';
// Dev-mode Google Drive appdata mock. In an unpackaged run (`npm start`,
// drivers) src/db/drive.js talks to this in-process HTTP server instead of
// the real `www.googleapis.com` — same endpoint shapes (about/files list/
// create/update/get), so the whole backup/restore flow is testable with
// zero real Google account or OAuth client. State persists as JSON next to
// novel-manager.db in the dev data dir. Loopback only; never started in a
// packaged build (src/db/drive.js gates on app.isPackaged).
//
// Quota is simulated via an env var rather than real byte accounting —
// ponytail: good enough to deterministically exercise the near_full/full UI
// thresholds; a real accumulate-from-uploads model would need to track
// every file's size for no behavioral benefit over just forcing the percent.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const STATE_SCHEMA = 1;
const FAKE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10GB, arbitrary fixed "account size"

let state = null;   // { schema, files: { [id]: { id, name, bytes(base64), size, modifiedTime } } }
let stateFile = null;
let serverUrl = null;
let starting = null;

function loadState() {
  stateFile = path.join(path.dirname(app.getPath('userData')), 'dev-drive-server.json');
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { state = null; }
  if (!state || typeof state !== 'object' || state.schema !== STATE_SCHEMA) {
    state = { schema: STATE_SCHEMA, files: {} };
  }
  state.files = state.files || {};
}

function saveState() {
  try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch (e) {
    console.error('dev-drive-server: persist failed:', e);
  }
}

function findByName(name) {
  return Object.values(state.files).find((f) => f.name === name) || null;
}

function quotaPct() {
  const n = Number(process.env.DDX_DEV_DRIVE_QUOTA_PCT);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

// Splits a multipart/related body (RFC 2387, as sent by drive.js's own
// buildMultipartBody) into { metadata, media } using Buffer operations only
// — media content (a .ddx file) is arbitrary binary and must never be
// treated as text.
function parseMultipart(body, boundary) {
  const dash = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = body.indexOf(dash);
  while (idx !== -1) {
    const next = body.indexOf(dash, idx + dash.length);
    if (next === -1) break;
    parts.push(body.slice(idx + dash.length, next));
    idx = next;
  }
  const parsePart = (buf) => {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return { headers: '', content: Buffer.alloc(0) };
    const headers = buf.slice(0, headerEnd).toString('utf8');
    let content = buf.slice(headerEnd + 4);
    // trailing CRLF before the next boundary marker
    if (content.slice(-2).toString('utf8') === '\r\n') content = content.slice(0, -2);
    return { headers, content };
  };
  const [metaPart, mediaPart] = parts.map(parsePart);
  return {
    metadata: JSON.parse((metaPart?.content || Buffer.alloc(0)).toString('utf8') || '{}'),
    media: mediaPart?.content || Buffer.alloc(0),
  };
}

function handle(req, res) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const sendRaw = (code, buf) => {
    res.writeHead(code, { 'Content-Type': 'application/octet-stream' });
    res.end(buf);
  };
  const u = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);

    if (req.method === 'GET' && u.pathname === '/drive/v3/about') {
      const pct = quotaPct();
      return send(200, { storageQuota: { usage: String(Math.floor(FAKE_LIMIT_BYTES * (pct / 100))), limit: String(FAKE_LIMIT_BYTES) } });
    }

    if (req.method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q') || '';
      const m = /name='([^']*)'/.exec(q);
      const name = m ? m[1] : null;
      const files = name ? [findByName(name)].filter(Boolean) : Object.values(state.files);
      return send(200, { files: files.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, size: String(f.size) })) });
    }

    const getMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'GET' && getMatch && u.searchParams.get('alt') === 'media') {
      const f = state.files[getMatch[1]];
      if (!f) return send(404, { error: { message: 'not_found' } });
      return sendRaw(200, Buffer.from(f.bytes, 'base64'));
    }

    if (req.method === 'POST' && u.pathname === '/upload/drive/v3/files' && u.searchParams.get('uploadType') === 'multipart') {
      const ct = req.headers['content-type'] || '';
      const bm = /boundary=(\S+)/.exec(ct);
      if (!bm) return send(400, { error: { message: 'bad_multipart' } });
      const { metadata, media } = parseMultipart(body, bm[1]);
      const id = crypto.randomUUID();
      const f = { id, name: metadata.name, bytes: media.toString('base64'), size: media.length, modifiedTime: new Date().toISOString() };
      state.files[id] = f;
      saveState();
      return send(200, { id: f.id, name: f.name });
    }

    const patchMatch = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (req.method === 'PATCH' && patchMatch && u.searchParams.get('uploadType') === 'media') {
      const f = state.files[patchMatch[1]];
      if (!f) return send(404, { error: { message: 'not_found' } });
      f.bytes = body.toString('base64');
      f.size = body.length;
      f.modifiedTime = new Date().toISOString();
      saveState();
      return send(200, { id: f.id, name: f.name });
    }

    send(404, { error: { message: 'not found' } });
  });
}

// Starts once per process on an ephemeral loopback port; the URL is injected
// into the drive client at runtime and never persisted.
function ensureDevDriveServer() {
  if (serverUrl) return Promise.resolve(serverUrl);
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    loadState();
    const srv = http.createServer(handle);
    srv.on('error', (e) => { starting = null; reject(e); });
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${srv.address().port}`;
      console.log(`dev-drive-server: mock Drive appdata backend at ${serverUrl} (state: ${stateFile})`);
      resolve(serverUrl);
    });
  });
  return starting;
}

module.exports = { ensureDevDriveServer };
