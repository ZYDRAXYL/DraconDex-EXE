'use strict';
// ═══ Every Nexus is a folder (Procress 20; APP docs/V5.md §8.5) ═══════════
// Before Procress 20 a Locate folder was something the user chose; now every
// Nexus has one, made by the app — `<root>/<Nexus name>`, root being
// `<Documents>/DraconDex` unless the user moved it (Settings → App data).
// The .ddx stays the truth (§8.1): the folder mirrors it and holds the asset
// files. This file owns the folder's life and the two signals that keep a
// sync from redoing work nothing asked for:
//   - which modules changed since the last mirror (vault side), from TEMP
//     triggers on the vault connection (never written into the .ddx)
//   - whether anything changed in the folder (disk side), from fs.watch
// db/mirror.js writes the mirror; main.js's syncLocate walks the folder.
const fs = require('fs');
const path = require('path');
const { getAppDB, getVaultDB, dataDir } = require('./conn');
const { getVault, setVaultLocateDir } = require('./vaults');

// ── What changed in the vault (part 1a) ────────────────────────────────────
// Each row a write touches names its module through the expression below
// (R = NEW or OLD). -1 = "can't tell which — all of them" (a date, a tag,
// a colour or the Nexus itself renamed shows in many modules' files).
const OBJ = (col) => `(SELECT module_ref FROM classifier_object WHERE id=R.${col})`;
const TRACK = {
  module: 'R.id', page_block: 'R.module_ref', module_ui: 'R.module_ref', module_hashtag: 'R.module_ref',
  classifier_object: 'R.module_ref', classifier_template: 'R.module_ref',
  classifier_attribute: OBJ('object_ref'), classifier_level: OBJ('object_ref'),
  map: 'R.module_ref', map_area: '(SELECT module_ref FROM map WHERE id=R.map_id)',
  map_point: '(SELECT mp.module_ref FROM map_area a JOIN map mp ON a.map_id=mp.id WHERE a.id=R.area_id)',
  timeline: 'R.module_ref', timeline_event: '(SELECT module_ref FROM timeline WHERE id=R.timeline_id)',
  map_event: 'R.module_ref',
  story_dialogue: 'R.module_ref', story_edge: 'R.module_ref',
  story_talk: '(SELECT module_ref FROM story_dialogue WHERE id=R.dialogue_ref)',
  story_choice_option: '(SELECT d.module_ref FROM story_talk t JOIN story_dialogue d ON t.dialogue_ref=d.id WHERE t.id=R.talk_ref)',
  book_chapter: 'R.module_ref',
  chat_session: 'R.module_ref', chat_message: '(SELECT module_ref FROM chat_session WHERE id=R.session_ref)',
  sketch_page: 'R.module_ref', sketch_stroke: '(SELECT module_ref FROM sketch_page WHERE id=R.page_ref)',
  sketch_pin: '(SELECT module_ref FROM sketch_page WHERE id=R.page_ref)',
  design_node: 'R.module_ref', design_edge: 'R.module_ref',
  diviner_table: 'R.module_ref', diviner_entry: '(SELECT module_ref FROM diviner_table WHERE id=R.table_ref)',
  diviner_roll: '(SELECT module_ref FROM diviner_table WHERE id=R.table_ref)',
  exhibit_node: 'R.module_ref', exhibit_view: 'R.module_ref',
};
const TRACK_UPDATE_ALL = ['timeline_date', 'hashtag', 'use_color', 'nexus'];

const tracked = new WeakMap(); // vault connection -> nexus id it reports for
const dirty = new Map();       // nexus id -> { all, ids:Set }
const dirtyOf = (nx) => { if (!dirty.has(nx)) dirty.set(nx, { all: false, ids: new Set() }); return dirty.get(nx); };

function touch(nx, id) {
  if (id == null) return null;
  const d = dirtyOf(nx);
  if (Number(id) === -1) d.all = true; else d.ids.add(Number(id));
  return null;
}

