'use strict';
// ═══ A module as a document (Procress 14, EXPORT-DECOR.md E2 / E5) ═════
// What DOCX and EPUB write, read once from the vault: a title, the cover
// (the page title's cover image, by sha256 — page-head.js), and sections in
// reading order. Each section: a heading, an optional line under it, the
// pictures its page shows (image blocks), a property table, and its text
// as doc-model blocks.
//
//   author       a section per chapter, in order, a page break between
//   classifier   a section per element: its fields as a table, its note
//   chronicler   a section per event, its timeline and dates under it
//   drafter,     the module's own text
//   inspector
const { getDB } = require('./core');
const { toBlocks } = require('./doc-model');
const { ENTITY_KINDS } = require('./entity-kinds');

const DOC_KINDS = new Set(['author', 'classifier', 'chronicler', 'drafter', 'inspector']);

function imagesOf(d, moduleId, itemKey) {
  const rows = itemKey == null
    ? d.prepare(`SELECT source_key FROM page_block WHERE module_ref=? AND item_key IS NULL AND block_type='image' ORDER BY block_order, id`).all(moduleId)
    : d.prepare(`SELECT source_key FROM page_block WHERE module_ref=? AND item_key=? AND block_type='image' ORDER BY block_order, id`).all(moduleId, itemKey);
  return rows.map((r) => /^file_(\d+)$/.exec(r.source_key || '')).filter(Boolean).map((m) => Number(m[1]));
}

function coverOf(d, moduleId, nexusId) {
  let sha = null;
  try { sha = JSON.parse(d.prepare(`SELECT ui_value FROM module_ui WHERE module_ref=? AND ui_key='pageHead'`).get(moduleId)?.ui_value || 'null')?.cover || null; } catch (_) {}
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) return null;
  return d.prepare(`SELECT id FROM import_file WHERE nexus_ref=? AND sha256=? ORDER BY id LIMIT 1`).get(nexusId, sha)?.id ?? null;
}

const dateText = (r, p) => (r[`${p}_years`] == null ? '' : `${r[`${p}_years`]}.${String(r[`${p}_month`]).padStart(2, '0')}.${String(r[`${p}_day`]).padStart(2, '0')}`);

function moduleDocument(moduleId) {
  const d = getDB();
  const m = d.prepare(`SELECT id, nexus_ref, name, kind, description FROM module WHERE id=?`).get(moduleId);
  if (!m || !DOC_KINDS.has(m.kind)) return null;
  const doc = { title: m.name, kind: m.kind, cover: coverOf(d, m.id, m.nexus_ref), intro: { images: imagesOf(d, m.id, null), blocks: [] }, sections: [] };
  const nameOf = (key) => {
    const k = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
    try { return k && ENTITY_KINDS[k[1]]?.lookup ? d.prepare(ENTITY_KINDS[k[1]].lookup.sql).get(Number(k[2]))?.name ?? null : null; } catch (_) { return null; }
  };

  if (m.kind === 'author') {
    const rows = d.prepare(`SELECT id, name, chapter_label, chapter_content, synopsis FROM book_chapter WHERE module_ref=? ORDER BY chapter_order, id`).all(m.id);
    rows.forEach((c, i) => doc.sections.push({
      key: `bchp_${c.id}`, title: c.chapter_label ? `${c.chapter_label}. ${c.name}` : c.name,
      images: imagesOf(d, m.id, `bchp_${c.id}`), props: [], blocks: toBlocks(c.chapter_content || ''), breakBefore: i > 0,
    }));
  } else if (m.kind === 'classifier') {
    const tpls = d.prepare(`SELECT id, description, attribute_type, object_ref FROM classifier_template WHERE module_ref=? AND (object_ref IS NULL OR object_ref=?) ORDER BY display_order, id`);
    const vals = d.prepare(`SELECT template_ref, attribute_value FROM classifier_attribute WHERE object_ref=?`);
    const rel = d.prepare(`SELECT to_key FROM entity_relation WHERE from_key=? AND rel_type=? ORDER BY id`);
    for (const o of d.prepare(`SELECT id, name, note FROM classifier_object WHERE module_ref=? ORDER BY display_order, id`).all(m.id)) {
      const v = new Map(vals.all(o.id).map((r) => [r.template_ref, r.attribute_value]));
      const props = [];
      for (const tp of tpls.all(m.id, o.id)) {
        const type = tp.attribute_type || 'text';
        if (type === 'formula') continue; // computed in the app — nothing stored to write
        let val = v.get(tp.id) ?? '';
        if (type === 'relation') val = rel.all(`cobj_${o.id}`, `ctpl_${tp.id}`).map((r) => nameOf(r.to_key)).filter(Boolean).join(', ');
        else if (type === 'checkbox') val = val === '1' ? '✓' : val === '' ? '' : '✗';
        else if (type === 'multi') { try { const a = JSON.parse(val); if (Array.isArray(a)) val = a.join(', '); } catch (_) {} }
        if (String(val).trim()) props.push([tp.description, String(val)]);
      }
      doc.sections.push({ key: `cobj_${o.id}`, title: o.name, images: imagesOf(d, m.id, `cobj_${o.id}`), props, blocks: toBlocks(o.note || '') });
    }
  } else if (m.kind === 'chronicler') {
    const rows = d.prepare(`
      SELECT te.id, te.event_name, te.story, tl.line_name,
        s.day s_day, s.month s_month, s.years s_years, e.day e_day, e.month e_month, e.years e_years
      FROM timeline_event te JOIN timeline tl ON te.timeline_id=tl.id
      LEFT JOIN timeline_date s ON te.start_at=s.id LEFT JOIN timeline_date e ON te.end_at=e.id
      WHERE tl.module_ref=? ORDER BY s.years, s.month, s.day, te.id`).all(m.id);
    for (const e of rows) {
      const when = [dateText(e, 's'), dateText(e, 'e')].filter(Boolean).join(' – ');
      doc.sections.push({ key: `tlev_${e.id}`, title: e.event_name || when, sub: [e.line_name, when].filter(Boolean).join(' · '),
        images: imagesOf(d, m.id, `tlev_${e.id}`), props: [], blocks: toBlocks(e.story || '') });
    }
  } else {
    doc.intro.blocks = toBlocks(m.description || '');
  }
  return doc;
}

module.exports = { moduleDocument, DOC_KINDS };
