'use strict';
// ═══ Diviner — random tables and dice (v5 Part 7, APP docs/V5.md §11.5) ══
// The one new kind of Part 7: nothing else in the app can roll. A Diviner
// module holds tables; a table holds entries and a roll history.
//
//   dice    '1d20', '2d6+1', 'd%' … — an entry is chosen by its range_lo..hi.
//           NULL = weighted: each entry's `weight` is its share.
//   mode    'pick' = one entry · 'join' = every entry, in order, joined —
//           which, with entries that roll other tables, is the name / word
//           generator (§11.5: a preset of this kind, not a module of its own).
//
// Nesting: an entry whose linker_key is divt_<id> rolls that table in its
// place. The key remaps through ENTITY_KINDS like every other key (§11.2),
// so there is no syntax inside the text. A chain deeper than DIVINER_MAX_DEPTH,
// or one that comes back to a table already on the path (A → B → A), stops
// with a marker in the text instead of looping.
//
// The roll itself runs here, in main, so a result and its history row are
// one write, and the random source is crypto's — a DM's d20 should not
// come from Math.random.
const crypto = require('crypto');
const { getDB } = require('./core');
const wiki = require('./wiki');

const DIVINER_MAX_DEPTH = 8;
const DIVINER_MODES = ['pick', 'join'];
const DICE_RE = /^\s*(\d*)\s*d\s*(\d+|%)\s*(?:([+-])\s*(\d+))?\s*$/i;

// '2d6+1' → { n:2, sides:6, mod:1 } | null. Bounds keep a typo from asking
// for a million dice.
function parseDice(s) {
  const m = DICE_RE.exec(String(s ?? ''));
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  const sides = m[2] === '%' ? 100 : Number(m[2]);
  const mod = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  if (n < 1 || n > 100 || sides < 2 || sides > 1000) return null;
  return { n, sides, mod };
}

const diceText = ({ n, sides, mod }) => `${n}d${sides}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}`;
const diceRange = ({ n, sides, mod }) => ({ lo: n + mod, hi: n * sides + mod });

// Uniform int in [1, sides] — randomInt has no modulo bias.
const rollDie = (sides, rng) => (rng ? rng(sides) : crypto.randomInt(1, sides + 1));

function rollDice(spec, rng) {
  const d = typeof spec === 'string' ? parseDice(spec) : spec;
  if (!d) return null;
  const faces = Array.from({ length: d.n }, () => rollDie(d.sides, rng));
  const total = faces.reduce((a, b) => a + b, 0) + d.mod;
  const parts = [...faces.map(String), ...(d.mod ? [String(d.mod)] : [])];
  return { total, faces, text: `${diceText(d)} = ${total}${d.n > 1 || d.mod ? ` (${parts.join('+').replace(/\+-/g, '-')})` : ''}` };
}

// ── tables & entries ────────────────────────────────────────────────────
const nexusOfModule = (moduleRef) => getDB().prepare(`SELECT nexus_ref FROM module WHERE id=?`).get(moduleRef)?.nexus_ref ?? null;

const getDivinerTables = (moduleRef) => getDB().prepare(`
  SELECT t.*, (SELECT COUNT(*) FROM diviner_entry e WHERE e.table_ref=t.id) AS entry_count
  FROM diviner_table t WHERE t.module_ref=? ORDER BY t.display_order, t.id`).all(moduleRef);

const getDivinerEntries = (tableRef) => getDB().prepare(`
  SELECT * FROM diviner_entry WHERE table_ref=? ORDER BY display_order, id`).all(tableRef);

// Every table in the Nexus — what an entry can point at to roll on.
const getDivinerTablesInNexus = (nexusId) => getDB().prepare(`
  SELECT t.id, t.name, t.module_ref, m.name AS module_name FROM diviner_table t
  JOIN module m ON t.module_ref=m.id WHERE m.nexus_ref=? ORDER BY m.name, t.display_order, t.id`).all(nexusId);

const cleanDice = (dice) => {
  const s = String(dice ?? '').trim();
  if (!s) return null;
  const d = parseDice(s);
  return d ? diceText(d) : undefined; // undefined = refused
};

function createDivinerTable(moduleRef, name, dice = null, mode = 'pick') {
  const dc = cleanDice(dice);
  if (dc === undefined) return { ok: false, code: 'bad_dice' };
  const d = getDB();
  const order = d.prepare(`SELECT COALESCE(MAX(display_order),-1)+1 AS o FROM diviner_table WHERE module_ref=?`).get(moduleRef).o;
  const id = d.prepare(`INSERT INTO diviner_table (module_ref, name, dice, mode, display_order) VALUES (?,?,?,?,?)`)
    .run(moduleRef, name, dc, DIVINER_MODES.includes(mode) ? mode : 'pick', order).lastInsertRowid;
  wiki.resolveDanglingLinks(name, nexusOfModule(moduleRef));
  return { ok: true, id };
}

