'use strict';
// ═══ Export as Markdown (v5 Part 7, APP docs/V5.md §11.4) ═══════════════
// The Longevity answer: a Nexus as plain .md files any program opens. One
// file per entity, one folder per module (the Nest's own tree), in a .zip
// through the §8.7 writer — no new dependency.
//
//   Classifier object   YAML frontmatter of its fields, its note as the body
//   Author chapter      one file per chapter, in order; status/synopsis/POV
//   Drafter / Inspector the module's text as <module>/<module>.md
//   Chronicler event    one file per event, its dates in the frontmatter
//   Narrator dialogue   description, then the talk rows
//   Scribe session      the messages
//   Diviner table       its entries as a list, ranges or weights first
//   legacy notes        Notes/<title>.md
//
// A relation is `[[Name]]` in the frontmatter, and every [[wikilink]] in the
// text is left exactly as written — Obsidian reads both as links as-is.
// Export only: nothing here reads Markdown back (§11.4).
const { getVaultDB } = require('./core');
const { ENTITY_KINDS } = require('./entity-kinds');
const { writeZip } = require('./zip');

const safeName = (s, fallback = 'untitled') =>
  (String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '') || fallback).slice(0, 120);

// Any YAML scalar as JSON: a double-quoted JSON string is valid YAML, and it
// survives colons, '#', leading dashes and Thai without special cases.
const yv = (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(String(v)));
const link = (name) => `[[${name}]]`;

