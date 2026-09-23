'use strict';
// ═══ The Nexus folder mirror (v5 Part 4, APP docs/V5.md §8.5–§8.7) ════════
// A Nexus can be "located" into a real folder: collectors become
// sub-folders and every other module becomes a `<name>.mddx` file in its
// collector's folder. The .ddx stays the source of truth (§8.1) — this is a
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
// What the mirror may delete: only a .mddx it wrote itself (listed in its
// manifest) that no longer has a module behind it, and a folder it created
// that is now empty. A file the user put in the folder is never touched.
const fs = require('fs');
const path = require('path');

const MANIFEST = '.dracondex-mirror.json';
const MODULE_EXT = '.mddx';
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
      const key = (b) => (isDir ? b : b + MODULE_EXT).toLowerCase();
      if (used.has(key(base))) base = `${base} (${m.id})`;
      used.add(key(base));
      const p = rel ? `${rel}/${base}` : base;
      if (isDir) {
        dirs.push({ id: m.id, rel: p });
        walk(m.id, p);
      } else {
        files.push({ id: m.id, rel: p + MODULE_EXT });
      }
    }
  };
  walk(null, '');
  return { dirs, files };
}

// dirs are {rel, id}: the id is what lets a renamed or moved collector move
// its folder instead of leaving the old one behind (see writeMirror).
function readManifest(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
    const dirs = (Array.isArray(j.dirs) ? j.dirs : [])
      .map((d) => (typeof d === 'string' ? { rel: d, id: null } : { rel: String(d?.rel || ''), id: d?.id ?? null }))
      .filter((d) => d.rel);
    return { files: Array.isArray(j.files) ? j.files : [], dirs };
  } catch (_) { return { files: [], dirs: [] }; }
}

// A relative path from the manifest, resolved and confirmed to stay inside
// the root — a hand-edited manifest must not reach outside the folder.
function inside(root, rel) {
  const abs = path.resolve(root, String(rel));
  const r = path.relative(root, abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? abs : null;
}

// Write the mirror for one Nexus into `root`. `serialize(moduleId)` returns
// the module's snapshot (sync.js serializeVault scoped to that one module —
// the same payload the .mddx export writes, §8.7). Unchanged files are left
// alone, so a sync that changes nothing writes nothing.
function writeMirror(root, modules, serialize) {
  if (!root || !fs.existsSync(root)) return { ok: false, code: 'missing' };
  const plan = planMirror(modules);
  const prev = readManifest(root);
  let written = 0, removed = 0;
  const moved = []; // [{from, to}] absolute folder paths that moved
  // A collector renamed or moved in the app: move ITS folder (with whatever
  // the user keeps in it) to the new place, shallowest first, rewriting the
  // remembered paths below it as each parent moves. Without this the next
  // sync's folder import would bring the old folder back as a collector.
  const prevRel = new Map(prev.dirs.filter((d) => d.id != null).map((d) => [d.id, d.rel]));
  for (const dir of [...plan.dirs].sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)) {
    const was = prevRel.get(dir.id);
    if (!was || was === dir.rel) continue;
    const from = inside(root, was), to = inside(root, dir.rel);
    if (!from || !to || !fs.existsSync(from) || fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push({ from, to });
      for (const [id, rel] of prevRel) {
        if (rel === was || rel.startsWith(`${was}/`)) prevRel.set(id, dir.rel + rel.slice(was.length));
      }
      for (const d of prev.dirs) if (d.rel === was || d.rel.startsWith(`${was}/`)) d.rel = dir.rel + d.rel.slice(was.length);
      prev.files = prev.files.map((f) => (String(f).startsWith(`${was}/`) ? dir.rel + String(f).slice(was.length) : f));
    } catch (_) { /* leave it; the folder is recreated below */ }
  }
  for (const dir of plan.dirs) fs.mkdirSync(path.join(root, ...dir.rel.split('/')), { recursive: true });
  for (const f of plan.files) {
    const abs = path.join(root, ...f.rel.split('/'));
    const body = JSON.stringify(serialize(f.id));
    let cur = null;
    try { cur = fs.readFileSync(abs, 'utf8'); } catch (_) {}
    if (cur !== body) { fs.writeFileSync(abs, body); written++; }
  }
  const nowFiles = new Set(plan.files.map((f) => f.rel.toLowerCase()));
  for (const rel of prev.files) {
    if (nowFiles.has(String(rel).toLowerCase()) || !String(rel).endsWith(MODULE_EXT)) continue;
    const abs = inside(root, rel);
    if (abs && fs.existsSync(abs)) { try { fs.unlinkSync(abs); removed++; } catch (_) {} }
  }
  // Deepest first; rmdirSync only succeeds on an empty folder, so a folder
  // the user has put anything into survives.
  const nowDirs = new Set(plan.dirs.map((d) => d.rel.toLowerCase()));
  for (const { rel } of [...prev.dirs].sort((a, b) => b.rel.length - a.rel.length)) {
    if (nowDirs.has(rel.toLowerCase())) continue;
    const abs = inside(root, rel);
    if (abs) { try { fs.rmdirSync(abs); } catch (_) {} }
  }
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({
    note: 'Written by DraconDex. The .ddx is the source of truth; this folder mirrors it.',
    files: plan.files.map((f) => f.rel), dirs: plan.dirs.map((d) => ({ rel: d.rel, id: d.id })),
  }, null, 1));
  return { ok: true, dirs: plan.dirs.length, files: plan.files.length, written, removed, moved };
}

// The sync the IPC runs: this Nexus's modules from its own vault file.
function syncNexusMirror(nexusId) {
  const { getVault } = require('./vaults');
  const { getVaultDB } = require('./conn');
  const { serializeVault } = require('./sync');
  const v = getVault(nexusId);
  if (!v?.locate_dir) return { ok: false, code: 'no_dir' };
  if (v.locate_missing) return { ok: false, code: 'missing' };
  const db = getVaultDB(nexusId);
  const modules = db.prepare(`SELECT id, parent_id, name, kind, display_order FROM module WHERE nexus_ref=?`).all(nexusId);
  const out = writeMirror(v.locate_dir, modules, (id) => serializeVault(nexusId, [id]));
  // A folder that moved carried the user's files with it: re-point every
  // asset registered under it, or the next sweep would mark them missing.
  for (const { from, to } of out.moved || []) repointAssets(db, nexusId, from, to);
  return { ...out, moved: (out.moved || []).length };
}

function repointAssets(db, nexusId, from, to) {
  const rows = db.prepare(`SELECT id, file_path FROM import_file WHERE nexus_ref=? AND source_kind='file'`).all(nexusId);
  const st = db.prepare(`UPDATE import_file SET file_path=?, missing=0 WHERE id=?`);
  for (const r of rows) {
    const rel = path.relative(from, r.file_path);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    st.run(path.join(to, rel), r.id);
  }
}

module.exports = {
  MODULE_EXT, dirNameOf, collectorNameOfDir, planMirror, writeMirror, syncNexusMirror,
};