function updateDivinerTable(id, name, dice, mode) {
  const dc = cleanDice(dice);
  if (dc === undefined) return { ok: false, code: 'bad_dice' };
  const cur = getDB().prepare(`SELECT name FROM diviner_table WHERE id=?`).get(id);
  if (!cur) return { ok: false, code: 'not_found' };
  getDB().prepare(`UPDATE diviner_table SET name=?, dice=?, mode=?, update_at=datetime('now') WHERE id=?`)
    .run(name, dc, DIVINER_MODES.includes(mode) ? mode : 'pick', id);
  if (cur.name !== name) wiki.renameWikiTarget(`divt_${id}`, cur.name, name);
  return { ok: true };
}

function deleteDivinerTable(id) {
  getDB().prepare(`DELETE FROM diviner_table WHERE id=?`).run(id);
  // An entry elsewhere that rolled this table now rolls nothing: clear it,
  // so it reads as plain text rather than a dangling key.
  getDB().prepare(`UPDATE diviner_entry SET linker_key=NULL WHERE linker_key=?`).run(`divt_${id}`);
  return { ok: true };
}

// A dice table's new entry continues the ranges: after 1–3, 4–4.
function createDivinerEntry(tableRef, text = '', linkerKey = null) {
  const d = getDB();
  const t = d.prepare(`SELECT dice FROM diviner_table WHERE id=?`).get(tableRef);
  if (!t) return { ok: false, code: 'not_found' };
  const last = d.prepare(`SELECT MAX(range_hi) AS hi, COALESCE(MAX(display_order),-1)+1 AS o FROM diviner_entry WHERE table_ref=?`).get(tableRef);
  let lo = null, hi = null;
  const dc = t.dice ? parseDice(t.dice) : null;
  if (dc) { const r = diceRange(dc); lo = last.hi != null ? last.hi + 1 : r.lo; hi = lo; }
  const id = d.prepare(`INSERT INTO diviner_entry (table_ref, weight, range_lo, range_hi, entry_text, linker_key, display_order) VALUES (?,?,?,?,?,?,?)`)
    .run(tableRef, 1, lo, hi, text, linkerKey || null, last.o).lastInsertRowid;
  return { ok: true, id };
}

function updateDivinerEntry(id, e = {}) {
  const cur = getDB().prepare(`SELECT * FROM diviner_entry WHERE id=?`).get(id);
  if (!cur) return { ok: false, code: 'not_found' };
  const num = (v, dflt) => (v === undefined ? dflt : v === null || v === '' ? null : Math.trunc(Number(v)));
  const weight = Math.max(0, num(e.weight, cur.weight) ?? 1);
  let lo = num(e.lo, cur.range_lo), hi = num(e.hi, cur.range_hi);
  if (lo != null && hi != null && hi < lo) [lo, hi] = [hi, lo];
  if (lo != null && hi == null) hi = lo;
  getDB().prepare(`UPDATE diviner_entry SET weight=?, range_lo=?, range_hi=?, entry_text=?, linker_key=? WHERE id=?`)
    .run(weight, lo, hi, e.text === undefined ? cur.entry_text : e.text,
         e.linkerKey === undefined ? cur.linker_key : (e.linkerKey || null), id);
  return { ok: true };
}

const deleteDivinerEntry = (id) => { getDB().prepare(`DELETE FROM diviner_entry WHERE id=?`).run(id); return { ok: true }; };

function moveDivinerEntry(id, dir) {
  const d = getDB();
  const cur = d.prepare(`SELECT id, table_ref, display_order FROM diviner_entry WHERE id=?`).get(id);
  if (!cur) return { ok: false };
  const rows = d.prepare(`SELECT id FROM diviner_entry WHERE table_ref=? ORDER BY display_order, id`).all(cur.table_ref).map((r) => r.id);
  const i = rows.indexOf(id), j = i + (dir < 0 ? -1 : 1);
  if (j < 0 || j >= rows.length) return { ok: false };
  [rows[i], rows[j]] = [rows[j], rows[i]];
  d.transaction(() => rows.forEach((rid, k) => d.prepare(`UPDATE diviner_entry SET display_order=? WHERE id=?`).run(k, rid)))();
  return { ok: true };
}

// ── rolling ─────────────────────────────────────────────────────────────
// The name an entry shows when it points at an entity that is not a table.
function linkedName(d, key) {
  const m = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
  if (!m) return null;
  const { ENTITY_KINDS } = require('./entity-kinds');
  const sql = ENTITY_KINDS[m[1]]?.lookup?.sql;
  if (!sql) return null;
  try { return d.prepare(sql).get(Number(m[2]))?.name ?? null; } catch (_) { return null; }
}

// Weighted pick; entries of weight 0 never come up.
function pickWeighted(entries, rng) {
  const total = entries.reduce((a, e) => a + Math.max(0, e.weight ?? 1), 0);
  if (total <= 0) return null;
  let r = (rng ? rng(total) : crypto.randomInt(1, total + 1));
  for (const e of entries) { r -= Math.max(0, e.weight ?? 1); if (r <= 0) return e; }
  return entries[entries.length - 1];
}

