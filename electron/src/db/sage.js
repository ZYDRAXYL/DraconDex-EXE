// Plan part2 #2: this file's original whole-database, legacy-table-scoped
// analytics (getDataSize/getObjectAmounts/getLinkerList/getLinkerGraph) were
// removed — the legacy nav-rail Sage page they backed was replaced by the
// Hub's own nexus-scoped Sage Hut section below, which is what remains.

// ═══ Sage Hut (v3 Phase 17) — vault-wide analytics over the module nest ═
// Per-module item counts and approximate content byte sizes across every
// v3 content table, plus the wiki-link roll-up for the hub section.
// One read transaction around the 9 aggregate scans — outside one, each
// statement pays its own file-lock cycle (~2.5ms vs ~6µs). The per-module
// description loop that used to sit here is gone (Plan part2 #2.3); its
// LENGTH() is selected with the module list itself.
function sageHutStats(nexusId) {
  const { getDB } = require('./core');
  return getDB().readTx(() => _sageHutStats(nexusId))();
}
function _sageHutStats(nexusId) {
  const { getDB } = require('./core');
  const { scopedAll } = require('./sqlscope');
  const d = getDB();
  const nx = nexusId ?? null;
  // desc_bytes is read off this same row rather than a per-module SELECT in
  // a loop below it, which is what this used to do (Plan part2 #2.3) — same
  // table, same scope, so it costs nothing here. It is destructured out
  // again when seeding `per` so it never reaches the shipped perModule
  // payload (the renderer reads only id/name/kind/color_code/items/bytes).
  const modules = d.prepare(`
    SELECT m.id, m.name, m.kind, uc.color_code, COALESCE(LENGTH(m.description),0) AS desc_bytes FROM module m
    LEFT JOIN use_color uc ON uc.id=m.color
    WHERE (? IS NULL OR m.nexus_ref=?) ORDER BY m.display_order, m.id
  `).all(nx, nx);
  const per = new Map(modules.map(({ desc_bytes, ...m }) => [m.id, { ...m, items: 0, bytes: desc_bytes || 0 }]));
  const add = (sql, idCol, cntCol, byteCol) => {
    try {
      for (const r of scopedAll(d, sql, nx)) {
        const row = per.get(r[idCol]);
        if (!row) continue;
        row.items += r[cntCol] || 0;
        row.bytes += r[byteCol] || 0;
      }
    } catch (_) {}
  };
  add(`SELECT o.module_ref AS mid, COUNT(*) AS c,
        SUM(LENGTH(o.name) + COALESCE(LENGTH(o.note),0)) AS b
      FROM classifier_object o JOIN module m ON o.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY o.module_ref`, 'mid', 'c', 'b');
  add(`SELECT tl.module_ref AS mid, COUNT(*) AS c,
        SUM(COALESCE(LENGTH(te.event_name),0) + COALESCE(LENGTH(te.story),0)) AS b
      FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id
      JOIN module m ON tl.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY tl.module_ref`, 'mid', 'c', 'b');
  add(`SELECT sd.module_ref AS mid, COUNT(*) AS c,
        SUM(LENGTH(sd.name) + COALESCE((SELECT SUM(COALESCE(LENGTH(st.speaker),0)+COALESCE(LENGTH(st.talk_sentence),0)) FROM story_talk st WHERE st.dialogue_ref=sd.id),0)) AS b
      FROM story_dialogue sd JOIN module m ON sd.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY sd.module_ref`, 'mid', 'c', 'b');
  add(`SELECT ch.module_ref AS mid, COUNT(*) AS c,
        SUM(LENGTH(ch.name) + COALESCE(LENGTH(ch.chapter_content),0)) AS b
      FROM book_chapter ch JOIN module m ON ch.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY ch.module_ref`, 'mid', 'c', 'b');
  add(`SELECT s.module_ref AS mid, COUNT(*) AS c,
        SUM(LENGTH(s.name) + COALESCE((SELECT SUM(LENGTH(g.message)) FROM chat_message g WHERE g.session_ref=s.id),0)) AS b
      FROM chat_session s JOIN module m ON s.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY s.module_ref`, 'mid', 'c', 'b');
  add(`SELECT sp.module_ref AS mid, COUNT(*) AS c,
        SUM(LENGTH(sp.name) + COALESCE((SELECT SUM(LENGTH(ss.points)) FROM sketch_stroke ss WHERE ss.page_ref=sp.id),0)) AS b
      FROM sketch_page sp JOIN module m ON sp.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY sp.module_ref`, 'mid', 'c', 'b');
  add(`SELECT dn.module_ref AS mid, COUNT(*) AS c,
        SUM(COALESCE(LENGTH(dn.node_text),0) + 16) AS b
      FROM design_node dn JOIN module m ON dn.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY dn.module_ref`, 'mid', 'c', 'b');
  add(`SELECT me.module_ref AS mid, COUNT(*) AS c, SUM(COALESCE(LENGTH(me.label),0) + 16) AS b
      FROM map_event me JOIN module m ON me.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY me.module_ref`, 'mid', 'c', 'b');
  add(`SELECT mp.module_ref AS mid, COUNT(*) AS c, SUM(COALESCE(LENGTH(mp.point_name),0) + 16) AS b
      FROM map_point mp JOIN module m ON mp.module_ref=m.id
      WHERE (? IS NULL OR m.nexus_ref=?) GROUP BY mp.module_ref`, 'mid', 'c', 'b');
  const links = d.prepare(`SELECT COUNT(*) AS c FROM wiki_link WHERE (? IS NULL OR nexus_ref=?)`).get(nx, nx).c;
  const perModule = [...per.values()];
  return {
    objects: perModule.reduce((a, m) => a + m.items, 0),
    modules: modules.length,
    links,
    bytes: perModule.reduce((a, m) => a + m.bytes, 0),
    perModule,
  };
}

// Same read-transaction treatment as sageHutStats — the LIMIT 500 scan plus
// resolveEntityKeys's own queries would otherwise each pay a lock cycle.
function sageHutLinkerList(nexusId) {
  const { getDB } = require('./core');
  return getDB().readTx(() => _sageHutLinkerList(nexusId))();
}
function _sageHutLinkerList(nexusId) {
  const { getDB } = require('./core');
  const wiki = require('./wiki');
  const d = getDB();
  const rows = d.prepare(`
    SELECT id, src_key, target_key, target_text FROM wiki_link
    WHERE (? IS NULL OR nexus_ref=?) ORDER BY id DESC LIMIT 500
  `).all(nexusId ?? null, nexusId ?? null);
  const keys = new Set();
  for (const r of rows) { keys.add(r.src_key); if (r.target_key) keys.add(r.target_key); }
  const named = new Map(wiki.resolveEntityKeys([...keys]).map(e => [e.key, e]));
  return rows.map(r => ({
    id: r.id,
    from: named.get(r.src_key) || { key: r.src_key, name: r.src_key, type: '?' },
    to: r.target_key ? (named.get(r.target_key) || null) : null,
    text: r.target_text,
  }));
}

module.exports = { sageHutStats, sageHutLinkerList };
