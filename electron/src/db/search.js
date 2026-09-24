'use strict';
// ═══ Content search (v5 Part 7, APP docs/V5.md §11.4) ═══════════════════
// Until now only names were searchable. search_index is one FTS5 table over
// every family that declares `search` in db/entity-kinds.js: its first
// column is the title, and the body is the family's indexed text from
// db/wiki-sources.js when it has one (a Classifier object's note AND its
// text fields, a chat session's messages), else the rest of its columns.
//
// Why these choices (tested, §11.4):
//   - tokenize='trigram': Thai has no spaces between words, so unicode61
//     makes a whole sentence one token and "มังกร" matches nothing inside
//     it. trigram matches any substring of 3+ characters.
//   - a query shorter than 3 characters cannot use trigram → LIKE instead
//     (short Thai words are common: มด, ปู).
//   - NOT in vault.sql: a front-end without fts5 would fail its whole init.
//     Each app creates it at runtime inside a try; without fts5, every
//     query uses LIKE. It is derived data like wiki_link: never in a
//     snapshot, rebuilt from the content.
const { getVaultDB } = require('./core');
const { ENTITY_KINDS } = require('./entity-kinds');
const { CONTENT_SOURCES } = require('./wiki-sources');

const FTS_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(key UNINDEXED, title, body, tokenize='trigram')`;
// Per CONNECTION, not per nexus id: a vault file reopened, replaced or
// relinked is a new connection, and the index must be (re)made on it.
const _state = new WeakMap(); // db -> { fts: bool, builtAt: ms }

function ensureIndex(db) {
  let st = _state.get(db);
  if (!st) {
    let fts = true;
    try { db.exec(FTS_SQL); } catch (_) { fts = false; }
    st = { fts, builtAt: 0 };
    _state.set(db, st);
  }
  return st;
}

// Every searchable row: { key, title, body }.
function* searchRows(db) {
  for (const [prefix, k] of Object.entries(ENTITY_KINDS)) {
    if (!Array.isArray(k.search) || !k.search.length) continue;
    const [titleCol, ...bodyCols] = k.search;
    let rows;
    try { rows = db.prepare(`SELECT id, ${k.search.join(', ')} FROM ${k.table}`).all(); } catch (_) { continue; }
    const src = CONTENT_SOURCES[prefix];
    for (const r of rows) {
      let body = null;
      if (src) { try { body = src.content(db, r.id); } catch (_) {} }
      if (body == null) body = bodyCols.map((c) => r[c]).filter(Boolean).join('\n');
      yield { key: `${prefix}_${r.id}`, title: String(r[titleCol] ?? ''), body: String(body ?? '') };
    }
  }
}

// Rebuilt whole — derived data, and a vault's text is small next to the
// cost of keeping ten families' triggers in step. Ctrl+P forces one as it
// opens (renderer quickswitch.js), so a search never runs on text older
// than the palette; the queries typed after that reuse it.
function rebuildSearch(nexusId, force = false) {
  const db = getVaultDB(nexusId);
  const st = ensureIndex(db);
  if (!st.fts) return { fts: false };
  if (!force && st.builtAt) return { fts: true, skipped: true };
  db.transaction(() => {
    db.prepare(`DELETE FROM search_index`).run();
    const ins = db.prepare(`INSERT INTO search_index (key, title, body) VALUES (?,?,?)`);
    for (const r of searchRows(db)) ins.run(r.key, r.title, r.body);
  })();
  st.builtAt = Date.now();
  return { fts: true };
}

// [{ key, title, snippet }] — best matches first. Never throws.
function searchContent(nexusId, query, limit = 40) {
  const q = String(query || '').trim();
  if (!q) return [];
  const db = getVaultDB(nexusId);
  const { fts } = rebuildSearch(nexusId);
  const chars = [...q].length;
  if (fts && chars >= 3) {
    try {
      // One phrase, quotes doubled: nothing the user types is FTS syntax.
      return db.prepare(`
        SELECT key, title, snippet(search_index, 2, '[', ']', '…', 12) AS snippet
        FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?`)
        .all(`"${q.replace(/"/g, '""')}"`, limit)
        .map((r) => ({ key: r.key, title: r.title, snippet: r.snippet }));
    } catch (_) { /* fall through to LIKE */ }
  }
  // Short query, or no fts5: a plain substring scan over the same rows.
  const needle = q.toLowerCase();
  const out = [];
  for (const r of searchRows(db)) {
    const hay = `${r.title}\n${r.body}`;
    const at = hay.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const from = Math.max(0, at - 20);
    out.push({ key: r.key, title: r.title, snippet: `${from ? '…' : ''}${hay.slice(from, at)}[${hay.slice(at, at + q.length)}]${hay.slice(at + q.length, at + q.length + 30)}…` });
    if (out.length >= limit) break;
  }
  return out;
}

// For tests and for a caller that just changed a lot (an import).
const invalidateSearch = (nexusId) => { const st = _state.get(getVaultDB(nexusId)); if (st) st.builtAt = 0; };

module.exports = { searchContent, rebuildSearch, invalidateSearch };
