'use strict';
const { getDB } = require('./core');
const { scopedAll, scopedGet } = require('./sqlscope');
const { CONTENT_SOURCES, NEXUS_OF } = require('./wiki-sources');
const { ENTITY_KINDS } = require('./entity-kinds');

// Wiki-link index (v2.8). [[Name]] references typed inside markdown content
// (Scribe notes, Director object notes, Writer chapters) are parsed on save,
// resolved against the vault's entities and stored in wiki_link. The text is
// the source of truth — this table is a rebuildable index (see backfill).
//
// Entity keys follow Sage's getLinkerGraph convention: note_3, obj_12,
// wchar_7, wobj_4, gchar_2, gel_9, wchp_5, wnote_1, proj_6, world_2, game_1,
// write_3.

// Keep in sync with MD_WIKILINK_RE in src/renderer/markdown.js.
const WIKILINK_RE = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g;

// ── Name resolution ─────────────────────────────────────────────────────────
// Fixed, deterministic precedence; case-insensitive (ASCII). A namespace
// prefix ([[note:X]], [[obj:X]], …) forces one resolver.
// v5 Part 7 (§11.2): the v3+ families come from db/entity-kinds.js — note
// first, then the read-only legacy prefixes, then the rest in declared order
// (file last, so an asset's file name never shadows an entity's name). A
// family with `wiki: false` (tlev, sdlg) is left out on purpose, and says so
// there.
const ekResolver = (prefix) => [prefix, (d, n, nx) => scopedGet(d, ENTITY_KINDS[prefix].wiki.sql, nx, n)?.id, `${prefix}_`];
const WIKI_FAMILIES = Object.keys(ENTITY_KINDS).filter((p) => ENTITY_KINDS[p].wiki);
const RESOLVERS = [
  ...WIKI_FAMILIES.filter((p) => p === 'note').map(ekResolver),
  ['obj',   (d, n, nx) => scopedGet(d, `SELECT o.id FROM object o JOIN project p ON o.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?) AND o.name=? COLLATE NOCASE`, nx, n)?.id, 'obj_'],
  ['wchar', (d, n, nx) => scopedGet(d, `SELECT c.id FROM world_character c JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?) AND c.name=? COLLATE NOCASE`, nx, n)?.id, 'wchar_'],
  ['wobj',  (d, n, nx) => scopedGet(d, `SELECT o.id FROM world_orig_object o JOIN world_orig_category c ON o.category_id=c.id JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?) AND o.name=? COLLATE NOCASE`, nx, n)?.id, 'wobj_'],
  ['gchar', (d, n, nx) => scopedGet(d, `SELECT c.id FROM game_character c JOIN game_project g ON c.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?) AND c.name=? COLLATE NOCASE`, nx, n)?.id, 'gchar_'],
  ['gel',   (d, n, nx) => scopedGet(d, `SELECT e.id FROM game_col_element e JOIN game_collection c ON e.collection_ref=c.id JOIN game_project g ON c.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?) AND e.name=? COLLATE NOCASE`, nx, n)?.id, 'gel_'],
  ['wchp',  (d, n, nx) => scopedGet(d, `SELECT ch.id FROM write_chapter ch JOIN write_book b ON ch.book_id=b.id JOIN write_series s ON b.series_id=s.id JOIN write_project p ON s.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?) AND ch.name=? COLLATE NOCASE`, nx, n)?.id, 'wchp_'],
  ['wnote', (d, n, nx) => scopedGet(d, `SELECT wn.id FROM write_note wn JOIN write_project p ON wn.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?) AND wn.notename=? COLLATE NOCASE`, nx, n)?.id, 'wnote_'],
  ['proj',  (d, n, nx) => scopedGet(d, `SELECT id FROM project WHERE (? IS NULL OR nexus_ref=?) AND name=? COLLATE NOCASE`, nx, n)?.id, 'proj_'],
  ['world', (d, n, nx) => scopedGet(d, `SELECT id FROM world_project WHERE (? IS NULL OR nexus_ref=?) AND name=? COLLATE NOCASE`, nx, n)?.id, 'world_'],
  ['game',  (d, n, nx) => scopedGet(d, `SELECT id FROM game_project WHERE (? IS NULL OR nexus_ref=?) AND name=? COLLATE NOCASE`, nx, n)?.id, 'game_'],
  ['write', (d, n, nx) => scopedGet(d, `SELECT id FROM write_project WHERE (? IS NULL OR nexus_ref=?) AND project_name=? COLLATE NOCASE`, nx, n)?.id, 'write_'],
  ...WIKI_FAMILIES.filter((p) => p !== 'note' && p !== 'file').map(ekResolver),
  ...WIKI_FAMILIES.filter((p) => p === 'file').map(ekResolver),
];

