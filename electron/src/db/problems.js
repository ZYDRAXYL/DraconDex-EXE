'use strict';
// ═══ Problems (v5 Part 7, APP docs/V5.md §11.10) ════════════════════════
// Everything worth a second look, in one list — the Problems panel of VS
// Code. Read-only: each row names where the problem is, and the panel
// opens that place. What is checked, all derived from ENTITY_KINDS (§11.2)
// so a new family is covered without touching this file:
//   link      a [[link]] whose target does not exist (wiki_link.target_key NULL)
//   empty     a module of a content kind with nothing in it yet
//   relation  a relation — a relation FIELD's value included — whose end is
//             gone (deleted, or moved to the trash, which deletes for real)
// The fourth kind of problem — what the last import or pull could not bring
// across — is known only to the renderer that ran it (S.lastImportDrops).
const { getDB } = require('./core');
const { ENTITY_KINDS } = require('./entity-kinds');

const MAX_PER_TYPE = 200;

function listProblems(nexusId) {
  const d = getDB();
  const nameCache = new Map();
  const nameOf = (key) => {
    if (nameCache.has(key)) return nameCache.get(key);
    const m = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
    let name = null;
    const sql = m && ENTITY_KINDS[m[1]]?.lookup?.sql;
    if (sql) { try { name = d.prepare(sql).get(Number(m[2]))?.name ?? null; } catch (_) {} }
    nameCache.set(key, name);
    return name;
  };
  const exists = (key) => {
    const m = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
    const table = m && ENTITY_KINDS[m[1]]?.table;
    if (!table) return true; // a family this app does not know is not ours to judge
    try { return !!d.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(Number(m[2])); } catch (_) { return true; }
  };
  const out = [];

  // Unresolved [[links]], grouped per source so one page with five broken
  // links is one row, not five.
  const bySrc = new Map();
  for (const r of d.prepare(`SELECT src_key, target_text FROM wiki_link WHERE nexus_ref=? AND target_key IS NULL ORDER BY src_key`).all(nexusId)) {
    if (!bySrc.has(r.src_key)) bySrc.set(r.src_key, []);
    bySrc.get(r.src_key).push(r.target_text);
  }
  for (const [src, targets] of [...bySrc].slice(0, MAX_PER_TYPE)) {
    out.push({ type: 'link', key: src, name: nameOf(src) || src, detail: [...new Set(targets)].map((x) => `[[${x}]]`).join(' ') });
  }

  // Empty content modules. A kind's content family is the one whose lookup
  // names that kind as its module; Drafter / Inspector hold their text in
  // the module's own description.
  const familyOf = {};
  for (const [prefix, k] of Object.entries(ENTITY_KINDS)) {
    if (k.owner && k.lookup?.module && prefix !== 'module' && prefix !== 'ctpl' && prefix !== 'exn') familyOf[k.lookup.module] ??= prefix;
  }
  for (const m of d.prepare(`SELECT id, name, kind, description FROM module WHERE nexus_ref=? ORDER BY display_order, id`).all(nexusId)) {
    let empty = false;
    if (m.kind === 'drafter' || m.kind === 'inspector') empty = !String(m.description || '').trim();
    else if (familyOf[m.kind]) empty = !d.prepare(ENTITY_KINDS[familyOf[m.kind]].owner).get(m.id);
    if (empty) out.push({ type: 'empty', key: `module_${m.id}`, name: m.name, detail: m.kind });
    if (out.filter((p) => p.type === 'empty').length >= MAX_PER_TYPE) break;
  }

  // Relations with a missing end.
  let n = 0;
  for (const r of d.prepare(`SELECT from_key, to_key, rel_type, label FROM entity_relation WHERE nexus_ref=? ORDER BY id`).all(nexusId)) {
    const fromOk = exists(r.from_key), toOk = exists(r.to_key);
    if (fromOk && toOk) continue;
    const field = /^ctpl_\d+$/.test(r.rel_type || '') ? nameOf(r.rel_type) : null;
    const live = fromOk ? r.from_key : r.to_key;
    out.push({ type: 'relation', key: fromOk || toOk ? live : null, name: fromOk || toOk ? (nameOf(live) || live) : '—',
      detail: [field || r.rel_type || r.label || '', `→ ${fromOk ? r.to_key : r.from_key}`].filter(Boolean).join(' ') });
    if (++n >= MAX_PER_TYPE) break;
  }
  return out;
}

module.exports = { listProblems };
