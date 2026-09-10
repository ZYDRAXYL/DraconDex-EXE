'use strict';
const { Database: _RawDatabase } = require('node-sqlite3-wasm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app } = require('electron');
const { currentNexusId } = require('./vault-context');
const { createUndoRecorder } = require('./undo');

// Boot/query profiling, off unless DDX_PERF is set in the environment. The whole
// data layer runs synchronously in the main process before the first paint, so
// "how long did initDB take" is only answerable from in here.
//   DDX_PERF=1 node .claude/skills/run-dracondex/driver.mjs --fresh "evalmain 1"
// Recorded as well as logged: main-process stdout isn't forwarded by the
// run-dracondex driver, so `evalmain require('./src/db/core').perfLog()` is how
// a boot profile is actually read back.
const PERF = !!process.env.DDX_PERF;
const _perfLog = [];
const _now = () => (PERF ? performance.now() : 0);
const _t = PERF
  ? (label, t0) => {
      const ms = +(performance.now() - t0).toFixed(1);
      _perfLog.push({ label, ms });
      console.log(`[perf] ${label.padEnd(28)} ${ms}ms`);
    }
  : () => {};
const perfLog = () => _perfLog;

const STMT_CACHE_MAX = 256;

function adaptDb(rawDb, kind) {
  const origPrepare = rawDb.prepare.bind(rawDb);
  const origExec = rawDb.exec.bind(rawDb);
  const origClose = typeof rawDb.close === 'function' ? rawDb.close.bind(rawDb) : null;

  // Process 7 part 2 — undo/redo history tracks vault content only (kind
  // 'vault'/'single'), never the app-level db (kind 'app': settings,
  // plugins, the vault registry — machine config, not novel content) nor the
  // throwaway relink probe connection (no kind passed at all).
  const undoRec = (kind === 'vault' || kind === 'single') ? createUndoRecorder(origPrepare) : null;

  // WHY THIS IS SAFE TO CACHE (it previously wasn't).
  // The original adapter prepared-and-finalized on every call because a
  // statement left open holds a schema read-lock, which made later DDL
  // (DROP/ALTER) fail with SQLITE_LOCKED "database table is locked" and
  // silently broke the Navigator migration. The precise cause is that
  // node-sqlite3-wasm's get() pulls one row from its internal generator and
  // then abandons it, so the statement stays mid-scan with a live cursor.
  // Statement._reset() (clear_bindings + sqlite3_reset) closes that cursor and
  // ends the implicit read transaction just as decisively as finalize() does —
  // so resetting in a finally is exactly as DDL-safe, without paying a full
  // sqlite3_prepare_v2 compile on every single query.
  // Load-bearing rule: never expose iterate(). It returns a suspended
  // generator; caching one would let two callers share a cursor and silently
  // truncate results. all() materialises before returning and get() resets in
  // finally, so no cached statement ever holds state between calls — which is
  // also why re-entrant use of the same SQL (recursion, or a query inside a
  // loop over another query's rows) cannot interleave.
  const cache = new Map();    // sql -> Statement          (Map order = LRU)
  const handles = new Map();  // sql -> {all,get,run}      (stable identity)
  let cacheOn = false;        // off until initDB() has finished — see getDB()
  let resetOk = null;         // feature check, resolved on first prepare

  const flush = () => {
    for (const s of cache.values()) {
      try { if (!s.isFinalized) s.finalize(); } catch (_) {}
    }
    cache.clear();
  };

  // Never cache DDL/PRAGMA: a statement compiled against a table a later DROP
  // removed would fail at step time, and PRAGMA compiles specially. Both are
  // rare, so bypassing costs nothing. This is belt-and-braces for any FUTURE
  // runtime DDL added outside initDB — the cacheOn gate already covers today's.
  const NO_CACHE_RE = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(CREATE|ALTER|DROP|REINDEX|VACUUM|ATTACH|DETACH|PRAGMA)\b/i;

  const acquire = (sql) => {
    const hit = cache.get(sql);
    if (hit) { cache.delete(sql); cache.set(sql, hit); return hit; }  // LRU touch
    const stmt = origPrepare(sql);
    if (resetOk === null) resetOk = typeof stmt._reset === 'function';
    if (!resetOk) return stmt;                                        // caller finalizes
    cache.set(sql, stmt);
    if (cache.size > STMT_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      const victim = cache.get(oldest);
      cache.delete(oldest);
      try { victim.finalize(); } catch (_) {}
    }
    return stmt;
  };

  rawDb.prepare = (sql) => {
    const existing = handles.get(sql);
    if (existing) return existing;
    const exec = (method, args, transform) => {
      const uncacheable = !cacheOn || resetOk === false || NO_CACHE_RE.test(sql);
      if (uncacheable) {
        if (NO_CACHE_RE.test(sql)) flush();   // DDL issued via prepare().run()
        const stmt = origPrepare(sql);
        try {
          const r = stmt[method](args);
          return transform ? transform(r) : r;
        } finally { stmt.finalize(); }
      }
      const stmt = acquire(sql);
      if (!cache.has(sql)) {                  // resetOk === false fallback
        try {
          const r = stmt[method](args);
          return transform ? transform(r) : r;
        } finally { stmt.finalize(); }
      }
      try {
        const r = stmt[method](args);
        return transform ? transform(r) : r;
      } finally {
        // Reset frees the cursor. If it ever fails, drop this one from the
        // cache rather than leaving a half-live statement in it.
        try { stmt._reset(); }
        catch (_) { cache.delete(sql); try { stmt.finalize(); } catch (__) {} }
      }
    };
    const handle = {
      all: (...args) => exec('all', args),
      get: (...args) => exec('get', args, (r) => (r === null ? undefined : r)),
      run: !undoRec ? (...args) => exec('run', args) : (...args) => {
        const pre = undoRec.beforeRun(sql, args);
        const result = exec('run', args);
        undoRec.afterRun(sql, args, pre, result);
        return result;
      },
    };
    // Stable identity per SQL string is what keeps the ~140 hoisted
    // `const ins = db.prepare(...)` call sites working unchanged — and turns
    // them into genuine compile-once/execute-many statements for the first time.
    if (handles.size < STMT_CACHE_MAX * 4) handles.set(sql, handle);
    return handle;
  };

  // Every DDL/PRAGMA that goes through exec() originates in this file (verified:
  // no other src/db module calls .exec). Flushing on everything except the
  // transaction verbs needs no SQL classification.
  rawDb.exec = (sql) => {
    const head = String(sql).trimStart().slice(0, 9).toUpperCase();
    if (!(head.startsWith('BEGIN') || head.startsWith('COMMIT') || head.startsWith('ROLLBACK'))) flush();
    return origExec(sql);
  };

  // close() does NOT finalize pending statements in this library, so without
  // this the cached ones leak — importDatabaseMerge closes its source DB.
  if (origClose) rawDb.close = (...a) => { flush(); handles.clear(); return origClose(...a); };

  // initDB() issues ~30 ALTER TABLE and a DROP via prepare().run() rather than
  // exec(), so intercepting exec alone would NOT be enough. The gate simply
  // keeps the cache off for all of initDB, with no SQL classification at all.
  rawDb.setStatementCache = (on) => { if (!on) flush(); cacheOn = !!on; };
  rawDb.statementCacheSize = () => cache.size;

  // MEASURED, and by far the biggest single lever in this data layer: a
  // statement executed outside an explicit transaction costs ~2.5ms, while the
  // same statement inside one costs ~6µs — a ~400x difference. Under
  // journal_mode=DELETE every bare statement opens and closes its own implicit
  // read transaction, which on Windows means real file-locking syscalls; the
  // actual SQL work and the statement compile are noise next to it (compile
  // measured at ~1% of total).
  //
  // readTx wraps a multi-statement READ so all of its queries share one lock
  // acquisition. It is just db.transaction with an intention-revealing name —
  // reentrant, so nesting inside a write transaction is a no-op join.
  //
  // Only for SYNCHRONOUS functions: transaction() issues COMMIT as soon as fn
  // returns, so handing it an async fn would commit before the awaited work ran.
  rawDb.readTx = (fn) => rawDb.transaction(fn);
  // Reentrant: a transaction opened inside another (e.g. the Phase 24
  // migration calling save paths that reindex wikilinks transactionally)
  // joins the outer one instead of issuing a nested BEGIN.
  let txDepth = 0;
  rawDb.transaction = (fn) => (...args) => {
    if (txDepth > 0) return fn(...args);
    txDepth++;
    if (undoRec) undoRec.beginGroup();
    rawDb.exec('BEGIN');
    try {
      const result = fn(...args);
      rawDb.exec('COMMIT');
      if (undoRec) undoRec.endGroup(true);
      return result;
    } catch (e) {
      try { rawDb.exec('ROLLBACK'); } catch (_) {}
      if (undoRec) undoRec.endGroup(false);
      throw e;
    } finally {
      txDepth--;
    }
  };

  // Process 7 part 2 — the app-wide session undo/redo surface main.js's
  // history:undo/history:redo IPC handlers call through getDB(). Absent
  // (kind 'app', or the relink probe) they report {ok:false,reason:'unsupported'}.
  rawDb.undo = () => (undoRec ? undoRec.undo() : { ok: false, reason: 'unsupported' });
  rawDb.redo = () => (undoRec ? undoRec.redo() : { ok: false, reason: 'unsupported' });
  rawDb.canUndo = () => !!undoRec && undoRec.canUndo();
  rawDb.canRedo = () => !!undoRec && undoRec.canRedo();
  // Left off until openDdx flips it on right after schema init/migration
  // finishes — otherwise seed data and migration backfills would show up as
  // the first, surprising undo steps.
  rawDb.setUndoTracking = (on) => { if (undoRec) undoRec.setEnabled(on); };
  return rawDb;
}

// A sqlite file's header can declare WAL journal mode (bytes 18-19 = 2,2)
// with no accompanying -wal sidecar on disk — a shape node-sqlite3-wasm
// aborts hard trying to open, rather than throwing a catchable error. Forces
// the header back to legacy rollback-journal mode (1,1) in that case, which
// is safe since without a -wal file there's nothing WAL-specific to lose.
function forceLegacyJournalMode(filePath) {
  try {
    const hdr = Buffer.alloc(2);
    const hfd = fs.openSync(filePath, 'r+');
    fs.readSync(hfd, hdr, 0, 2, 18);
    if (hdr[0] === 2 || hdr[1] === 2) {
      hdr[0] = 1; hdr[1] = 1;
      fs.writeSync(hfd, hdr, 0, 2, 18);
      fs.fsyncSync(hfd);
    }
    fs.closeSync(hfd);
  } catch (_) {}
}

// The directory every database file lives in by default. app.getPath('userData')
// was pointed at <dataDir>/electron-user-data by main.js, so the data dir is one
// level up.
const dataDir = () => path.dirname(app.getPath('userData'));

class VaultFileMissingError extends Error {
  constructor(filePath) {
    super(`vault file not found: ${filePath}`);
    this.code = 'vault_file_missing';
    this.filePath = filePath;
  }
}

// The shared open procedure, lifted out of the old single-file getDB(). Every
// database file — app.ddx and every vault .ddx — goes through exactly this.
//
// `create` is the important argument. new _RawDatabase(path) silently CREATES
// an empty file, and the init below would then fill it with tables: a user
// whose vault file got moved or deleted would open an empty vault where their
// world used to be, with no error anywhere. So every caller but "make a new
// vault" passes create:false and gets a VaultFileMissingError instead.
// `register` is called with the live connection AFTER the pragmas but BEFORE
// the init path. That ordering is load-bearing and easy to lose: initVaultDB's
// wiki backfill calls rebuildWikiIndex(), which resolves its own connection
// through getDB() — if the caller hasn't published this one yet, that reentrant
// call opens a SECOND connection to the same file and re-enters init on it. The
// original single-file getDB() assigned its module-level `db` before calling
// initDB for exactly this reason.
function openDdx(filePath, { kind, create = false, register = null } = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    if (!create) throw new VaultFileMissingError(filePath);
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!create && !fs.existsSync(filePath)) throw new VaultFileMissingError(filePath);

  // Must run for every file, including user-chosen locations on removable or
  // network drives: node-sqlite3-wasm HARD-ABORTS (does not throw) on a
  // WAL-declared header with no -wal sidecar.
  if (fs.existsSync(filePath) && !fs.existsSync(filePath + '-wal')) forceLegacyJournalMode(filePath);
  try { fs.rmSync(filePath + '.lock', { recursive: true, force: true }); } catch (_) {}

  const tOpen = _now();
  const conn = adaptDb(new _RawDatabase(filePath), kind);
  _t(`open ${kind}`, tOpen);

  const tPragma = _now();
  conn.exec("PRAGMA busy_timeout = 5000");
  // journal_mode stays DELETE — see forceLegacyJournalMode above; WAL makes
  // node-sqlite3-wasm hard-abort (not throw) when the -wal sidecar is missing.
  conn.exec("PRAGMA journal_mode = DELETE");
  conn.exec("PRAGMA foreign_keys = ON");
  // Page cache (default 2 MB) and in-memory temp tables for GROUP BY / ORDER BY
  // spills. Both are pure runtime tuning: no on-disk format change, no
  // durability trade. Deliberately NOT setting synchronous=NORMAL — under
  // rollback-journal mode that admits corruption on power loss, not just lost
  // transactions, and wrapping writes in transactions gets the same win safely.
  // Sized per kind now that several files can be open at once: the old flat
  // 8 MB across five connections would be 40 MB of page cache.
  conn.exec(`PRAGMA cache_size = ${kind === 'app' ? -2000 : -4000}`);
  conn.exec("PRAGMA temp_store = MEMORY");
  _t('pragmas', tPragma);

  if (register) register(conn);

  const tInit = _now();
  // Required lazily: schema/init.js requires this file back (for _t/_now and
  // the has*() probes), so a top-level require here would be a load-time
  // cycle. Same pattern initDB itself uses for require('./wiki').
  const init = require('./schema/init');
  if (kind === 'app') init.initAppDB(conn);
  else if (kind === 'vault') init.initVaultDB(conn);
  else init.initDB(conn); // 'single' — the pre-split file holding both halves
  _t(`init ${kind} (total)`, tInit);

  // Only now — the init paths are the one place that issues DDL via prepare().run().
  conn.setStatementCache(true);
  conn.setUndoTracking(true);
  return conn;
}

