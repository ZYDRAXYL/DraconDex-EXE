'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { getAppSetting, setAppSetting } = require('./versions');
const { checkForUpdate, internals: U } = require('./update');
const { installAsset, expectedSha256, sendProgress, isNewerVersion, RELEASE_URL_PREFIX, IS_DEV, AUTO_CHECK_KEY } = U;

// ═══ Updating by itself (Procress 29 part 9) ══════════════════════════════
// Like VS Code or Chrome: the app checks on its own (at start and every few
// hours), downloads a new version in the background, and when it is ready
// asks ONCE — "Install and restart" / "Later" (D6). Nothing to download by
// hand and no installer wizard. The Settings → Versions page picks how far it
// goes (UPDATE_MODES): ask (the default), install quietly when the app is
// closed, only tell, or never check.
//
// An installed (NSIS) build updates through electron-updater (D8): it reads
// latest.yml + the .blockmap the release carries, so a version after the
// first one downloads only the blocks that changed. A portable exe has no
// installer to run, so it keeps this file's own download and swaps itself in
// place under the SAME file name (D7) — a pinned shortcut keeps working.
//
// Every download is checked before it is allowed to run: its SHA-256 against
// the release's checksums-sha256.txt, and — once a signing key is set
// (UPDATE_PUBLIC_KEY, see .github/scripts/sign-checksums.mjs) — that file's
// Ed25519 signature, so the mirror alone cannot hand out a different exe.
// electron-updater's own hook for this only runs for Authenticode-signed
// builds, which this one is not, so the check is done here, before "ready".
const UPDATE_MODES = ['ask', 'quit', 'notify', 'off'];
const MODE_KEY = 'update:mode';
const LAST_VERSION_KEY = 'update:lastVersion';
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
// The public half of the release signing key (SPKI PEM, base64 body only).
// Empty = releases are not signed yet: the SHA-256 check still runs, and the
// quiet install-on-quit mode falls back to asking first.
const UPDATE_PUBLIC_KEY = '';

function getUpdateMode() {
  const m = getAppSetting(MODE_KEY);
  if (UPDATE_MODES.includes(m)) return m;
  return getAppSetting(AUTO_CHECK_KEY) === '0' ? 'off' : 'ask'; // the old on/off switch
}
function setUpdateMode(mode) {
  if (!UPDATE_MODES.includes(mode)) return { ok: false };
  setAppSetting(MODE_KEY, mode);
  setAppSetting(AUTO_CHECK_KEY, mode === 'off' ? '0' : '1');
  scheduleUpdateChecks();
  if (_ready) armInstallOnQuit();
  return { ok: true };
}

// What the renderer shows: the newest release (if any), whether it is
// downloaded and verified, and the mode.
let _ready = null;        // { version, kind: 'nsis' | 'portable', file? }
let _downloading = null;  // Promise while a download runs
function updateState() {
  const r = U.latest();
  return { mode: getUpdateMode(), current: app.getVersion(), available: !!r, version: r?.version || null,
    notes: r?.notes || '', url: r?.url || null, ready: !!_ready && _ready.version === r?.version, downloading: !!_downloading,
    canInstall: !!(r && installAsset(r)), signed: !!UPDATE_PUBLIC_KEY };
}
function sendState() {
  const st = updateState();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('update:state', st);
}

// The checksums file of a release, verified. Pure enough to test: given the
// text, the base64 signature and a key, true when the key signed exactly it.
function checksumsSigned(text, sigB64, publicKeyB64) {
  if (!publicKeyB64) return true;
  if (!sigB64) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(text, 'utf8'), key, Buffer.from(String(sigB64).trim(), 'base64'));
  } catch (_) { return false; }
}

