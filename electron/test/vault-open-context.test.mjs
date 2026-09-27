// A vault's first open runs its init path — migrations and the one-time
// [[wikilink]] backfill — and that path reads through getDB(), which resolves
// the vault from the IPC call's context. A vault first opened from somewhere
// else (the Welcome window creating a Nexus, a stats read across vaults) used
// to resolve to NO vault there: the backfill threw, was logged, and the schema
// stamp was written anyway, so an upgraded vault's old links were never
// indexed. conn.js now opens every vault inside its own context.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-open-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(dir, 'userData'), isPackaged: false, getVersion: () => '0.0.0' } } };

const conn = require('../src/db/conn.js');
const { runWithVault } = require('../src/db/vault-context.js');

test('an older vault first opened outside its context still gets its [[links]] indexed', (t) => {
  t.after(() => { conn.closeAllVaults(); rmSync(dir, { recursive: true, force: true }); });
  const app = conn.getAppDB();
  const file = join(dir, 'old.ddx');
  const id = Number(app.prepare(`INSERT INTO nexus_file (name, file_path) VALUES ('Old', ?)`).run(file).lastInsertRowid);

  // make it, then turn it into a vault from before wiki_link existed
  const v = runWithVault(id, () => conn.createVaultDB(id, file));
  v.prepare(`INSERT INTO nexus (id, name) VALUES (?, 'Old')`).run(id);
  const a = Number(v.prepare(`INSERT INTO module (nexus_ref, name, kind) VALUES (?, 'Tarven', 'inspector')`).run(id).lastInsertRowid);
  v.prepare(`INSERT INTO module (nexus_ref, name, kind, description) VALUES (?, 'Road', 'inspector', 'Leads to [[Tarven]].')`).run(id);
  v.exec(`DROP TABLE wiki_link; PRAGMA user_version = 0`);
  conn.closeVault(id);

  // first open from no vault context — the Welcome window's position
  const errors = [];
  const orig = console.error;
  console.error = (...x) => errors.push(x.join(' '));
  let reopened;
  try { reopened = conn.getVaultDB(id); } finally { console.error = orig; }

  assert.deepEqual(errors.filter((e) => /backfill/.test(e)), [], 'the backfill ran without error');
  const links = reopened.prepare(`SELECT target_key FROM wiki_link`).all().map((r) => r.target_key);
  assert.deepEqual(links, [`module_${a}`]);
});