// ─── The connection registry ────────────────────────────────────────────────
const appPath = () => path.join(dataDir(), 'app.ddx');
const legacyPath = () => path.join(dataDir(), 'novel-manager.ddx');

let appDb = null;
const vaultDbs = new Map(); // nexusId -> { conn, filePath, lastUsed }
const pinnedVaults = new Set();
const MAX_OPEN_VAULTS = 4;

// The pre-v4.9 single file, opened normally. Only reachable during the split
// bootstrap: it runs the full init path (including the wiki backfill) against a
// properly published connection, so the file is schema-current before
// split-migrate.js takes a scalpel to copies of it.
function openLegacySingle() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dbPath = legacyPath();
  const legacyDotDb = path.join(dir, 'novel-manager.db');
  if (!fs.existsSync(dbPath) && fs.existsSync(legacyDotDb)) {
    // v.3.11+: the app's own working file is renamed .db -> .ddx once, in
    // place (same file, no data copy) — non-destructive, no-op on every
    // later launch since dbPath already exists after the first rename.
    try {
      fs.renameSync(legacyDotDb, dbPath);
      if (fs.existsSync(legacyDotDb + '-wal')) fs.renameSync(legacyDotDb + '-wal', dbPath + '-wal');
      if (fs.existsSync(legacyDotDb + '-shm')) fs.renameSync(legacyDotDb + '-shm', dbPath + '-shm');
    } catch (_) {}
  }
  let conn = null;
  openDdx(dbPath, { kind: 'single', create: true, register: (c) => { conn = c; } });
  return conn;
}