// Optional memo for bulk passes (Plan part2 #2.4). A miss costs all 17
// resolvers, and a rebuild resolves the same [[Name]] once per source that
// mentions it — reindexWikiLinks only dedupes within one source. Scope is
// deliberately ONE bulk operation, never process-lifetime: creating an
// entity retroactively changes a name that previously resolved to null
// (that is exactly what resolveDanglingLinks exists for), renameWikiTarget
// mutates names mid-flight, and deletes anywhere in src/db/* invalidate it
// with no hook back here. A long-lived memo would ship stale target_keys.
let _resolveMemo = null;
function withResolveMemo(fn) {
  const outer = _resolveMemo;
  _resolveMemo = new Map();
  try { return fn(); } finally { _resolveMemo = outer; }
}

function resolveWikiName(rawName, nexusId) {
  const d = getDB();
  const nx = nexusId ?? null;
  let name = String(rawName || '').trim();
  if (!name) return null;
  // Lowercased because every resolver matches COLLATE NOCASE; the forced
  // `ns:` prefix stays part of the key, since note:X and X can differ.
  const memoKey = _resolveMemo && `${nx}::${name.toLowerCase()}`;
  if (memoKey !== null && memoKey !== undefined && _resolveMemo.has(memoKey)) return _resolveMemo.get(memoKey);
  const result = _resolveWikiName(d, nx, name);
  if (memoKey !== null && memoKey !== undefined) _resolveMemo.set(memoKey, result);
  return result;
}

function _resolveWikiName(d, nx, name) {
  const forced = name.match(/^(\w+):(.+)$/);
  if (forced) {
    const r = RESOLVERS.find(([ns]) => ns === forced[1].toLowerCase());
    if (r) {
      const id = r[1](d, forced[2].trim(), nx);
      return id ? r[2] + id : null;
    }
  }
  for (const [, fn, prefix] of RESOLVERS) {
    try {
      const id = fn(d, name, nx);
      if (id) return prefix + id;
    } catch (_) {}
  }
  return null;
}