// Resolve one table to text. path = the tables already open above this one.
// Returns { text, dice, entryId, steps } — steps is the trail for the UI.
function resolveTable(d, tableId, rng, path = []) {
  if (path.includes(tableId)) return { text: '⟲', cycle: true, steps: [] };
  if (path.length >= DIVINER_MAX_DEPTH) return { text: '…', deep: true, steps: [] };
  const t = d.prepare(`SELECT id, name, dice, mode FROM diviner_table WHERE id=?`).get(tableId);
  if (!t) return { text: '', steps: [] };
  const entries = d.prepare(`SELECT * FROM diviner_entry WHERE table_ref=? ORDER BY display_order, id`).all(tableId);
  const next = [...path, tableId];
  const expand = (e) => {
    const sub = /^divt_(\d+)$/.exec(e.linker_key || '');
    if (sub) {
      const r = resolveTable(d, Number(sub[1]), rng, next);
      return { text: [e.entry_text, r.text].filter(Boolean).join(' '), steps: r.steps, cycle: r.cycle, deep: r.deep };
    }
    const nm = e.linker_key ? linkedName(d, e.linker_key) : null;
    return { text: e.entry_text || (nm ? `[[${nm}]]` : ''), steps: [] };
  };
  if (t.mode === 'join') {
    const parts = entries.map(expand);
    return {
      text: parts.map((p) => p.text).join(''), steps: [{ tableId, name: t.name }, ...parts.flatMap((p) => p.steps)],
      cycle: parts.some((p) => p.cycle), deep: parts.some((p) => p.deep),
    };
  }
  let chosen = null, dice = null;
  if (t.dice) {
    const r = rollDice(t.dice, rng);
    if (r) {
      dice = r.text;
      chosen = entries.find((e) => e.range_lo != null && r.total >= e.range_lo && r.total <= (e.range_hi ?? e.range_lo)) || null;
    }
  } else chosen = pickWeighted(entries, rng);
  if (!chosen) return { text: '', dice, entryId: null, steps: [{ tableId, name: t.name, dice }] };
  const x = expand(chosen);
  return { ...x, dice, entryId: chosen.id, steps: [{ tableId, name: t.name, dice, entryId: chosen.id }, ...x.steps] };
}

// Roll a table and keep it in the history. `rng(n)` (1..n) is for tests.
function rollDivinerTable(tableId, rng = null) {
  const d = getDB();
  const r = resolveTable(d, tableId, rng);
  const id = d.prepare(`INSERT INTO diviner_roll (table_ref, dice_result, entry_ref, result_text) VALUES (?,?,?,?)`)
    .run(tableId, r.dice ?? null, r.entryId ?? null, r.text).lastInsertRowid;
  // The history keeps its last 200 per table — enough for a session, not a log forever.
  d.prepare(`DELETE FROM diviner_roll WHERE table_ref=? AND id NOT IN (SELECT id FROM diviner_roll WHERE table_ref=? ORDER BY id DESC LIMIT 200)`).run(tableId, tableId);
  return { ok: true, id, text: r.text, dice: r.dice ?? null, entryId: r.entryId ?? null, steps: r.steps, cycle: !!r.cycle, deep: !!r.deep };
}

// A bare dice expression, no table — the "just roll 3d6" row. Not kept.
const rollDiceOnly = (expr) => { const r = rollDice(expr); return r ? { ok: true, ...r } : { ok: false, code: 'bad_dice' }; };

const getDivinerRolls = (tableRef, limit = 30) => getDB().prepare(`
  SELECT * FROM diviner_roll WHERE table_ref=? ORDER BY id DESC LIMIT ?`).all(tableRef, limit);
const clearDivinerRolls = (tableRef) => { getDB().prepare(`DELETE FROM diviner_roll WHERE table_ref=?`).run(tableRef); return { ok: true }; };

// Would pointing tableId's entry at targetId close a loop? The picker greys
// those out, and the roll guards anyway.
function divinerWouldCycle(tableId, targetId) {
  const d = getDB();
  const seen = new Set();
  const walk = (id) => {
    if (id === tableId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return d.prepare(`SELECT linker_key FROM diviner_entry WHERE table_ref=? AND linker_key LIKE 'divt\\_%' ESCAPE '\\'`).all(id)
      .some((e) => walk(Number(e.linker_key.slice(5))));
  };
  return walk(targetId);
}

module.exports = {
  DIVINER_MAX_DEPTH, parseDice, rollDice,
  getDivinerTables, getDivinerEntries, getDivinerTablesInNexus,
  createDivinerTable, updateDivinerTable, deleteDivinerTable,
  createDivinerEntry, updateDivinerEntry, deleteDivinerEntry, moveDivinerEntry,
  rollDivinerTable, rollDiceOnly, getDivinerRolls, clearDivinerRolls, divinerWouldCycle,
};
