'use strict';
// ═══ Trash (v5 Part 7, APP docs/V5.md §11.4) ════════════════════════════
// Deleting a module used to be an ON DELETE CASCADE with no way back. Now:
//
//   1. the module and everything under it is serialized — the same snapshot
//      a .mddx export writes (sync.js serializeVault, scoped to the subtree)
//   2. every relation that touches anything inside it, in either direction,
//      is saved beside it: a scoped snapshot deliberately carries no
//      relations, and the ones pointing INTO the subtree from outside are
//      exactly what a restore must not lose. Which keys are "inside" comes
//      from ENTITY_KINDS' owner facet, so a new key family is covered too.
//   3. the rows are deleted for real, exactly as before.
//
// Restore imports the snapshot back under its old parent (top level if that
// parent is gone) through the one importer every other import uses, then
// re-adds the saved relations with the inside keys remapped to the new ids.
// Nothing else in the schema knows the trash exists: no deleted_at column
// for ~100 queries to forget. What does NOT come back is the module's
// version history (module_version is never in a snapshot) — the UI says so.
const { getVaultDB } = require('./core');
const { keysOwnedBy } = require('./entity-kinds');

function trashModule(nexusId, moduleId) {
  const sync = require('./sync');
  const db = getVaultDB(nexusId);
  const m = db.prepare(`SELECT id, parent_id, name, kind FROM module WHERE id=? AND nexus_ref=?`).get(moduleId, nexusId);
  if (!m) return { ok: false, code: 'not_found' };
  const ids = sync.collectModuleSubtreeIds(nexusId, moduleId);
  const payload = sync.serializeVault(nexusId, ids);
  if (!payload) return { ok: false, code: 'serialize_failed' };
  const keys = [...keysOwnedBy(db, ids)];
  const inside = new Set(keys);
  const rows = db.prepare(`SELECT * FROM entity_relation WHERE nexus_ref=?`).all(nexusId)
    .filter((r) => inside.has(r.from_key) || inside.has(r.to_key));
  const trashId = db.transaction(() => {
    const id = db.prepare(`INSERT INTO trash (nexus_ref, parent_ref, name, kind, module_count, payload, relations) VALUES (?,?,?,?,?,?,?)`)
      .run(nexusId, m.parent_id, m.name, m.kind, ids.length, JSON.stringify(payload), JSON.stringify({ keys, rows })).lastInsertRowid;
    // The saved rows go with the subtree; left behind, they would dangle.
    const del = db.prepare(`DELETE FROM entity_relation WHERE id=?`);
    for (const r of rows) del.run(r.id);
    return id;
  })();
  require('./module').deleteModule(moduleId);
  return { ok: true, trashId, modules: ids.length };
}

function listTrash(nexusId) {
  return getVaultDB(nexusId).prepare(`
    SELECT t.id, t.parent_ref, t.name, t.kind, t.module_count, t.deleted_at, p.name AS parent_name
    FROM trash t LEFT JOIN module p ON p.id=t.parent_ref WHERE t.nexus_ref=? ORDER BY t.id DESC`).all(nexusId);
}

function restoreTrash(nexusId, trashId) {
  const sync = require('./sync');
  const db = getVaultDB(nexusId);
  const t = db.prepare(`SELECT * FROM trash WHERE id=? AND nexus_ref=?`).get(trashId, nexusId);
  if (!t) return { ok: false, code: 'not_found' };
  // The old parent may be gone (or no longer a folder) — top level then.
  const parent = t.parent_ref != null
    ? db.prepare(`SELECT id FROM module WHERE id=? AND kind='collector'`).get(t.parent_ref)?.id ?? null
    : null;
  const payload = JSON.parse(t.payload);
  const r = sync.importModuleSnapshot(nexusId, parent, payload, { withKeyMaps: true });
  if (!r.ok) return r;
  const { keys = [], rows = [] } = JSON.parse(t.relations || '{}');
  const inside = new Set(keys);
  const remap = (k) => {
    if (!inside.has(k)) return k; // an endpoint outside the subtree kept its id
    const m = /^([a-z]+)_(\d+)$/.exec(k);
    const to = m && r.keyMaps?.[m[1]]?.get(Number(m[2]));
    return to == null ? null : `${m[1]}_${to}`;
  };
  const mod = (id) => (id == null ? null : r.keyMaps?.module?.get(id) ?? (db.prepare(`SELECT 1 FROM module WHERE id=?`).get(id) ? id : null));
  let relations = 0, dropped = 0;
  db.transaction(() => {
    const ins = db.prepare(`INSERT OR IGNORE INTO entity_relation (nexus_ref, from_key, to_key, label, color, rel_type, directed, module_ref, valid_from, valid_to, create_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const row of rows) {
      const fk = remap(row.from_key), tk = remap(row.to_key);
      const rt = /^ctpl_\d+$/.test(row.rel_type || '') ? remap(row.rel_type) : row.rel_type;
      if (!fk || !tk || (row.rel_type && rt == null)) { dropped++; continue; }
      ins.run(nexusId, fk, tk, row.label, row.color, rt, row.directed, mod(row.module_ref), row.valid_from, row.valid_to, row.create_at);
      relations++;
    }
    db.prepare(`DELETE FROM trash WHERE id=?`).run(trashId);
  })();
  const inPayload = new Set((payload.modules || []).map((mm) => mm.id));
  const root = (payload.modules || []).find((mm) => mm.parentId == null || !inPayload.has(mm.parentId));
  const rootId = root ? r.keyMaps?.module?.get(root.id) ?? null : null;
  return { ok: true, summary: { ...r.summary, relations, droppedRelations: (r.summary?.droppedRelations || 0) + dropped }, moduleId: rootId };
}

const deleteTrash = (nexusId, trashId) => getVaultDB(nexusId).prepare(`DELETE FROM trash WHERE id=? AND nexus_ref=?`).run(trashId, nexusId).changes;
const emptyTrash = (nexusId) => getVaultDB(nexusId).prepare(`DELETE FROM trash WHERE nexus_ref=?`).run(nexusId).changes;

module.exports = { trashModule, listTrash, restoreTrash, deleteTrash, emptyTrash };
