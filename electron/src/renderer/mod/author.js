'use strict';
// ═══ Book "Author" (progress.md Phase 11) ═════════════════════════════
// An Author module IS a book (mockup docs/mockups/12-author.png): a
// chapter column on the left and the shared markdown editor
// (src/renderer/mdeditor.js — same component as Drafter/Detail/Scribe,
// with its own Ctrl+E edit/preview toggle, autosave and word count in the
// status bar) on the right. Chapters are wikilink-indexed under the
// bchp_<id> key kind (src/db/author.js + src/db/wiki.js).

const AUTHOR_VIEWS = ['editor', 'outline', 'reading', 'book'];
const AUTHOR_VIEW_LABEL = { editor: 'Editor', outline: 'Outline', reading: 'Reading', book: 'Book' };

async function loadAuthorData(m) {
  const [chapters, ui] = await Promise.all([
    api.author.getChapters(m.id),
    api.module.getUi(m.id),
  ]);
  const prev = (S.authorData && S.authorData.moduleId === m.id) ? S.authorData : null;
  // A [[bchp]] wikilink jump (openEntityByKey) pre-selects its chapter.
  let selectedId = S.pendingAuthorChapter || prev?.selectedId || Number(ui.activeChapter) || null;
  S.pendingAuthorChapter = null;
  if (selectedId && !chapters.find(c => c.id === selectedId)) selectedId = null;
  if (!selectedId && chapters.length) selectedId = chapters[0].id;
  const view = AUTHOR_VIEWS.includes(ui.activeView) ? ui.activeView : 'editor';
  S.authorData = { moduleId: m.id, chapters, selectedId, view };
}

