'use strict';
// Process 7 part 2 — generic, session-only (in-memory) undo/redo for vault
// content. conn.js's adaptDb() creates one recorder per open vault
// connection (createUndoRecorder below) and wires it into the same
// prepare()/transaction() chokepoint every one of the ~24 db files' SQL
// already funnels through — so this covers every single-row write app-wide
// (Hub module moves, deletes, renames, field edits, …) without touching any
// of those files' hand-written SQL.
//
// Scope/limitations (deliberate, see Plan.md Process 7 part 2):
//  - Only single-row writes shaped `...WHERE id = ?` — this codebase's
//    dominant CRUD pattern, one row per character/place/module/etc — can be
//    reversed generically, by snapshotting the row before/after. A bulk
//    statement (no simple trailing id predicate) can't be safely
//    reconstructed from the SQL alone, so its whole containing group is
//    flagged irreversible instead of guessed at: undo()/redo() then report
//    {ok:false, reason:'irreversible'} rather than silently no-opping or
//    corrupting data.
//  - In-memory only, per connection: history lives entirely in this closure,
//    so it's naturally scoped to (and cleared with) the vault connection it
//    belongs to — closing/evicting that connection just drops it, no
//    separate bookkeeping needed. Nothing here is persisted to disk.
//  - A multi-statement db.transaction(fn) call collapses into ONE undo step
//    (e.g. module.js's moveModule(), which reparents + rewrites every
//    sibling's display_order in one transaction) — see beginGroup/endGroup.

const MAX_GROUPS = 200;

