'use strict';
// ═══ Port Link — the 3-way merge (Procress 32 part 4) ══════════════════════
// Three files of one Nexus:
//   B  the base — what the drive held at the last sync (this machine's copy)
//   L  this machine's file, edited since
//   D  the drive's file, edited since (on another machine, or by the portable app)
// The result W starts as a scratch copy of D and gets L's changes laid on top,
// so the DRIVE's ids never move — other machines' bases stay valid (the drive
// is the hub, APP Plan.md Procress 32). W then goes to the drive, becomes the
// new base, and (renumbered to this machine's id) replaces L.
//
// Rows are matched by (table, id): every vault table but the nine *_hashtag /
// *_tag join tables is AUTOINCREMENT, so an id is never reused and a row in B
// is the same row in L and D. Per row, against B:
//   changed on one side         that side's values
//   changed on both             per column; a column both changed differently
//                               is a CONFLICT — the user picks (merge returns
//                               needs_choice and writes nothing until told)
//   deleted on one, edited on   kept (an edit wins over a delete — nothing
//   the other                   is lost without a word)
//   new on this machine         added to W; if the drive made a row with the
//                               same id meanwhile, ours is renumbered and every
//                               reference to it rewritten (below); if a UNIQUE
//                               says it is the same thing (a tag both made),
//                               it becomes that row
// Join tables are sets: what L added is added, what L removed is removed.
//
// References a renumber must follow: foreign keys (from the schema), entity
// keys (KEY_COLUMNS) and every other stored id (ID_REFS: nexus_history
// .module_ref, module_ui's pageHead:<key> / mapModule / timelineModule /
// clsRelInclude, an Exhibitor node's props.fields / props.columns) — the
// last two from SDB's entity-kinds.json, shared with the APK merge. A reference to a row that was
// NOT renumbered is left as it is — it names a row both sides share.
//
// Nothing is written until the whole merge is built; the drive file is put in
// place under a .tmp name and renamed; this machine's file is backed up first
// (the last 3 kept) and only replaced once the drive has the result.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const { getAppDB, getVaultDB, adaptDb, closeVault } = require('./conn');
const { getVault } = require('./vaults');
const { renumberNexusIn } = require('./nexus');
const { rebase } = require('./portable');
const { repointAssets } = require('./mirror');
const { ENTITY_KINDS, KEY_COLUMNS, ID_REFS } = require('./entity-kinds');
const drives = require('./portlink-drives');
const pl = require('./portlink');

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
const scratch = (tag) => path.join(os.tmpdir(), `dracondex-merge-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${tag}.ddx`);
const isBlob = (v) => v instanceof Uint8Array;
const same = (a, b) => (isBlob(a) || isBlob(b) ? isBlob(a) && isBlob(b) && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0 : a === b);
const KEEP_BACKUPS = 3;

// ── Reading a file's tables ────────────────────────────────────────────────
// Derived data (the FTS search index and its shadow tables) is not merged:
// it is rebuilt from the content.
function tablesOf(db) {
  const all = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all();
  const virt = all.filter((t) => /^\s*CREATE\s+VIRTUAL/i.test(t.sql || '')).map((t) => t.name);
  return all.map((t) => t.name).filter((n) => !virt.some((v) => n === v || n.startsWith(`${v}_`)));
}
function shapeOf(db, t) {
  const cols = db.prepare(`PRAGMA table_info(${q(t)})`).all();
  const fks = db.prepare(`PRAGMA foreign_key_list(${q(t)})`).all().map((f) => ({ from: f.from, table: f.table }));
  const uniques = db.prepare(`PRAGMA index_list(${q(t)})`).all()
    .filter((i) => i.unique && i.origin !== 'pk')
    .map((i) => db.prepare(`PRAGMA index_info(${q(i.name)})`).all().map((c) => c.name));
  return { cols: cols.map((c) => c.name), hasId: cols.some((c) => c.name === 'id' && c.pk === 1), fks, uniques };
}
const rowsOf = (db, t, has) => (has ? db.prepare(`SELECT * FROM ${q(t)}`).all() : []);
const byId = (rows) => new Map(rows.map((r) => [Number(r.id), r]));
const tupleKey = (r, cols) => JSON.stringify(cols.map((c) => (isBlob(r[c]) ? Buffer.from(r[c]).toString('base64') : r[c] ?? null)));