async function setAuthorView(view) {
  const d = S.authorData;
  d.view = view;
  await api.module.setUi(d.moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === d.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

async function selectAuthorChapter(id) {
  const d = S.authorData;
  d.selectedId = id;
  await api.module.setUi(d.moduleId, 'activeChapter', String(id));
  renderNexusHome();
}

// Plan part5 Author #3: native HTML5 drag-and-drop reorder — chapters don't
// nest, so this only needs a before/after split (reusing the generic
// .li.drop-before/.drop-after classes hub.js's module tree already defines
// in style.css), not hub.js's 3-zone before/after/in version.
function onAuthorChapterDragStart(ev, id) {
  S.dragAuthorChapter = id;
  ev.dataTransfer.effectAllowed = 'move';
  ev.stopPropagation();
}
function onAuthorChapterDragOver(ev, row) {
  if (S.dragAuthorChapter == null) return;
  ev.preventDefault();
  ev.stopPropagation();
  const r = row.getBoundingClientRect();
  const before = (ev.clientY - r.top) / r.height < 0.5;
  row.classList.remove('drop-before', 'drop-after');
  row.classList.add(before ? 'drop-before' : 'drop-after');
}
async function onAuthorChapterDrop(ev, moduleId, targetId) {
  ev.preventDefault();
  ev.stopPropagation();
  const row = ev.currentTarget;
  const before = row.classList.contains('drop-before');
  row.classList.remove('drop-before', 'drop-after');
  const dragId = S.dragAuthorChapter;
  S.dragAuthorChapter = null;
  if (dragId == null || dragId === targetId) return;
  const d = S.authorData;
  const ids = d.chapters.map(c => c.id).filter(id => id !== dragId);
  const idx = ids.indexOf(targetId);
  ids.splice(before ? idx : idx + 1, 0, dragId);
  await api.author.moveChapter(moduleId, ids);
  await openModuleNode(moduleId);
}

function buildAuthorMainHtml(m) {
  const d = (S.authorData && S.authorData.moduleId === m.id) ? S.authorData : null;
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const viewBar = `<div class="viewbar">
    ${AUTHOR_VIEWS.map(v => `<span class="vitem${v === d.view ? ' act' : ''}" onclick="setAuthorView('${v}')">${AUTHOR_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <button class="btn btn-p" onclick="openAuthorChapterModal(${m.id})">${I.plus} ${t('writeChapterNew')}</button>
    ${viewBar}
  </div>`;
  if (!d.chapters.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div>
      <h3>${x(m.name)}</h3><p>${t('nestEmpty')}</p></div>`;
  }
  // Chapter column (mockup 12) frames every view; the right side swaps.
  // Native HTML5 drag-and-drop (Plan part5 Author #3) — a 2-zone
  // before/after split since chapters don't nest, smaller than hub.js's
  // 3-zone module-tree version.
  const rows = d.chapters.map((c, i) => `
    <div class="li${c.id === d.selectedId ? ' sel' : ''}" onclick="selectAuthorChapter(${c.id})"
      draggable="true" ondragstart="onAuthorChapterDragStart(event,${c.id})" ondragover="onAuthorChapterDragOver(event,this)" ondragleave="this.classList.remove('drop-before','drop-after')" ondrop="onAuthorChapterDrop(event,${m.id},${c.id})">
      <span class="name">${x(c.chapter_label || String(i + 1))}. ${x(c.name)}</span>
      <span class="acts">
        <button class="btn btn-g btn-i" onclick="event.stopPropagation();openAuthorChapterModal(${m.id},${c.id})" title="${t('edit')}">${I.edit}</button>
      </span>
    </div>`).join('');
  const column = `<div class="author-chapters">
    <div class="au-col-label" data-no-i18n>CHAPTERS · ${x(m.name)}</div>
    ${rows}
    <div class="li au-add" onclick="openAuthorChapterModal(${m.id})">${I.plus}<span class="name">${t('writeChapterNew')}</span></div>
  </div>`;
  // 'book': its own layout (a jump-to-chapter nav, not the select/switch
  // column every other view shares) since all chapters render concatenated.
  if (d.view === 'book') return `${toolbar}${buildAuthorBookHtml(m, d)}`;
  let body;
  if (d.view === 'outline') body = buildAuthorOutlineHtml(d);
  else if (d.view === 'reading') body = buildAuthorReadingHtml(d);
  else body = `<div id="author-editor" class="scribe-editor au-editor"></div>`;
  return `${toolbar}<div class="author-layout">${column}<div class="author-main">${body}</div></div>`;
}

// Post-DOM hook (registered in renderNexusHome): mounts the Author-only
// rich-text (contenteditable) editor for the selected chapter.
function mountAuthorEditor() {
  const d = S.authorData;
  if (!d || S.activeModuleNode?.id !== d.moduleId || d.view !== 'editor') return;
  const el = q('#author-editor');
  const ch = d.chapters.find(c => c.id === d.selectedId);
  if (!el || !ch) return;
  mountAuthorRichEditor(el, ch);
}

// A chapter predating this change is plain Markdown text; anything saved
// through this editor is real HTML. This heuristic tells the two apart
// everywhere chapter_content is displayed (editor load, Reading view, Book
// view) — ponytail: simplest signal that works, not a stored flag.
function authorLooksHtml(content) {
  return /^\s*</.test(content || '');
}
// The HTML branch is sanitized (sanitize.js) because chapter_content is not
// necessarily locally authored — it also arrives via an imported .db or a
// pulled sync vault, and this is the one place stored markup reaches
// innerHTML unescaped. The markdown branch needs no filter; mdRender escapes
// everything on the way through.
function authorContentAsHtml(content) {
  return authorLooksHtml(content)
    ? sanitizeHtml(content || '')
    : mdRender(content || '', { resolveLink: typeof resolveWikiNameCached === 'function' ? resolveWikiNameCached : null });
}

// Plan part5 Author #1/#2: real contenteditable WYSIWYG surface (not the
// shared mdeditor.js textarea — that stays untouched for Drafter/others).
// document.execCommand is the pragmatic, no-new-dependency way to get real
// bold/underline/italic/strike/superscript/alignment without a rich-text
// editor library.
const AUTHOR_FMT_ACTIONS = [
  ['B', 'bold'], ['U', 'underline'], ['I', 'italic'], ['S', 'strikeThrough'], ['x²', 'superscript'],
];
const AUTHOR_ALIGN_ACTIONS = [
  ['⟸', 'justifyLeft'], ['≡', 'justifyCenter'], ['⟹', 'justifyRight'], ['☰', 'justifyFull'],
];
let _authorSaveTimer = null;

function mountAuthorRichEditor(el, ch) {
  el.innerHTML = `
    <div class="mded-head">
      <span class="mded-title">${x(ch.name)}</span>
      <span class="mded-save-state" id="au-save-state"></span>
    </div>
    <div class="au-rich-toolbar" data-no-i18n>
      ${AUTHOR_FMT_ACTIONS.map(([label, cmd]) => `<button type="button" class="btn btn-s btn-sm" data-cmd="${cmd}">${label}</button>`).join('')}
      <span class="au-rich-sep"></span>
      ${AUTHOR_ALIGN_ACTIONS.map(([label, cmd]) => `<button type="button" class="btn btn-s btn-sm" data-cmd="${cmd}">${label}</button>`).join('')}
    </div>
    <div class="au-rich-body" contenteditable="true"></div>`;
  const body = el.querySelector('.au-rich-body');
  const saveState = el.querySelector('#au-save-state');
  body.innerHTML = authorContentAsHtml(ch.chapter_content);

  el.querySelector('.au-rich-toolbar').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (!btn) return;
    e.preventDefault(); // keep the contenteditable selection alive
    document.execCommand(btn.dataset.cmd);
    body.dispatchEvent(new Event('input'));
  });

  body.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { // contenteditable's default Tab shifts focus away
      e.preventDefault();
      document.execCommand('insertHTML', false, '&emsp;');
    }
  });

  const doSave = async () => {
    // Sanitize on the way OUT as well as in: a paste into the contenteditable
    // brings the source document's markup with it, so this is what keeps a
    // payload from being written to the DB in the first place.
    const clean = sanitizeHtml(body.innerHTML);
    await api.author.updateContent(ch.id, clean);
    ch.chapter_content = clean;
    if (saveState) saveState.textContent = t('saved');
  };
  const scheduleSave = () => {
    if (saveState) saveState.textContent = '…';
    clearTimeout(_authorSaveTimer);
    _authorSaveTimer = setTimeout(doSave, 800);
  };
  body.addEventListener('input', scheduleSave);
}

