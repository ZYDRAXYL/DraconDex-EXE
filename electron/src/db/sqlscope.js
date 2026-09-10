'use strict';

// `WHERE (? IS NULL OR t.col=?)` — the vault-scoping idiom used across wiki.js,
// viewer.js, sage.js and the legacy modules — is NON-SARGABLE: SQLite cannot use
// an index for it and plans a full SCAN even when t.col is indexed. Verified
// against this project's own node-sqlite3-wasm build:
//
//   WHERE (? IS NULL OR n.nexus_ref=?)  ->  SCAN n USING COVERING INDEX
//   WHERE n.nexus_ref=?                 ->  SEARCH n USING COVERING INDEX (nexus_ref=?)
//   WHERE n.nexus_ref = COALESCE(?,...) ->  SCAN  (the tempting one-liner does NOT work)
//
// Two SQL variants is the only real fix. Rather than fork ~73 query strings by
// hand, these wrappers take the EXISTING string unchanged and derive both
// variants from it, memoized per string:
//
//   scope value present -> `t.col=?`  (one bound param, index seek)
//   scope value null    -> `1=1`      (no bound param, same full scan as before)
//
// The null branch is deliberately identical in behaviour to today — some callers
// (notably wiki.js's resolvers, for rows whose nexus_ref is NULL) genuinely rely
// on the "match everything" semantics. So: the null path is unchanged, the
// non-null path goes from SCAN to SEARCH.
//
// Precondition: the scope predicate's two `?` are the FIRST two bound params of
// the statement. That holds at every current call site.

// Matches `( ? IS NULL OR <ident>=? )` with flexible whitespace.
const SCOPE_RE = /\(\s*\?\s+IS\s+NULL\s+OR\s+([A-Za-z_][\w.]*)\s*=\s*\?\s*\)/i;

const _memo = new Map();

function variants(sql) {
  const hit = _memo.get(sql);
  if (hit) return hit;
  const m = sql.match(SCOPE_RE);
  // Only rewrite when the pattern occurs EXACTLY once — a second occurrence
  // would break the "first two bound params" precondition, so those fall back
  // to the original SQL. Degrades to slow, never to wrong.
  const once = !!m && !SCOPE_RE.test(sql.replace(SCOPE_RE, ''));
  const v = once
    ? { split: true, on: sql.replace(SCOPE_RE, `${m[1]}=?`), off: sql.replace(SCOPE_RE, '1=1') }
    : { split: false };
  _memo.set(sql, v);
  return v;
}

// Drop-in for `d.prepare(sql).all(nx, nx, ...rest)`
function scopedAll(d, sql, nx, ...rest) {
  const v = variants(sql);
  if (!v.split) return d.prepare(sql).all(nx, nx, ...rest);
  return nx == null ? d.prepare(v.off).all(...rest) : d.prepare(v.on).all(nx, ...rest);
}

// Drop-in for `d.prepare(sql).get(nx, nx, ...rest)`
function scopedGet(d, sql, nx, ...rest) {
  const v = variants(sql);
  if (!v.split) return d.prepare(sql).get(nx, nx, ...rest);
  return nx == null ? d.prepare(v.off).get(...rest) : d.prepare(v.on).get(nx, ...rest);
}

module.exports = { scopedAll, scopedGet, variants };