// ── Index maintenance ───────────────────────────────────────────────────────
function reindexWikiLinks(srcKey, content, nexusId) {
  const d = getDB();
  const links = [];
  WIKILINK_RE.lastIndex = 0;
  let m;
  while ((m = WIKILINK_RE.exec(String(content || ''))) !== null) {
    const name = m[1].trim();
    if (name) links.push(name);
  }
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM wiki_link WHERE src_key=?`).run(srcKey);
    const seen = new Set();
    for (const name of links) {
      const dedupe = name.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      d.prepare(`INSERT INTO wiki_link (nexus_ref, src_key, target_key, target_text) VALUES (?,?,?,?)`)
        .run(nexusId ?? null, srcKey, resolveWikiName(name, nexusId), name);
    }
  });
  tx();
}

// Vault of a content source, for the reindex hooks.
const nexusOfNote = (id) => getDB().prepare(`SELECT nexus_ref FROM note WHERE id=?`).get(id)?.nexus_ref ?? null;
const nexusOfObject = (id) => getDB().prepare(`SELECT p.nexus_ref FROM object o JOIN project p ON o.project_id=p.id WHERE o.id=?`).get(id)?.nexus_ref ?? null;
const nexusOfChapter = (id) => getDB().prepare(`
  SELECT p.nexus_ref FROM write_chapter ch JOIN write_book b ON ch.book_id=b.id
  JOIN write_series s ON b.series_id=s.id JOIN write_project p ON s.project_id=p.id WHERE ch.id=?
`).get(id)?.nexus_ref ?? null;

// Rebuild the whole index from every markdown-bearing source. Used by the
// one-time backfill in initDB and available after DB import-merge.
//
// Plan part2 #2.4: this used to issue 8 bare top-level statements plus one
// reindexWikiLinks per matched row — and reindexWikiLinks opens its own
// transaction, so R source rows meant R separate BEGIN/COMMIT lock cycles.
// One outer transaction collapses them all (db.transaction is reentrant via
// core.js's txDepth guard, so the inner ones become no-ops and no call site
// had to change). This matters most on the initDB backfill, which runs
// before setStatementCache(true) — there is no other lever on that path.
function rebuildWikiIndex() {
  const d = getDB();
  return withResolveMemo(() => d.transaction(_rebuildWikiIndex)());
}

function _rebuildWikiIndex() {
  const d = getDB();
  d.prepare(`DELETE FROM wiki_link`).run();
  // One loop over the registry (db/wiki-sources.js) — the list of indexed
  // fields and the list that is rebuilt can no longer drift apart.
  for (const [prefix, src] of Object.entries(CONTENT_SOURCES)) {
    for (const r of d.prepare(src.rebuild).all()) {
      const content = src.rebuildContent ? src.rebuildContent(d, r.id) : r.c;
      reindexWikiLinks(`${prefix}_${r.id}`, content, r.nexus_ref);
    }
  }
}

// Save-time hook for a field registered in db/wiki-sources.js: re-read the
// field's whole indexed text and reindex it. The callers are the db writes
// of those fields (classifier values, event stories, dialogue descriptions,
// Exhibitor notes).
function reindexSource(prefix, id) {
  const d = getDB();
  const src = CONTENT_SOURCES[prefix];
  if (!src || !NEXUS_OF[prefix]) throw new Error(`reindexSource: no source '${prefix}'`);
  const nexusRef = d.prepare(NEXUS_OF[prefix]).get(id)?.n ?? null;
  reindexWikiLinks(`${prefix}_${id}`, src.content(d, id), nexusRef);
}

// ── Key hydration ───────────────────────────────────────────────────────────
// key → {key, name, type, module}; unknown/dangling keys are omitted.
const KEY_LOOKUPS = {
  obj:   { sql: `SELECT id, name FROM object WHERE id=?`,                      type: 'object',    module: 'director' },
  wchar: { sql: `SELECT id, name FROM world_character WHERE id=?`,             type: 'character', module: 'navigator' },
  wobj:  { sql: `SELECT id, name FROM world_orig_object WHERE id=?`,           type: 'object',    module: 'navigator' },
  gchar: { sql: `SELECT id, name FROM game_character WHERE id=?`,              type: 'character', module: 'hero' },
  gel:   { sql: `SELECT id, name FROM game_col_element WHERE id=?`,            type: 'object',    module: 'hero' },
  wchp:  { sql: `SELECT id, name FROM write_chapter WHERE id=?`,               type: 'chapter',   module: 'writer' },
  wnote: { sql: `SELECT id, notename AS name FROM write_note WHERE id=?`,      type: 'note',      module: 'writer' },
  proj:  { sql: `SELECT id, name FROM project WHERE id=?`,                     type: 'project',   module: 'director' },
  world: { sql: `SELECT id, name FROM world_project WHERE id=?`,               type: 'project',   module: 'navigator' },
  game:  { sql: `SELECT id, name FROM game_project WHERE id=?`,                type: 'project',   module: 'hero' },
  write: { sql: `SELECT id, project_name AS name FROM write_project WHERE id=?`, type: 'project', module: 'writer' },
  // v5 Part 7 (§11.2): every v3+ family's lookup, from db/entity-kinds.js.
  ...Object.fromEntries(Object.entries(ENTITY_KINDS).map(([p, k]) => [p, k.lookup])),
};
// Plan part2 #2.4: one .get() per key became one IN-query per key PREFIX.
// The chunk size is fixed and the last chunk is padded by repeating an id
// (IN is a set — duplicates cannot add rows) so the SQL string set stays at
// exactly one shape per prefix. A variable-arity IN would mint a new string
// per (prefix, arity) pair, and core.js's statement cache is keyed on the
// literal SQL: that would churn its 256-entry LRU and could push the
// never-evicting `handles` map past its cap, degrading prepare() globally.
// Compile cost is ~1% anyway — the win here is collapsing N lock cycles.
const KEY_CHUNK = 64;

// Precomputed once so a future KEY_LOOKUPS entry that doesn't end in the
// expected `WHERE id=?` fails loudly here instead of silently degrading
// inside resolveEntityKeys's per-prefix try/catch.
const KEY_IN_SQL = Object.fromEntries(Object.entries(KEY_LOOKUPS).map(([prefix, lk]) => {
  if (!/WHERE id=\?$/.test(lk.sql)) throw new Error(`KEY_LOOKUPS.${prefix}.sql must end in "WHERE id=?"`);
  return [prefix, `${lk.sql.replace(/WHERE id=\?$/, '')}WHERE id IN (${Array(KEY_CHUNK).fill('?').join(',')})`];
}));

function resolveEntityKeys(keys) {
  const d = getDB();
  const list = keys || [];
  // Group by prefix, keeping the first occurrence of each key only.
  const byPrefix = new Map();
  const wanted = new Map(); // key -> {prefix, id}
  for (const key of list) {
    if (wanted.has(key)) continue;
    const m = String(key).match(/^([a-z]+)_(\d+)$/);
    if (!m || !KEY_LOOKUPS[m[1]]) continue;
    const id = Number(m[2]);
    wanted.set(key, { prefix: m[1], id });
    if (!byPrefix.has(m[1])) byPrefix.set(m[1], []);
    byPrefix.get(m[1]).push(id);
  }
  const rowsByKey = new Map();
  for (const [prefix, ids] of byPrefix) {
    const lk = KEY_LOOKUPS[prefix];
    const sql = KEY_IN_SQL[prefix];
    // try/catch per prefix, not per key: a missing table degrades one entity
    // type rather than all 16 (the reason the old per-key catch existed).
    try {
      for (let i = 0; i < ids.length; i += KEY_CHUNK) {
        const chunk = ids.slice(i, i + KEY_CHUNK);
        while (chunk.length < KEY_CHUNK) chunk.push(chunk[chunk.length - 1]);
        for (const row of d.prepare(sql).all(...chunk)) {
          rowsByKey.set(`${prefix}_${row.id}`, { name: row.name, type: lk.type, module: lk.module });
        }
      }
    } catch (_) {}
  }
  // Input order is load-bearing — getBacklinks hands this array straight to
  // the UI's backlink list — and unresolved keys stay silently omitted.
  const out = [];
  for (const key of list) {
    const row = rowsByKey.get(key);
    if (row) out.push({ key, ...row });
  }
  return out;
}

const getBacklinks = (targetKey) => {
  const rows = getDB().prepare(`SELECT DISTINCT src_key FROM wiki_link WHERE target_key=?`).all(targetKey);
  return resolveEntityKeys(rows.map(r => r.src_key));
};

const getOutgoingLinks = (srcKey) => {
  const rows = getDB().prepare(`SELECT target_key, target_text FROM wiki_link WHERE src_key=?`).all(srcKey);
  const resolved = resolveEntityKeys(rows.filter(r => r.target_key).map(r => r.target_key));
  const byKey = new Map(resolved.map(e => [e.key, e]));
  return rows.map(r => r.target_key && byKey.has(r.target_key)
    ? byKey.get(r.target_key)
    : { key: null, name: r.target_text, type: 'unresolved', module: null });
};

// target_key -> incoming [[link]] count, for the Search Link result rows.
function getLinkCounts(nexusId) {
  const rows = getDB().prepare(`
    SELECT target_key k, COUNT(*) c FROM wiki_link
    WHERE target_key IS NOT NULL AND (? IS NULL OR nexus_ref=?) GROUP BY target_key
  `).all(nexusId ?? null, nexusId ?? null);
  return Object.fromEntries(rows.map(r => [r.k, r.c]));
}

// ── Quick index: every linkable entity in a vault ───────────────────────────
// Feeds the quick switcher, the [[ autocomplete and the renderer's sync
// wikilink-resolution cache.
// Wrapped in one read transaction: this issues 16 separate whole-table scans,
// and outside a transaction each one pays its own implicit-transaction /
// file-lock cycle (~2.5ms per statement vs ~6µs inside). Measured 30.1ms -> 0.1ms.
// Reentrant, so calling it from inside another transaction is a no-op join.
function quickIndex(nexusId) {
  return getDB().readTx(() => _quickIndex(nexusId))();
}
function _quickIndex(nexusId) {
  const d = getDB();
  const nx = nexusId ?? null;
  const out = [];
  const add = (sql, prefix, type, module) => {
    try {
      for (const r of scopedAll(d, sql, nx)) {
        out.push({ key: `${prefix}${r.id}`, name: r.name, type, module, color: r.color_code || null });
      }
    } catch (_) {}
  };
  add(`SELECT n.id, n.title AS name, uc.color_code FROM note n LEFT JOIN use_color uc ON uc.id=n.color WHERE (? IS NULL OR n.nexus_ref=?)`, 'note_', 'note', 'scribe');
  add(`SELECT o.id, o.name, uc.color_code FROM object o JOIN project p ON o.project_id=p.id LEFT JOIN use_color uc ON uc.id=o.color WHERE (? IS NULL OR p.nexus_ref=?)`, 'obj_', 'object', 'director');
  add(`SELECT c.id, c.name, uc.color_code FROM world_character c JOIN world_project w ON c.world_ref=w.id LEFT JOIN use_color uc ON uc.id=c.color WHERE (? IS NULL OR w.nexus_ref=?)`, 'wchar_', 'character', 'navigator');
  add(`SELECT o.id, o.name, NULL AS color_code FROM world_orig_object o JOIN world_orig_category c ON o.category_id=c.id JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?)`, 'wobj_', 'object', 'navigator');
  add(`SELECT c.id, c.name, uc.color_code FROM game_character c JOIN game_project g ON c.game_ref=g.id LEFT JOIN use_color uc ON uc.id=c.color_ref WHERE (? IS NULL OR g.nexus_ref=?)`, 'gchar_', 'character', 'hero');
  add(`SELECT e.id, e.name, NULL AS color_code FROM game_col_element e JOIN game_collection c ON e.collection_ref=c.id JOIN game_project g ON c.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?)`, 'gel_', 'object', 'hero');
  add(`SELECT ch.id, ch.name, uc.color_code FROM write_chapter ch JOIN write_book b ON ch.book_id=b.id JOIN write_series s ON b.series_id=s.id JOIN write_project p ON s.project_id=p.id LEFT JOIN use_color uc ON uc.id=ch.color WHERE (? IS NULL OR p.nexus_ref=?)`, 'wchp_', 'chapter', 'writer');
  add(`SELECT id, name, NULL AS color_code FROM project WHERE (? IS NULL OR nexus_ref=?)`, 'proj_', 'project', 'director');
  add(`SELECT id, name, NULL AS color_code FROM world_project WHERE (? IS NULL OR nexus_ref=?)`, 'world_', 'project', 'navigator');
  add(`SELECT id, name, NULL AS color_code FROM game_project WHERE (? IS NULL OR nexus_ref=?)`, 'game_', 'project', 'hero');
  add(`SELECT id, project_name AS name, NULL AS color_code FROM write_project WHERE (? IS NULL OR nexus_ref=?)`, 'write_', 'project', 'writer');
  add(`SELECT m.id, m.name, uc.color_code FROM module m LEFT JOIN use_color uc ON uc.id=m.color WHERE (? IS NULL OR m.nexus_ref=?)`, 'module_', 'module', 'hub');
  add(`SELECT ch.id, ch.name, NULL AS color_code FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, 'bchp_', 'chapter', 'author');
  add(`SELECT s.id, s.name, NULL AS color_code FROM chat_session s JOIN module m ON s.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, 'chss_', 'chat', 'scribe');
  add(`SELECT o.id, o.name, uc.color_code FROM classifier_object o JOIN module m ON o.module_ref=m.id LEFT JOIN use_color uc ON uc.id=o.color WHERE (? IS NULL OR m.nexus_ref=?)`, 'cobj_', 'object', 'classifier');
  add(`SELECT t.id, t.name, NULL AS color_code FROM diviner_table t JOIN module m ON t.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, 'divt_', 'table', 'diviner');
  return out;
}