// App-level tables: preferences, credentials, installed plugins, the vault
// index. Never a vault. Call this from anything that must work with no vault
// open — which includes everything main.js touches outside an IPC handler.
function getAppDB() {
  if (appDb) return appDb;
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // The one-time split, gated on app.ddx's absence — its existence IS the
  // "already migrated" marker, written last by the migration itself. A throw
  // here propagates: booting into a half-split state would be far worse than
  // failing to boot with the original file still intact.
  if (!fs.existsSync(appPath()) && fs.existsSync(legacyPath())) {
    const legacy = openLegacySingle();
    try { legacy.close(); } catch (_) {}
    require('./split-migrate').splitLegacyDatabase(dir);
  }

  openDdx(appPath(), { kind: 'app', create: true, register: (c) => { appDb = c; } });
  return appDb;
}

// One vault's tables, resolved through the registry in app.ddx.
//
// The LRU exists because a user with twenty vaults must not end up with twenty
// open sqlite handles; a vault bound to a live window is pinned and never
// evicted regardless of how long it has been idle.
function getVaultDB(nexusId) {
  const id = Number(nexusId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new NoVaultError(nexusId);
  }
  const hit = vaultDbs.get(id);
  if (hit) { hit.lastUsed = Date.now(); return hit.conn; }

  const row = getAppDB().prepare(`SELECT file_path FROM nexus_file WHERE id=?`).get(id);
  if (!row) throw new NoVaultError(id);
  // A NULL file_path is a registry row backfilled from a pre-split database
  // that has not been split yet. That should be unreachable once getAppDB()
  // has run, so treat it as the bug it would be rather than guessing a file.
  if (!row.file_path) throw new NoVaultError(id);

  let conn = null;
  openDdx(row.file_path, {
    kind: 'vault',
    create: false,
    register: (c) => { conn = c; vaultDbs.set(id, { conn: c, filePath: row.file_path, lastUsed: Date.now() }); },
  });
  evictIdleVaults();
  return conn;
}

