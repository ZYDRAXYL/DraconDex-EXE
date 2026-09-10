'use strict';
// ═══ Which vault is this call for? (v4.9.0) ════════════════════════════════
// Once each Nexus is its own .ddx file, every vault-scoped query needs to know
// which file it belongs to — and the ~440 IPC handlers in main.js delegate
// straight to src/db/*.js functions that just call getDB() with no vault
// argument. This module carries that answer ambiently so those call sites stay
// unchanged.
//
// ─── Why AsyncLocalStorage and not a module-scoped variable ────────────────
// Two windows on two vaults share one process and one event loop. A plain
// "set the active vault, then call the handler" scheme is correct only while
// no handler awaits anything:
//
//   sync:push   for window A -> setActive(1) -> await ensureAccessToken()  [yields]
//   note:get    for window B -> setActive(2) -> returns          [active is now 2]
//                               ...token arrives, A resumes -> getDB() -> VAULT 2
//
// It fails OPEN: a wrong-vault write, silently, with no error. Some of those
// paths call applySnapshot, which WIPES the target nexus. ALS binds the store
// to the async chain, so a continuation after an await still sees its own
// vault. node-sqlite3-wasm is synchronous, so the cost is a per-async-op
// bookkeeping overhead measured in microseconds against a ~2.5ms statement.
//
// The handlers that would actually break under the naive scheme, for the
// record: db:exportNexusFile / db:importNexusFile / db:exportModuleFile /
// db:importModuleFile (all await a file dialog first), db:importMergeFile,
// sync:push / sync:pull / sync:pullByToken, drive:backupNow /
// drive:restoreDatabase.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// BrowserWindow.id -> nexus id. Maintained by main.js's createWindow and the
// window's 'closed' handler; the Welcome window deliberately has no entry.
const windowNexus = new Map();

class NoActiveVaultError extends Error {
  constructor() {
    super('no active vault for this call — a vault-scoped db function ran outside a vault context');
    this.code = 'no_active_vault';
  }
}

const runWithVault = (nexusId, fn) => als.run({ nexusId: nexusId ?? null }, fn);

const currentNexusId = () => als.getStore()?.nexusId ?? null;

// Fails CLOSED, always. An app-level function that forgets to use getAppDB()
// throws here instead of silently reading or writing whichever vault happens
// to be open — which is the failure mode that would be hardest to notice and
// worst to recover from.
function requireNexusId() {
  const id = currentNexusId();
  if (id == null) throw new NoActiveVaultError();
  return id;
}

module.exports = {
  windowNexus, runWithVault, currentNexusId, requireNexusId, NoActiveVaultError,
};