// Vault-scoped Obsidian-style graph: every quickIndex entity is a node
// (node.key feeds openEntityByKey), edges = structural containment/links +
// Director relations + wiki_link references (flagged wiki:true so the UI can
// draw them differently).
// One read transaction for the whole build: quickIndex's 16 scans plus ~15 more
// edge queries. Measured 70.8ms -> 0.2ms. The nested quickIndex call joins this
// transaction rather than opening its own (db.transaction is reentrant).
function getGraph(nexusId) {
  return getDB().readTx(() => _getGraph(nexusId))();
}
function _getGraph(nexusId) {
  const d = getDB();
  const nx = nexusId ?? null;
  const nodes = [];
  const idx = new Map();
  for (const e of quickIndex(nexusId)) {
    if (!idx.has(e.key)) {
      idx.set(e.key, nodes.length);
      nodes.push({ id: nodes.length, key: e.key, label: e.name, type: e.type, module: e.module });
    }
  }
  const edges = [];
  const eSet = new Set();
  const addEdge = (aKey, bKey, wiki) => {
    const s = idx.get(aKey), t = idx.get(bKey);
    if (s == null || t == null || s === t) return;
    const dk = (s < t ? `${s}-${t}` : `${t}-${s}`) + (wiki ? 'w' : '');
    if (eSet.has(dk)) return;
    eSet.add(dk);
    edges.push({ source: s, target: t, wiki: !!wiki });
  };
  const run = (sql, fn) => { try { scopedAll(d, sql, nx).forEach(fn); } catch (_) {} };

  // structural containment
  run(`SELECT o.id, o.project_id FROM object o JOIN project p ON o.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?)`, r => addEdge(`obj_${r.id}`, `proj_${r.project_id}`));
  run(`SELECT c.id, c.world_ref FROM world_character c JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?)`, r => addEdge(`wchar_${r.id}`, `world_${r.world_ref}`));
  run(`SELECT o.id, c.world_ref FROM world_orig_object o JOIN world_orig_category c ON o.category_id=c.id JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?)`, r => addEdge(`wobj_${r.id}`, `world_${r.world_ref}`));
  run(`SELECT c.id, c.game_ref FROM game_character c JOIN game_project g ON c.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?)`, r => addEdge(`gchar_${r.id}`, `game_${r.game_ref}`));
  run(`SELECT e.id, c.game_ref FROM game_col_element e JOIN game_collection c ON e.collection_ref=c.id JOIN game_project g ON c.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?)`, r => addEdge(`gel_${r.id}`, `game_${r.game_ref}`));
  run(`SELECT ch.id, s.project_id FROM write_chapter ch JOIN write_book b ON ch.book_id=b.id JOIN write_series s ON b.series_id=s.id JOIN write_project p ON s.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?)`, r => addEdge(`wchp_${r.id}`, `write_${r.project_id}`));
  run(`SELECT ch.id, ch.module_ref FROM book_chapter ch JOIN module m ON ch.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, r => addEdge(`bchp_${r.id}`, `module_${r.module_ref}`));
  run(`SELECT s.id, s.module_ref FROM chat_session s JOIN module m ON s.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, r => addEdge(`chss_${r.id}`, `module_${r.module_ref}`));
  run(`SELECT o.id, o.module_ref FROM classifier_object o JOIN module m ON o.module_ref=m.id WHERE (? IS NULL OR m.nexus_ref=?)`, r => addEdge(`cobj_${r.id}`, `module_${r.module_ref}`));
  // cross-module project links
  run(`SELECT wn.world_ref, wn.project_ref FROM world_novel wn JOIN world_project w ON wn.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?)`, r => addEdge(`world_${r.world_ref}`, `proj_${r.project_ref}`));
  run(`SELECT gl.game_ref, gl.project_ref FROM game_novel_link gl JOIN game_project g ON gl.game_ref=g.id WHERE (? IS NULL OR g.nexus_ref=?)`, r => addEdge(`game_${r.game_ref}`, `proj_${r.project_ref}`));
  run(`SELECT s.project_id, l.novel_id FROM write_novel_link l JOIN write_series s ON l.series_id=s.id JOIN write_project p ON s.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?)`, r => addEdge(`write_${r.project_id}`, `proj_${r.novel_id}`));
  // Director object↔object relations
  run(`SELECT ro.object_from, ro.object_to FROM relation_obob ro JOIN relation rl ON ro.relation_id=rl.id JOIN project p ON rl.project_id=p.id WHERE (? IS NULL OR p.nexus_ref=?)`, r => addEdge(`obj_${r.object_from}`, `obj_${r.object_to}`));
  // character↔director-object links (Navigator, Hero)
  run(`SELECT cl.character_ref, cl.object_ref FROM world_character_link cl JOIN world_character c ON cl.character_ref=c.id JOIN world_project w ON c.world_ref=w.id WHERE (? IS NULL OR w.nexus_ref=?)`, r => addEdge(`wchar_${r.character_ref}`, `obj_${r.object_ref}`));
  // wiki links
  run(`SELECT src_key, target_key FROM wiki_link WHERE target_key IS NOT NULL AND (? IS NULL OR nexus_ref=?)`, r => addEdge(r.src_key, r.target_key, true));

  return { nodes, edges };
}