const ua = () => ({ 'User-Agent': `DraconDex/${app.getVersion()}` });
async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: ua() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// The SHA-256 a file of this release must have — after the checksums file
// itself has been checked against the signing key.
async function expectedHashOf(release, fileName) {
  const sums = (release.assets || []).find((a) => a.name === 'checksums-sha256.txt');
  if (!sums) throw new Error('no checksums');
  const text = await fetchText(sums.url);
  if (UPDATE_PUBLIC_KEY) {
    const sig = (release.assets || []).find((a) => a.name === 'checksums-sha256.txt.sig');
    if (!sig || !checksumsSigned(text, await fetchText(sig.url), UPDATE_PUBLIC_KEY)) throw new Error('bad signature');
  }
  const expected = expectedSha256(text, fileName);
  if (!expected) throw new Error('no checksum for this file');
  return expected;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// electron-updater, for an installed build only — created on first use.
let _nsis;
function nsisUpdater() {
  if (_nsis !== undefined) return _nsis;
  _nsis = null;
  const asset = U.latest() && installAsset(U.latest());
  if (!asset || asset.kind !== 'setup') return null;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false; // only once verified (armInstallOnQuit)
    autoUpdater.logger = null;
    autoUpdater.on('download-progress', (p) => sendProgress((p?.percent || 0) / 100));
    _nsis = autoUpdater;
  } catch (_) { _nsis = null; }
  return _nsis;
}

// The portable exe's own download (also the fallback if electron-updater is
// unavailable): stream to .part, hash while it comes in, rename when it matches.
async function downloadAsset(asset, expected) {
  const part = `${asset.dest}.part`;
  try {
    const res = await fetch(asset.url, { signal: AbortSignal.timeout(30 * 60000), headers: ua() });
    if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    let got = 0, lastPct = -1;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await once(out, 'drain');
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct !== lastPct) { lastPct = pct; sendProgress(pct / 100); }
      }
    } finally {
      await new Promise((ok) => out.end(ok));
    }
    if (total && got !== total) throw new Error('download stopped early');
    if (hash.digest('hex') !== expected) throw new Error('checksum mismatch');
    fs.renameSync(part, asset.dest);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch (_) {}
    throw e;
  }
}

// Download the newest release in the background and verify it. Resolves to
// { ok } — failures are reported, never thrown, and leave nothing behind.
function downloadUpdate() {
  if (_downloading) return _downloading;
  const release = U.latest();
  const asset = release && installAsset(release);
  if (!asset) return Promise.resolve({ ok: false, error: 'no_installer' });
  if (_ready?.version === release.version) return Promise.resolve({ ok: true });
  _downloading = (async () => {
    try {
      const expected = await expectedHashOf(release, asset.name);
      const u = asset.kind === 'setup' ? nsisUpdater() : null;
      // electron-updater first (latest.yml + .blockmap); a release without them,
      // or any failure there, falls back to downloading the Setup whole.
      const viaUpdater = u && await (async () => {
        u.setFeedURL({ provider: 'generic', url: `${RELEASE_URL_PREFIX}/download/v${release.version}` });
        const found = await u.checkForUpdates();
        if (found?.isUpdateAvailable === false) throw new Error('feed has no update');
        const files = await u.downloadUpdate();
        const file = (files || []).find((f) => /\.exe$/i.test(f));
        if (!file || (await sha256File(file)) !== expected) throw new Error('checksum mismatch');
        return true;
      })().catch(() => false);
      if (viaUpdater) {
        _ready = { version: release.version, kind: 'nsis' };
      } else {
        await downloadAsset(asset, expected);
        _ready = { version: release.version, kind: asset.kind === 'setup' ? 'setup' : 'portable', file: asset.dest };
      }
      armInstallOnQuit();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      _downloading = null;
      sendState();
    }
  })();
  sendState();
  return _downloading;
}