// Installs the triggers on this vault's connection, once per connection (a
// connection closed and reopened by conn.js's LRU comes back without them).
// Everything before the triggers existed is unknown, so a fresh install
// marks the whole Nexus. → false when this SQLite cannot call back into JS:
// every sync is then a whole pass, which is correct, only slower.
function trackVault(nx, db) {
  if (!db) return false;
  if (tracked.get(db) === nx) return true;
  try {
    db.function('ddx_mirror_touch', (id) => touch(nx, id));
    const sql = [];
    for (const [t, expr] of Object.entries(TRACK)) {
      const at = (r) => expr.replace(/R\./g, `${r}.`);
      sql.push(`CREATE TEMP TRIGGER IF NOT EXISTS ddx_mt_${t}_i AFTER INSERT ON main.${t} BEGIN SELECT ddx_mirror_touch(${at('NEW')}); END;`);
      sql.push(`CREATE TEMP TRIGGER IF NOT EXISTS ddx_mt_${t}_u AFTER UPDATE ON main.${t} BEGIN SELECT ddx_mirror_touch(${at('NEW')}), ddx_mirror_touch(${at('OLD')}); END;`);
      sql.push(`CREATE TEMP TRIGGER IF NOT EXISTS ddx_mt_${t}_d AFTER DELETE ON main.${t} BEGIN SELECT ddx_mirror_touch(${at('OLD')}); END;`);
    }
    for (const t of TRACK_UPDATE_ALL) sql.push(`CREATE TEMP TRIGGER IF NOT EXISTS ddx_mt_${t}_u AFTER UPDATE ON main.${t} BEGIN SELECT ddx_mirror_touch(-1); END;`);
    db.exec(sql.join('\n'));
  } catch (e) {
    console.error('locate: change tracking unavailable, every sync is a whole pass:', e?.message || e);
    return false;
  }
  tracked.set(db, nx);
  dirtyOf(nx).all = true;
  return true;
}

// The changes since the last call, and a fresh empty set for the next ones.
function takeDirty(nx) {
  const d = dirtyOf(nx);
  dirty.set(nx, { all: false, ids: new Set() });
  return d;
}
// A sync that failed half way gives its set back, so the next one redoes it.
function giveBackDirty(nx, d) {
  const cur = dirtyOf(nx);
  cur.all = cur.all || d.all;
  for (const id of d.ids) cur.ids.add(id);
}
const hasDirty = (nx) => { const d = dirty.get(nx); return !!d && (d.all || d.ids.size > 0); };

// ── What changed in the folder (part 1c) ───────────────────────────────────
// fs.watch(root, {recursive}) — Windows and macOS natively, Linux from Node
// 20 (Electron 42 ships Node 24). The folder is walked in full when the Nexus
// opens; after that only when the watcher saw something. No watcher (it
// threw, or errored later) = walk every time, which is what every sync did
// before Procress 20.
const OWN_MS = 3000;
const watchers = new Map(); // nx -> { root, w, changed, verify:Set(rel), own:Map(abs -> until) }
let watchSupported = true;

