'use strict';
// Shared OAuth helpers: PKCE pair generation + a temporary loopback HTTP
// server that captures an authorization-code redirect from a system-browser
// OAuth flow. Used by src/db/sync.js (Supabase-relayed Google login) and
// src/db/drive.js (direct Google OAuth for Drive appdata access) — the two
// flows differ only in the authorize-URL shape and in whether the token
// exchange needs the redirect_uri echoed back (Google's does; Supabase's
// PKCE exchange doesn't), which is why this resolves { code, redirectUri }
// rather than a bare code string.
const crypto = require('crypto');
const http = require('http');

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function makePkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// CSRF nonce for the authorize URL, verified back in runOAuthLoopback.
const makeState = () => crypto.randomBytes(16).toString('hex');

// Opens the system browser via buildAuthUrl(redirectUri) and resolves with
// { code, redirectUri } once the loopback redirect lands, or rejects with an
// Error whose .message is 'login_timeout', 'no_code', 'state_mismatch', or
// the provider's own error string.
//
// `state` is the CSRF nonce the caller put in the authorize URL. When given,
// the callback MUST echo it back or we reject — otherwise this server accepts
// any request that reaches the port, and an attacker who can hit the loopback
// (any local process, since the port is discoverable) could inject their own
// authorization code and get the user's account bound to it. Callers that
// cannot guarantee the nonce round-trips must omit it rather than pass one
// that will never come back; see the note at the sync.js call site.
function runOAuthLoopback(buildAuthUrl, { timeoutMs = 5 * 60 * 1000, state = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let redirectUri;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      srv.close();
      fn(arg);
    };
    const srv = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (_) { res.writeHead(400); res.end(); return; }
      if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      // Checked before anything else is read off the URL, and before the
      // success page is served, so a mismatched callback never looks like it
      // worked to the person staring at the browser tab.
      if (state !== null && u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font-family:sans-serif;padding:2rem">Login failed — the request could not be verified. Please try again.</body></html>');
        finish(reject, new Error('state_mismatch'));
        return;
      }
      const code = u.searchParams.get('code');
      const error = u.searchParams.get('error_description') || u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font-family:sans-serif;padding:2rem">Login complete — you can close this tab.</body></html>');
      if (code) finish(resolve, { code, redirectUri }); else finish(reject, new Error(error || 'no_code'));
    });
    const timer = setTimeout(() => finish(reject, new Error('login_timeout')), timeoutMs);
    srv.on('error', (e) => finish(reject, e));
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      require('electron').shell.openExternal(buildAuthUrl(redirectUri));
    });
  });
}

module.exports = { makePkcePair, makeState, runOAuthLoopback };