// A portable exe replaces itself under its own name once it has exited:
// a hidden PowerShell waits until the file can be moved, moves the new one
// over it, and (on "install and restart") starts it again.
function portableSwap(newFile, restart) {
  const self = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!self) return;
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const ps = `$n=${q(newFile)};$s=${q(self)};for($i=0;$i -lt 150;$i++){try{Move-Item -LiteralPath $n -Destination $s -Force -ErrorAction Stop;break}catch{Start-Sleep -Milliseconds 200}}${restart ? ';Start-Process -FilePath $s' : ''}`;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// Mode "quit": a verified update installs quietly when the app is closed.
// Without a signing key it is never quiet — the ask mode's prompt stays.
let _quitHooked = false;
function armInstallOnQuit() {
  const quiet = getUpdateMode() === 'quit' && !!UPDATE_PUBLIC_KEY && !!_ready;
  if (_ready?.kind === 'nsis' && _nsis) _nsis.autoInstallOnAppQuit = quiet;
  if (quiet && _ready?.kind !== 'nsis' && !_quitHooked) {
    _quitHooked = true;
    app.once('will-quit', () => {
      if (!_ready || getUpdateMode() !== 'quit') return;
      if (_ready.kind === 'portable') portableSwap(_ready.file, false);
      else spawn(_ready.file, ['/S'], { detached: true, stdio: 'ignore' }).unref();
    });
  }
}

// "Install and restart" (or the Install button): download first if needed,
// then quit and let the installer / the swap bring the new version up.
async function installUpdate() {
  const r = await downloadUpdate();
  if (!r.ok) return r;
  if (_ready.kind === 'nsis') {
    setTimeout(() => _nsis.quitAndInstall(true, true), 1200); // silent, then start the new version
  } else if (_ready.kind === 'portable') {
    app.once('will-quit', () => portableSwap(_ready.file, true));
    setTimeout(() => app.quit(), 1200);
  } else {
    // the electron-updater-less fallback for a Setup: run it silently on the way out
    app.once('quit', () => { spawn(_ready.file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref(); });
    setTimeout(() => app.quit(), 1200);
  }
  return { ok: true };
}

// The schedule: once a little after start, then every CHECK_EVERY_MS. In
// "ask" and "quit" a found update downloads straight away (unless that
// version was set aside with "Remind me later" — then only the indicator).
let _timer = null;
async function backgroundCheck() {
  const mode = getUpdateMode();
  if (mode === 'off') return;
  const r = await checkForUpdate().catch(() => null);
  sendState();
  if (r?.available && r.canInstall && (mode === 'ask' || mode === 'quit')) await downloadUpdate();
}
function scheduleUpdateChecks() {
  clearTimeout(_timer); clearInterval(_timer);
  if (IS_DEV || getUpdateMode() === 'off') return;
  _timer = setTimeout(() => { backgroundCheck(); _timer = setInterval(backgroundCheck, CHECK_EVERY_MS); }, 15000);
}

// Once per new version: which version this one replaced (the "updated to
// vX.Y.Z — what's new" toast), then remembered so it says so only once.
function justUpdated() {
  const now = app.getVersion();
  const prev = getAppSetting(LAST_VERSION_KEY);
  if (prev === now) return null;
  setAppSetting(LAST_VERSION_KEY, now);
  return prev && isNewerVersion(now, prev) ? { from: prev, to: now, url: `${RELEASE_URL_PREFIX}/tag/v${now}` } : null;
}


// Plan process1 part2 #1.2: on by default (unset/anything but the literal
// '0' reads as enabled) — same getAppSetting boolean-as-string convention as
// drive.js's own `drive:autoBackup` flag, checked once per app open by
// initVersionCheck() (renderer/update.js) rather than on an interval.
// Procress 29 part 9: the on/off switch is now the 'off' end of the update
// mode (getUpdateMode) — kept for the callers that only ask "check at all?".
function getAutoCheck() { return getUpdateMode() !== 'off'; }
function setAutoCheck(enabled) { return setUpdateMode(enabled ? 'ask' : 'off'); }
module.exports = { installUpdate, downloadUpdate, updateState, getUpdateMode, setUpdateMode, scheduleUpdateChecks, justUpdated, getAutoCheck, setAutoCheck };
