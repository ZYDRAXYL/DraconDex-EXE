'use strict';
// ═══ The Nexus folder mirror (v5 Part 4, APP docs/V5.md §8.5–§8.7) ════════
// Every Nexus is "located" into a real folder (made for it by db/locate.js
// since Procress 20): collectors become sub-folders and every other module
// becomes a `<name>.ddata` + `<name>.dpage` pair in its collector's folder. The .ddx stays the source of truth (§8.1) — this is a
// mirror, rebuilt from the vault whenever it syncs, never read back as data.
//
// It is the second direction of ONE mechanism (§8.11.4). Part 1's folder
// import (db/importdock.js importFolderTree, §2.3) turns a folder into a
// collector named after it; this turns a collector into the folder named
// after it. Both go through the two functions below, so a folder imported
// and then mirrored lands on the folder it came from, and a collector
// mirrored and then re-imported is the same collector — not two breeds of
// collector that happen to look alike.
//
// What the mirror may delete: only a module file it wrote itself (listed in its
// manifest) that no longer has a module behind it, and a folder it created
// that is now empty. A file the user put in the folder is never touched.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MANIFEST = '.dracondex-mirror.json';
const MODULE_EXT = '.mddx'; // what mirrors before Procress 16 part 3a wrote — still cleaned up
const { DATA_EXT, PAGE_EXT, splitSnapshot } = require('./module-files');
const MIRROR_EXTS = [MODULE_EXT, DATA_EXT, PAGE_EXT];
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// collector name -> folder name. Identity for any name a folder can carry,
// which is every name folder import produced; anything else is made safe.
function dirNameOf(name) {
  let s = String(name ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s || s === '.' || s === '..') s = '_';
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

// folder name -> collector name (folder import's direction). A folder name is
// already a valid collector name, so this is the identity — kept as a named
// function so both directions visibly go through one pair.
const collectorNameOfDir = (dirName) => String(dirName);

// Where every module of a Nexus lands, relative to the locate folder.
// Siblings whose names collide after dirNameOf keep apart by id.
function planMirror(modules) {
  const byParent = new Map();
  for (const m of modules) {
    const k = m.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(m);
  }
  const dirs = [];
  const files = [];
  const walk = (parentId, rel) => {
    const kids = (byParent.get(parentId) || []).slice().sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.id - b.id);
    const used = new Set();
    for (const m of kids) {
      const isDir = m.kind === 'collector';
      let base = dirNameOf(m.name);
      const key = (b) => (isDir ? b : b + DATA_EXT).toLowerCase();
      if (used.has(key(base))) base = `${base} (${m.id})`;
      used.add(key(base));
      const p = rel ? `${rel}/${base}` : base;
      if (isDir) {
        dirs.push({ id: m.id, rel: p });
        walk(m.id, p);
      } else {
        // Procress 16 part 3a: a module is two files — its data and its page
        files.push({ id: m.id, rel: p + DATA_EXT, part: 'data' }, { id: m.id, rel: p + PAGE_EXT, part: 'page' });
      }
    }
  };
  walk(null, '');
  return { dirs, files };
}

// dirs are {rel, id}: the id is what lets a renamed or moved collector move
// its folder instead of leaving the old one behind (see writeMirror).
// files are {rel, id, part, hash, size, mtime} since Procress 20 (a plain
// string before): the hash says whether a module's file needs writing without
// reading the file back, size + mtime whether someone changed it on disk.
function readManifest(root) {
  try {
    const raw = fs.readFileSync(path.join(root, MANIFEST), 'utf8');
    const j = JSON.parse(raw);
    const dirs = (Array.isArray(j.dirs) ? j.dirs : [])
      .map((d) => (typeof d === 'string' ? { rel: d, id: null } : { rel: String(d?.rel || ''), id: d?.id ?? null }))
      .filter((d) => d.rel);
    const files = (Array.isArray(j.files) ? j.files : [])
      .map((f) => (typeof f === 'string' ? { rel: f } : { ...f, rel: String(f?.rel || '') }))
      .filter((f) => f.rel);
    return { files, dirs, autoName: j.autoName ?? null, raw };
  } catch (_) { return { files: [], dirs: [], autoName: null, raw: null }; }
}

// A relative path from the manifest, resolved and confirmed to stay inside
// the root — a hand-edited manifest must not reach outside the folder.
function inside(root, rel) {
  const abs = path.resolve(root, String(rel));
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null;
}

const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex');
const statOf = (abs) => { try { const st = fs.statSync(abs); return { size: st.size, mtime: st.mtimeMs }; } catch (_) { return null; } };