const INSERT_RE = /^\s*INSERT\s+INTO\s+["'`]?(\w+)["'`]?/i;
const UPDATE_RE = /^\s*UPDATE\s+["'`]?(\w+)["'`]?\s+SET\b/i;
const DELETE_RE = /^\s*DELETE\s+FROM\s+["'`]?(\w+)["'`]?\s+WHERE\b/i;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE)\b/i;
// An `id = ?` predicate ANYWHERE in the WHERE clause, not necessarily last —
// this codebase routinely adds a redundant scoping condition after it (e.g.
// module.js's moveModule(): `WHERE id=? AND nexus_ref=?`), which a "last
// bound param is the id" assumption would misclassify as irreversible.
const ID_PRED_RE = /(?:^|[\s(]|\bAND\s|\bOR\s)(?:\w+\.)?["'`]?id["'`]?\s*=\s*\?/i;

// The 0-based index into the bound `args` array of the value that fills the
// WHERE clause's `id = ?` placeholder — found by counting every `?` that
// appears earlier in the SQL text (SET clause included), since positional
// params bind left-to-right in textual order. Returns -1 if there's no such
// clause (a bulk statement, or one keyed by something other than id).
function idParamIndex(sql) {
  const whereAt = sql.search(/\bWHERE\b/i);
  if (whereAt === -1) return -1;
  const where = sql.slice(whereAt);
  const m = ID_PRED_RE.exec(where);
  if (!m) return -1;
  const qAtInWhere = m.index + m[0].length - 1; // '?' is always the match's last char
  const qAt = whereAt + qAtInWhere;
  return (sql.slice(0, qAt).match(/\?/g) || []).length;
}

// Classifies one write statement: which table, which op, and — for
// update/delete — which arg index holds the row's id (-1 if this isn't a
// simple single-row-by-id statement we can safely reverse).
function classifyWrite(sql) {
  let m;
  if ((m = INSERT_RE.exec(sql))) return { op: 'insert', table: m[1] };
  if ((m = UPDATE_RE.exec(sql))) return { op: 'update', table: m[1], idIdx: idParamIndex(sql) };
  if ((m = DELETE_RE.exec(sql))) return { op: 'delete', table: m[1], idIdx: idParamIndex(sql) };
  if (WRITE_RE.test(sql)) return { op: 'other' };
  return null;
}

// `origPrepare` is the RAW (pre-adaptDb) prepare — undo capture and undo/redo
// application both go through it directly, never through the instrumented
// rawDb.prepare, so applying an undo never re-logs itself as a new change.
function createUndoRecorder(origPrepare) {
  let undoStack = [];
  let redoStack = [];
  let group = null; // {entries:[], irreversible:bool} while a group is open
  let depth = 0;    // nesting depth — joins the outer group, same idea as conn.js's txDepth
  // Off until conn.js flips it on, right after schema init/migration finishes
  // (same moment setStatementCache(true) does) — otherwise seed data and
  // migration backfills would show up as the first, surprising undo steps.
  let enabled = false;

  function withStmt(sql, fn) {
    const stmt = origPrepare(sql);
    try { return fn(stmt); }
    finally { try { stmt.finalize(); } catch (_) {} }
  }
  function rawRow(table, id) {
    try { return withStmt(`SELECT * FROM ${table} WHERE id = ?`, (s) => s.get([id])); }
    catch (_) { return null; }
  }
  function insertRow(table, row) {
    if (!row) return;
    const cols = Object.keys(row);
    withStmt(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      (s) => s.run(cols.map((c) => row[c])));
  }
  function updateRow(table, id, row) {
    if (!row) return;
    const cols = Object.keys(row).filter((c) => c !== 'id');
    if (!cols.length) return;
    withStmt(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(',')} WHERE id = ?`,
      (s) => s.run([...cols.map((c) => row[c]), id]));
  }
  function deleteRow(table, id) {
    withStmt(`DELETE FROM ${table} WHERE id = ?`, (s) => s.run([id]));
  }

  function markIrreversible() { if (group) group.irreversible = true; }

  function beginGroup() {
    depth++;
    if (depth === 1) group = { entries: [], irreversible: false };
  }
  function endGroup(commit) {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (commit && group && (group.entries.length || group.irreversible)) {
        undoStack.push(group);
        if (undoStack.length > MAX_GROUPS) undoStack.shift();
        redoStack = [];
      }
      group = null;
    }
  }

  // Called by conn.js's patched prepare()'s run(), before the real statement
  // runs, to snapshot the "before" row for an update/delete.
  function beforeRun(sql, args) {
    if (!enabled) return null;
    const info = classifyWrite(sql);
    if (!info || (info.op !== 'update' && info.op !== 'delete') || info.idIdx < 0) return null;
    const id = Array.isArray(args) ? args[info.idIdx] : args;
    return { table: info.table, id, before: rawRow(info.table, id) };
  }
  // Called after the real statement runs, with its result and whatever
  // beforeRun captured.
  function afterRun(sql, args, pre, result) {
    if (!enabled) return;
    const implicit = !group;
    if (implicit) beginGroup();
    const info = classifyWrite(sql);
    if (info?.op === 'insert') {
      const id = result && result.lastInsertRowid;
      if (id != null) group.entries.push({ table: info.table, id, op: 'insert', before: null, after: rawRow(info.table, id) });
      else markIrreversible();
    } else if (info?.op === 'update') {
      if (pre) group.entries.push({ table: pre.table, id: pre.id, op: 'update', before: pre.before, after: rawRow(pre.table, pre.id) });
      else markIrreversible();
    } else if (info?.op === 'delete') {
      if (pre && pre.before) group.entries.push({ table: pre.table, id: pre.id, op: 'delete', before: pre.before, after: null });
      else markIrreversible();
    } else if (info?.op === 'other') {
      markIrreversible(); // a write we recognize but can't safely reverse (e.g. a bulk statement)
    }
    if (implicit) endGroup(true);
  }

  function applyGroup(g, direction) {
    const order = direction === 'undo' ? [...g.entries].reverse() : g.entries;
    for (const e of order) {
      if (direction === 'undo') {
        if (e.op === 'insert') deleteRow(e.table, e.id);
        else if (e.op === 'delete') insertRow(e.table, e.before);
        else updateRow(e.table, e.id, e.before);
      } else {
        if (e.op === 'insert') insertRow(e.table, e.after);
        else if (e.op === 'delete') deleteRow(e.table, e.id);
        else updateRow(e.table, e.id, e.after);
      }
    }
  }

  function undo() {
    const g = undoStack.pop();
    if (!g) return { ok: false, reason: 'nothing' };
    if (g.irreversible) { undoStack.push(g); return { ok: false, reason: 'irreversible' }; }
    applyGroup(g, 'undo');
    redoStack.push(g);
    return { ok: true };
  }
  function redo() {
    const g = redoStack.pop();
    if (!g) return { ok: false, reason: 'nothing' };
    applyGroup(g, 'redo');
    undoStack.push(g);
    return { ok: true };
  }
  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;
  const setEnabled = (v) => { enabled = !!v; };

  return { beginGroup, endGroup, beforeRun, afterRun, undo, redo, canUndo, canRedo, setEnabled };
}

module.exports = { createUndoRecorder };