// Creates a brand-new vault file and registers its connection. The ONLY path
// that passes create:true for a vault — everything else must fail loudly on a
// missing file rather than mint an empty one.
function createVaultDB(nexusId, filePath) {
  const id = Number(nexusId);
  let conn = null;
  openDdx(filePath, {
    kind: 'vault',
    create: true,
    register: (c) => { conn = c; vaultDbs.set(id, { conn: c, filePath, lastUsed: Date.now() }); },
  });
  return conn;
}

// A throwaway read-only handle for "is this file actually a vault?", used by
// the relink flow. Deliberately does NOT run the init path — probing a file the
// user picked must never write to it, least of all create tables in it.
function openVaultProbe(filePath) {
  if (!fs.existsSync(filePath)) throw new VaultFileMissingError(filePath);
  if (!fs.existsSync(filePath + '-wal')) forceLegacyJournalMode(filePath);
  const conn = adaptDb(new _RawDatabase(filePath));
  conn.exec('PRAGMA busy_timeout = 5000');
  const ok = ['nexus', 'module'].every((t) => hasTable(conn, t));
  if (!ok) { try { conn.close(); } catch (_) {} throw new Error('not a vault file'); }
  return conn;
}

function evictIdleVaults() {
  if (vaultDbs.size <= MAX_OPEN_VAULTS) return;
  const evictable = [...vaultDbs.entries()]
    .filter(([id]) => !pinnedVaults.has(id))
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (vaultDbs.size > MAX_OPEN_VAULTS && evictable.length) {
    const [id] = evictable.shift();
    closeVault(id);
  }
}