// Write the mirror for one Nexus into `root`. `serialize(moduleId)` returns
// the module's snapshot (sync.js serializeVault scoped to that one module —
// the same payload the .mddx export writes, §8.7).
// Procress 20 part 1 — a sync does only the work something asked for:
//   opts.dirty          ids of the modules that changed (a Set), or null = all
//   opts.verify         'all' = stat every file against the manifest (the
//                       Nexus just opened), or a Set of rels the folder
//                       watcher saw touched
//   opts.serializeMany  (ids) -> Map(id -> snapshot): one pass for many
//                       modules instead of one pass each
// A module that did not change and whose files are as the manifest says is
// not serialized at all; one that did is written only if its bytes differ.
// Nothing changed = nothing written, the manifest included.
function writeMirror(root, modules, serialize, opts = {}) {
  if (!root || !fs.existsSync(root)) return { ok: false, code: 'missing' };
  const plan = planMirror(modules);
  const prev = readManifest(root);
  let written = 0, removed = 0;
  const moved = []; // [{from, to}] absolute folder paths that moved
  const touched = []; // every path this call wrote, made, moved or removed
  // A collector renamed or moved in the app: move ITS folder (with whatever
  // the user keeps in it) to the new place, shallowest first, rewriting the
  // remembered paths below it as each parent moves. Without this the next
  // sync's folder import would bring the old folder back as a collector.
  const prevRel = new Map(prev.dirs.filter((d) => d.id != null).map((d) => [d.id, d.rel]));
  for (const dir of [...plan.dirs].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)) {
    const was = prevRel.get(dir.id);
    if (!was || was === dir.rel) continue;
    const from = inside(root, was), to = inside(root, dir.rel);
    if (!from || !to || !fs.existsSync(from)) continue;
    // A case-only rename ("World" -> "world") on a case-insensitive file
    // system: `to` "exists" because it IS `from`. Rename through a temp name.
    let caseOnly = false;
    if (fs.existsSync(to)) {
      try {
        const a = fs.statSync(from), b = fs.statSync(to);
        caseOnly = was.toLowerCase() === dir.rel.toLowerCase() && a.ino === b.ino && a.dev === b.dev;
      } catch (_) {}
      if (!caseOnly) continue;
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (caseOnly) {
        const tmp = `${from}.ddx-rename-${process.pid}-${Date.now()}`;
        fs.renameSync(from, tmp);
        try { fs.renameSync(tmp, to); } catch (e) { fs.renameSync(tmp, from); throw e; }
      } else fs.renameSync(from, to);
      moved.push({ from, to });
      touched.push(from, to);
      for (const [id, rel] of prevRel) {
        if (rel === was || rel.startsWith(`${was}/`)) prevRel.set(id, dir.rel + rel.slice(was.length));
      }
      for (const d of prev.dirs) if (d.rel === was || d.rel.startsWith(`${was}/`)) d.rel = dir.rel + d.rel.slice(was.length);
      prev.files = prev.files.map((f) => (f.rel.startsWith(`${was}/`) ? { ...f, rel: dir.rel + f.rel.slice(was.length) } : f));
    } catch (_) { /* leave it; the folder is recreated below */ }
  }
  for (const dir of plan.dirs) {
    const abs = path.join(root, ...dir.rel.split('/'));
    if (!fs.existsSync(abs)) { fs.mkdirSync(abs, { recursive: true }); touched.push(abs); }
  }

  // Which modules need serializing at all.
  const prevFile = new Map(prev.files.map((f) => [f.rel.toLowerCase(), f]));
  const verify = opts.verify === 'all' ? null : new Set([...(opts.verify || [])].map((r) => String(r).toLowerCase()));
  const offDisk = new Set(); // rels whose file is not what the manifest recorded
  const need = new Set();
  for (const f of plan.files) {
    const p = prevFile.get(f.rel.toLowerCase());
    if (!p || p.id !== f.id || !p.hash || opts.dirty == null || opts.dirty.has(f.id)) { need.add(f.id); continue; }
    if (verify && !verify.has(f.rel.toLowerCase())) continue;
    const st = statOf(path.join(root, ...f.rel.split('/')));
    if (!st || st.size !== p.size || st.mtime !== p.mtime) { offDisk.add(f.rel.toLowerCase()); need.add(f.id); }
  }
  let snaps = new Map();
  if (need.size) {
    if (opts.serializeMany) snaps = opts.serializeMany([...need]);
    else for (const id of need) snaps.set(id, serialize(id));
  }

  const split = new Map(); // one snapshot per module, two files from it
  const files = [];
  for (const f of plan.files) {
    const p = prevFile.get(f.rel.toLowerCase());
    if (!need.has(f.id)) { files.push({ rel: f.rel, id: f.id, part: f.part, hash: p.hash, size: p.size, mtime: p.mtime }); continue; }
    const abs = path.join(root, ...f.rel.split('/'));
    if (!split.has(f.id)) {
      const s = snaps.get(f.id);
      split.set(f.id, s ? splitSnapshot(s) : null);
    }
    const parts = split.get(f.id);
    if (!parts) continue; // the module went away mid-sync; the next sync settles it
    const body = JSON.stringify(parts[f.part]);
    const hash = hashOf(body);
    let same = !!p?.hash && p.hash === hash && p.id === f.id && !offDisk.has(f.rel.toLowerCase());
    if (same && opts.verify === 'all') same = !!statOf(abs);
    if (!same && p && !p.hash) { // a manifest from before Procress 20: compare once by reading
      try { same = fs.readFileSync(abs, 'utf8') === body; } catch (_) {}
    }
    if (!same) { fs.writeFileSync(abs, body); written++; touched.push(abs); }
    const st = statOf(abs) || { size: Buffer.byteLength(body), mtime: 0 };
    files.push({ rel: f.rel, id: f.id, part: f.part, hash, size: st.size, mtime: st.mtime });
  }
  const nowFiles = new Set(plan.files.map((f) => f.rel.toLowerCase()));
  for (const { rel } of prev.files) {
    if (nowFiles.has(rel.toLowerCase()) || !MIRROR_EXTS.some((e) => rel.endsWith(e))) continue;
    const abs = inside(root, rel);
    if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); removed++; touched.push(abs); } catch (_) {} }
  }
  // Deepest first; rmdirSync only succeeds on an empty folder, so a folder
  // the user has put anything into survives.
  const nowDirs = new Set(plan.dirs.map((d) => d.rel.toLowerCase()));
  for (const { rel } of [...prev.dirs].sort((a, b) => b.rel.length - a.rel.length)) {
    if (nowDirs.has(rel.toLowerCase())) continue;
    const abs = inside(root, rel);
    if (abs) { try { fs.rmdirSync(abs); touched.push(abs); } catch (_) {} }
  }
  const manifest = JSON.stringify({
    note: 'Written by DraconDex. The .ddx is the source of truth; this folder mirrors it.',
    version: 2, autoName: prev.autoName,
    files, dirs: plan.dirs.map((d) => ({ rel: d.rel, id: d.id })),
  }, null, 1);
  const manifestWritten = manifest !== prev.raw;
  if (manifestWritten) {
    fs.writeFileSync(path.join(root, MANIFEST), manifest);
    touched.push(path.join(root, MANIFEST));
  }
  return { ok: true, dirs: plan.dirs.length, files: plan.files.length, written, removed, moved, touched, serialized: need.size, manifestWritten };
}