// ── Outline view: markdown headings across every chapter ────────────────
function buildAuthorOutlineHtml(d) {
  let html = '';
  for (const [i, c] of d.chapters.entries()) {
    const heads = [...String(c.chapter_content || '').matchAll(/^(#{1,4})\s+(.+)$/gm)]
      .map(mm => ({ depth: mm[1].length, text: mm[2].trim() }));
    html += `<div class="au-outline-sec">
      <div class="au-outline-ch" onclick="selectAuthorChapter(${c.id}).then(()=>setAuthorView('editor'))">${x(c.chapter_label || String(i + 1))}. ${x(c.name)}</div>
      ${heads.map(h2 => `<div class="au-outline-h" style="padding-left:${h2.depth * 14}px">${x(h2.text)}</div>`).join('')
        || `<div class="au-outline-h ghost" data-no-i18n>—</div>`}
    </div>`;
  }
  return `<div class="au-outline">${html}</div>`;
}

// ── Reading view: rendered content of the selected chapter ──────────────
function buildAuthorReadingHtml(d) {
  const ch = d.chapters.find(c => c.id === d.selectedId);
  if (!ch) return '';
  return `<div class="au-reading md-preview">${authorContentAsHtml(ch.chapter_content)}</div>`;
}

// ── Book view: all chapters concatenated + paginated, .doc export ──────
// (Plan part5 Author #5)
function buildAuthorBookHtml(m, d) {
  const navRows = d.chapters.map((c, i) => `
    <div class="li" onclick="scrollToAuthorBookChapter(${c.id})">
      <span class="name">${x(c.chapter_label || String(i + 1))}. ${x(c.name)}</span>
    </div>`).join('');
  return `<div class="author-layout">
    <div class="author-chapters">
      <div class="au-col-label" data-no-i18n>CHAPTERS · ${x(m.name)}</div>
      ${navRows}
      <button class="btn btn-s au-book-export" onclick="exportAuthorBookDoc(${m.id})">${I.document} ${t('exportDoc')}</button>
    </div>
    <div class="author-main au-book-pages" id="au-book-host">
      <div class="empty" style="padding:30px"><p>…</p></div>
    </div>
  </div>`;
}

function scrollToAuthorBookChapter(chapterId) {
  q(`#au-book-ch-${chapterId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Paginates every chapter's (looksHtml-aware) content into fixed-height
// "page" divs — plain DOM measurement via an offscreen probe container, no
// pagination library. Forced page break at each chapter boundary; within a
// chapter, a new page starts whenever the next node would overflow the
// page box (checked via scrollHeight against the box's fixed height).
async function mountAuthorBook() {
  const d = S.authorData;
  const host = q('#au-book-host');
  if (!d || !host) return;

  const measure = document.createElement('div');
  measure.className = 'au-book-page au-book-measure';
  document.body.appendChild(measure);

  const pages = [];
  let page = document.createElement('div');
  page.className = 'au-book-page';

  const startPage = () => {
    if (page.childNodes.length) pages.push(page);
    page = document.createElement('div');
    page.className = 'au-book-page';
    measure.innerHTML = '';
  };

  const appendNode = (node) => {
    const probe = node.cloneNode(true);
    measure.appendChild(probe);
    if (measure.scrollHeight > measure.clientHeight && page.childNodes.length > 0) {
      startPage();
      measure.appendChild(probe);
    }
    page.appendChild(node);
  };

  for (const ch of d.chapters) {
    if (page.childNodes.length) startPage(); // forced break at each chapter
    const header = document.createElement('h2');
    header.className = 'au-book-chapter-h';
    header.id = `au-book-ch-${ch.id}`;
    header.textContent = `${ch.chapter_label ? ch.chapter_label + '. ' : ''}${ch.name}`;
    appendNode(header);

    const wrap = document.createElement('div');
    wrap.innerHTML = authorContentAsHtml(ch.chapter_content);
    for (const node of Array.from(wrap.childNodes)) appendNode(node);
  }
  if (page.childNodes.length) pages.push(page);
  document.body.removeChild(measure);

  host.innerHTML = pages.length
    ? pages.map(p => `<div class="au-book-page">${p.innerHTML}</div>`).join('')
    : `<div class="empty" style="padding:30px"><p>${t('nestEmpty')}</p></div>`;
}

async function exportAuthorBookDoc(moduleId) {
  const d = S.authorData;
  const m = findModuleNode(moduleId);
  const html = d.chapters.map(ch =>
    `<h2>${x(ch.chapter_label ? ch.chapter_label + '. ' : '')}${x(ch.name)}</h2>${authorContentAsHtml(ch.chapter_content)}`
  ).join('<br clear="all" style="page-break-before:always">');
  const res = await api.author.exportDoc(m?.name || 'book', html);
  if (!res?.canceled) toast(t('saved'), 'ok');
}

// ── Chapter CRUD ────────────────────────────────────────────────────────
async function openAuthorChapterModal(moduleId, id = null) {
  const ch = id ? S.authorData?.chapters.find(c => c.id === id) : null;
  openModal(ch ? t('moduleEdit') : t('writeChapterNew'), `
    <div class="fg"><label>${t('name')} *</label><input id="ac-name" value="${x(ch?.name || '')}"></div>
    ${ch ? `<div class="fg"><label>${t('chapterLabel')}</label><input id="ac-label" value="${x(ch?.chapter_label || '')}"></div>` : ''}
    <div class="mfoot">
      ${ch ? `<button class="btn btn-d" onclick="deleteAuthorChapter(${ch.id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitAuthorChapter(${moduleId},${ch ? ch.id : 'null'})">${ch ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#ac-name').focus(), 60);
}

async function submitAuthorChapter(moduleId, id) {
  const name = q('#ac-name').value.trim();
  if (!name) return;
  if (id) {
    await api.author.renameChapter(id, name);
    const label = q('#ac-label')?.value.trim() || '';
    const ch = S.authorData?.chapters.find(c => c.id === id);
    if (label !== (ch?.chapter_label || '')) {
      await api.author.setChapterLabel(id, label);
      if (ch) ch.chapter_label = label;
    }
  } else {
    const newId = await api.author.createChapter(moduleId, name);
    S.authorData.selectedId = newId;
  }
  closeModal();
  await openModuleNode(moduleId);
  invalidateNestItems(moduleId, id ? 0 : 1);
  toast(id ? t('saved') : t('created'), 'ok');
}

async function deleteAuthorChapter(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.author.deleteChapter(id);
  closeModal();
  const d = S.authorData;
  if (d.selectedId === id) d.selectedId = null;
  await openModuleNode(d.moduleId);
  invalidateNestItems(d.moduleId, -1);
  toast(t('deleted'), 'ok');
}
