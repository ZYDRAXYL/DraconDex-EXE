'use strict';
// Façade. This file used to be 2532 lines: the connection adapter, ~1100 lines
// of DDL/index/seed data, seven migrations and a 727-line import-merge. Plan
// part1 split those into conn.js, schema/* and import-merge.js — but ~29 files
// in src/db (and database.js) do `require('./core')`, so the public surface
// stays exactly what it was.
//
//   conn.js               open/adapt connections, statement cache, has*() probes
//   vault-context.js      which vault the current IPC call belongs to
//   schema/ddl.js         CREATE TABLE …           (data)
//   schema/indexes.js     CREATE INDEX …           (data)
//   schema/seed.js        first-run seed rows      (data)
//   schema/init.js        schema stamps + initAppDB/initVaultDB/initDB
//   schema/migrations.js  additive migrations + ensureIndexes()
//   import-merge.js       export a copy / merge an external database in
const { getDB, getAppDB, getVaultDB, createVaultDB, closeVault, closeAllVaults, pinVault, unpinVault, adaptDb, perfLog } = require('./conn');
const { exportDatabaseTo, importDatabaseMerge, getAppDatabasePath, getVaultPath } = require('./import-merge');

// Process 7 part 2 — the app-wide session undo/redo surface (undo.js, hooked
// into every vault connection by conn.js's adaptDb()). Thin pass-throughs to
// the active vault's connection, same as every other getDB()-based call here.
const historyUndo = () => getDB().undo();
const historyRedo = () => getDB().redo();
const historyCanUndo = () => getDB().canUndo();
const historyCanRedo = () => getDB().canRedo();

module.exports = {
  getDB, getAppDB, getVaultDB, createVaultDB,
  closeVault, closeAllVaults, pinVault, unpinVault,
  adaptDb, exportDatabaseTo, importDatabaseMerge, getAppDatabasePath, getVaultPath, perfLog,
  historyUndo, historyRedo, historyCanUndo, historyCanRedo,
};
