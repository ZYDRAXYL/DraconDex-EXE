const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const db = require('./database');
const { isSecretKey } = require('./src/db/secret-store');
const {
  ASSET_CLASS, assetClassOf, mimeOf, isStreamable, parseRange, normalizeAssetUrl, LARGE_BYTES, PROXY_MAX_BYTES,
} = require('./src/db/asset-media');
const { windowNexus, runWithVault, currentNexusId } = require('./src/db/vault-context');

// Data location per build flavor:
// - portable exe (build:exe): PORTABLE_EXECUTABLE_DIR is set by the launcher
// - portable folder (build:portable): finish-portable.mjs drops portable.flag
//   next to the exe
// Both keep data in novel-manager-data beside the exe so it travels with the
// app. An installed build (build:installer) has neither marker, so data goes
// to the per-user appData dir — the install dir is deleted on uninstall/update
// and (for per-machine installs) may not be writable.
// In dev, DRACONDEX_DATA_DIR overrides the location so automated drivers can
// run against scratch data instead of tmp-user-data.
const isPackaged = app.isPackaged;
const exeDir = path.dirname(app.getPath('exe'));
const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR ||
  (fs.existsSync(path.join(exeDir, 'portable.flag')) ? exeDir : null);
const tempDataPath = isPackaged
  ? (portableRoot
      ? path.join(portableRoot, 'novel-manager-data')
      : path.join(app.getPath('appData'), 'DraconDex', 'novel-manager-data'))
  : (process.env.DRACONDEX_DATA_DIR || path.join(__dirname, '..', 'tmp-user-data'));
if (!fs.existsSync(tempDataPath)) fs.mkdirSync(tempDataPath, { recursive: true });
const electronUserDataPath = path.join(tempDataPath, 'electron-user-data');
app.setPath('userData', electronUserDataPath);
app.commandLine.appendSwitch('no-sandbox');

// ddx-file:// — display images are served straight to <img src> instead of
// being base64'd through IPC (Plan part2 #2.2). Must be declared before the
// app is ready.
// Deliberately NOT `standard: true`: index.html is loaded with loadFile, so
// the document origin is file://, and Chromium refuses to load a *standard*
// custom scheme as a subresource of a file:// page (verified — the request
// never reaches the handler, <img> just fires onerror). A non-standard
// scheme is opaque-origin like data:/blob: and loads fine. Consequence:
// ddx-file://<id> has no host component, so the handler parses the id off
// the raw URL rather than URL.hostname.
// Guarded because the run-dracondex web-driver harness loads this file with
// Electron's shell stubbed out (no `protocol`); there the renderer's
// <img onerror> fallback to importdock:readFiles takes over instead.
if (protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'ddx-file', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  ]);
}

// Ensure only one instance runs per data dir. The SQLite layer recovers from a
// stale lock dir by deleting it on open, which is only safe if no other
// instance is using the same DB. userData is set above so the lock is keyed to
// the active data dir, letting an isolated test instance run alongside dev.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});


// Popup (Builder-tab) windows are tracked here by id so "move this tab back
// to the main window" (Plan part1 #2/#2.1) can find a non-popup window to
// relay to, without needing a full parent/opener registry — see
// window:moveTabToMain below.
const popupWindowIds = new Set();

function createWindow(bootstrapNexusId, bootstrapTabKey) {
  const win = new BrowserWindow({
    width: bootstrapTabKey ? 900 : 1280, height: bootstrapTabKey ? 650 : 800,
    minWidth: 960, minHeight: 600,
    backgroundColor: '#050506',
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'src', 'assets', 'brand', 'DraconDex_Icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Plugin panels (v4.3.0) embed a plugin's page as a <webview> so it still
      // runs in its own webContents with preload-plugin.js and no window.api —
      // the same isolation a plugin WINDOW gets, just docked into the Module
      // Inspector slot. Enabling the tag is only half of it: every attach is
      // vetted by hardenWebviewAttach below, which is what keeps this narrow.
      webviewTag: true,
    },
  });
  hardenWebviewAttach(win.webContents);
  // Which vault this window's IPC calls belong to. Registered before loadFile
  // so the renderer's very first wave of calls already resolves.
  if (bootstrapNexusId) {
    const nexusId = Number(bootstrapNexusId);
    windowNexus.set(win.id, nexusId);
    // The Welcome list's item count is a cached value in app.ddx, refreshed on
    // the window lifecycle rather than on every module create/delete — those
    // are hot paths, and "counts as of the last time this vault was open" is
    // correct the moment its window closes. Refreshed on open too, so a vault
    // whose file was edited elsewhere corrects itself on first use.
    try { db.refreshVaultCounts(nexusId); } catch (_) {}
    try { db.touchVaultOpened(nexusId); } catch (_) {}
    // Pinned for as long as a window holds it, so conn.js's LRU can never
    // close a vault out from under a live renderer.
    db.pinVault(nexusId);
    win.on('closed', () => {
      windowNexus.delete(win.id);
      try { db.refreshVaultCounts(nexusId); } catch (_) {}
      // Only unpin once NO window is left on this vault — two windows on one
      // vault is a supported thing (window:openNexus).
      if (![...windowNexus.values()].includes(nexusId)) {
        db.unpinVault(nexusId);
        db.closeVault(nexusId);
      }
    });
  }
  if (bootstrapTabKey) {
    popupWindowIds.add(win.id);
    win.on('closed', () => popupWindowIds.delete(win.id));
  }
  const params = new URLSearchParams();
  if (bootstrapNexusId) params.set('nexus', bootstrapNexusId);
  if (bootstrapTabKey) { params.set('tab', bootstrapTabKey); params.set('popup', '1'); }
  win.loadFile(path.join(__dirname, 'index.html'), params.toString() ? { search: params.toString() } : undefined);
}

// Welcome window (v4.6.0) — the app's single entry point. Boot no longer
// restores the last vault (see boot.js), so every launch opens THIS window
// instead of the app shell, and a Nexus is only ever opened by picking one
// here (or from the vault-head switcher's "change Nexus" row, which reopens
// this window). It loads the same index.html with ?welcome=1 rather than a
// second HTML entry point: the renderer's modal/colorPicker/toast/i18n/theme
// bootstrap all live there, and a separate page would have to duplicate the
// lot. boot.js's S.isWelcome branch keeps it from booting the whole app.
// Only ever one — a second call focuses the existing window.
const welcomeWindowIds = new Set();

function createWelcomeWindow() {
  for (const id of welcomeWindowIds) {
    const open = BrowserWindow.fromId(id);
    if (open && !open.isDestroyed()) { if (open.isMinimized()) open.restore(); open.focus(); return; }
  }
  const win = new BrowserWindow({
    // Roughly half the app window's 1280x800 (createWindow above): this window
    // only ever shows a vault list or one setup step, and at the old 940x620 it
    // read as a second app window rather than a picker.
    width: 760, height: 560,
    minWidth: 640, minHeight: 480,
    backgroundColor: '#050506',
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'src', 'assets', 'brand', 'DraconDex_Icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  welcomeWindowIds.add(win.id);
  win.on('closed', () => welcomeWindowIds.delete(win.id));
  win.loadFile(path.join(__dirname, 'index.html'), { search: 'welcome=1' });
}

// Plugins (v4.0.0 as "Github extensions", renamed v4.2.0): one dedicated
// BrowserWindow per running plugin, tracked winId -> plugin row id so
// pluginapi:table:* handlers below can resolve "which plugin is this" from the
// WINDOW's own identity (never renderer/plugin-supplied), and so
// launch/stop/uninstall can find or refuse an already-open plugin.
// This window gets preload-plugin.js — a categorically smaller contextBridge
// surface than preload.js, never the main app's window.api. See
// docs/PLUGINS.md for the full security notes (including why
// `sandbox: true` here is honest, not reassuring, given the process-wide
// --no-sandbox switch set above for portable-build compatibility).
const pluginWindows = new Map(); // BrowserWindow.id -> plugin row id

function findPluginWindow(pluginId) {
  for (const [winId, id] of pluginWindows) {
    if (id === pluginId) return BrowserWindow.fromId(winId);
  }
  return null;
}

// Plugin PANELS (v4.3.0): the same plugin page, embedded in the main window's
// Module Inspector slot as a <webview> instead of getting its own window.
// webContents.id -> plugin row id, the panel-side twin of pluginWindows above,
// and read by callerPluginId() for exactly the same reason: a plugin's identity
// must come from the contents that made the call, never from an argument.
const pluginPanelContents = new Map();

// Everything that makes an embedded panel as narrow as a plugin window. Runs on
// EVERY attach in the main window — a page that tries to attach a <webview>
// pointing anywhere other than a declared panel entry of an installed plugin is
// refused outright, and the webPreferences it asked for are overwritten rather
// than merged (params/webPreferences are attacker-controlled if the renderer is
// ever compromised, so nothing from them is trusted).
function hardenWebviewAttach(hostContents) {
  let pendingPluginId = null;

  hostContents.on('will-attach-webview', (event, webPreferences, params) => {
    pendingPluginId = null;
    let filePath = null;
    try {
      const u = new URL(String(params.src || ''));
      if (u.protocol !== 'file:') { event.preventDefault(); return; }
      filePath = decodeURIComponent(u.pathname);
      // file:///C:/... on Windows parses with a leading slash before the drive.
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
    } catch (_) { event.preventDefault(); return; }

    const plugin = db.pluginByPanelPath(filePath);
    if (!plugin) { event.preventDefault(); return; }

    delete webPreferences.preloadURL;
    webPreferences.preload = path.join(__dirname, 'preload-plugin.js');
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webviewTag = false;
    params.nodeintegration = 'off';
    params.allowpopups = 'false';
    pendingPluginId = plugin.id;
  });

  // Fires immediately after the will-attach it was vetted by, so the id parked
  // above belongs to this guest and nothing else.
  hostContents.on('did-attach-webview', (_event, guest) => {
    if (pendingPluginId == null) return;
    const pluginId = pendingPluginId;
    pendingPluginId = null;
    pluginPanelContents.set(guest.id, pluginId);
    guest.on('destroyed', () => {
      pluginPanelContents.delete(guest.id);
      stopPluginStreamsFor(guest.id);
    });
    // A panel is a docked view, not a browser: it may not navigate off its own
    // files and may not spawn windows.
    guest.setWindowOpenHandler(() => ({ action: 'deny' }));
    guest.on('will-navigate', (e, url) => {
      let p = null;
      try { p = decodeURIComponent(new URL(url).pathname); } catch (_) { /* not a file URL */ }
      if (!p || !db.pluginByPanelPath(p)) e.preventDefault();
    });
  });
}

// A file:// URL's on-disk path, or null if it isn't one. Windows file URLs
// parse with a leading slash before the drive letter (file:///C:/…), same
// normalisation hardenWebviewAttach does for params.src.
function fileUrlToPath(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (u.protocol !== 'file:') return null;
  let p = decodeURIComponent(u.pathname);
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p;
}

const APP_INDEX_PATH = path.join(__dirname, 'index.html');

// Keep in sync with the <webview partition="..."> written by
// src/renderer/pluginpanel.js — a plugin's window and its docked panel must
// land in the SAME session, or the two forms of the same plugin would see
// different storage.
const pluginPartition = (pluginKey) => `persist:plugin-${pluginKey}`;

// This app needs no web permissions at all: no camera, microphone, geolocation,
// notifications, MIDI or clipboard-read anywhere in the UI. Denying the whole
// set is therefore free, and it matters most for the persist:plugin-* sessions,
// which host third-party code downloaded from a git repo.
function lockDownSession(sess) {
  if (!sess || sess.__ddxLocked) return sess;
  sess.__ddxLocked = true;
  sess.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  sess.setPermissionCheckHandler(() => false);
  return sess;
}

// Catch-all containment for EVERY webContents the app ever creates — the main
// window, the Welcome window, Builder popups, plugin windows and webview
// guests alike. Before this, only webview guests were guarded
// (hardenWebviewAttach), which left two holes: the app windows carry the full
// window.api preload and could be navigated away from index.html, and a
// plugin WINDOW could navigate itself to a remote origin while keeping its
// preload-plugin.js bridge — handing pluginApi.table/net to attacker-hosted
// script. Neither window needs to navigate anywhere at runtime, so the rule
// is simply: stay on your own file, and never open new windows.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Covers every session the app ever touches, including the per-plugin
  // partitions created lazily when a plugin window or panel first loads.
  lockDownSession(contents.session);
  contents.on('will-navigate', (event, url) => {
    const p = fileUrlToPath(url);
    // The app's own document: index.html, including its ?welcome=1 / popup
    // query-string variants, which URL() has already stripped from pathname.
    if (p && path.normalize(p) === APP_INDEX_PATH) return;
    // A plugin page navigating within its own installed directory.
    if (p && db.pluginByOwnedPath(p)) return;
    event.preventDefault();
  });
});

