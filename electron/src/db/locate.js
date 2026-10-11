'use strict';
// ═══ The Locate folder's sync (Procress 20 part 1; APP docs/V5.md §8.5) ════
// The .ddx stays the truth (§8.1): the folder mirrors it and holds the asset
// files. This file keeps a sync from redoing work nothing asked for, with
// two signals:
//   - which modules changed since the last mirror (vault side), from TEMP
//     triggers on the vault connection (never written into the .ddx)
//   - whether anything changed in the folder (disk side), from fs.watch
// db/mirror.js writes the mirror; main.js's syncLocate walks the folder.
const fs = require('fs');
const path = require('path');
const { getVault } = require('./vaults');

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

// ── The sync (main.js's syncLocate wraps this) ─────────────────────────────
// One sync, both directions (§8.11.4): folders the user made on disk come in
// as collectors — and their files as assets — through importFolderTree, the
// Dock's folder import; then the vault is written back out (db/mirror.js).
// Procress 20 part 1 — a sync does only what something asked for:
//   reason 'open' / 'create' / 'manual'  walk the whole folder, check every file
//   'focus' / 'tree'                     walk only if the watcher saw a change
//   'edit'  (main's own, after a write)  mirror the changed modules, no walk
// Runs inside the Nexus's vault context (importFolderTree uses it).
// → the mirror's counts + { imported, dir } · { ok:false, code:'no_dir' | 'missing' }
function syncLocate(nx, { reason = 'manual' } = {}) {
  const { walkImportFolder, importFolderTree } = require('./importdock');
  const { syncNexusMirror } = require('./mirror');
  const v = getVault(nx);
  if (!v) return { ok: false, code: 'not_found' };
  if (!v.locate_dir) return { ok: false, code: 'no_dir' };
  if (v.locate_missing) { unwatchFolder(nx); return { ok: false, code: 'missing' }; }
  const root = path.resolve(v.locate_dir);
  const full = ['open', 'create', 'manual'].includes(reason);
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
  return { ...syncNexusMirror(nx, { full, verify }), imported, dir: root };
}

module.exports = {
  trackVault, takeDirty, giveBackDirty, hasDirty,
  watchFolder, unwatchFolder, folderChanged, takeVerify, ignoreOwn, isWatching, markActive, isActive, forget,
  syncLocate,
};