// frontmatter from [[key, value]]; a value that is an array becomes a list,
// null/'' is left out.
function frontmatter(pairs) {
  const lines = [];
  for (const [k, v] of pairs) {
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const key = /^[\p{L}\p{N}_ -]+$/u.test(k) && !/^\s|\s$/.test(k) ? k : JSON.stringify(k);
    if (Array.isArray(v)) { lines.push(`${key}:`); for (const it of v) lines.push(`  - ${yv(it)}`); }
    else lines.push(`${key}: ${yv(v)}`);
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

const fmtDate = (r) => (r && r.years != null ? `${r.years}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}` : null);

function exportNexusMarkdown(nexusId, zipPath) {
  const d = getVaultDB(nexusId);
  const nx = d.prepare(`SELECT name FROM nexus WHERE id=?`).get(nexusId);
  const root = safeName(nx?.name, 'nexus');

  // key -> display name, through each family's own lookup (§11.2).
  const nameCache = new Map();
  const nameOf = (key) => {
    if (nameCache.has(key)) return nameCache.get(key);
    const m = /^([a-z]+)_(\d+)$/.exec(String(key || ''));
    let name = null;
    if (m && ENTITY_KINDS[m[1]]?.lookup) {
      try { name = d.prepare(ENTITY_KINDS[m[1]].lookup.sql).get(Number(m[2]))?.name ?? null; } catch (_) {}
    }
    nameCache.set(key, name);
    return name;
  };

  // Module folders: the Nest tree, names made unique among siblings.
  const mods = d.prepare(`SELECT id, parent_id, name, kind, handle, description FROM module WHERE nexus_ref=? ORDER BY display_order, id`).all(nexusId);
  const byId = new Map(mods.map((m) => [m.id, m]));
  const folderOf = new Map();
  const taken = new Map(); // folder -> Set(lowercase names)
  const unique = (folder, base, ext = '') => {
    if (!taken.has(folder)) taken.set(folder, new Set());
    const set = taken.get(folder);
    let name = base, n = 2;
    while (set.has(`${name}${ext}`.toLowerCase())) name = `${base} (${n++})`;
    set.add(`${name}${ext}`.toLowerCase());
    return `${name}${ext}`;
  };
  const folder = (m) => {
    if (folderOf.has(m.id)) return folderOf.get(m.id);
    const parent = m.parent_id && byId.get(m.parent_id) ? folder(byId.get(m.parent_id)) : root;
    folderOf.set(m.id, null); // cycle guard: a broken parent chain lands at the root
    const f = `${parent}/${unique(parent, safeName(m.name))}`;
    folderOf.set(m.id, f);
    return f;
  };
  for (const m of mods) folder(m);

  const entries = [];
  const add = (dir, base, text) => entries.push({ name: `${dir}/${unique(dir, safeName(base), '.md')}`, data: text });

  // Relations of one entity, both directions, minus a field's own rows (those
  // are written under the field). Names only: an id means nothing outside.
  const relStmt = d.prepare(`SELECT from_key, to_key, rel_type FROM entity_relation WHERE nexus_ref=? AND (from_key=? OR to_key=?)`);
  const relatedOf = (key) => {
    const out = new Set();
    for (const r of relStmt.all(nexusId, key, key)) {
      if (/^ctpl_\d+$/.test(r.rel_type || '')) continue;
      const other = nameOf(r.from_key === key ? r.to_key : r.from_key);
      if (other) out.add(link(other));
    }
    return [...out];
  };

  // Drafter / Inspector: the module's own text is the content. Any other
  // module with a description keeps it as a folder note of the same name.
  for (const m of mods) {
    if (!m.description && !['drafter', 'inspector'].includes(m.kind)) continue;
    add(folderOf.get(m.id), m.name, frontmatter([['kind', m.kind], ['handle', m.handle], ['related', relatedOf(`module_${m.id}`)]]) + (m.description || ''));
  }

  // Classifier objects.
  const tplStmt = d.prepare(`SELECT id, description, attribute_type, options, object_ref FROM classifier_template WHERE module_ref=? AND (object_ref IS NULL OR object_ref=?) ORDER BY display_order, id`);
  const valStmt = d.prepare(`SELECT template_ref, attribute_value FROM classifier_attribute WHERE object_ref=?`);
  const fieldRelStmt = d.prepare(`SELECT to_key FROM entity_relation WHERE from_key=? AND rel_type=? ORDER BY id`);
  for (const m of mods.filter((x) => x.kind === 'classifier')) {
    for (const o of d.prepare(`SELECT id, name, note FROM classifier_object WHERE module_ref=? ORDER BY display_order, id`).all(m.id)) {
      const vals = new Map(valStmt.all(o.id).map((v) => [v.template_ref, v.attribute_value]));
      const pairs = [['category', link(m.name)]];
      for (const tp of tplStmt.all(m.id, o.id)) {
        const raw = vals.get(tp.id);
        const type = tp.attribute_type || 'text';
        let v;
        if (type === 'relation') v = fieldRelStmt.all(`cobj_${o.id}`, `ctpl_${tp.id}`).map((r) => nameOf(r.to_key)).filter(Boolean).map(link);
        else if (type === 'formula') { // computed in the app; the file keeps the rule
          let expr = ''; try { expr = JSON.parse(tp.options || '{}').expr || ''; } catch (_) {}
          v = expr ? `= ${expr}` : null;
        } else if (raw == null || raw === '') v = null;
        else if (type === 'multi') { try { v = JSON.parse(raw); } catch (_) { v = [raw]; } if (!Array.isArray(v)) v = [String(v)]; }
        else if (type === 'checkbox') v = raw === '1';
        else if (type === 'number' && Number.isFinite(Number(raw))) v = Number(raw);
        else v = raw;
        pairs.push([tp.description, v]);
      }
      pairs.push(['related', relatedOf(`cobj_${o.id}`)]);
      add(folderOf.get(m.id), o.name, frontmatter(pairs) + (o.note || ''));
    }
  }

  // Author chapters, numbered so a file browser keeps the reading order.
  for (const m of mods.filter((x) => x.kind === 'author')) {
    const rows = d.prepare(`SELECT id, name, chapter_label, chapter_content, synopsis, status, pov_key FROM book_chapter WHERE module_ref=? ORDER BY chapter_order, id`).all(m.id);
    const width = String(rows.length).length;
    rows.forEach((c, i) => {
      const pov = c.pov_key ? nameOf(c.pov_key) : null;
      add(folderOf.get(m.id), `${String(i + 1).padStart(width, '0')} ${c.name}`,
        frontmatter([['book', link(m.name)], ['label', c.chapter_label], ['status', c.status], ['synopsis', c.synopsis], ['pov', pov ? link(pov) : null], ['related', relatedOf(`bchp_${c.id}`)]])
        + (c.chapter_content || ''));
    });
  }

  // Scribe sessions.
  for (const m of mods.filter((x) => x.kind === 'scribe')) {
    for (const s of d.prepare(`SELECT id, name FROM chat_session WHERE module_ref=? ORDER BY session_order, id`).all(m.id)) {
      const msgs = d.prepare(`SELECT message, side, create_at FROM chat_message WHERE session_ref=? ORDER BY id`).all(s.id);
      add(folderOf.get(m.id), s.name, frontmatter([['related', relatedOf(`chss_${s.id}`)]])
        + msgs.map((g) => (g.side === 'l' ? `> ${String(g.message).replace(/\n/g, '\n> ')}` : g.message)).join('\n\n'));
    }
  }

  // Chronicler events.
  const dateStmt = d.prepare(`SELECT day, month, years FROM timeline_date WHERE id=?`);
  for (const m of mods.filter((x) => x.kind === 'chronicler')) {
    const rows = d.prepare(`
      SELECT te.id, te.event_name, te.story, te.start_at, te.end_at, tl.line_name FROM timeline_event te
      JOIN timeline tl ON te.timeline_id=tl.id WHERE tl.module_ref=? ORDER BY te.id`).all(m.id);
    for (const e of rows) {
      const start = fmtDate(dateStmt.get(e.start_at));
      const end = e.end_at ? fmtDate(dateStmt.get(e.end_at)) : null;
      add(folderOf.get(m.id), e.event_name || start || 'event',
        frontmatter([['timeline', e.line_name], ['start', start], ['end', end], ['related', relatedOf(`tlev_${e.id}`)]]) + (e.story || ''));
    }
  }

  // Narrator dialogues.
  for (const m of mods.filter((x) => x.kind === 'narrator')) {
    for (const g of d.prepare(`SELECT id, name, description FROM story_dialogue WHERE module_ref=? ORDER BY id`).all(m.id)) {
      const talk = d.prepare(`SELECT speaker, linker_key, talk_sentence, row_type FROM story_talk WHERE dialogue_ref=? ORDER BY talk_order, id`).all(g.id);
      const lines = talk.map((r) => {
        const who = r.linker_key ? nameOf(r.linker_key) : null;
        const sp = who ? link(who) : r.speaker;
        return sp ? `**${sp}:** ${r.talk_sentence || ''}` : (r.talk_sentence || '');
      });
      add(folderOf.get(m.id), g.name,
        frontmatter([['related', relatedOf(`sdlg_${g.id}`)]]) + [g.description, lines.join('\n\n')].filter(Boolean).join('\n\n'));
    }
  }

  // Diviner tables (§11.5): a list a GM can still read at the table.
  for (const m of mods.filter((x) => x.kind === 'diviner')) {
    for (const tb of d.prepare(`SELECT id, name, dice, mode FROM diviner_table WHERE module_ref=? ORDER BY display_order, id`).all(m.id)) {
      const rows = d.prepare(`SELECT weight, range_lo, range_hi, entry_text, linker_key FROM diviner_entry WHERE table_ref=? ORDER BY display_order, id`).all(tb.id);
      const lines = rows.map((e) => {
        const nm = e.linker_key ? nameOf(e.linker_key) : null;
        const text = [e.entry_text, nm ? link(nm) : null].filter(Boolean).join(' ');
        const lead = tb.mode === 'join' ? '' : tb.dice && e.range_lo != null
          ? `${e.range_lo}${e.range_hi != null && e.range_hi !== e.range_lo ? `–${e.range_hi}` : ''}: ` : !tb.dice ? `(${e.weight}) ` : '';
        return `- ${lead}${text}`;
      });
      add(folderOf.get(m.id), tb.name, frontmatter([['dice', tb.dice], ['mode', tb.mode === 'join' ? 'join' : null]]) + lines.join('\n'));
    }
  }

  // Legacy notes (nexus-level).
  for (const n of d.prepare(`SELECT title, content FROM note WHERE nexus_ref=? ORDER BY id`).all(nexusId)) add(`${root}/Notes`, n.title, n.content || '');

  if (!entries.length) return { ok: false, code: 'empty' };
  const out = writeZip(zipPath, entries);
  if (!out.ok) { try { require('fs').rmSync(zipPath, { force: true }); } catch (_) {} return out; }
  return { ok: true, filePath: zipPath, files: entries.length };
}

module.exports = { exportNexusMarkdown };
