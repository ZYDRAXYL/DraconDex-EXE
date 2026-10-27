'use strict';
// ═══ Author — Part dividers (Procress 28 part 5) ═══════════════════════════
// A line between chapters in the chapter column, to split a book into parts
// or leave a note: a plain rule across the column, or a few words in its
// middle with the rule giving way to them (CSS, .au-part).
//
// Stored per Author in module_ui "authorParts" (D1 — no SDB table):
// [{ id, at, label }], `at` = the number of chapters before it. A position,
// not a chapter id: dragging a chapter leaves the parts where they are, and
// there is no id to remap when a snapshot is imported on another device.
// Parts with the same `at` show in array order.

const AUTHOR_PARTS_KEY = 'authorParts';

function authorPartsOf(ui) {
  try {
    const v = JSON.parse(ui?.[AUTHOR_PARTS_KEY] || '[]');
    return Array.isArray(v) ? v.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, at: Math.max(0, p.at | 0), label: String(p.label || '') })) : [];
  } catch (_) { return []; }
}

// The column's rows in order: a part before chapter `at` (past the end =
// after the last chapter), then the chapter.
function authorPartRows(chapters, parts) {
  const n = chapters.length;
  const out = [];
  for (let i = 0; i <= n; i++) {
    for (const p of parts) if (Math.min(p.at, n) === i) out.push({ part: p });
    if (i < n) out.push({ ch: chapters[i], i });
  }
  return out;
}
const authorPartsFromRows = (rows) => {
  let at = 0;
  const parts = [];
  for (const r of rows) { if (r.ch) at++; else parts.push({ ...r.part, at }); }
  return parts;
};
// Move part `id` before/after a row: { ch: chapterId } or { part: partId }.
function authorPartMove(chapters, parts, id, target, before) {
  const rows = authorPartRows(chapters, parts);
  const me = rows.find((r) => r.part?.id === id);
  const rest = rows.filter((r) => r !== me);
  const at = rest.findIndex((r) => (target.ch != null ? r.ch?.id === target.ch : r.part?.id === target.part));
  if (!me || at < 0) return parts;
  rest.splice(before ? at : at + 1, 0, me);
  return authorPartsFromRows(rest);
}
// A chapter at `index` is gone: the parts after it close up by one.
const authorPartsAfterDelete = (parts, index) => parts.map((p) => (p.at > index ? { ...p, at: p.at - 1 } : p));

function authorPartHtml(moduleId, p) {
  return `<div class="au-part" data-part-id="${x(p.id)}" role="separator" tabindex="0" aria-label="${x(p.label || t('auPart'))}"
    onpointerdown="onAuthorPartDown(event,this,${moduleId},${xj(p.id)})" ondblclick="startAuthorPartRename(${moduleId},${xj(p.id)})"
    onkeydown="authorPartKey(event,${moduleId},${xj(p.id)})" title="${x(t('auPartHint'))}">
    ${p.label ? `<span class="au-part-t" data-no-i18n>${x(p.label)}</span>` : ''}
    <button type="button" class="btn btn-g btn-i au-part-x" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation();deleteAuthorPart(${moduleId},${xj(p.id)})" aria-label="${x(t('delete'))}">${I.close}</button>
  </div>`;
}

async function saveAuthorParts(moduleId, parts) {
  const d = S.authorData?.moduleId === moduleId ? S.authorData : AUT.M[moduleId];
  const val = parts.length ? JSON.stringify(parts.map(({ id, at, label }) => ({ id, at, label }))) : '';
  await api.module.setUi(moduleId, AUTHOR_PARTS_KEY, val);
  if (d) { d.parts = parts; if (d.ui) d.ui[AUTHOR_PARTS_KEY] = val; }
  renderNexusHome();
}

// "+ Part": under the open chapter (or at the end), named straight away.
async function addAuthorPart(moduleId) {
  const d = S.authorData;
  const i = d.chapters.findIndex((c) => c.id === d.selectedId);
  const p = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, at: i < 0 ? d.chapters.length : i + 1, label: '' };
  await saveAuthorParts(moduleId, [...(d.parts || []), p]);
  startAuthorPartRename(moduleId, p.id);
}

function startAuthorPartRename(moduleId, id) {
  const row = pbQOr(`.au-part[data-part-id="${CSS.escape(id)}"]`);
  const p = S.authorData?.parts?.find((v) => v.id === id);
  if (!row || !p) return;
  row.querySelector('.au-part-t')?.remove();
  const inp = document.createElement('input');
  inp.className = 'rename-input'; // the Nest's inline rename box (hub/edit.js)
  inp.value = p.label;
  inp.placeholder = t('auPartPlaceholder');
  inp.setAttribute('aria-label', t('auPart'));
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save || inp.value.trim() === p.label) { renderNexusHome(); return; }
    saveAuthorParts(moduleId, S.authorData.parts.map((v) => (v.id === id ? { ...v, label: inp.value.trim() } : v)));
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('pointerdown', (e) => e.stopPropagation());
  row.prepend(inp);
  inp.focus();
}

function deleteAuthorPart(moduleId, id) {
  return saveAuthorParts(moduleId, (S.authorData?.parts || []).filter((p) => p.id !== id));
}

function authorPartKey(ev, moduleId, id) {
  if (ev.target !== ev.currentTarget) return;
  if (ev.key === 'Enter' || ev.key === 'F2') { ev.preventDefault(); startAuthorPartRename(moduleId, id); }
  else if (ev.key === 'Delete') { ev.preventDefault(); deleteAuthorPart(moduleId, id); }
}

// Drag a part among the chapters and the other parts (core/reorder.js).
function onAuthorPartDown(ev, el, moduleId, id) {
  reorderDrag(ev, el, {
    axis: 'y',
    items: () => [...el.parentElement.children].filter((n) => n.dataset.chid != null || n.dataset.partId != null),
    onDrop: async ({ target, before }) => {
      const d = S.authorData;
      const tgt = target.dataset.partId != null ? { part: target.dataset.partId } : { ch: Number(target.dataset.chid) };
      await saveAuthorParts(moduleId, authorPartMove(d.chapters, d.parts || [], id, tgt, before));
    },
  });
}