// Ancestor ids so the renderer can navigate straight to a deep entity.
function getEntityPath(key) {
  const d = getDB();
  const m = String(key).match(/^([a-z]+)_(\d+)$/);
  if (!m) return null;
  const id = Number(m[2]);
  try {
    switch (m[1]) {
      case 'note': return { kind: 'note', noteId: id };
      case 'obj': {
        const r = d.prepare(`SELECT id, project_id, category_id FROM object WHERE id=?`).get(id);
        return r && { kind: 'obj', projectId: r.project_id, categoryId: r.category_id, objectId: id };
      }
      case 'proj': return { kind: 'proj', projectId: id };
      case 'world': return { kind: 'world', worldId: id };
      case 'game': return { kind: 'game', gameId: id };
      case 'write': return { kind: 'write', writeId: id };
      case 'wchar': {
        const r = d.prepare(`SELECT world_ref FROM world_character WHERE id=?`).get(id);
        return r && { kind: 'world', worldId: r.world_ref, charId: id };
      }
      case 'wobj': {
        const r = d.prepare(`SELECT c.world_ref FROM world_orig_object o JOIN world_orig_category c ON o.category_id=c.id WHERE o.id=?`).get(id);
        return r && { kind: 'world', worldId: r.world_ref, objId: id };
      }
      case 'gchar': {
        const r = d.prepare(`SELECT game_ref FROM game_character WHERE id=?`).get(id);
        return r && { kind: 'game', gameId: r.game_ref, charId: id };
      }
      case 'gel': {
        const r = d.prepare(`SELECT c.game_ref FROM game_col_element e JOIN game_collection c ON e.collection_ref=c.id WHERE e.id=?`).get(id);
        return r && { kind: 'game', gameId: r.game_ref, elementId: id };
      }
      case 'wchp': {
        const r = d.prepare(`
          SELECT ch.book_id, b.series_id, s.project_id FROM write_chapter ch
          JOIN write_book b ON ch.book_id=b.id JOIN write_series s ON b.series_id=s.id WHERE ch.id=?
        `).get(id);
        return r && { kind: 'wchp', writeId: r.project_id, seriesId: r.series_id, bookId: r.book_id, chapterId: id };
      }
      case 'wnote': {
        const r = d.prepare(`SELECT project_id FROM write_note WHERE id=?`).get(id);
        return r && { kind: 'write', writeId: r.project_id, wnoteId: id };
      }
      case 'module': return { kind: 'module', moduleId: id };
      case 'bchp': {
        const r = d.prepare(`SELECT module_ref FROM book_chapter WHERE id=?`).get(id);
        return r && { kind: 'bchp', moduleId: r.module_ref, chapterId: id };
      }
      case 'chss': {
        const r = d.prepare(`SELECT module_ref FROM chat_session WHERE id=?`).get(id);
        return r && { kind: 'chss', moduleId: r.module_ref, sessionId: id };
      }
      case 'cobj': {
        const r = d.prepare(`SELECT module_ref FROM classifier_object WHERE id=?`).get(id);
        return r && { kind: 'cobj', moduleId: r.module_ref, objectId: id };
      }
      // Process 8 part 2: these two were the only viewer.index kinds with no
      // path, so a link to an event or a dialogue resolved to nothing and the
      // click reported 'unresolved link'. Narrator's conversation links now
      // routinely point at both.
      case 'tlev': {
        const r = d.prepare(`
          SELECT tl.module_ref FROM timeline_event te
          JOIN timeline tl ON te.timeline_id=tl.id WHERE te.id=?
        `).get(id);
        return r && { kind: 'tlev', moduleId: r.module_ref, eventId: id };
      }
      case 'sdlg': {
        const r = d.prepare(`SELECT module_ref FROM story_dialogue WHERE id=?`).get(id);
        return r && { kind: 'sdlg', moduleId: r.module_ref, dialogueId: id };
      }
      // v5 Part 7: a Sketcher page opens its module on that page.
      case 'skpg': {
        const r = d.prepare(`SELECT module_ref FROM sketch_page WHERE id=?`).get(id);
        return r && { kind: 'skpg', moduleId: r.module_ref, pageId: id };
      }
      case 'divt': { // v5 Part 7 (§11.5): a Diviner table, selected
        const r = d.prepare(`SELECT module_ref FROM diviner_table WHERE id=?`).get(id);
        return r && { kind: 'divt', moduleId: r.module_ref, tableId: id };
      }
      // v5 Part 4: a link written in an Exhibitor note leads back to that
      // note, selected, in its own Exhibitor.
      case 'exn': {
        const r = d.prepare(`SELECT module_ref FROM exhibit_node WHERE id=?`).get(id);
        return r && { kind: 'exn', moduleId: r.module_ref, nodeId: id };
      }
      // v5 Asset Nest: an asset opens in the file viewer; moduleId (null when
      // unfiled) lets the renderer reveal its node in the Nest.
      case 'file': {
        const r = d.prepare(`SELECT module_ref FROM import_file WHERE id=?`).get(id);
        return r && { kind: 'file', moduleId: r.module_ref ?? null, fileId: id };
      }
    }
  } catch (_) {}
  return null;
}