function createPluginWindow(plugin) {
  const existing = findPluginWindow(plugin.id);
  if (existing && !existing.isDestroyed()) { existing.focus(); return existing; }
  const win = new BrowserWindow({
    width: 900, height: 650, minWidth: 480, minHeight: 360,
    backgroundColor: '#050506',
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'src', 'assets', 'brand', 'DraconDex_Icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-plugin.js'), // narrow — never preload.js
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      // Same per-plugin partition the docked PANEL form already uses
      // (src/renderer/pluginpanel.js). Without it a plugin window ran in the
      // app's own default session, sharing cache/storage/cookies with the
      // main renderer; now each plugin gets its own and they are isolated
      // from the app and from each other.
      partition: pluginPartition(plugin.plugin_key),
    },
  });
  pluginWindows.set(win.id, plugin.id);
  const contentsId = win.webContents.id;
  win.on('closed', () => {
    pluginWindows.delete(win.id);
    stopPluginStreamsFor(contentsId);
  });
  win.loadFile(path.join(tempDataPath, 'plugins', plugin.plugin_key, plugin.entry_html));
  return win;
}

app.whenReady().then(() => {
  // Frameless window means no menu bar is ever visible, but keeping a real
  // application menu (rather than setApplicationMenu(null)) preserves its
  // accelerators — in particular Ctrl+Shift+I for DevTools, which the old
  // before-input-event handler reimplemented but double-fired on keyUp.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'viewMenu' },
  ]));
  registerDisplayImageProtocol();
  // On-disk half of the v4.2.0 extensions -> plugins rename (the DB half is
  // migratePluginV42 in src/db/schema/migrations.js). Idempotent and silent.
  db.migratePluginDir();
  // Start up setting (process 2 part 2): 'latest' skips the Welcome picker
  // and opens straight into whichever vault was most recently opened, via
  // the exact same createWindow(nexusId) path window:openNexus uses. Falls
  // through to Welcome when no vault has ever been opened yet (fresh
  // install — Welcome's own S.welcomeStep logic then runs the first-run
  // wizard) or the most-recent vault's file has gone missing.
  const startupMode = db.getAppSetting('startupMode');
  if (startupMode === 'latest') {
    const candidates = db.listVaults()
      .filter((v) => !v.missing && v.last_opened_at)
      .sort((a, b) => (b.last_opened_at > a.last_opened_at ? 1 : -1));
    if (candidates.length) { createWindow(candidates[0].id); return; }
  }
  createWelcomeWindow();
});