// Parents before children, so an inserted row's parent ids are already mapped.
function topo(tables, shapes) {
  const out = [], seen = new Set();
  const visit = (t, stack = new Set()) => {
    if (seen.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const f of shapes[t].fks) if (f.table !== t && shapes[f.table]) visit(f.table, stack);
    seen.add(t); out.push(t);
  };
  tables.forEach((t) => visit(t));
  return out;
}

// ── References ─────────────────────────────────────────────────────────────
const PREFIX_TABLE = Object.fromEntries(Object.entries(ENTITY_KINDS).map(([p, k]) => [p, k.table]));
function makeRemap(idMap) {
  const id = (table, v) => { const m = idMap[table]; return v != null && m && m.has(Number(v)) ? m.get(Number(v)) : v; };
  const key = (k) => {
    const m = /^([a-z]+)_(\d+)$/.exec(String(k ?? ''));
    if (!m || !PREFIX_TABLE[m[1]]) return k;
    const to = id(PREFIX_TABLE[m[1]], Number(m[2]));
    return to === Number(m[2]) ? k : `${m[1]}_${to}`;
  };
  const json = (s, fn) => { try { return JSON.stringify(fn(JSON.parse(s))); } catch (_) { return s; } };
  // Every non-FK reference in one row (FKs are mapped by the caller, from the schema).
  function refs(t, r) {
    for (const kc of KEY_COLUMNS) {
      if (kc.table !== t) continue;
      for (const c of kc.cols) {
        if (r[c] == null) continue;
        if (kc.json) r[c] = json(r[c], (l) => (Array.isArray(l) ? l.map((e) => (e && e.key ? { ...e, key: key(e.key) } : e)) : l));
        else if (!kc.only || kc.only.test(String(r[c]))) r[c] = key(r[c]);
      }
    }
    // The rest comes from SDB (idRefs) — the same list the APK merge reads.
    // `when` is judged on the row as it came in, before any of these rewrites.
    const orig = { ...r };
    for (const ir of ID_REFS) {
      if (ir.table !== t || r[ir.col] == null) continue;
      if (ir.when && !ir.when.in.has(String(orig[ir.when.col]))) continue;
      const v = r[ir.col];
      if (ir.shape === 'id') {
        const to = id(ir.to, v);
        r[ir.col] = to !== v && typeof v === 'string' ? String(to) : to; // an id kept as TEXT stays TEXT
      } else if (ir.shape === 'prefixedKey') {
        if (String(v).startsWith(ir.prefix)) r[ir.col] = ir.prefix + key(String(v).slice(ir.prefix.length));
      } else if (ir.shape === 'jsonIdList') {
        r[ir.col] = json(v, (l) => (Array.isArray(l) ? l.map((x) => id(ir.to, x)) : l));
      } else if (ir.shape === 'jsonObjectIdLists') {
        r[ir.col] = json(v, (o) => {
          if (o && typeof o === 'object') for (const k of ir.keys) if (Array.isArray(o[k])) o[k] = o[k].map((x) => id(ir.to, x));
          return o;
        });
      }
    }
    return r;
  }
  return { id, key, refs };
}