function watchFolder(nx, root) {
  const cur = watchers.get(nx);
  if (cur && cur.root === root && cur.w) return true;
  unwatchFolder(nx);
  if (!watchSupported) return false;
  const st = { root, w: null, changed: false, verify: new Set(), own: new Map() };
  const { MIRROR_EXTS, MANIFEST } = require('./mirror');
  try {
    st.w = fs.watch(root, { recursive: true, persistent: false }, (_ev, name) => {
      if (!name) { st.changed = true; return; }
      const rel = String(name).replace(/\\/g, '/');
      const abs = path.join(root, rel);
      const until = st.own.get(abs);
      if (until && until > Date.now()) return; // the mirror's own write
      if (rel === MANIFEST || MIRROR_EXTS.some((e) => rel.toLowerCase().endsWith(e))) st.verify.add(rel);
      else st.changed = true;
    });
    st.w.on('error', () => { try { st.w.close(); } catch (_) {} st.w = null; });
  } catch (e) {
    if (e?.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') watchSupported = false;
    return false;
  }
  watchers.set(nx, st);
  return true;
}

function unwatchFolder(nx) {
  const st = watchers.get(nx);
  if (st?.w) { try { st.w.close(); } catch (_) {} }
  watchers.delete(nx);
}

// true = walk the folder (something changed there, or there is no watcher
// to say it didn't); the flag resets.
function folderChanged(nx) {
  const st = watchers.get(nx);
  if (!st?.w) return true;
  const c = st.changed;
  st.changed = false;
  return c;
}
// Mirror files the user touched on disk — checked against the manifest on
// the next sync, and rewritten if they no longer match.
function takeVerify(nx) {
  const st = watchers.get(nx);
  if (!st) return new Set();
  const v = st.verify;
  st.verify = new Set();
  return v;
}
// Paths the mirror just wrote, so their watch events are not news.
function ignoreOwn(nx, absPaths) {
  const st = watchers.get(nx);
  if (!st || !absPaths?.length) return;
  const until = Date.now() + OWN_MS;
  for (const [k, t] of st.own) if (t < Date.now()) st.own.delete(k);
  for (const p of absPaths) st.own.set(path.resolve(p), until);
}
const isWatching = (nx) => !!watchers.get(nx)?.w;

// Nexuses whose folder has been mirrored this session — the ones a write
// schedules a follow-up mirror for (main.js scheduleEditMirror). Cleared
// when the Nexus's last window closes, along with its watcher and changes.
const active = new Set();
const markActive = (nx) => active.add(nx);
const isActive = (nx) => active.has(nx);
function forget(nx) {
  active.delete(nx);
  unwatchFolder(nx);
  dirty.delete(nx);
}

// ── Where a Nexus's folder goes (part 2) ────────────────────────────────────
// `<Documents>/DraconDex`, where a person finds it in Explorer — not AppData
// beside the .ddx. A run with DRACONDEX_DATA_DIR (the tests, the driver) or an
// unpackaged dev run keeps it under its data dir instead, so they never write
// into the real Documents folder; DRACONDEX_LOCATE_ROOT overrides both.
function defaultLocateRoot() {
  if (process.env.DRACONDEX_LOCATE_ROOT) return path.resolve(process.env.DRACONDEX_LOCATE_ROOT);
  const { app } = require('electron');
  if (process.env.DRACONDEX_DATA_DIR || !app?.isPackaged) return path.join(dataDir(), 'Documents', 'DraconDex');
  return path.join(app.getPath('documents'), 'DraconDex');
}
const ROOT_KEY = 'locateRoot';
function locateRoot() {
  try {
    const v = getAppDB().prepare(`SELECT value FROM app_setting WHERE key=?`).get(ROOT_KEY)?.value;
    if (v && path.isAbsolute(v)) return v;
  } catch (_) {}
  return defaultLocateRoot();
}
// Only main's folder dialog calls this — the renderer never names a path.
function setLocateRoot(dir) {
  getAppDB().prepare(`INSERT INTO app_setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(ROOT_KEY, path.resolve(dir));
}

// "<name>", or "<name> (2)", (3)… — never a folder that is already there, or
// one another Nexus has (even if it is missing right now).
function freeDir(parent, name) {
  const taken = new Set(getAppDB().prepare(`SELECT locate_dir FROM nexus_file WHERE locate_dir IS NOT NULL`).all()
    .map((r) => path.resolve(r.locate_dir).toLowerCase()));
  const free = (p) => !fs.existsSync(p) && !taken.has(path.resolve(p).toLowerCase());
  let p = path.join(parent, name);
  for (let n = 2; !free(p); n++) p = path.join(parent, `${name} (${n})`);
  return p;
}

// The folder name the app gave is remembered in the manifest (autoName), so a
// rename can follow it — and a folder the user moved or named is left alone.
function setAutoName(dir, autoName) {
  const { MANIFEST } = require('./mirror');
  const f = path.join(dir, MANIFEST);
  let j = {};
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  j.note = j.note || 'Written by DraconDex. The .ddx is the source of truth; this folder mirrors it.';
  j.autoName = autoName || null;
  try { fs.writeFileSync(f, JSON.stringify(j, null, 1)); } catch (_) {}
}
function autoNameOf(dir) {
  const { MANIFEST } = require('./mirror');
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')).autoName || null; } catch (_) { return null; }
}

// A Nexus without a folder gets one — at create, and for a Nexus from before
// Procress 20, the first time it opens. → { ok, dir, created }
function ensureLocateDir(nx) {
  const v = getVault(nx);
  if (!v) return { ok: false, code: 'not_found' };
  if (v.locate_dir) return { ok: true, dir: v.locate_dir, created: false };
  const { dirNameOf } = require('./mirror');
  const base = locateRoot();
  try {
    const dir = freeDir(base, dirNameOf(v.name || 'Nexus'));
    fs.mkdirSync(dir, { recursive: true });
    setVaultLocateDir(nx, dir);
    setAutoName(dir, path.basename(dir));
    return { ok: true, dir, created: true };
  } catch (e) {
    return { ok: false, code: 'no_dir', error: String(e?.message || e) };
  }
}

// Asset files that live outside the folder (a Nexus from before Procress 20
// referenced them where they were). Never moved on their own — "Gather into
// the folder" COPIES them in, next to their module's folder, and points the
// asset at the copy. The originals stay where they are.
function outsideAssets(nx) {
  const v = getVault(nx);
  if (!v?.locate_dir) return [];
  const root = path.resolve(v.locate_dir);
  return getVaultDB(nx).prepare(`SELECT id, file_name, file_path, module_ref FROM import_file WHERE nexus_ref=? AND source_kind='file' AND missing=0`).all(nx)
    .filter((r) => {
      const rel = path.relative(root, path.resolve(String(r.file_path || '')));
      return !rel || rel.startsWith('..') || path.isAbsolute(rel);
    });
}
function gatherAssets(nx) {
  const v = getVault(nx);
  if (!v?.locate_dir || v.locate_missing) return { ok: false, code: 'no_dir' };
  const db = getVaultDB(nx);
  const { planMirror } = require('./mirror');
  const mods = db.prepare(`SELECT id, parent_id, name, kind, display_order FROM module WHERE nexus_ref=?`).all(nx);
  const byId = new Map(mods.map((m) => [m.id, m]));
  const dirOf = new Map(planMirror(mods).dirs.map((d) => [d.id, d.rel]));
  const folderOf = (id) => { // the module's own folder, or its nearest collector's
    for (let m = byId.get(id); m; m = byId.get(m.parent_id)) if (dirOf.has(m.id)) return dirOf.get(m.id);
    return '';
  };
  const root = path.resolve(v.locate_dir);
  const upd = db.prepare(`UPDATE import_file SET file_path=? WHERE id=?`);
  const done = [];
  let failed = 0;
  for (const r of outsideAssets(nx)) {
    try {
      if (!fs.statSync(r.file_path).isFile()) { failed++; continue; }
      const dir = path.join(root, ...folderOf(r.module_ref).split('/').filter(Boolean));
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(r.file_path);
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      let to = path.join(dir, base);
      for (let n = 2; fs.existsSync(to); n++) to = path.join(dir, `${stem} (${n})${ext}`);
      fs.copyFileSync(r.file_path, to, fs.constants.COPYFILE_EXCL);
      done.push([to, r.id]);
    } catch (_) { failed++; }
  }
  db.transaction(() => { for (const [to, id] of done) upd.run(to, id); })();
  return { ok: true, copied: done.length, failed };
}

// ── The sync (main.js's syncLocate wraps this) ─────────────────────────────
// One sync, both directions (§8.11.4): folders the user made on disk come in
// as collectors — and their files as assets — through importFolderTree, the
// Dock's folder import; then the vault is written back out (db/mirror.js).
// Procress 20 part 1 — a sync does only what something asked for:
//   reason 'open' / 'create' / 'manual'  walk the whole folder, check every file
//   'focus' / 'tree'                     walk only if the watcher saw a change
//   'edit'  (main's own, after a write)  mirror the changed modules, no walk
// A Nexus with no folder gets one. Runs inside the Nexus's vault context
// (importFolderTree uses it).
// → the mirror's counts + { imported, created, dir } · { ok:false, code:'missing' }
function syncLocate(nx, { reason = 'manual' } = {}) {
  const { walkImportFolder, importFolderTree } = require('./importdock');
  const { syncNexusMirror } = require('./mirror');
  let v = getVault(nx);
  if (!v) return { ok: false, code: 'not_found' };
  let created = false;
  if (!v.locate_dir) {
    const e = ensureLocateDir(nx);
    if (!e.ok) return e;
    created = e.created;
    v = getVault(nx);
  }
  if (v.locate_missing) { unwatchFolder(nx); return { ok: false, code: 'missing' }; }
  const root = path.resolve(v.locate_dir);
  const full = created || ['open', 'create', 'manual'].includes(reason);
  watchFolder(nx, root);
  // read (and reset) even on a full walk, so this walk is not redone on the next focus
  const changed = folderChanged(nx);
  let imported = null;
  if (reason !== 'edit' && (full || changed)) {
    // walkImportFolder names its first segment after the root; the root IS
    // the Nexus top level here, so that segment is dropped.
    const { dirs, files } = walkImportFolder(root);
    const sub = dirs.map((segs) => segs.slice(1)).filter((segs) => segs.length);
    const inFolders = files.map((f) => ({ ...f, dir: f.dir.slice(1) }));
    imported = sub.length || inFolders.length ? importFolderTree(nx, null, sub, inFolders) : null;
  }
  const verify = full ? null : takeVerify(nx);
  return { ...syncNexusMirror(nx, { full, verify }), imported, created, dir: root };
}

module.exports = {
  trackVault, takeDirty, giveBackDirty, hasDirty,
  watchFolder, unwatchFolder, folderChanged, takeVerify, ignoreOwn, isWatching, markActive, isActive, forget,
  defaultLocateRoot, locateRoot, setLocateRoot, ensureLocateDir, outsideAssets, gatherAssets, freeDir, autoNameOf,
  syncLocate,
};
