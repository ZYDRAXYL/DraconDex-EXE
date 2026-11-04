// Procress 32 9.0 — the Port Link merge cases shared with the APK
// (SDB fixtures/portlink-merge-v1.json, vendored to test/fixtures/), run
// through this app's engine. Both engines pass the same cases or one of them
// has a bug: a merge rule changes in SDB first, never here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'ddx-portfx-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => join(dir, 'electron-user-data'), isPackaged: true, getVersion: () => '0.0.0' } } };
process.env.DRACONDEX_DATA_DIR = dir;

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { mergeInto } = require('../src/db/portlink-merge.js');
const { VAULT_DDL_SQL } = require('../../src/schema/generated/vault-ddl.electron.js');
const fx = JSON.parse(readFileSync(new URL('./fixtures/portlink-merge-v1.json', import.meta.url), 'utf8'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('the fixture is the version this runner reads', () => {
  assert.equal(fx.format, 'dracondex-portlink-merge-fixture');
  assert.equal(fx.version, 1);
});

for (const c of fx.cases) {
  test(`${c.name} — ${c.why}`, () => {
    // Seeded ONCE, then copied: in real use the base and both sides start as
    // copies of one file. Seeding three databases separately gives the
    // datetime('now') defaults different seconds whenever the seeds straddle
    // one — and every row then reads as changed on the drive.
    const at = mkdtempSync(join(dir, `${c.name}-`));
    const seed = new Database(join(at, 'b'));
    seed.exec(VAULT_DDL_SQL);
    seed.exec('PRAGMA foreign_keys = ON');
    for (const s of [...fx.seed, ...(c.seedExtra || [])]) seed.exec(s);
    seed.close();
    copyFileSync(join(at, 'b'), join(at, 'l'));
    copyFileSync(join(at, 'b'), join(at, 'w'));
    const open = (n) => { const db = adaptDb(new Database(join(at, n))); db.exec('PRAGMA foreign_keys = ON'); return db; };
    const B = open('b'), L = open('l'), W = open('w');
    try {
      for (const s of c.local) L.exec(s);
      for (const s of c.drive) W.exec(s);
      const r = mergeInto(B, L, W, c.choices || {});
      if (c.expect.code === 'needs_choice') {
        assert.deepEqual(r.conflicts.map((x) => x.key).sort(), [...c.expect.conflicts].sort());
        return;
      }
      assert.deepEqual(r.conflicts.map((x) => x.key), [], 'no conflict left unanswered');
      for (const q of c.expect.queries) assert.deepEqual(W.prepare(q.sql).all(), q.rows, q.sql);
      assert.deepEqual(W.prepare('PRAGMA foreign_key_check').all(), [], 'nothing points nowhere');
    } finally {
      for (const db of [B, L, W]) db.close();
    }
  });
}