// The sync the IPC runs: this Nexus's modules from its own vault file.
// full = the Nexus just opened (or its folder was just made): every module
// is checked. Otherwise only what db/locate.js recorded as changed.
function syncNexusMirror(nexusId, { full = false, verify = null } = {}) {
  const { getVault } = require('./vaults');
  const { getVaultDB } = require('./conn');
  const { serializeModules } = require('./snapshot-split');
  const locate = require('./locate');
  const v = getVault(nexusId);
  if (!v?.locate_dir) return { ok: false, code: 'no_dir' };
  if (v.locate_missing) return { ok: false, code: 'missing' };
  const db = getVaultDB(nexusId);
  const tracking = locate.trackVault(nexusId, db);
  const changed = locate.takeDirty(nexusId);
  const all = full || !tracking || changed.all;
  const modules = db.prepare(`SELECT id, parent_id, name, kind, display_order FROM module WHERE nexus_ref=?`).all(nexusId);
  let out;
  try {
    out = writeMirror(v.locate_dir, modules, null, {
      dirty: all ? null : changed.ids,
      verify: full ? 'all' : verify,
      serializeMany: (ids) => (all ? serializeModules(nexusId) : serializeModules(nexusId, ids)),
    });
  } catch (e) {
    locate.giveBackDirty(nexusId, changed);
    throw e;
  }
  // A folder that moved carried the user's files with it: re-point every
  // asset registered under it, or the next sweep would mark them missing.
  for (const { from, to } of out.moved || []) repointAssets(db, nexusId, from, to);
  locate.ignoreOwn(nexusId, out.touched);
  if (out.ok) locate.markActive(nexusId);
  const { touched, ...rest } = out;
  return { ...rest, moved: (out.moved || []).length };
}

function repointAssets(db, nexusId, from, to) {
  const rows = db.prepare(`SELECT id, file_path FROM import_file WHERE nexus_ref=? AND source_kind='file'`).all(nexusId);
  const st = db.prepare(`UPDATE import_file SET file_path=?, missing=0 WHERE id=?`);
  // one transaction: a statement outside one costs ~2.5 ms (conn.js), and a
  // moved folder can hold thousands of assets
  db.transaction(() => {
    for (const r of rows) {
      const rel = path.relative(from, r.file_path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      st.run(path.join(to, rel), r.id);
    }
  })();
}

module.exports = {
  MANIFEST, MODULE_EXT, MIRROR_EXTS, dirNameOf, collectorNameOfDir, planMirror, readManifest, writeMirror,
  syncNexusMirror, repointAssets,
};