// A newly created entity should claim [[links]] typed before it existed —
// they were indexed with target_key NULL. Called from entity create paths.
// Plan part2 #2.4: every matched row here resolves the SAME name (they only
// differ by an optional ns: prefix), and a dangling name is the worst case
// for resolveWikiName — all 17 resolvers miss. One memo + one transaction
// around the UPDATE loop; the memo is torn down on exit, since this function
// is precisely what makes a previously-null resolution start succeeding.
function resolveDanglingLinks(name, nexusId) {
  const d = getDB();
  return withResolveMemo(() => d.transaction(() => {
    const rows = d.prepare(`SELECT id, target_text FROM wiki_link WHERE target_key IS NULL AND (? IS NULL OR nexus_ref=?)`)
      .all(nexusId ?? null, nexusId ?? null);
    const bare = (s) => String(s).replace(/^\w+:/, '').trim().toLowerCase();
    const wanted = String(name).trim().toLowerCase();
    let n = 0;
    for (const r of rows) {
      if (bare(r.target_text) !== wanted) continue;
      const key = resolveWikiName(r.target_text, nexusId);
      if (key) { d.prepare(`UPDATE wiki_link SET target_key=?, update_at=datetime('now') WHERE id=?`).run(key, r.id); n++; }
    }
    return n;
  })());
}