// ── The merge itself, on three open connections. Pure: writes only W. ─────
// choices: { '<table>:<id>:<col>': 'local'|'drive', '*': 'local'|'drive' }
function mergeInto(B, L, W, choices = {}) {
  const tables = tablesOf(W).filter((t) => tablesOf(L).includes(t));
  const bT = new Set(tablesOf(B));
  const shapes = {};
  for (const t of tables) {
    const sw = shapeOf(W, t), sl = new Set(shapeOf(L, t).cols);
    shapes[t] = { ...sw, cols: sw.cols.filter((c) => sl.has(c)) };
  }
  const order = topo(tables, shapes);
  const idMap = {}; // table → Map(L id → W id), only for rows that had to move
  const remap = makeRemap(idMap);
  const conflicts = [];
  // [table, W id, L row as read, the columns W took from it] — for the reference pass
  const written = [];
  const sum = { fromLocal: 0, updated: 0, deleted: 0, kept: 0, merged: 0, conflicts: 0, driveAdded: 0, driveChanged: 0, driveRemoved: 0 };
  const mapFks = (t, r) => { for (const f of shapes[t].fks) if (r[f.from] != null) r[f.from] = remap.id(f.table, r[f.from]); return r; };
  const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
  const insert = (t, r) => {
    const cols = shapes[t].cols.filter((c) => c in r);
    return W.prepare(`INSERT INTO ${q(t)} (${cols.map(q).join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => r[c]));
  };
  const update = (t, id, r, cols) => {
    if (!cols.length) return;
    W.prepare(`UPDATE ${q(t)} SET ${cols.map((c) => `${q(c)}=?`).join(',')} WHERE id=?`).run(...cols.map((c) => r[c]), id);
  };
  const deletes = []; // [table, id] — L deleted, D did not touch

  W.exec('PRAGMA foreign_keys = OFF');
  const tx = () => {
    for (const t of order) {
      const s = shapes[t];
      if (!s.hasId) {
        // a join table: sets of rows
        const bs = new Set(rowsOf(B, t, bT.has(t)).map((r) => tupleKey(r, s.cols)));
        const ls = rowsOf(L, t, true);
        const lk = new Set(ls.map((r) => tupleKey(r, s.cols)));
        for (const r of ls) if (!bs.has(tupleKey(r, s.cols))) { mapFks(t, r); try { const c = s.cols.filter((x) => x in r); W.prepare(`INSERT OR IGNORE INTO ${q(t)} (${c.map(q).join(',')}) VALUES (${c.map(() => '?').join(',')})`).run(...c.map((x) => r[x])); sum.fromLocal++; } catch (_) {} }
        for (const r of rowsOf(B, t, bT.has(t))) {
          if (lk.has(tupleKey(r, s.cols))) continue;
          const c = s.cols;
          W.prepare(`DELETE FROM ${q(t)} WHERE ${c.map((x) => `${q(x)} IS ?`).join(' AND ')}`).run(...c.map((x) => r[x]));
        }
        continue;
      }
      const b = byId(rowsOf(B, t, bT.has(t))), l = byId(rowsOf(L, t, true)), d = byId(rowsOf(W, t, true));
      const cols = s.cols.filter((c) => c !== 'id');
      // what the drive did since the base — for the summary only
      for (const [id, dr] of d) { const br = b.get(id); if (!br) sum.driveAdded++; else if (cols.some((c) => !same(dr[c], br[c]))) sum.driveChanged++; }
      for (const id of b.keys()) if (!d.has(id)) sum.driveRemoved++;
      let nextId = Math.max(0, ...b.keys(), ...l.keys(), ...d.keys()) + 1;
      for (const [id, lr] of l) {
        const br = b.get(id), dr = d.get(id);
        if (!br) {
          // new on this machine
          const r = mapFks(t, { ...lr });
          let wid = id;
          if (dr) { wid = nextId++; r.id = wid; (idMap[t] ||= new Map()).set(id, wid); }
          try { insert(t, r); written.push([t, wid, lr, cols]); sum.fromLocal++; }
          catch (e) {
            // a UNIQUE says the drive already has it (both made the same tag …): that row it is
            const u = s.uniques.find((cs) => cs.every((c) => r[c] != null));
            const ex = u && W.prepare(`SELECT * FROM ${q(t)} WHERE ${u.map((c) => `${q(c)}=?`).join(' AND ')}`).get(...u.map((c) => r[c]));
            if (!ex) throw e;
            (idMap[t] ||= new Map()).set(id, Number(ex.id));
            if (String(lr.update_at || '') > String(ex.update_at || '')) {
              const up = cols.filter((c) => !u.includes(c) && !same(r[c], ex[c]));
              update(t, ex.id, r, up);
              written.push([t, Number(ex.id), lr, up]);
            }
            sum.merged++;
          }
          continue;
        }
        const lc = cols.filter((c) => !same(lr[c], br[c]));
        if (!lc.length) continue; // unchanged here: W (= the drive) already has the answer
        if (!dr) {
          // the drive deleted it, this machine edited it: kept
          insert(t, mapFks(t, { ...lr })); written.push([t, id, lr, cols]); sum.kept++;
          continue;
        }
        const r = mapFks(t, { ...lr });
        const take = [];
        for (const c of lc) {
          if (same(dr[c], br[c]) || same(dr[c], r[c])) { take.push(c); continue; }
          if (c === 'update_at') { if (String(r[c]) > String(dr[c])) take.push(c); continue; }
          const k = `${t}:${id}:${c}`;
          const choice = choices[k] || choices['*'];
          if (choice === 'local') take.push(c);
          else if (choice !== 'drive') conflicts.push({ key: k, table: t, id, col: c, base: br[c], local: lr[c], drive: dr[c], label: lr.name ?? lr.title ?? dr.name ?? dr.title ?? null, localAt: lr.update_at ?? null, driveAt: dr.update_at ?? null });
        }
        update(t, id, r, take); if (take.length) { written.push([t, id, lr, take]); sum.updated++; }
      }
      for (const [id, br] of b) {
        if (l.has(id) || !d.has(id)) continue;
        // deleted here; deleted from W only if the drive left it as it was
        if (cols.every((c) => same(d.get(id)[c], br[c]))) deletes.push([t, id]);
        else sum.kept++;
      }
    }
    for (const [t, id] of deletes) { W.prepare(`DELETE FROM ${q(t)} WHERE id=?`).run(id); sum.deleted++; }

    // References: every column W took from L, mapped ONCE from L's own value
    // through every map (FKs again too — a parent in the same table may have
    // been renumbered after its child went in). Only those columns: the rest
    // of the row is the drive's, its ids are already W's, and mapping them
    // would move a drive-side reference onto a renumbered row of this machine.
    if (Object.keys(idMap).length) {
      for (const [t, id, lr, from] of written) {
        const r = W.prepare(`SELECT * FROM ${q(t)} WHERE id=?`).get(id);
        if (!r) continue;
        const m = remap.refs(t, mapFks(t, { ...lr }));
        const up = from.filter((c) => !same(m[c], r[c]));
        for (const c of up) r[c] = m[c];
        update(t, id, r, up);
      }
    }

    // Integrity: a row left pointing at a parent the merge removed gets the
    // parent back (restored from L, or from the drive as it was); one whose
    // parent exists nowhere is dropped. Until nothing changes.
    for (let pass = 0; pass < 50; pass++) {
      const bad = W.prepare('PRAGMA foreign_key_check').all();
      if (!bad.length) break;
      let fixed = false;
      for (const v of bad) {
        const fk = W.prepare(`PRAGMA foreign_key_list(${q(v.table)})`).all().find((f) => f.id === v.fkid);
        const child = W.prepare(`SELECT * FROM ${q(v.table)} WHERE rowid=?`).get(v.rowid);
        if (!fk || !child) continue;
        const pid = child[fk.from];
        const src = shapes[v.parent]?.hasId && (L.prepare(`SELECT * FROM ${q(v.parent)} WHERE id=?`).get(pid) || B.prepare(`SELECT * FROM ${q(v.parent)} WHERE id=?`).get(pid));
        if (src && !W.prepare(`SELECT 1 FROM ${q(v.parent)} WHERE id=?`).get(pid)) { insert(v.parent, mapFks(v.parent, { ...src })); sum.kept++; sum.deleted = Math.max(0, sum.deleted - 1); fixed = true; }
        else { W.prepare(`DELETE FROM ${q(v.table)} WHERE rowid=?`).run(v.rowid); fixed = true; }
      }
      if (!fixed) break;
    }
  };
  W.transaction(tx)();
  W.exec('PRAGMA foreign_keys = ON');
  sum.conflicts = conflicts.length;
  return { conflicts, summary: sum };
}

// ── The link: three files on disk → merged, everywhere ─────────────────────
// isOpen(nexusId): a window holds it — then no merge (its file is replaced).
// → { ok, summary } · { ok:false, code:'needs_choice', conflicts } · { ok:false, code }
function mergeLink(nexusId, { choices = {}, isOpen = () => false } = {}) {
  const link = pl.linkOf(nexusId);
  if (!link) return { ok: false, code: 'not_linked' };
  if (isOpen(nexusId)) return { ok: false, code: 'open' };
  const drive = drives.listDrives().find((d) => d.driveUid === link.driveUid);
  if (!drive) return { ok: false, code: 'no_drive' };
  if (drive.running) return { ok: false, code: 'drive_busy' };
  const dn = drive.nexuses.find((n) => n.id === link.driveNexusId);
  if (!dn || dn.missing) return { ok: false, code: 'gone' };
  const v = getVault(nexusId);
  if (!v?.file_path || v.missing) return { ok: false, code: 'not_found' };
  if (!fs.existsSync(link.basePath)) return { ok: false, code: 'no_base' };
  const own = drive.ownRoot || drive.root;
  const driveLoc = dn.locate_dir ? rebase(dn.locate_dir, drive.root, own) : null; // as the drive's rows name it

  const files = { l: scratch('l'), w: scratch('w') };
  const open = (f, ro) => adaptDb(new _RawDatabase(f, ro ? { readOnly: true } : undefined));
  let B, L, W;
  try {
    const driveSig = pl.sigOf(dn.file_path);
    getVaultDB(nexusId).prepare(`VACUUM INTO ?`).run(files.l);
    fs.copyFileSync(dn.file_path, files.w);
    // L in the drive's terms: its nexus id, its asset folder
    L = open(files.l);
    renumberNexusIn(L, nexusId, link.driveNexusId);
    if (v.locate_dir && driveLoc) repointAssets(L, link.driveNexusId, v.locate_dir, driveLoc);
    B = open(link.basePath, true);
    W = open(files.w);
    const r = mergeInto(B, L, W, choices);
    if (r.conflicts.length) return { ok: false, code: 'needs_choice', conflicts: r.conflicts.map(showable) };
    for (const db of [B, L, W]) { try { db.close(); } catch (_) {} }
    B = L = W = null;

    // 1. the drive — unless it changed under us while we merged
    if (pl.sigOf(dn.file_path) !== driveSig) return { ok: false, code: 'drive_changed' };
    const dtmp = pl.tmpOf(dn.file_path);
    fs.copyFileSync(files.w, dtmp);
    fs.renameSync(dtmp, dn.file_path);
    // 2. the new base
    const base = path.join(pl.baseDir(), `${crypto.randomUUID()}.base.ddx`);
    fs.copyFileSync(files.w, base);
    // 3. this machine: backed up, then replaced (renumbered, assets pointed home)
    closeVault(nexusId);
    const bdir = path.join(pl.baseDir(), 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    fs.copyFileSync(v.file_path, path.join(bdir, `${link.linkUid}-${Date.now()}.ddx`));
    const old = fs.readdirSync(bdir).filter((f) => f.startsWith(link.linkUid)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) pl.rmQuiet(path.join(bdir, f));
    const ltmp = pl.tmpOf(v.file_path);
    fs.copyFileSync(files.w, ltmp);
    const n = open(ltmp);
    try {
      renumberNexusIn(n, link.driveNexusId, nexusId);
      if (v.locate_dir && driveLoc) repointAssets(n, nexusId, driveLoc, v.locate_dir);
    } finally { n.close(); }
    fs.renameSync(ltmp, v.file_path);
    // 4. asset files a row now names but that side's folder lacks
    const copied = syncAssetFiles(v.file_path, nexusId, v.locate_dir, dn.locate_dir);
    // 5. the link
    pl.rmQuiet(link.basePath);
    getAppDB().prepare(`UPDATE port_link SET base_path=?, local_sig=?, drive_sig=?, last_sync_at=datetime('now') WHERE link_uid=?`)
      .run(base, pl.sigOf(v.file_path), pl.sigOf(dn.file_path), link.linkUid);
    drives.rescan();
    return { ok: true, summary: { ...r.summary, assetsCopied: copied } };
  } catch (e) {
    return { ok: false, code: e.code || 'merge_failed', error: String(e?.message || e) };
  } finally {
    for (const db of [B, L, W]) { try { db?.close(); } catch (_) {} }
    pl.rmQuiet(files.l); pl.rmQuiet(files.w);
  }
}

// A file a merged row points at, present on one side only → copied across.
// ponytail: an asset edited in place on both sides keeps each side's bytes;
// add a hash compare if that turns out to happen.
function syncAssetFiles(localFile, nexusId, localDir, driveDir) {
  if (!localDir || !driveDir) return 0;
  const db = open1(localFile);
  let n = 0;
  try {
    for (const r of db.prepare(`SELECT file_path FROM import_file WHERE nexus_ref=? AND source_kind='file'`).all(nexusId)) {
      const rel = path.relative(localDir, r.file_path);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const here = path.join(localDir, rel), there = path.join(driveDir, rel);
      try {
        if (!fs.existsSync(here) && fs.existsSync(there)) { fs.mkdirSync(path.dirname(here), { recursive: true }); fs.copyFileSync(there, here); n++; }
        else if (fs.existsSync(here) && !fs.existsSync(there)) { fs.mkdirSync(path.dirname(there), { recursive: true }); fs.copyFileSync(here, there); n++; }
      } catch (_) {}
    }
  } finally { db.close(); }
  return n;
}
const open1 = (f) => adaptDb(new _RawDatabase(f, { readOnly: true }));

// What the renderer gets for a conflict: short text, no blobs.
function showable(c) {
  const v = (x) => (x == null ? null : isBlob(x) ? `[${x.length} bytes]` : String(x).length > 300 ? `${String(x).slice(0, 300)}…` : x);
  return { ...c, base: v(c.base), local: v(c.local), drive: v(c.drive) };
}

module.exports = { mergeInto, mergeLink };