// Imported files are NOT copied into the data dir — import_file.file_path is
// the user's original absolute path, anywhere on disk (see importdock:add /
// pickFolder below), so there is no directory prefix to sandbox against.
// The URL therefore carries row ids, never a path: ddx-file://<nexusId>-<importFileId>
// is looked up in that vault's import_file and served only if it is a
// registered image/audio/video/pdf asset (v5). A path in the URL would be an arbitrary-file-read hole;
// don't add one.
//
// The nexus id joined the URL in v4.9.0, when import_file moved into per-vault
// files. This is NOT an IPC handler — it gets a bare Request, and every app
// window shares the default session (only plugins get partitions), so there is
// no calling window to infer a vault from. The URL has to say. The id is
// validated against the registry and the lookup runs inside runWithVault, so a
// forged nexus id can only reach a vault that actually exists, and only its
// registered assets.
function registerDisplayImageProtocol() {
  if (!protocol) return;
  protocol.handle('ddx-file', async (req) => {
    const url = String(req.url);
    const raw = url.replace(/^ddx-file:(\/\/)?/, '').split(/[?#/]/)[0];
    const [nexusPart, idPart] = raw.split('-');
    const nexusId = Number(nexusPart);
    const id = Number(idPart);
    if (!Number.isInteger(nexusId) || nexusId <= 0 || !Number.isInteger(id) || id <= 0) {
      return new Response(null, { status: 400 });
    }
    let f;
    try { f = await runWithVault(nexusId, () => db.getImportFile(id)); }
    catch (_) { return new Response(null, { status: 404 }); }
    const ext = (f?.file_type || '').toLowerCase();
    if (!f || f.source_kind !== 'file' || !isStreamable(ext)) return new Response(null, { status: 404 });
    // v5 (APP docs/V5.md §2.5): the cover proxy stored in the vault, served
    // on ?proxy=1 and as the automatic fallback for an image whose original
    // has gone missing — the vault still shows every cover after a move.
    const serveProxy = async () => {
      const p = await runWithVault(nexusId, () => db.getImportProxy(id));
      if (!p?.proxy) return new Response(null, { status: 404 });
      return new Response(Buffer.from(p.proxy), {
        headers: { 'Content-Type': p.proxy_type || 'image/jpeg', 'Cache-Control': 'no-cache' },
      });
    };
    if (/[?&]proxy=1(?:&|#|$)/.test(url)) return serveProxy();
    let st;
    try { st = await fs.promises.stat(f.file_path); }
    catch (_) { return assetClassOf(ext) === 'image' ? serveProxy() : new Response(null, { status: 404 }); }
    // ETag off mtime+size, served with no-cache: the browser reuses the
    // decoded image across re-renders but still revalidates, so replacing
    // the file on disk shows up immediately.
    const etag = `"${st.mtimeMs}-${st.size}"`;
    const headers = { 'Content-Type': mimeOf(ext), ETag: etag, 'Cache-Control': 'no-cache', 'Accept-Ranges': 'bytes' };
    // §2.6: Range / 206 is what lets <video> seek, and streaming (never
    // readFile) is what keeps a 2 GB mkv from becoming one 2 GB Response.
    const range = parseRange(req.headers.get('range'), st.size);
    if (range?.invalid) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
    }
    if (!range && req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : st.size - 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(Math.max(0, end - start + 1));
    try {
      const body = st.size === 0 ? null : Readable.toWeb(fs.createReadStream(f.file_path, { start, end }));
      return new Response(body, { status: range ? 206 : 200, headers });
    } catch (_) {
      return new Response(null, { status: 404 });
    }
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWelcomeWindow(); });

// The single choke point where every handler learns which vault it is for.
// Vault-scoped db functions call getDB(), which reads the AsyncLocalStorage
// store established here; app-level ones call getAppDB() and are unaffected.
// See src/db/vault-context.js for why ALS and not a module-scoped variable —
// short version: a handler that awaits (a file dialog, a network call) would
// otherwise resume with whatever vault a DIFFERENT window set in the meantime,
// and some of those paths wipe a nexus.
//
// The Welcome window has no entry in windowNexus, so its handlers run with a
// null vault and any vault-scoped call fails loudly rather than picking one.
const h = (ch, fn) => ipcMain.handle(ch, async (event, ...a) => {
  const nexusId = windowNexus.get(BrowserWindow.fromWebContents(event.sender)?.id) ?? null;
  try {
    return await runWithVault(nexusId, () => fn(...a));
  } catch (err) {
    console.error(`IPC handler ${ch} error:`, err);
    throw err;
  }
});

// DB import/export
// Exports the OPEN VAULT, not "the database" — since v4.9.0 there isn't one.
h('db:exportFile', async () => {
  const vaultName = (db.getNexus(currentNexusId())?.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
  const defaultName = `${vaultName}-backup-${new Date().toISOString().slice(0, 10)}.ddx`;
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Database',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'DraconDex Nexus', extensions: ['ddx'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await db.exportDatabaseTo(result.filePath);
  return { canceled: false, filePath: result.filePath };
});

// Split into pick + merge so the renderer can show its "merge into the current
// database?" confirm *between* the two — while these were one call, the merge
// had already run by the time there was anything to confirm.
//
// That split also left db:importMergeFile accepting ANY absolute path the
// renderer passed, so an arbitrary local file could be opened as a SQLite
// database and merged into the vault. Paths this dialog returned are recorded
// here and the merge below accepts nothing else.
const pickedImportDbPaths = new Set();

h('db:pickImportFile', async () => {
  // Accepts the current .ddx vault format, legacy .db files (pre-v3.11, or a
  // v1/v2 export — an old-shaped .db import is exactly the trigger case for
  // the Nexus Nest / Import DB choice modal, src/renderer/hub.js), and .mdx
  // module files (Plan process5 part2 — module export switched from a bare
  // .json snapshot to its own .mdx extension so it reads unambiguously next
  // to a .ddx vault export; the renderer branches on extension afterward,
  // see importDatabaseFile() in core/views.js).
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Import Database (.ddx / .mddx / .db)',
    properties: ['openFile'],
    filters: [{ name: 'DraconDex File', extensions: ['ddx', 'mddx', 'mdx', 'db'] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
  pickedImportDbPaths.add(path.resolve(result.filePaths[0]));
  return { canceled: false, filePath: result.filePaths[0] };
});

// targetNexusId (Plan process5 part2, optional): merge into a specific nexus
// instead of the calling window's currently-open one — the "create a new
// Nexus" branch of the import-target choice (core/views.js) creates an empty
// nexus first, then merges here into THAT id. See import-merge.js's own
// comment on why passing an explicit id is safe regardless of what's open.
h('db:importMergeFile', async (filePath, targetNexusId) => {
  if (!filePath) return { canceled: true };
  if (!pickedImportDbPaths.has(path.resolve(String(filePath)))) return { canceled: true };
  const summary = db.importDatabaseMerge(filePath, targetNexusId ?? null);
  return { canceled: false, summary };
});

// Setting window → Appdata → Database: per-nexus / per-module export-import
// (Plan.md part1 #Setting) — same save/open-dialog-then-call split as the
// whole-database flow above, reusing Token Sync's snapshot format/functions
// (src/db/sync.js) under the hood (src/db/db-transfer.js).
h('db:exportNexusFile', async (nexusId, nexusName) => {
  const defaultName = `${String(nexusName || 'nexus').replace(/[\\/:*?"<>|]/g, '_')}.json`;
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Nexus', defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'DraconDex Nexus Snapshot', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return db.exportNexusFile(nexusId, result.filePath);
});
h('db:importNexusFile', async (nexusId) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Import Nexus', properties: ['openFile'],
    filters: [{ name: 'DraconDex Nexus Snapshot', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  return db.importNexusFile(nexusId, result.filePaths[0]);
});
// .mddx (v5 Part 4, V5.md §8.7) — the same snapshot this always wrote, under
// the extension the folder mirror (db/mirror.js) uses for a module's file,
// so an exported module and a mirrored one are the same kind of file.
// (Plan process5 part2 had moved it from bare .json to .mdx to tell it apart
// from the Nexus snapshot export above.)
h('db:exportModuleFile', async (nexusId, moduleId, moduleName) => {
  const defaultName = `${String(moduleName || 'module').replace(/[\\/:*?"<>|]/g, '_')}.mddx`;
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Module', defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'DraconDex Module File', extensions: ['mddx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return db.exportModuleFile(nexusId, moduleId, result.filePath);
});
// Accepts .mdx and .json too — a module exported before either switch is
// still a valid snapshot in the same shape, only the extension changed.
h('db:importModuleFile', async (nexusId, parentModuleId) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Import Module', properties: ['openFile'],
    filters: [{ name: 'DraconDex Module File', extensions: ['mddx', 'mdx', 'json'] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  return db.importModuleFile(nexusId, parentModuleId, result.filePaths[0]);
});
// Same underlying import as above, but for a file already picked through
// db:pickImportFile's unified .ddx/.mdx/.db dialog (Plan process5 part2's
// import-target-choice flow, core/views.js) instead of opening a second
// dialog of its own — validated against the same picked-paths allowlist
// db:importMergeFile uses, for the same reason (see pickedImportDbPaths above).
h('db:importModuleFileAt', async (nexusId, parentModuleId, filePath) => {
  if (!filePath) return { ok: false, canceled: true };
  if (!pickedImportDbPaths.has(path.resolve(String(filePath)))) return { ok: false, canceled: true };
  return db.importModuleFile(nexusId, parentModuleId, filePath);
});

// Nexus (vault)
h('nexus:getAll', ()             => db.getNexuses());
h('nexus:get',    (id)           => db.getNexus(id));
// Where a vault file goes. The DEFAULT path is a pure string with no dialog —
// that is what keeps the run-dracondex driver deterministic (a native
// showSaveDialog would block the real-Electron driver forever, and
// web-driver.mjs stubs dialogs to {canceled:true}). The dialog only ever opens
// because the user clicked Change.
const pickedVaultPaths = new Set();
// Share copies this session produced, so shell:revealPath can accept them.
const sharedVaultPaths = new Set();
h('nexus:defaultPath', ()        => db.vaultsDir());
h('nexus:pickLocation', async (name) => {
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Save Nexus As',
    defaultPath: db.vaultDefaultPath(name || '', 0).replace(/-0\.ddx$/, '.ddx'),
    filters: [{ name: 'DraconDex Nexus', extensions: ['ddx'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const resolved = path.resolve(result.filePath);
  pickedVaultPaths.add(resolved);
  return { canceled: false, filePath: resolved };
});
// A path the renderer supplies is only honoured if a dialog produced it — the
// same "a picker returned it or it doesn't exist" rule pickedImportDbPaths and
// pickedImportRoots already apply. Anything else falls back to the default.
h('nexus:create', (n,m,c,fp) => {
  const chosen = fp && pickedVaultPaths.has(path.resolve(String(fp))) ? path.resolve(String(fp)) : null;
  return db.createNexus(n, m, c, chosen);
});
// ─── The Nexus ... menu (v4.9.0) ───────────────────────────────────────────
// Duplicate / Export / Share / Open in Explorer. These are real file
// operations now that a Nexus is a real file.
h('nexus:duplicate', (id) => db.duplicateNexus(id));

h('nexus:exportFile', async (id) => {
  const n = db.getNexus(id);
  if (!n) return { ok: false, code: 'not_found' };
  const safe = String(n.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
  // v5 Part 4 (§8.7): .ddx (data; media stay paths on this machine) or
  // .zip (the .ddx plus the real media files — db-transfer exportNexusZip).
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Nexus', defaultPath: path.join(app.getPath('documents'), `${safe}.ddx`),
    filters: [
      { name: 'DraconDex Nexus', extensions: ['ddx'] },
      { name: 'DraconDex Nexus + media (.zip)', extensions: ['zip'] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  if (/\.zip$/i.test(result.filePath)) return db.exportNexusZip(id, result.filePath);
  return db.exportNexusVaultFile(id, result.filePath);
});

// Share = "hand this file to a person". Windows gives Electron no way to
// attach a file to the user's mail client, so this writes the copy and the
// renderer offers the three things that DO work: reveal it (one drag into a
// chat window), copy its path, or open a pre-filled mail draft to attach it to.
// macOS gets the real native share sheet instead.
h('nexus:shareFile', async (id) => {
  const n = db.getNexus(id);
  if (!n) return { ok: false, code: 'not_found' };
  const safe = String(n.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Share Nexus', defaultPath: path.join(app.getPath('desktop'), `${safe}.ddx`),
    filters: [{ name: 'DraconDex Nexus', extensions: ['ddx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const out = db.exportNexusVaultFile(id, result.filePath);
  if (!out.ok) return out;
  sharedVaultPaths.add(path.resolve(out.filePath));
  if (process.platform === 'darwin') {
    try {
      const { ShareMenu } = require('electron');
      new ShareMenu({ filePaths: [out.filePath] }).popup({ window: BrowserWindow.getFocusedWindow() });
      return { ...out, native: true };
    } catch (_) { /* fall through to the modal */ }
  }
  return { ...out, native: false };
});

// Reveals a path the APP owns — resolved from the registry, never taken from
// the renderer, so this cannot be pointed at an arbitrary file.
h('nexus:revealFile', (id) => {
  const n = db.getNexus(id);
  if (!n?.file_path) return { ok: false, code: 'not_found' };
  shell.showItemInFolder(n.file_path);
  return { ok: true };
});
h('shell:revealPath', (p) => {
  // Only paths this app produced: a registered vault file, or a share copy the
  // save dialog just returned.
  const known = db.getNexuses().some((n) => n.file_path && path.resolve(n.file_path) === path.resolve(String(p || '')));
  if (!known && !sharedVaultPaths.has(path.resolve(String(p || '')))) return { ok: false, code: 'not_found' };
  shell.showItemInFolder(String(p));
  return { ok: true };
});
// mailto: only. openExternal hands a string to the OS shell handler, so an
// unrestricted one is a new door out of the sandbox — file:, and on Windows
// anything the shell will execute, must never reach it.
h('shell:composeMail', (subject, body) => {
  const url = `mailto:?subject=${encodeURIComponent(String(subject || ''))}&body=${encodeURIComponent(String(body || ''))}`;
  shell.openExternal(url);
  return { ok: true };
});

// A vault whose file was moved or deleted: point the registry at it again.
h('nexus:relink', async (id) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Locate Nexus File', properties: ['openFile'],
    filters: [{ name: 'DraconDex Nexus', extensions: ['ddx'] }],
  });
  if (result.canceled || !result.filePaths?.[0]) return { ok: false, canceled: true };
  return db.relinkNexusFile(id, result.filePaths[0]);
});
h('nexus:update', (id,n,m,c)     => db.updateNexus(id,n,m,c));
h('nexus:delete', (id)           => db.deleteNexus(id));
h('nexus:taught',     (nx)         => db.getTaught(nx));
h('nexus:markTaught', (nx, tip, st) => db.markTaught(nx, tip, st));
// v5 Part 6 (§10.8): the user's own module presets. Built-ins live in the
// renderer (hub/presets.js) and are applied through preset:apply too.
h('preset:list',   (nx, kind)        => db.listPresets(nx, kind));
h('preset:save',   (nx, mid, name)   => db.savePreset(nx, mid, name));
h('preset:delete', (id)              => db.deletePreset(id));
h('preset:apply',  (mid, spec)       => db.applyPreset(mid, spec));

// Scribe (markdown notes)
h('note:getFolders',   (nx)            => db.getNoteFolders(nx));
h('note:createFolder', (nx,n,p,c)      => db.createNoteFolder(nx,n,p,c));
h('note:updateFolder', (id,n,p,c)      => db.updateNoteFolder(id,n,p,c));
h('note:deleteFolder', (id)            => db.deleteNoteFolder(id));
h('note:getAll',       (nx)            => db.getNotes(nx));
h('note:get',          (id)            => db.getNote(id));
h('note:create',       (nx,t,f,c)      => db.createNote(nx,t,f,c));
h('note:update',       (id,t,f,c,p)    => db.updateNote(id,t,f,c,p));
h('note:updateContent',(id,content)    => db.updateNoteContent(id,content));
h('note:delete',       (id)            => db.deleteNote(id));

// Module system (v3 Nexus nest)
// Legacy Scribe notes become modules the first time a tree is read (v5 Part
// 8, §12) — boot, a vault switch, and the reload after an import merge all
// pass through here, so none of them can show a tree with notes left out.
h('module:getTree',     (nx)          => { db.autoMigrateNotes(nx); return db.getTree(nx); });
h('module:getNestItems', (nx)         => db.getNestItems(nx));
h('module:get',         (id)          => db.getModule(id));
h('module:create',      (data)        => db.createModule(data));
h('module:update',      (id,data)     => db.updateModule(id,data));
h('module:updateDescription', (id,d)  => db.updateModuleDescription(id,d));
h('module:delete',      (id)          => db.deleteModule(id));
// v5 Part 7 (§11.4): the trash — a deleted module is kept as a snapshot.
h('trash:module',  (nx, id)  => db.trashModule(nx, id));
h('trash:list',    (nx)      => db.listTrash(nx));
h('trash:restore', (nx, id)  => db.restoreTrash(nx, id));
h('trash:delete',  (nx, id)  => db.deleteTrash(nx, id));
h('trash:empty',   (nx)      => db.emptyTrash(nx));
// v5 Part 7 (§11.4): content search (FTS5 trigram, LIKE fallback).
h('search:rebuild', (nx)     => db.rebuildSearch(nx, true));
h('search:query',   (nx, qy) => db.searchContent(nx, qy));

// v5 Part 7 (§11.5): Diviner — random tables and dice.
h('diviner:getTables',   (mref)          => db.getDivinerTables(mref));
h('diviner:tablesInNexus', (nx)          => db.getDivinerTablesInNexus(nx));
h('diviner:createTable', (mref,n,dc,md)  => db.createDivinerTable(mref,n,dc,md));
h('diviner:updateTable', (id,n,dc,md)    => db.updateDivinerTable(id,n,dc,md));
h('diviner:deleteTable', (id)            => db.deleteDivinerTable(id));
h('diviner:getEntries',  (tref)          => db.getDivinerEntries(tref));
h('diviner:createEntry', (tref,tx,k)     => db.createDivinerEntry(tref,tx,k));
h('diviner:updateEntry', (id,e)          => db.updateDivinerEntry(id,e));
h('diviner:deleteEntry', (id)            => db.deleteDivinerEntry(id));
h('diviner:moveEntry',   (id,dir)        => db.moveDivinerEntry(id,dir));
h('diviner:roll',        (tref)          => db.rollDivinerTable(tref));
h('diviner:rollDice',    (expr)          => db.rollDiceOnly(expr));
h('diviner:getRolls',    (tref)          => db.getDivinerRolls(tref));
h('diviner:clearRolls',  (tref)          => db.clearDivinerRolls(tref));
h('diviner:wouldCycle',  (tref,target)   => db.divinerWouldCycle(tref,target));

// v5 Part 7 (§11.7): a whole project from one spec, in one transaction.
h('bundle:create', (nx, parent, spec) => db.createBundle(nx, parent, spec));
// v5 Part 7 (§11.10): the Problems panel.
h('tools:problems', (nx) => db.listProblems(nx));
// CSV → Classifier: pick and read here (the renderer cannot touch files);
// the Classifier itself is made through bundle:create.
h('tools:csvPick', async () => {
  const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'CSV', properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv', 'tsv', 'txt'] }],
  });
  if (r.canceled || !r.filePaths?.[0]) return { ok: false, canceled: true };
  const out = db.readCsvFile(r.filePaths[0]);
  return { ...out, name: path.basename(r.filePaths[0]).replace(/\.(csv|tsv|txt)$/i, '') };
});
// §11.8: the guide's spec for a locale (installed PKG guide › bundled › English).
h('bundle:guide',  (locale)          => db.guideSpec(locale));
// The genre bundles, vendored from DraconDex-SDB and resolved in the UI language.
h('bundle:catalog', (locale)         => db.bundleCatalog(locale));
// Procress 14 (APP docs/TEMPLATES.md §3–§4): page templates and the user's own bundles.
h('bundle:saveMine', (nx, folderId, name, opts) => db.saveBundle(nx, folderId, name, opts));
h('bundle:listMine', (nx)          => db.listBundles(nx));
h('template:catalog', (locale)     => db.pageCatalog(locale));
h('template:apply',  (mid, tpl, opts) => db.applyTemplate(mid, tpl, opts));
h('template:restore', (mid, old)   => db.restorePageLayout(mid, old));

// v5 Part 7 (§11.4): the whole Nexus as .md files in a .zip — export only.
h('nexus:exportMarkdown', async (id) => {
  const n = db.getNexus(id);
  if (!n) return { ok: false, code: 'not_found' };
  const safe = String(n.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Markdown', defaultPath: path.join(app.getPath('documents'), `${safe}-markdown.zip`),
    filters: [{ name: 'Markdown (.zip)', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return db.exportNexusMarkdown(id, result.filePath);
});
// v5 Part 8 (§12.13): a website of pages — the walk, then the zip.
h('htmlExport:collect', (nx,key,depth) => db.collectPages(nx,key,depth));
h('htmlExport:write', async (nx, payload) => {
  const n = db.getNexus(nx);
  if (!n) return { ok: false, code: 'not_found' };
  const safe = String(n.name || 'nexus').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export HTML', defaultPath: path.join(app.getPath('documents'), `${safe}-site.zip`),
    filters: [{ name: 'Website (.zip)', extensions: ['zip'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return db.exportHtmlSite(result.filePath, payload, nx);
});
// Procress 14 (EXPORT-DECOR.md E1): PDF. db/pdf-export.js makes one print
// document from the pages the renderer drew; it is printed in a hidden
// window with JavaScript off, no preload and a session of its own (the
// web-contents-created lockdown above covers it too), then closed.
h('export:pdf', async (nx, payload, opts) => {
  const doc = db.buildPrintHtml(payload, nx);
  if (!doc.ok) return doc;
  const safe = String(payload?.title || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'export';
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export PDF', defaultPath: path.join(app.getPath('documents'), `${safe}.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const tmp = path.join(app.getPath('temp'), `ddx-print-${process.pid}-${Date.now()}.html`);
  const win = new BrowserWindow({
    show: false, width: 1100, height: 1400,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'ddx-print', spellcheck: false },
  });
  try {
    fs.writeFileSync(tmp, doc.html, 'utf8');
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF(db.pdfOptions(opts || {}, payload?.title || ''));
    fs.writeFileSync(result.filePath, pdf);
    return { ok: true, saved: result.filePath, pages: doc.pages, missing: doc.missing, bytes: pdf.length };
  } catch (err) {
    console.error('export:pdf', err);
    return { ok: false, code: 'print_failed' };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
});
// Procress 14 (EXPORT-DECOR.md E4): a Classifier / Chronicler as a table.
// The renderer names the module and the format; main reads the vault.
h('export:table', async (moduleId, format) => {
  const m = db.getModule(moduleId);
  if (!m || !['csv', 'xlsx'].includes(format)) return { ok: false, code: 'not_found' };
  const safe = String(m.name || 'table').replace(/[\\/:*?"<>|]/g, '_');
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: format === 'csv' ? 'Export CSV' : 'Export Excel', defaultPath: path.join(app.getPath('documents'), `${safe}.${format}`),
    filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Excel', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return { ...db.exportTable(moduleId, format, result.filePath), saved: result.filePath };
});
h('module:duplicate',   (id)          => db.duplicateModule(id));
h('module:move',        (nx,id,parentId,ids) => db.moveModule(nx,id,parentId,ids));
h('module:normalizeReport', ()        => db.takeParentNormalizeReport());
h('module:count',       (nx)          => db.countModules(nx));
h('module:getUi',       (id)          => db.getModuleUi(id));
h('module:setUi',       (id,k,v)      => db.setModuleUi(id,k,v));
h('module:getTags',     (id)          => db.getModuleTags(id));
h('module:setTags',     (id,tags)     => db.setModuleTags(id,tags));
h('module:getLinks',    (id)          => db.getModuleLinks(id));
h('module:getProps',    (id,item)     => db.getPageProps(id,item));

// v5 Part 8 (§12) — pages made of blocks (db/page-block.js).
h('block:list',     (id,item)       => db.listBlocks(id,item));
h('block:ensure',   (id,item,defs)  => db.ensurePage(id,item,defs));
h('block:add',      (id,item,b)     => db.addBlock(id,item,b));
h('block:get',      (id)            => db.getBlock(id));
h('block:update',   (id,patch)      => db.updateBlock(id,patch));
h('block:move',     (id,to)         => db.moveBlock(id,to));
h('block:remove',   (id)            => db.deleteBlock(id));
h('block:restore',  (rows)          => db.restoreBlocks(rows));
h('block:split',    (id,item)       => db.splitItemPage(id,item));
h('block:revert',   (id,item)       => db.revertItemPage(id,item));
h('block:setProp',  (id,item,pid,n,v,tp) => db.setProp(id,item,pid,n,v,tp));

// Process 7 part 2 — app-wide session undo/redo (Ctrl+Z/Ctrl+Shift+Z),
// scoped to the active vault the same way every handler above is.
h('history:undo', () => db.historyUndo());
h('history:redo', () => db.historyRedo());

// Category "Classifier" (v3 Phase 5)
h('classifier:setCatType',        (id,ct)              => db.setCatType(id,ct));
h('classifier:getObjects',        (mref)                => db.getObjects(mref));
h('classifier:getObjectsFull',    (mref)                => db.getObjectsFull(mref));
h('classifier:createObject',      (mref,n,c,ic)         => db.createObject(mref,n,c,ic));
h('classifier:updateObject',      (id,n,c,ic)           => db.updateObject(id,n,c,ic));
h('classifier:deleteObject',      (id)                  => db.deleteObject(id));
h('classifier:duplicateObject',   (id,n)                => db.duplicateObject(id,n));
h('classifier:moveObject',        (id,mref)             => db.moveObject(id,mref));
h('classifier:getTemplates',      (mref)                => db.getTemplates(mref));
h('classifier:getObjectTemplates',(mref,oref)           => db.getObjectTemplates(mref,oref));
h('classifier:createTemplate',    (mref,d,t,lv,c,oref,op) => db.createTemplate(mref,d,t,lv,c,oref,op));
h('classifier:updateTemplate',    (id,d,t,lv,c,op)      => db.updateTemplate(id,d,t,lv,c,op));
h('classifier:deleteTemplate',    (id)                  => db.deleteTemplate(id));
h('classifier:getAttrs',          (oid)                 => db.getAttrs(oid));
h('classifier:upsertAttr',        (oid,tid,v)           => db.upsertAttr(oid,tid,v));
h('classifier:getLevels',         (oid)                 => db.getLevels(oid));
h('classifier:createLevel',       (oid,tid)             => db.createLevel(oid,tid));
h('classifier:updateLevelField',  (id,f,v)              => db.updateLevelField(id,f,v));
h('classifier:deleteLevel',       (id)                  => db.deleteLevel(id));
h('classifier:moveLevels',        (oid,tid,ids)         => db.moveLevels(oid,tid,ids));

// TimeMap "Wanderer" (v3 Phase 9) — MapEvent Link pins
h('wanderer:list',   (mref)                     => db.getMapEvents(mref));
h('wanderer:create', (mref,ev,key,px,py,ar)     => db.createMapEvent(mref,ev,key,px,py,ar));
h('wanderer:update', (id,ev,key,px,py,ar)       => db.updateMapEvent(id,ev,key,px,py,ar));
h('wanderer:setLabel', (id,label)               => db.setMapEventLabel(id,label));
h('wanderer:delete', (id)                       => db.deleteMapEvent(id));

// Story "Narrator" (v3 Phase 10) — Dialogue route board
h('narrator:getDialogues',   (mref)             => db.getDialogues(mref));
h('narrator:createDialogue', (mref,n,c,px,py)   => db.createDialogue(mref,n,c,px,py));
h('narrator:updateDialogue', (id,n,c)           => db.updateDialogue(id,n,c));
h('narrator:updateDialogueDescription', (id,desc) => db.updateDialogueDescription(id,desc));
h('narrator:updateDialoguePos', (id,px,py)      => db.updateDialoguePos(id,px,py));
h('narrator:deleteDialogue', (id)               => db.deleteDialogue(id));
h('narrator:getEdges',       (mref)             => db.getEdges(mref));
h('narrator:createEdge',     (mref,f,to,lb)     => db.createEdge(mref,f,to,lb));
h('narrator:updateEdgeLabel',(id,lb)            => db.updateEdgeLabel(id,lb));
h('narrator:deleteEdge',     (id)               => db.deleteEdge(id));
h('narrator:getTalks',       (did)              => db.getTalks(did));
h('narrator:createTalk',     (did,sp,tx,lk,ty)  => db.createTalk(did,sp,tx,lk,ty));
h('narrator:updateTalk',     (id,sp,tx,lk)      => db.updateTalk(id,sp,tx,lk));
h('narrator:deleteTalk',     (id)               => db.deleteTalk(id));
h('narrator:moveTalks',      (did,ids)          => db.moveTalks(did,ids));
h('narrator:getChoiceOptions',   (did)          => db.getChoiceOptions(did));
h('narrator:createChoiceOption', (tid,tx)       => db.createChoiceOption(tid,tx));
h('narrator:updateChoiceOption', (id,tx,k,ef,j) => db.updateChoiceOption(id,tx,k,ef,j));
h('narrator:deleteChoiceOption', (id)           => db.deleteChoiceOption(id));
h('narrator:setChoiceLogic',     (id,c,s)       => db.setChoiceOptionLogic(id,c,s));
h('narrator:variables',          (nx)           => db.getStoryVariables(nx));

// Book "Author" (v3 Phase 11) — chapters
h('author:getChapters',    (mref)      => db.getBookChapters(mref));
h('author:createChapter',  (mref,n)    => db.createBookChapter(mref,n));
h('author:renameChapter',  (id,n)      => db.renameBookChapter(id,n));
h('author:updateContent',  (id,c)      => db.updateBookChapterContent(id,c));
h('author:deleteChapter',  (id)        => db.deleteBookChapter(id));
h('author:setChapterLabel', (id,lb)    => db.setBookChapterLabel(id,lb));
h('author:moveChapter',    (mref,ids)  => db.moveBookChapter(mref,ids));
h('author:setChapterMeta', (id,meta)   => db.setBookChapterMeta(id,meta));

// Chat "Scribe" (v3 Phase 12) — sessions + bubble messages
h('chatscribe:getSessions',   (mref)   => db.getChatSessions(mref));
h('chatscribe:createSession', (mref,n) => db.createChatSession(mref,n));
h('chatscribe:renameSession', (id,n)   => db.renameChatSession(id,n));
h('chatscribe:deleteSession', (id)     => db.deleteChatSession(id));
h('chatscribe:getMessages',   (sref)   => db.getChatMessages(sref));
h('chatscribe:createMessage', (sref,t) => db.createChatMessage(sref,t));
h('chatscribe:updateMessage', (id,t)   => db.updateChatMessage(id,t));
h('chatscribe:deleteMessage', (id)     => db.deleteChatMessage(id));
h('chatscribe:updateMessageStyle', (id,c,s) => db.updateMessageStyle(id,c,s));

// Analys "Viewer" / Relation "Connector" (v3 Phase 14)
// Calendar templates (Process 8 part 1)
h('calendar:listTemplates',  (nx)          => db.listCalendarTemplates(nx));
h('calendar:saveTemplate',   (nx,n,spec)   => db.saveCalendarTemplate(nx,n,spec));
h('calendar:deleteTemplate', (id)          => db.deleteCalendarTemplate(id));
h('calendar:ensureBuiltin',  (nx,n,spec)   => db.ensureBuiltinCalendarTemplate(nx,n,spec));
h('viewer:index',          (nx)         => db.viewerIndex(nx));
h('viewer:getRelations',   (nx)         => db.getEntityRelations(nx));
h('viewer:createRelation', (nx,f,tk,l,c,o) => db.createEntityRelation(nx,f,tk,l,c,o || {}));
h('viewer:updateRelation', (id,l,c,o)     => db.updateEntityRelation(id,l,c,o));
h('viewer:deleteRelation', (id)         => db.deleteEntityRelation(id));
h('viewer:relationTypes',  (nx)         => db.getRelationTypes(nx));
// Exhibitor scene (v5 Part 2)
h('exhibitor:scene',       (mid)        => db.getExhibitScene(mid));
h('exhibitor:addNodes',    (mid, ns)    => db.addExhibitNodes(mid, ns));
h('exhibitor:updateNode',  (id, patch)  => db.updateExhibitNode(id, patch));
h('exhibitor:moveNodes',   (moves)      => db.moveExhibitNodes(moves));
h('exhibitor:deleteNode',  (id)         => db.deleteExhibitNode(id));
h('exhibitor:setView',     (mid, patch) => db.setExhibitView(mid, patch));
h('exhibitor:findFor',     (mid)        => db.findExhibitorFor(mid));
h('exhibitor:dedupeReport', ()          => db.takeRelationDedupeReport());

// Drawing "Sketcher" (v3 Phase 15) — pages, strokes, pins, PNG export
h('sketcher:getPages',     (mref)       => db.getSketchPages(mref));
h('sketcher:createPage',   (mref,n)     => db.createSketchPage(mref,n));
h('sketcher:renamePage',   (id,n)       => db.renameSketchPage(id,n));
h('sketcher:movePage',     (id,dir)     => db.moveSketchPage(id,dir));
h('sketcher:deletePage',   (id)         => db.deleteSketchPage(id));
h('sketcher:getStrokes',   (pref)       => db.getSketchStrokes(pref));
h('sketcher:addStroke',    (pref,c,w,pts) => db.createSketchStroke(pref,c,w,pts));
h('sketcher:deleteStroke', (id)         => db.deleteSketchStroke(id));
h('sketcher:getPins',      (pref)       => db.getSketchPins(pref));
h('sketcher:addPin',       (pref,k,px,py) => db.createSketchPin(pref,k,px,py));
h('sketcher:movePin',      (id,px,py)   => db.moveSketchPin(id,px,py));
h('sketcher:deletePin',    (id)         => db.deleteSketchPin(id));
// Import Dock (v3 Phase 18) — folder import, file<->linker, viewers.
// v5 Asset Nest (APP docs/V5.md §2): assets live in module nodes, four asset
// classes (asset-media.js), URL assets, a stat/hash/thumbnail sweep, relink.
const IMPORT_EXTS = new Set(Object.keys(ASSET_CLASS));
const IMAGE_EXTS = new Set(Object.keys(ASSET_CLASS).filter((e) => ASSET_CLASS[e] === 'image'));
// Roots the USER actually chose through a dialog this session. importdock:add
// takes absolute paths straight from the renderer and import_file rows are
// later read back as bytes (importdock:readFile / readFiles and the
// ddx-file:// protocol handler), so without this a compromised renderer could
// register any file on disk — `C:\Users\…\anything` declared as type 'png' —
// and then simply read it. Registration is confined to what a dialog returned.
const pickedImportRoots = new Set();

const isUnderPickedRoot = (p) => {
  let abs;
  try { abs = path.resolve(String(p || '')); } catch (_) { return false; }
  for (const root of pickedImportRoots) {
    const rel = path.relative(root, abs);
    // path.relative rather than a string prefix, so `<root>-evil` can't pass
    // as `<root>` — same idiom as db.pluginByPanelPath.
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
};

const pickDirectory = async () => {
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), { properties: ['openDirectory'] });
  return res.canceled || !res.filePaths?.length ? null : res.filePaths[0];
};

// Walk a picked folder. Every file carries `folder` (the provenance string
// the flat Dock always stored) and `dir` (its directory as a path array
// starting at the root's own name) — importFolderTree turns the latter into
// collector modules. dirs lists only directories that hold an importable
// file somewhere below them, and dot-directories are skipped, so a picked
// project folder does not sprout a collector per .git subfolder.
function walkImportFolder(root) {
  const rootName = path.basename(root);
  const files = [];
  const dirs = [];
  const walk = (dir, segs) => {
    let found = false;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.')) continue;
        if (walk(p, [...segs, ent.name])) found = true;
        continue;
      }
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!IMPORT_EXTS.has(ext)) continue;
      let size = 0;
      try { size = fs.statSync(p).size; } catch (_) {}
      files.push({
        name: ent.name, path: p, type: ext, size, dir: segs,
        folder: rootName + (dir === root ? '' : '/' + path.relative(root, dir).replace(/\\/g, '/')),
      });
      found = true;
    }
    if (found) dirs.push(segs);
    return found;
  };
  walk(root, [rootName]);
  // Parents before children, so a collector's parent always exists first.
  dirs.sort((a, b) => a.length - b.length);
  return { rootName, dirs, files };
}

h('importdock:list',          (nx)     => db.getImportFiles(nx));
h('importdock:get',           (id)     => db.getImportFile(id));
h('importdock:add', (nx, fs2, moduleRef) => {
  const clean = (Array.isArray(fs2) ? fs2 : []).filter((f) => isUnderPickedRoot(f?.path)).map((f) => ({
    name: String(f.name || path.basename(String(f.path))),
    path: String(f.path),
    size: Number(f.size) || 0,
    folder: f.folder == null ? null : String(f.folder),
    // Derived here, never taken from the renderer: file_type decides which
    // reader will later serve the bytes, so letting the caller pick it would
    // re-open the same hole from the other side.
    type: path.extname(String(f.path || '')).slice(1).toLowerCase(),
  })).filter((f) => IMPORT_EXTS.has(f.type));
  return db.addImportFiles(nx, clean, moduleRef ?? null);
});
h('importdock:setLinker',     (id,k)   => db.setImportLinker(id,k));
h('importdock:setUseAsImage', (id,on)  => db.setImportUseAsImage(id,on));
h('importdock:setModule',     (id,m)   => db.setImportModule(id, m ?? null));
h('importdock:moduleAssets',  (mid)    => db.getModuleAssets(mid));
h('importdock:nestAssets',    (nx)     => db.getNestAssets(nx));
h('importdock:delete',        (id)     => db.deleteImportFile(id));
h('importdock:displayImages', (nx)     => db.getDisplayImages(nx));
// Kept for the flat-file path (and Part 4's locate-nexus, which reuses the
// dialog + guard): returns the walk, registers nothing.
h('importdock:pickFolder', async () => {
  const root = await pickDirectory();
  if (!root) return { canceled: true };
  // The user picked it, so anything under it may be registered later.
  pickedImportRoots.add(path.resolve(root));
  const { rootName, files } = walkImportFolder(root);
  return { folder: rootName, files };
});
// §2.3 "locate folder asset": pick a folder, mirror its directory tree as
// collector modules under parentModuleId (null = top level), file each asset
// into its own folder's collector. The walk never leaves main, so there is
// no renderer-supplied path to vet.
h('importdock:importFolder', async (nx, parentModuleId) => {
  const root = await pickDirectory();
  if (!root) return { canceled: true };
  pickedImportRoots.add(path.resolve(root));
  const { dirs, files } = walkImportFolder(root);
  return db.importFolderTree(nx, parentModuleId ?? null, dirs, files);
});
// ─── Locate Nexus (v5 Part 4, APP docs/V5.md §8.5–§8.6) ──────────────────
// One sync, both directions (§8.11.4): folders the user made on disk come in
// as collectors — and their files as assets — through the same
// importFolderTree the Dock's folder import uses, then the vault is written
// back out as folders + .mddx files (db/mirror.js). The locate root joins
// pickedImportRoots, the same guard every other picked folder goes through.
function syncLocate(nx) {
  const v = db.getNexus(nx);
  if (!v?.locate_dir) return { ok: false, code: 'no_dir' };
  if (v.locate_missing) return { ok: false, code: 'missing' };
  const root = path.resolve(v.locate_dir);
  pickedImportRoots.add(root);
  // walkImportFolder names its first segment after the root; the root IS
  // the Nexus top level here, so that segment is dropped.
  const { dirs, files } = walkImportFolder(root);
  const sub = dirs.map((segs) => segs.slice(1)).filter((segs) => segs.length);
  const inFolders = files.map((f) => ({ ...f, dir: f.dir.slice(1) }));
  const imported = sub.length || inFolders.length ? db.importFolderTree(nx, null, sub, inFolders) : null;
  return { ...db.syncNexusMirror(nx), imported };
}
h('nexus:locatePick', async (nx) => {
  const root = await pickDirectory();
  if (!root) return { canceled: true };
  db.setVaultLocateDir(nx, path.resolve(root));
  return syncLocate(nx);
});
h('nexus:locateSync',   (nx) => syncLocate(nx));
h('nexus:locateForget', (nx) => { db.setVaultLocateDir(nx, null); return true; });
// Opens only the folder the registry holds, never a path from the renderer.
h('nexus:locateOpen', async (nx) => {
  const v = db.getNexus(nx);
  if (!v?.locate_dir || v.locate_missing) return false;
  return (await shell.openPath(v.locate_dir)) === '';
});

// URL assets (§2.6): metadata + shell.openExternal only. connect-src 'none'
// and frame-src 'none' stay exactly as they are — no preview, no embed.
h('importdock:addUrl', (nx, url, name, moduleRef) => {
  const u = normalizeAssetUrl(url);
  if (!u) return { error: 'invalid_url' };
  const label = String(name || '').trim() || new URL(u).hostname;
  return { id: db.addImportUrl(nx, u, label, moduleRef ?? null) };
});
// Opens only what the ROW says, never a URL the renderer hands over, and
// re-validates the scheme on the way out.
h('importdock:openUrl', async (id) => {
  const f = db.getImportFile(id);
  const u = f && f.source_kind === 'url' ? normalizeAssetUrl(f.file_path) : null;
  if (!u) return false;
  await shell.openExternal(u);
  return true;
});
// A Classifier url field (v5 Part 7, §11.3) — same rule as a URL asset:
// main opens what the STORED value says, re-validated, never a string the
// renderer hands over.
h('classifier:openUrl', async (objectId, templateId) => {
  const v = db.getAttrValue(objectId, templateId);
  const u = v != null ? normalizeAssetUrl(v) : null;
  if (!u) return false;
  await shell.openExternal(u);
  return true;
});
// PDFs (and anything else without an in-app reader) open in the OS default
// app — object-src/frame-src 'none' rule out an embedded viewer. Registered
// rows only, and only an importable type: file_type is derived in main and a
// relink must keep the extension, so this can never launch an executable.
h('importdock:openPath', async (id) => {
  const f = db.getImportFile(id);
  const ext = (f?.file_type || '').toLowerCase();
  if (!f || f.source_kind !== 'file' || !IMPORT_EXTS.has(ext)
      || path.extname(f.file_path).slice(1).toLowerCase() !== ext) return false;
  return !(await shell.openPath(f.file_path));
});
// Content is only served for files already registered in import_file.
h('importdock:readFile', async (id) => {
  const f = db.getImportFile(id);
  if (!f) return null;
  if (f.source_kind === 'url') return { kind: 'url', url: f.file_path };
  const ext = (f.file_type || '').toLowerCase();
  const cls = assetClassOf(ext);
  try {
    await fs.promises.access(f.file_path);
  } catch (_) {
    // §2.5: the original is gone but the row (and its proxy, if any) stays —
    // the viewer shows the proxy with a Relink button instead of an error.
    return { kind: 'missing', cls, hasProxy: !!f.has_proxy };
  }
  try {
    // Images, audio and video carry no payload — the viewer points the
    // element at ddx-file://<id>, which streams with Range support.
    if (cls === 'image' || cls === 'audio' || cls === 'video') return { kind: cls };
    if (ext === 'pdf') return { kind: 'pdf' };
    if (ext === 'md' || ext === 'txt') return { kind: ext, text: await fs.promises.readFile(f.file_path, 'utf8') };
    return { kind: 'binary' };
  } catch (e) {
    return { kind: 'error', message: String(e.message || e) };
  }
});
// Batched image read (Plan part2 #2.2) — the fallback path for renderers
// where ddx-file:// isn't available (the Playwright web-driver harness loads
// index.html over plain file:// with no Electron protocol registered). One
// round-trip and one parallel read wave for the whole set instead of the
// per-image sequential await hydrateDisplayImages used to do. Returns
// {id: dataUrl}; ids that aren't registered images are simply absent.
h('importdock:readFiles', async (ids) => {
  const out = {};
  await Promise.all((ids || []).map(async (id) => {
    const f = db.getImportFile(id);
    if (!f) return;
    const ext = (f.file_type || '').toLowerCase();
    if (!IMAGE_EXTS.has(ext)) return;
    try {
      out[id] = `data:${mimeOf(ext)};base64,${(await fs.promises.readFile(f.file_path)).toString('base64')}`;
    } catch (_) { /* unreadable/moved file — leave it out, renderer shows the empty state */ }
  }));
  return out;
});

// ── Asset sweep (§2.5) ─────────────────────────────────────────────────────
// stat every file asset (missing flag + last_seen_at), hash the ones never
// hashed, and build a cover proxy for images that have none. Async fs work
// between synchronous one-row db writes, so it never blocks the main process
// for long; the renderer runs it once per vault per session and after every
// import. One sweep per vault at a time.
const hashFile = (p) => new Promise((resolve) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(p).on('error', () => resolve(null))
    .on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex')));
});

// ≤512px JPEG, stepped down until it fits the per-file cap. JPEG drops
// transparency, which a cover thumbnail can afford. SVG (nativeImage can't
// decode it, and it is small and scalable anyway) and anything undecodable
// get no proxy. Audio/video posters are deferred — they need a decoder the
// app does not ship; the renderer shows the class icon instead.
function makeImageProxy(p) {
  const img = nativeImage.createFromPath(p);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  for (const [edge, q] of [[512, 80], [512, 60], [256, 60]]) {
    const dims = width >= height ? { width: Math.min(edge, width) } : { height: Math.min(edge, height) };
    const buf = img.resize({ ...dims, quality: 'good' }).toJPEG(q);
    if (buf.length <= PROXY_MAX_BYTES) return buf;
  }
  return null;
}

const sweepsRunning = new Set();
h('importdock:sweep', async (nx) => {
  if (nx == null || sweepsRunning.has(nx)) return { busy: true };
  sweepsRunning.add(nx);
  const stats = { checked: 0, missing: 0, changed: 0, hashed: 0, proxied: 0 };
  try {
    for (const r of db.getSweepRows(nx)) {
      stats.checked++;
      let st = null;
      try { st = await fs.promises.stat(r.file_path); if (!st.isFile()) st = null; } catch (_) {}
      if (!st) stats.missing++;
      if (!!r.missing !== !st || (st && !r.last_seen_at)) {
        db.markImportSeen(r.id, !!st);
        if (!!r.missing !== !st) stats.changed++;
      }
      if (!st) continue;
      if (!r.sha256) {
        const hex = await hashFile(r.file_path);
        if (hex) { db.setImportHash(r.id, hex, st.size); stats.hashed++; }
      }
      const ext = (r.file_type || '').toLowerCase();
      if (r.needs_proxy && assetClassOf(ext) === 'image' && ext !== 'svg' && st.size <= LARGE_BYTES) {
        let buf = null;
        try { buf = makeImageProxy(r.file_path); } catch (_) {}
        if (buf && db.setImportProxy(r.id, buf, 'image/jpeg')) stats.proxied++;
      }
    }
  } finally {
    sweepsRunning.delete(nx);
  }
  return stats;
});

// ── Relink (§2.5) ──────────────────────────────────────────────────────────
// The dialog runs here, so the new path always comes from the user, never
// from the renderer. A hash mismatch is parked in pendingRelink and needs a
// second, explicit call — the renderer confirms, it does not supply a path.
const pendingRelink = new Map();
const sameExt = (p, ext) => path.extname(p).slice(1).toLowerCase() === String(ext || '').toLowerCase();

h('importdock:relink', async (id) => {
  const f = db.getImportFile(id);
  if (!f || f.source_kind !== 'file') return { error: 'not_file' };
  const ext = (f.file_type || '').toLowerCase();
  const res = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    properties: ['openFile'], filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (res.canceled || !res.filePaths?.length) return { canceled: true };
  const p = res.filePaths[0];
  if (!sameExt(p, ext)) return { error: 'type' };
  const st = await fs.promises.stat(p);
  const hex = await hashFile(p);
  if (f.sha256 && hex && hex !== f.sha256) {
    pendingRelink.set(id, { path: p, size: st.size, hex });
    return { mismatch: true };
  }
  db.relinkImportFile(id, p, st.size);
  if (hex) db.setImportHash(id, hex, st.size);
  return { ok: true };
});
h('importdock:relinkConfirm', (id) => {
  const pend = pendingRelink.get(id);
  pendingRelink.delete(id);
  if (!pend) return { error: 'none' };
  db.relinkImportFile(id, pend.path, pend.size);
  if (pend.hex) db.setImportHash(id, pend.hex, pend.size);
  return { ok: true };
});
// Folder relink: every missing asset of this vault is matched by file name
// + extension inside the picked folder, and — when the row was ever hashed —
// by sha256 as well, so two different "cover.png"s never swap places. An
// unhashed row relinks only on a unique name match.
h('importdock:relinkFolder', async (nx) => {
  const root = await pickDirectory();
  if (!root) return { canceled: true };
  pickedImportRoots.add(path.resolve(root));
  const byName = new Map();
  for (const f of walkImportFolder(root).files) {
    const k = f.name.toLowerCase();
    (byName.get(k) || byName.set(k, []).get(k)).push(f);
  }
  let relinked = 0;
  const missing = db.getMissingImports(nx);
  for (const m of missing) {
    const cands = (byName.get(String(m.file_name).toLowerCase()) || []).filter((c) => sameExt(c.path, m.file_type));
    let hit = null;
    if (m.sha256) {
      for (const c of cands) if (await hashFile(c.path) === m.sha256) { hit = c; break; }
    } else if (cands.length === 1) {
      hit = cands[0];
    }
    if (hit) { db.relinkImportFile(m.id, hit.path, hit.size); relinked++; }
  }
  return { relinked, remaining: missing.length - relinked };
});

// Version control (v3 Phase 21)
h('versions:list',    (mref) => db.listVersions(mref));
h('versions:restore', (id)   => db.restoreVersion(id));
// setting:get/set are a GENERIC key/value door into app_setting, which is
// also where Drive/Sync park their refresh tokens and OAuth client secret.
// Unrestricted, one line of renderer-side script execution turns into
// `api.setting.get('drive:refreshToken')` and walks off with the user's
// Google credentials. The renderer only ever asks for one key (verified:
// every api.setting.* call site passes a literal, and 'versionLimit' is the
// only one), so this is an allowlist rather than a denylist — a new secret
// key added later is closed by default instead of open by default.
const RENDERER_SETTING_KEYS = new Set(['versionLimit', 'startupMode', 'nexusHistoryLimit']);
// Two gates, not one. The allowlist is the rule; isSecretKey() is the backstop
// that survives someone widening the allowlist later without noticing they
// just handed the renderer a refresh token. Cloud-provider credentials are
// keyed by provider id (cloud:<id>:refreshToken, …) and so cannot be
// enumerated in a set — isSecretKey matches them by shape.
const rendererSettingAllowed = (k) => RENDERER_SETTING_KEYS.has(String(k)) && !isSecretKey(k);
h('setting:get',      (k)    => (rendererSettingAllowed(k) ? db.getAppSetting(k) : null));
h('setting:set',      (k,v)  => (rendererSettingAllowed(k) ? db.setAppSetting(k,v) : { ok: false }));

// History limit (Procress 10 part 1) — byte usage + clear for whichever
// vault this window has open; see db/versions.js's historyBytesUsed for why
// none of these take a nexus id.
h('history:bytesUsed',   () => db.historyBytesUsed());
h('history:clearModule', () => { db.clearModuleHistory(); return { ok: true }; });
h('history:clearNexus',  () => { db.clearNexusHistory(); return { ok: true }; });
h('history:clearAll',    () => { db.clearAllHistory(); return { ok: true }; });

// Cloud sync — Token Sync (Supabase) — snapshot push/pull per vault slot
h('sync:getConfig',     ()             => db.getSyncConfig());
h('sync:setConfig',     (u,k)          => db.setSyncConfig(u,k));
h('sync:googleLogin',   (u,t)          => db.syncGoogleLogin(u,t));
h('sync:googleLogout',  ()             => db.syncGoogleLogout());
h('sync:authStatus',    ()             => db.syncAuthStatus());
h('sync:status',        (nx)           => db.syncStatus(nx));
h('sync:push',          (nx,pw)        => db.syncPushVault(nx,pw));
h('sync:pull',          (nx,vaultId)   => db.syncPullVault(nx,vaultId));
h('sync:pullByToken',   (nx,tok,pw)    => db.syncPullByToken(nx,tok,pw));
h('sync:deleteUpload',  (vaultId)      => db.syncDeleteUpload(vaultId));

// DDX Transfer (src/db/transfer.js) — hand a whole Nexus to another device
// through the service in ZYDRAXYL/DraconDex-TRX. Unlike sync:*, there is no
// account and no config step, so there is nothing to log in to here.
//
// The transfer key never crosses this boundary in either direction: the main
// process makes it, keeps it, and hands the renderer a QR/link string with it
// already embedded in the fragment. `transfer:receive` takes the nexus to
// apply into as an explicit argument for the same reason db:importNexusFile
// does — applySnapshot is wipe-and-rebuild, and the ambient current nexus is
// the wrong thing to trust across a network round trip (see the runWithVault
// note above and src/db/vault-context.js).
h('transfer:getConfig', ()                  => db.getTransferConfig());
h('transfer:setConfig', (url)               => db.setTransferConfig(url));
h('transfer:send',      (nx, opts)          => db.transferSend(nx, opts || {}));
h('transfer:status',    (id)                => db.transferStatus(id));
h('transfer:cancel',    (id)                => db.transferCancel(id));
h('transfer:verify',    (code, pin, linkKey) => db.transferVerify(code, pin, linkKey || null));
h('transfer:receive',   (id, targetNexusId) => db.transferReceive(id, targetNexusId));

// "Bring your own Supabase project" setup — check the user's own project and
// install the schema Cloud Sync needs (src/db/supabase-setup.js). The access
// token supabase:install takes is used for that one Management API call and is
// never stored, so it is a plain argument rather than a setting.
h('supabase:getSetup',   ()        => db.getSupabaseSetup());
h('supabase:setSetup',   (u,k)     => db.setSupabaseSetup(u,k));
h('supabase:clearSetup', ()        => db.clearSupabaseSetup());
h('supabase:getSql',     ()        => db.getSupabaseSetupSql());
h('supabase:check',      (u,k)     => db.checkSupabaseProject(u,k));
h('supabase:install',    (tok,u,k) => db.installSupabaseSchema(tok,u,k));
h('supabase:openDash',   (page)    => db.openSupabaseDashboard(page));

// Google Drive appdata backup — independent Google login from Sync's
h('drive:getConfig',       ()      => db.getDriveConfig());
h('drive:setConfig',       (i,s)   => db.setDriveConfig(i,s));
h('drive:connect',         ()      => db.driveConnect());
h('drive:disconnect',      ()      => db.driveDisconnect());
h('drive:status',          ()      => db.driveStatus());
h('drive:setAutoBackup',   (en)    => db.driveSetAutoBackup(en));
h('drive:setBackupLayout', (en)    => db.driveSetBackupLayout(en));
h('drive:setBackupDdx',    (en)    => db.driveSetBackupDdx(en));
h('drive:backupNow',       (lyt)   => db.driveBackupNow(lyt));
h('drive:restoreLayout',   ()      => db.driveRestoreLayoutProfile());
h('drive:restoreDatabase', ()      => db.driveRestoreDatabase());
h('drive:getBackupLog',    ()      => db.driveGetBackupLog());
h('drive:listLayoutSlots',   ()          => db.driveListLayoutSlots());
h('drive:saveLayoutSlot',    (name,json) => db.driveSaveLayoutSlot(name,json));
h('drive:restoreLayoutSlot', (id)        => db.driveRestoreLayoutSlot(id));
h('drive:deleteLayoutSlot',  (id)        => db.driveDeleteLayoutSlot(id));

// Cloud storage registry (v4.9.0) — the provider-agnostic surface. Google
// Drive is reachable through BOTH this and the drive:* channels above: these
// delegate to the same functions via src/db/cloud-drive.js, they do
// not reimplement anything. Every other provider is a declared stub that
// answers not_implemented; see src/db/cloud.js for the contract.
h('cloud:listProviders',   ()        => db.cloudListProviders());
h('cloud:setActive',       (id)      => db.cloudSetActive(id));
h('cloud:setPrefs',        (id,p)    => db.cloudSetProviderPrefs(id,p));
h('cloud:getConfig',       (id)      => db.cloudGetConfig(id));
h('cloud:setConfig',       (id,cfg)  => db.cloudSetConfig(id,cfg));
h('cloud:connect',         (id)      => db.cloudConnect(id));
h('cloud:disconnect',      (id)      => db.cloudDisconnect(id));
h('cloud:status',          (id)      => db.cloudStatus(id));

// GitHub Releases — app-update notice (read-only, no auto-updater)
h('update:check',        ()    => db.checkForUpdate());
h('update:dismiss',      (v)   => db.dismissUpdate(v));
h('update:openDownload', (url) => db.openUpdateDownload(url));
h('update:getAutoCheck', ()    => db.getAutoCheck());
h('update:setAutoCheck', (v)   => db.setAutoCheck(v));

// Plugins — main-app-facing surface (preview/install/list/manage). The
// pluginapi:table:* bridge plugin windows actually use is a SEPARATE surface
// below, registered with raw ipcMain.handle (never through h()) since it
// must resolve the calling plugin from event.sender, not from an argument.
// `preview` and `install` each take the pasted repo URL and nothing else —
// install re-resolves it from scratch rather than trusting the preview.
// Packages from ZYDRAXYL/DraconDex-PKG. pkg.js does its own validation of
// everything the remote catalog claims — these are pass-throughs, same as the
// plugin handlers above them.
h('pkg:list',       ()            => db.pkgList());
h('pkg:active',     ()            => db.pkgActive());
h('pkg:catalog',    (release)     => db.pkgCatalog(release));
h('pkg:install',    (id, release) => db.pkgInstall(id, release));
h('pkg:uninstall',  (id)          => db.pkgUninstall(id));
h('pkg:setEnabled', (id, on)      => db.pkgSetEnabled(id, on));

h('plugin:list',      ()    => db.pluginList());
h('plugin:listOrgRepos', () => db.pluginListOrgRepos());
h('plugin:preview',   (url) => db.pluginPreview(url));
h('plugin:install',   (url) => db.pluginInstall(url));
h('plugin:installDependency', (id, url) => db.pluginInstallDependency(id, url));
h('plugin:uninstall', (id) => {
  if (findPluginWindow(id)) return { ok: false, code: 'running' };
  return db.pluginUninstall(id);
});
h('plugin:launch', (id) => {
  const plugin = db.pluginGetById(id);
  if (!plugin) return { ok: false, code: 'not_found' };
  // A plugin that declared a dependency it doesn't have would load into a
  // half-working state and fail in its own code, with nothing to point the
  // user at. Refuse here instead — the renderer already disables the button,
  // so this is the backstop for a stale list or a direct api call.
  const missing = db.pluginMissingDeps(id);
  if (missing.length) return { ok: false, code: 'missing_dependency', missing };
  createPluginWindow(plugin);
  return { ok: true };
});
h('plugin:stop', (id) => {
  const win = findPluginWindow(id);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});
h('plugin:isRunning', (id) => !!findPluginWindow(id));

// Extensions (Procress 10 part 1) — list-only, no install/sandbox surface.
h('extension:listRepos', () => db.extensionListRepos());
// Renderer passes just the repo NAME, never a URL: the actual link is built
// here from a fixed origin, so a compromised renderer can only ever open a
// github.com/ZYDRAXYL/<name> page, never an arbitrary shell.openExternal
// target (see shell:composeMail's comment above for why that door matters).
h('extension:openRepo', (name) => {
  if (!/^[A-Za-z0-9._-]+$/.test(String(name || ''))) return { ok: false };
  shell.openExternal(`https://github.com/ZYDRAXYL/${encodeURIComponent(name)}`);
  return { ok: true };
});

// pluginApi.* bridge (preload-plugin.js) — plugin windows and plugin PANELS
// only. Resolves the calling plugin from the calling contents itself, exactly
// like window:getId above, since a compromised plugin page must never be able
// to claim a different plugin's identity by argument. Two lookups because a
// plugin can run either way: its own BrowserWindow, or a <webview> docked in
// the main window (registered by hardenWebviewAttach, which vetted the src).
function callerPluginId(event) {
  const byWindow = pluginWindows.get(BrowserWindow.fromWebContents(event.sender)?.id);
  if (byWindow) return byWindow;
  const byPanel = pluginPanelContents.get(event.sender.id);
  if (byPanel) return byPanel;
  throw new Error('not a plugin window');
}
ipcMain.handle('pluginapi:table:getSchema', (event, localName)      => db.pluginApiGetSchema(callerPluginId(event), localName));
ipcMain.handle('pluginapi:table:query',     (event, localName, f)   => db.pluginApiQuery(callerPluginId(event), localName, f));
ipcMain.handle('pluginapi:table:insert',    (event, localName, row) => db.pluginApiInsert(callerPluginId(event), localName, row));
ipcMain.handle('pluginapi:table:update',    (event, localName, id, row) => db.pluginApiUpdate(callerPluginId(event), localName, id, row));
ipcMain.handle('pluginapi:table:delete',    (event, localName, id)  => db.pluginApiDelete(callerPluginId(event), localName, id));

// pluginApi.net.* / pluginApi.oauth.* (v4.3.0). The allowlist check lives in
// src/db/plugin.js next to the manifest it reads; what main.js owns is the
// plumbing that can only be done here — delivering stream chunks back to the
// exact contents that asked, and tearing streams down when it goes away.
const pluginStreams = new Map(); // streamId -> { abort, contentsId }
let pluginStreamSeq = 0;

function stopPluginStreamsFor(contentsId) {
  for (const [streamId, s] of pluginStreams) {
    if (s.contentsId !== contentsId) continue;
    try { s.abort(); } catch (_) { /* already finished */ }
    pluginStreams.delete(streamId);
  }
}

ipcMain.handle('pluginapi:net:fetch', (event, url, init) => db.pluginNetFetch(callerPluginId(event), url, init));

ipcMain.handle('pluginapi:net:stream:start', async (event, url, init) => {
  const pluginId = callerPluginId(event);
  const contents = event.sender;
  const streamId = `s${++pluginStreamSeq}`;
  const send = (channel, ...args) => { if (!contents.isDestroyed()) contents.send(channel, streamId, ...args); };
  const abort = await db.pluginNetStream(pluginId, url, init, {
    onChunk: (text) => send('pluginapi:net:stream:chunk', text),
    onEnd: (result) => { pluginStreams.delete(streamId); send('pluginapi:net:stream:end', result); },
  });
  pluginStreams.set(streamId, { abort, contentsId: contents.id });
  return { streamId };
});

// Scoped to the caller's own streams — a plugin cannot abort another's by
// guessing an id, because the map records which contents opened each one.
ipcMain.handle('pluginapi:net:stream:abort', (event, streamId) => {
  const s = pluginStreams.get(streamId);
  if (!s || s.contentsId !== event.sender.id) return { ok: false };
  try { s.abort(); } catch (_) { /* already finished */ }
  pluginStreams.delete(streamId);
  return { ok: true };
});

ipcMain.handle('pluginapi:oauth:authorize', (event, opts) => db.pluginOAuthAuthorize(callerPluginId(event), opts));

// Legacy -> v3 migration (v3 Phase 24)
h('migrate:list',           (target,nx)  => db.listLegacyProjects(target,nx));
h('migrate:run',    (nx,target,id,ctx)   => db.migrateLegacy(nx,target,id,ctx));
h('migrate:preview',        (nx)         => db.previewLegacyMigration(nx));
h('migrate:getPromptSeen',  (nx)         => db.getLegacyPromptSeen(nx));
h('migrate:setPromptSeen',  (nx)         => db.setLegacyPromptSeen(nx));

// Sage Hut (v3 Phase 17) — vault analytics
h('sagehut:stats',      (nx) => db.sageHutStats(nx));
h('sagehut:linkerList', (nx) => db.sageHutLinkerList(nx));

// Graph "Designer" (v3 Phase 16) — diagram nodes + labeled edges
h('designer:getNodes',   (mref)             => db.getDesignNodes(mref));
h('designer:createNode', (mref,s,px,py,tx,c,k) => db.createDesignNode(mref,s,px,py,tx,c,k));
h('designer:updateNode', (id,s,tx,c)        => db.updateDesignNode(id,s,tx,c));
h('designer:resizeNode', (id,w,hh)          => db.resizeDesignNode(id,w,hh));
h('designer:setComic',   (id,k,ro)          => db.setDesignNodeComic(id,k,ro));
h('designer:renumber',   (mref,rtl)         => db.renumberDesignReadOrder(mref,rtl));
h('designer:moveNode',   (id,px,py)         => db.moveDesignNode(id,px,py));
h('designer:deleteNode', (id)               => db.deleteDesignNode(id));
h('designer:getEdges',   (mref)             => db.getDesignEdges(mref));
h('designer:createEdge', (mref,f,tk,l)      => db.createDesignEdge(mref,f,tk,l));
h('designer:updateEdge', (id,l)             => db.updateDesignEdgeLabel(id,l));
h('designer:deleteEdge', (id)               => db.deleteDesignEdge(id));

h('sketcher:exportPng', async (name, dataUrl) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${name || 'sketch'}.png`,
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
  return { saved: res.filePath };
});

// Plan part5 Author #5: ".doc" export is plain HTML wrapped in a Word
// namespace shell — Word opens this natively, no docx-generation library
// needed (package.json has none, and this app is offline-first).
h('author:exportDoc', async (name, html) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${name || 'book'}.doc`,
    filters: [{ name: 'Word Document', extensions: ['doc'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  const shell = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset="utf-8"></head><body>${html}</body></html>`;
  fs.writeFileSync(res.filePath, shell, 'utf8');
  return { saved: res.filePath };
});

// Plan part5 Drafter #1: content is already raw markdown text — no HTML
// shell needed, just write the string as-is. Both extensions are offered
// as separate filter groups so the save dialog's own format dropdown lets
// the user pick .md vs .txt in one step.
h('drafter:exportFile', async (name, ext, content) => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showSaveDialog(win, {
    defaultPath: `${name || 'document'}.${ext || 'md'}`,
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  });
  if (res.canceled || !res.filePath) return { canceled: true };
  fs.writeFileSync(res.filePath, content ?? '', 'utf8');
  return { saved: res.filePath };
});

// Wiki-link index
h('wiki:resolve',      (name,nx)   => db.resolveWikiName(name,nx));
h('wiki:backlinks',    (key)       => db.getBacklinks(key));
h('wiki:outgoing',     (key)       => db.getOutgoingLinks(key));
h('wiki:quickIndex',   (nx)        => db.quickIndex(nx));
h('wiki:entityPath',   (key)       => db.getEntityPath(key));
h('wiki:rebuild',      ()          => db.rebuildWikiIndex());
h('wiki:resolveKeys',  (keys)      => db.resolveEntityKeys(keys));
h('wiki:linkCounts',   (nx)        => db.getLinkCounts(nx));
h('wiki:getGraph',     (nx)        => db.getGraph(nx));
h('wiki:renameTarget', (key,o,n)   => db.renameWikiTarget(key,o,n));

// Color
h('color:getAll',   ()           => db.getColors());
h('color:add',      (code)       => db.addColor(code));
h('color:markUsed', (id)         => db.markColorUsed(id));
h('color:getRecent',()           => db.getRecentColors());
h('color:delete',   (id)         => db.deleteColor(id));
h('color:getSymbolCollection', () => db.getSymbolCollection());

// Timeline
h('timeline:getAll',  (pid) => db.getTimelines(pid));
h('timeline:create',  (pid,n,c) => db.createTimeline(pid,n,c));
h('timeline:getModuleTimelines', (moduleRef) => db.getModuleTimelines(moduleRef));
h('timeline:createModuleTimeline', (moduleRef,n,c) => db.createModuleTimeline(moduleRef,n,c));
h('timeline:update',  (id,n,c) => db.updateTimeline(id,n,c));
h('timeline:delete',  (id) => db.deleteTimeline(id));
h('timeline:getOrCreateDate', (d,m,y,hh,mm) => db.getOrCreateDate(d,m,y,hh,mm));
h('timeline:getEvents',  (tlid) => db.getEvents(tlid));
h('timeline:createEvent',(tlid,n,sid,eid,c,story) => db.createEvent(tlid,n,sid,eid,c,story));
h('timeline:updateEvent',(id,n,sid,eid,c,story) => db.updateEvent(id,n,sid,eid,c,story));
h('timeline:updateEventStory',(id,story) => db.updateEventStory(id,story));
h('timeline:updateEventIcon',(id,icon,color) => db.updateEventIcon(id,icon,color));
h('timeline:deleteEvent',(id) => db.deleteEvent(id));

// Mapping
h('map:getAll',      (pid) => db.getMaps(pid));
h('map:create',      (pid,n,c) => db.createMap(pid,n,c));
h('map:update',      (id,n,c) => db.updateMap(id,n,c));
h('map:delete',      (id) => db.deleteMap(id));
h('map:getAreas',    (mid) => db.getMapAreas(mid));
h('map:createArea',  (mid,n,c) => db.createMapArea(mid,n,c));
h('map:updateArea',  (id,n,c) => db.updateMapArea(id,n,c));
h('map:deleteArea',  (id) => db.deleteMapArea(id));
h('map:getPoints',   (aid) => db.getMapAreaPoints(aid));
h('map:setPoints',   (aid,points) => db.setMapAreaPoints(aid, points));
h('map:getModuleMap',       (mref) => db.getModuleMap(mref));
h('map:getOrCreateModuleMap', (mref) => db.getOrCreateModuleMap(mref));

// Hashtag
h('hashtag:getAll',  () => db.getHashtags());
h('hashtag:create',  (n,c) => db.createHashtag(n,c));
h('hashtag:update',  (id,n,c) => db.updateHashtag(id,n,c));
h('hashtag:delete',  (id) => db.deleteHashtag(id));

// Hashtag mappings (event)
h('timeline:getEventTags', (eid) => db.getEventTags(eid));
h('timeline:setEventTags', (eid,tags) => db.setEventTags(eid,tags));
h('timeline:addEventTag', (eid,tid) => db.addEventTag(eid,tid));
h('timeline:removeEventTag', (eid,tid) => db.removeEventTag(eid,tid));

// Hashtag objects by tag
h('hashtag:getObjectsByTag', (tagId, projectId) => db.getObjectsByHashtag(tagId, projectId));
h('hashtag:getEventsByTag', (tagId, projectId) => db.getEventsByHashtag(tagId, projectId));

// Window controls for the custom title/tab bar.
h('window:minimize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.minimize();
});
h('window:toggleMaximize', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
h('window:close', () => {
  const win = BrowserWindow.getFocusedWindow();
  if (win) win.close();
});
// Workspace switcher (Hub's nexus-vault-head dropdown) — opens a second
// window bootstrapped directly into the chosen Nexus. Same running process
// and data dir as the first window, so the single-instance lock above
// (which only guards against a second OS process) doesn't apply here.
h('window:openNexus', (nexusId) => { createWindow(nexusId); });
// The Welcome window (v4.6.0), reopened on demand: the vault-head switcher's
// last row and the ⇄ button both route here instead of dropping the current
// window back to the in-hub Nexus picker.
h('window:openWelcome', () => { createWelcomeWindow(); });
// Welcome -> app handoff: open the vault in a fresh window, then close the
// window that asked (the Welcome one). Needs the raw ipcMain event to know
// WHICH window called — same reason as window:getId below, and the `h()`
// wrapper discards it. Order matters: the new window exists before the old
// one closes, so window-all-closed never sees zero windows and quits.
ipcMain.handle('window:openNexusReplace', (event, nexusId) => {
  createWindow(nexusId);
  const caller = BrowserWindow.fromWebContents(event.sender);
  if (caller && !caller.isDestroyed()) caller.close();
});
// Same pattern as window:openNexus, but bootstraps a specific Builder tab
// into a leaner popup window instead of the full app shell — see core.js's
// init() `popup=1` branch and style.css's `.popup-mode` rules.
h('window:openBuilderTab', (nexusId, tabKey) => { createWindow(nexusId, tabKey); });
// Plan part1 #2: a real cross-window HTML5 drag doesn't work between
// separate Electron BrowserWindows (each is an isolated renderer process —
// confirmed, not just assumed), so "drag a tab from a popup back to the
// main window" ships as a click action relayed via IPC instead. Needs the
// raw ipcMain event to identify the calling window, which the `h()` wrapper
// above discards — bypass it here with a direct ipcMain.handle.
ipcMain.handle('window:getId', (event) => BrowserWindow.fromWebContents(event.sender)?.id);
h('window:moveTabToMain', (nexusId, tabKey) => {
  const main = BrowserWindow.getAllWindows().find(w => !popupWindowIds.has(w.id));
  if (main && !main.isDestroyed()) main.webContents.send('builder:tabInbound', nexusId, tabKey);
  return !!main;
});