// ── Rename safety ───────────────────────────────────────────────────────────
// [[links]] live in plain text, so renaming a target breaks them. This
// rewrites [[Old]] / [[Old|alias]] / [[ns:Old]] inside every source that
// references targetKey, then reindexes those sources. The sources are the
// registry in db/wiki-sources.js — one entry per field that can hold links.
function renameWikiTarget(targetKey, oldName, newName) {
  const d = getDB();
  if (!oldName || !newName || oldName === newName) return 0;
  const esc = String(oldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\[\\[((?:\\w+:)?)\\s*${esc}\\s*(\\||\\]\\])`, 'gi');
  const rows = d.prepare(`SELECT DISTINCT src_key, nexus_ref FROM wiki_link WHERE target_key=?`).all(targetKey);
  let changed = 0;
  for (const r of rows) {
    const m = String(r.src_key).match(/^([a-z]+)_(\d+)$/);
    const src = m && CONTENT_SOURCES[m[1]];
    if (!src) continue;
    const next = src.rewrite(d, Number(m[2]), (c) => String(c || '').replace(re, (_, ns, tail) => `[[${ns}${newName}${tail}`));
    if (next === null) continue;
    reindexWikiLinks(r.src_key, next, r.nexus_ref);
    changed++;
  }
  return changed;
}

module.exports = {
  renameWikiTarget, resolveDanglingLinks,
  resolveWikiName, reindexWikiLinks, reindexSource, rebuildWikiIndex,
  nexusOfNote, nexusOfObject, nexusOfChapter,
  getBacklinks, getOutgoingLinks, resolveEntityKeys,
  quickIndex, getEntityPath, getGraph, getLinkCounts,
};
