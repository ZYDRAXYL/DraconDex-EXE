// v5 Part 7 (V5.md §11.5) — Diviner. Dice parse and roll inside their
// range; a dice table picks by range, a weighted one never picks weight 0;
// join concatenates; an entry that rolls another table nests, and a loop
// (A → B → A) stops instead of recursing forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const tmp = mkdtempSync(join(tmpdir(), 'ddx-div-'));
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { app: { getPath: () => tmp, isPackaged: false, getVersion: () => '0' } };
  return origLoad.call(this, req, parent, isMain);
};

const { Database } = require('node-sqlite3-wasm');
const { adaptDb } = require('../src/db/conn.js');
const { VAULT_DDL_SQL } = require('../src/db/schema/ddl.js');
const mig = require('../src/db/schema/migrations.js');

let db;
const core = require.resolve('../src/db/core.js');
require.cache[core] = { id: core, filename: core, loaded: true, exports: { getDB: () => db, getVaultDB: () => db } };

function freshVault() {
  db = adaptDb(new Database(join(tmp, `v${Math.random().toString(36).slice(2)}.ddx`)), 'vault');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(VAULT_DDL_SQL);
  mig.migrateInlineColumns(db); // creates idx_entity_relation_v5 on a fresh vault too
  db.readTx = (fn) => fn;
  db.prepare(`INSERT INTO nexus (id, name) VALUES (1, 'N')`).run();
  return db;
}
const mkModule = (name, kind, parent = null) =>
  db.prepare(`INSERT INTO module (nexus_ref, parent_id, name, kind) VALUES (1,?,?,?)`).run(parent, name, kind).lastInsertRowid;

test.after(() => { Module._load = origLoad; rmSync(tmp, { recursive: true, force: true }); });

const dv = require('../src/db/diviner.js');
// A scripted rng: returns the queued values in order (each 1..n).
const script = (...v) => (n) => { const x = v.shift(); assert.ok(x >= 1 && x <= n, `rng ${x} of ${n}`); return x; };

test('dice: parse, bounds, text', () => {
  assert.deepEqual(dv.parseDice('2d6+1'), { n: 2, sides: 6, mod: 1 });
  assert.deepEqual(dv.parseDice('d%'), { n: 1, sides: 100, mod: 0 });
  assert.deepEqual(dv.parseDice(' 3 D 8 - 2 '), { n: 3, sides: 8, mod: -2 });
  for (const bad of ['', 'd1', '0d6', '101d6', '2d6+', 'x', '1d6*2']) assert.equal(dv.parseDice(bad), null, bad);
  assert.equal(dv.rollDice('2d6+1', script(4, 4)).text, '2d6+1 = 9 (4+4+1)');
  assert.equal(dv.rollDice('1d20', script(17)).text, '1d20 = 17');
  assert.equal(dv.rollDice('2d4-1', script(1, 2)).text, '2d4-1 = 2 (1+2-1)');
  for (let i = 0; i < 200; i++) { const r = dv.rollDice('3d6'); assert.ok(r.total >= 3 && r.total <= 18); }
});

test('a dice table picks by range; ranges continue; the roll is kept', () => {
  freshVault();
  const m = mkModule('Div', 'diviner');
  const t = dv.createDivinerTable(m, 'Weather', '1d6').id;
  const a = dv.createDivinerEntry(t, 'Sun').id;
  dv.updateDivinerEntry(a, { lo: 1, hi: 3 });
  const b = dv.createDivinerEntry(t, 'Rain').id;
  assert.deepEqual(db.prepare(`SELECT range_lo, range_hi FROM diviner_entry WHERE id=?`).get(b), { range_lo: 4, range_hi: 4 });
  dv.updateDivinerEntry(b, { hi: 6 });
  assert.equal(dv.rollDivinerTable(t, script(2)).text, 'Sun');
  const r = dv.rollDivinerTable(t, script(5));
  assert.equal(r.text, 'Rain');
  assert.equal(r.dice, '1d6 = 5');
  assert.deepEqual(dv.getDivinerRolls(t).map((x) => x.result_text), ['Rain', 'Sun']);
  assert.deepEqual(dv.createDivinerTable(m, 'Bad', '2d'), { ok: false, code: 'bad_dice' });
});

test('weighted never picks weight 0; join concatenates nested tables', () => {
  freshVault();
  const m = mkModule('Names', 'diviner');
  const w = dv.createDivinerTable(m, 'W').id;
  dv.updateDivinerEntry(dv.createDivinerEntry(w, 'never').id, { weight: 0 });
  dv.createDivinerEntry(w, 'always');
  for (let i = 0; i < 50; i++) assert.equal(dv.rollDivinerTable(w).text, 'always');

  const pre = dv.createDivinerTable(m, 'Prefix').id;
  dv.createDivinerEntry(pre, 'Dra'); dv.createDivinerEntry(pre, 'Ka');
  const suf = dv.createDivinerTable(m, 'Suffix').id;
  dv.createDivinerEntry(suf, 'con'); dv.createDivinerEntry(suf, 'rin');
  const name = dv.createDivinerTable(m, 'Name', null, 'join').id;
  dv.createDivinerEntry(name, '', `divt_${pre}`);
  dv.createDivinerEntry(name, '', `divt_${suf}`);
  assert.equal(dv.rollDivinerTable(name, script(1, 1)).text, 'Dracon');
  assert.equal(dv.rollDivinerTable(name, script(2, 2)).text, 'Karin');
});

test('a loop stops at the repeated table; the picker can see it coming', () => {
  freshVault();
  const m = mkModule('Loop', 'diviner');
  const a = dv.createDivinerTable(m, 'A').id, b = dv.createDivinerTable(m, 'B').id;
  dv.createDivinerEntry(a, 'a', `divt_${b}`);
  assert.equal(dv.divinerWouldCycle(b, a), true);   // B → A would close A → B → A
  assert.equal(dv.divinerWouldCycle(a, b), false);  // A → B again is fine
  dv.createDivinerEntry(b, 'b', `divt_${a}`);       // the importer or an old vault can still hold one
  const r = dv.rollDivinerTable(a);
  assert.equal(r.cycle, true);
  assert.equal(r.text, 'a b ⟲');
  dv.deleteDivinerTable(b);
  assert.equal(db.prepare(`SELECT linker_key FROM diviner_entry WHERE table_ref=?`).get(a).linker_key, null);
});

test.after(() => rmSync(tmp, { recursive: true, force: true }));
