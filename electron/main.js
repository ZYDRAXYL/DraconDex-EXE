const { app, BrowserWindow, ipcMain, dialog, Menu, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { isSecretKey } = require('./src/db/secret-store');
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
// registered image. A path in the URL would be an arbitrary-file-read hole;
// don't add one.
//
// The nexus id joined the URL in v4.9.0, when import_file moved into per-vault
// files. This is NOT an IPC handler — it gets a bare Request, and every app
// window shares the default session (only plugins get partitions), so there is
// no calling window to infer a vault from. The URL has to say. The id is
// validated against the registry and the lookup runs inside runWithVault, so a
// forged nexus id can only reach a vault that actually exists, and only its
// registered images.
function registerDisplayImageProtocol() {
  if (!protocol) return;
  protocol.handle('ddx-file', async (req) => {
    const raw = String(req.url).replace(/^ddx-file:(\/\/)?/, '').split(/[?#/]/)[0];
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
    if (!f || !IMAGE_EXTS.has(ext)) return new Response(null, { status: 404 });
    try {
      // ETag off mtime+size, served with no-cache: the browser reuses the
      // decoded image across re-renders but still revalidates, so replacing
      // the file on disk shows up immediately. The old base64 path cached
      // bytes in a renderer Map that was never invalidated.
      const st = await fs.promises.stat(f.file_path);
      const etag = `"${st.mtimeMs}-${st.size}"`;
      if (req.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
      }
      return new Response(await fs.promises.readFile(f.file_path), {
        headers: { 'Content-Type': imageMime(ext), ETag: etag, 'Cache-Control': 'no-cache' },
      });
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
    title: 'Import Database (.ddx / .mdx / .db)',
    properties: ['openFile'],
    filters: [{ name: 'DraconDex File', extensions: ['ddx', 'mdx', 'db'] }],
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
// .mdx, not .json (Plan process5 part2) — disambiguates a module-scoped
// export from the Nexus snapshot export right above (both used to write a
// bare .json, indistinguishable in a file picker/Downloads folder).
h('db:exportModuleFile', async (nexusId, moduleId, moduleName) => {
  const defaultName = `${String(moduleName || 'module').replace(/[\\/:*?"<>|]/g, '_')}.mdx`;
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Module', defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'DraconDex Module File', extensions: ['mdx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  return db.exportModuleFile(nexusId, moduleId, result.filePath);
});
// Accepts .json too — a module exported before this switched to .mdx is
// still a valid snapshot in the same shape, only the extension changed.
h('db:importModuleFile', async (nexusId, parentModuleId) => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Import Module', properties: ['openFile'],
    filters: [{ name: 'DraconDex Module File', extensions: ['mdx', 'json'] }],
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
  const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
    title: 'Export Nexus', defaultPath: path.join(app.getPath('documents'), `${safe}.ddx`),
    filters: [{ name: 'DraconDex Nexus', extensions: ['ddx'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
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
h('module:getTree',     (nx)          => db.getTree(nx));
h('module:getNestItems', (nx)         => db.getNestItems(nx));
h('module:get',         (id)          => db.getModule(id));
h('module:create',      (data)        => db.createModule(data));
h('module:update',      (id,data)     => db.updateModule(id,data));
h('module:updateDescription', (id,d)  => db.updateModuleDescription(id,d));
h('module:delete',      (id)          => db.deleteModule(id));
h('module:duplicate',   (id)          => db.duplicateModule(id));
h('module:move',        (nx,id,parentId,ids) => db.moveModule(nx,id,parentId,ids));
h('module:count',       (nx)          => db.countModules(nx));
h('module:getAttrs',    (id)          => db.getModuleAttrs(id));
h('module:upsertAttr',  (id,aid,n,v)  => db.upsertModuleAttr(id,aid,n,v));
h('module:deleteAttr',  (id)          => db.deleteModuleAttr(id));
h('module:getUi',       (id)          => db.getModuleUi(id));
h('module:setUi',       (id,k,v)      => db.setModuleUi(id,k,v));
h('module:getTags',     (id)          => db.getModuleTags(id));
h('module:setTags',     (id,tags)     => db.setModuleTags(id,tags));
h('module:getLinks',    (id)          => db.getModuleLinks(id));
h('module:getInspector',(id)          => db.getModuleInspector(id));
h('module:getChildStats', (pid)      => db.getChildModuleStats(pid));

// Process 7 part 2 — app-wide session undo/redo (Ctrl+Z/Ctrl+Shift+Z),
// scoped to the active vault the same way every handler above is.
h('history:undo', () => db.historyUndo());
h('history:redo', () => db.historyRedo());

// Category "Classifier" (v3 Phase 5)
h('classifier:setCatType',        (id,ct)              => db.setCatType(id,ct));
h('classifier:getObjects',        (mref)                => db.getObjects(mref));
h('classifier:getObjectsFull',    (mref)                => db.getObjectsFull(mref));
h('classifier:getObject',         (id)                  => db.getObject(id));
h('classifier:createObject',      (mref,n,c,ic)         => db.createObject(mref,n,c,ic));
h('classifier:updateObject',      (id,n,c,ic)           => db.updateObject(id,n,c,ic));
h('classifier:updateObjectNote',  (id,note)             => db.updateObjectNote(id,note));
h('classifier:deleteObject',      (id)                  => db.deleteObject(id));
h('classifier:getTemplates',      (mref)                => db.getTemplates(mref));
h('classifier:getObjectTemplates',(mref,oref)           => db.getObjectTemplates(mref,oref));
h('classifier:createTemplate',    (mref,d,t,lv,c,oref,ls)=> db.createTemplate(mref,d,t,lv,c,oref,ls));
h('classifier:updateTemplate',    (id,d,t,lv,c,ls)      => db.updateTemplate(id,d,t,lv,c,ls));
h('classifier:deleteTemplate',    (id)                  => db.deleteTemplate(id));
h('classifier:countObjectTemplates', (oref)             => db.countObjectTemplates(oref));
h('classifier:getAttrs',          (oid)                 => db.getAttrs(oid));
h('classifier:upsertAttr',        (oid,tid,v)           => db.upsertAttr(oid,tid,v));
h('classifier:upsertAttrCondition', (oid,tid,v)         => db.upsertAttrCondition(oid,tid,v));
h('classifier:getLevels',         (oid)                 => db.getLevels(oid));
h('classifier:createLevel',       (oid,tid)             => db.createLevel(oid,tid));
h('classifier:updateLevelField',  (id,f,v)              => db.updateLevelField(id,f,v));
h('classifier:deleteLevel',       (id)                  => db.deleteLevel(id));
h('classifier:moveLevels',        (oid,tid,ids)         => db.moveLevels(oid,tid,ids));

// TimeMap "Wanderer" (v3 Phase 9) — MapEvent Link pins
h('wanderer:list',   (mref)                     => db.getMapEvents(mref));
h('wanderer:create', (mref,ev,key,px,py,ar)     => db.createMapEvent(mref,ev,key,px,py,ar));
h('wanderer:update', (id,ev,key,px,py,ar)       => db.updateMapEvent(id,ev,key,px,py,ar));
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

// Book "Author" (v3 Phase 11) — chapters
h('author:getChapters',    (mref)      => db.getBookChapters(mref));
h('author:createChapter',  (mref,n)    => db.createBookChapter(mref,n));
h('author:renameChapter',  (id,n)      => db.renameBookChapter(id,n));
h('author:updateContent',  (id,c)      => db.updateBookChapterContent(id,c));
h('author:deleteChapter',  (id)        => db.deleteBookChapter(id));
h('author:setChapterLabel', (id,lb)    => db.setBookChapterLabel(id,lb));
h('author:moveChapter',    (mref,ids)  => db.moveBookChapter(mref,ids));

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
h('viewer:createRelation', (nx,f,tk,l,c)  => db.createEntityRelation(nx,f,tk,l,c));
h('viewer:updateRelation', (id,l,c)       => db.updateEntityRelation(id,l,c));
h('viewer:deleteRelation', (id)         => db.deleteEntityRelation(id));

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
// Import Dock (v3 Phase 18) — folder import, file<->linker, viewers
const IMPORT_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg','md','txt','docx']);
const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','webp','svg']);
const imageMime = (ext) => (ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
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

h('importdock:list',          (nx)     => db.getImportFiles(nx));
h('importdock:add', (nx, fs2) => {
  const clean = (Array.isArray(fs2) ? fs2 : []).filter((f) => isUnderPickedRoot(f?.path)).map((f) => ({
    ...f,
    // Derived here, never taken from the renderer: file_type decides which
    // reader will later serve the bytes, so letting the caller pick it would
    // re-open the same hole from the other side.
    type: path.extname(String(f.path || '')).slice(1).toLowerCase(),
  })).filter((f) => IMPORT_EXTS.has(f.type));
  return db.addImportFiles(nx, clean);
});
h('importdock:setLinker',     (id,k)   => db.setImportLinker(id,k));
h('importdock:setUseAsImage', (id,on)  => db.setImportUseAsImage(id,on));
h('importdock:delete',        (id)     => db.deleteImportFile(id));
h('importdock:displayImages', (nx)     => db.getDisplayImages(nx));
h('importdock:pickFolder', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths?.length) return { canceled: true };
  const root = res.filePaths[0];
  // The user picked it, so anything under it may be registered later.
  pickedImportRoots.add(path.resolve(root));
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!IMPORT_EXTS.has(ext)) continue;
      files.push({
        name: ent.name, path: p, type: ext,
        size: fs.statSync(p).size,
        folder: path.basename(root) + (path.dirname(p) === root ? '' : '/' + path.relative(root, path.dirname(p)).replace(/\\/g, '/')),
      });
    }
  };
  walk(root);
  return { folder: path.basename(root), files };
});
// Content is only served for files already registered in import_file.
h('importdock:readFile', async (id) => {
  const f = db.getImportFile(id);
  if (!f) return null;
  const ext = (f.file_type || '').toLowerCase();
  try {
    // Images carry no payload any more (Plan part2 #2.2) — the viewer points
    // <img> at ddx-file://<id> instead. Only the existence/readability check
    // still matters here, so a missing file still renders the error state.
    if (IMAGE_EXTS.has(ext)) { await fs.promises.access(f.file_path); return { kind: 'image' }; }
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
      out[id] = `data:${imageMime(ext)};base64,${(await fs.promises.readFile(f.file_path)).toString('base64')}`;
    } catch (_) { /* unreadable/moved file — leave it out, renderer shows the empty state */ }
  }));
  return out;
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
const RENDERER_SETTING_KEYS = new Set(['versionLimit', 'startupMode']);
// Two gates, not one. The allowlist is the rule; isSecretKey() is the backstop
// that survives someone widening the allowlist later without noticing they
// just handed the renderer a refresh token. Cloud-provider credentials are
// keyed by provider id (cloud:<id>:refreshToken, …) and so cannot be
// enumerated in a set — isSecretKey matches them by shape.
const rendererSettingAllowed = (k) => RENDERER_SETTING_KEYS.has(String(k)) && !isSecretKey(k);
h('setting:get',      (k)    => (rendererSettingAllowed(k) ? db.getAppSetting(k) : null));
h('setting:set',      (k,v)  => (rendererSettingAllowed(k) ? db.setAppSetting(k,v) : { ok: false }));

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