function closeVault(nexusId) {
  const entry = vaultDbs.get(Number(nexusId));
  if (!entry) return false;
  vaultDbs.delete(Number(nexusId));
  // adaptDb's close() flushes the statement cache first — without that the
  // cached statements leak.
  try { entry.conn.close(); } catch (_) {}
  return true;
}

// Which vaults have a live connection right now. Used to refresh their cached
// item counts for free, without opening anything.
const openVaultIds = () => [...vaultDbs.keys()];

const pinVault = (nexusId) => pinnedVaults.add(Number(nexusId));
const unpinVault = (nexusId) => pinnedVaults.delete(Number(nexusId));
const closeAllVaults = () => { for (const id of [...vaultDbs.keys()]) closeVault(id); };

class NoVaultError extends Error {
  constructor(id) {
    super(`no vault for id ${id} — a vault-scoped call ran with no vault context, or the vault is not registered`);
    this.code = 'no_vault';
  }
}

// The ambient accessor the ~464 existing call sites keep using unchanged. It
// resolves the vault from the AsyncLocalStorage context that main.js's h()
// wrapper establishes per IPC call.
function getDB() {
  return getVaultDB(currentNexusId());
}

function hasTable(conn, tableName) {
  return !!conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(tableName);
}

function hasColumn(conn, tableName, columnName) {
  if (!hasTable(conn, tableName)) return false;
  return conn.prepare(`PRAGMA table_info(${tableName})`).all().some((c) => c.name === columnName);
}

function hasAnyMissingColumns(conn, specs) {
  return specs.some(([tableName, columnNames]) =>
    hasTable(conn, tableName) && columnNames.some((columnName) => !hasColumn(conn, tableName, columnName))
  );
}



// Exported for the schema/ files, which were carved out of this one: they still
// call _now()/_t() for boot profiling and the has*() probes for their guards.
module.exports = {
  adaptDb, getDB, getAppDB, getVaultDB, openDdx, dataDir,
  createVaultDB, openVaultProbe, closeVault, closeAllVaults, pinVault, unpinVault, openVaultIds,
  VaultFileMissingError, NoVaultError,
  perfLog, forceLegacyJournalMode,
  hasTable, hasColumn, hasAnyMissingColumns, _now, _t,
};
