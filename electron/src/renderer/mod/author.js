'use strict';
// ═══ Book "Author" (progress.md Phase 11) ═════════════════════════════
// An Author module IS a book (mockup docs/mockups/12-author.png): a
// chapter column on the left and the shared markdown editor
// (src/renderer/mdeditor.js — same component as Drafter/Detail/Scribe,
// with its own Ctrl+E edit/preview toggle, autosave and word count in the
// status bar) on the right. Chapters are wikilink-indexed under the
// bchp_<id> key kind (src/db/author.js + src/db/wiki.js).

const AUTHOR_VIEWS = ['editor', 'board', 'outline', 'reading', 'book'];
const AUTHOR_VIEW_LABEL = { editor: 'Editor', board: 'Board', outline: 'Outline', reading: 'Reading', book: 'Book' };
// v5 Part 8 (§12.3): a scoped page component — data per module, view per
// instance, S.authorData = the current instance (page/kind-state.js).
const AUT = kindState({ prop: 'authorData', kind: 'author', component: 'author.view', views: AUTHOR_VIEWS });
registerComponent('author.view', {
  kind: 'author', label: () => kindLabel('author'), borrow: true,
  presets: () => AUTHOR_VIEWS, presetLabel: (p) => AUTHOR_VIEW_LABEL[p],
  load: (m) => loadAuthorData(m),
  render: (c) => buildAuthorMainHtml(c.source, c),
  mount: () => { mountAuthorEditor(); if (S.authorData?.view === 'book') mountAuthorBook(); },
});

async function loadAuthorData(m) {
  const [chapters, ui] = await Promise.all([
    api.author.getChapters(m.id),
    api.module.getUi(m.id),
  ]);
  const prev = AUT.M[m.id] || null;
  // A [[bchp]] wikilink jump (openEntityByKey) pre-selects its chapter.
  let selectedId = S.pendingAuthorChapter || prev?.selectedId || Number(ui.activeChapter) || null;
  S.pendingAuthorChapter = null;
  if (selectedId && !chapters.find(c => c.id === selectedId)) selectedId = null;
  if (!selectedId && chapters.length) selectedId = chapters[0].id;
  // POV names for the corkboard (v5 Part 7, §11.6) — one round trip.
  const povKeys = [...new Set(chapters.map(c => c.pov_key).filter(Boolean))];
  const povNames = new Map(povKeys.length ? (await api.wiki.resolveKeys(povKeys)).map(r => [r.key, r.name]) : []);
  const pov = await authorPovPeople(m.id, chapters); // mod/author-board.js
  AUT.setModule(m.id, { moduleId: m.id, ui, chapters, selectedId, povNames, pov, parts: authorPartsOf(ui) }); // mod/author-parts.js
}

async function setAuthorView(view) {
  await AUT.setView(view); // the instance's preset (page/kind-state.js)
}

async function selectAuthorChapter(id) {
  const d = S.authorData;
  d.selectedId = id;
  await api.module.setUi(d.moduleId, 'activeChapter', String(id));
  renderNexusHome();
}

// Plan part5 Author #3 · Procress 27: drag to reorder (core/reorder.js) — the
// chapter column ('y') and the corkboard grid ('xy') share this.
function onAuthorChapterDown(ev, el, moduleId, id, axis = 'y') {
  reorderDrag(ev, el, {
    axis,
    items: () => [...el.parentElement.children].filter((n) => n.dataset.chid != null),
    onDrop: async ({ target, before }) => {
      const ids = reorderIds(S.authorData.chapters.map((c) => c.id), id, Number(target.dataset.chid), before);
      if (!ids) return;
      await api.author.moveChapter(moduleId, ids);
      await reloadSource(moduleId);
    },
  });
}

function buildAuthorMainHtml(m, c) {
  const d = AUT.instance(c);
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const viewBar = viewBarHtml(AUTHOR_VIEWS, d.view, v => `setAuthorView('${v}')`, v => AUTHOR_VIEW_LABEL[v]);
  const toolbar = `<div class="classifier-toolbar">
    ${cmdBtn('author.newChapter', { moduleId: m.id }, { cls: 'btn-p' })}
    ${viewBar}
  </div>`;
  if (!d.chapters.length) {
    return toolbar + kindEmptyStateHtml(m);
  }
  // Chapter column (mockup 12) frames every view; the right side swaps.
  // Drag to reorder (core/reorder.js) — chapters don't nest, so no "in" zone.
  // Procress 21: compact rows of the shared list (core/list.js), the drag
  // handle first — where every reorderable list keeps it. F2 = Edit.
  // Procress 28 part 5: Part dividers sit between the rows (mod/author-parts.js).
  const rows = authorPartRows(d.chapters, d.parts || []).map(({ ch: c, i, part }) => (part ? authorPartHtml(m.id, part) : listRowHtml({ density: 'compact', drag: true, state: { selected: c.id === d.selectedId },
    title: `${c.chapter_label || String(i + 1)}. ${c.name}`, onclick: `selectAuthorChapter(${c.id})`,
    attrs: `data-chid="${c.id}" onpointerdown="onAuthorChapterDown(event,this,${m.id},${c.id})"`,
    actions: listActHtml({ icon: I.delete, name: t('delete'), key: 'Delete', danger: true, onclick: `deleteAuthorChapter(${c.id})` }) }))).join('');
  const column = `<div class="author-chapters">
    <div class="au-col-label" data-no-i18n>CHAPTERS · ${x(m.name)}</div>
    ${listHtml({ list: 'author-chapters', aria: m.name, body: rows + listRowHtml({ density: 'compact', icon: I.plus, title: t('writeChapterNew'), cls: 'ls-add', onclick: `newAuthorChapter(${m.id})` })
      + listRowHtml({ density: 'compact', icon: I.plus, title: t('auPartAdd'), cls: 'ls-add', onclick: `addAuthorPart(${m.id})` }) })}
  </div>`;
  // 'book': its own layout (a jump-to-chapter nav, not the select/switch
  // column every other view shares) since all chapters render concatenated.
  if (d.view === 'book') return `${toolbar}${buildAuthorBookHtml(m, d)}`;
  if (d.view === 'board') return `${toolbar}${buildAuthorBoardHtml(m, d)}`; // mod/author-board.js
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
  if (!d || d.view !== 'editor') return;
  const el = pbQOr('#author-editor');
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
  // Procress 28 part 5: the name is typed into where it is shown (Enter /
  // blur saves, Esc puts it back), and the chapter's synopsis and status
  // sit between it and the text — the corkboard's facts, where you write.
  // The chapter number sits before the name and edits the same way.
  const d = S.authorData;
  const no = d.chapters.indexOf(ch) + 1;
  el.innerHTML = `
    <div class="mded-head">
      <input class="mded-title au-title au-no" value="${x(ch.chapter_label || '')}" placeholder="${no}" aria-label="${x(t('chapterLabel'))}" data-no-i18n
        onkeydown="authorTitleKey(event,this,${ch.id},'chapter_label')" onblur="saveAuthorChapterLabel(this,${ch.id})">
      <input class="mded-title au-title" value="${x(ch.name)}" aria-label="${x(t('name'))}" data-no-i18n
        onkeydown="authorTitleKey(event,this,${ch.id})" onblur="saveAuthorTitle(this,${ch.id})">
      <span class="au-stats" id="au-stats" data-no-i18n></span>
      <span class="mded-save-state" id="au-save-state"></span>
    </div>
    <div class="au-meta">
      <div class="au-meta-side">
      <div class="au-meta-pov">${authorPovSelectHtml(d, ch, 'au-meta-povsel')}${d.pov?.linked ? '' : `<button type="button" class="btn btn-g btn-i" title="${x(t('auPovNoLink'))}" aria-label="${x(t('auPovNoLink'))}" onclick="openPageLinksPopup(${d.moduleId},document.querySelector('.ph-links-open'))">${I.relation}</button>`}</div>
      <select class="au-meta-status" aria-label="${x(t('auStatus'))}" onchange="saveAuthorChapterMeta(${ch.id},{status:this.value})">
        <option value="">${t('auStatus')} —</option>
        ${AUTHOR_STATUSES.map((s) => `<option value="${s}"${ch.status === s ? ' selected' : ''}>${t(AUTHOR_STATUS_KEY[s])}</option>`).join('')}
      </select>
      </div>
      <div class="au-meta-synwrap${authorSynFolded() ? ' folded' : ''}">
      <button type="button" class="btn btn-g btn-i au-syn-fold" aria-expanded="${!authorSynFolded()}" title="${x(t('auSynFold'))}" aria-label="${x(t('auSynFold'))}" onclick="toggleAuthorSynFold(this)">${I.chevronDown}</button>
      <textarea class="au-meta-syn" rows="1" placeholder="${x(t('auSynopsis'))}" aria-label="${x(t('auSynopsis'))}"
        oninput="clearTimeout(this._t);this._t=setTimeout(()=>saveAuthorChapterMeta(${ch.id},{synopsis:this.value}),600)"
        onchange="clearTimeout(this._t);saveAuthorChapterMeta(${ch.id},{synopsis:this.value})">${x(ch.synopsis || '')}</textarea>
      </div>
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
  // Words / characters / pages: this chapter, and the whole book in words.
  const statsEl = el.querySelector('#au-stats');
  const others = d.chapters.reduce((n, c) => n + (c === ch ? 0 : authorTextStats(authorPlainText(c.chapter_content)).words), 0);
  const showStats = () => {
    const s = authorTextStats(authorPlainText(body.innerHTML));
    const f = (n) => n.toLocaleString();
    statsEl.textContent = `${f(s.words)} ${t('auWords')} · ${f(s.chars)} ${t('auChars')} · ${f(s.pages)} ${t('auPages')} · ${t('auBookTotal')} ${f(others + s.words)} ${t('auWords')}`;
  };
  showStats();

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
    showStats(); // with the save, not per keystroke — segmenting is the slow part
  };
  const scheduleSave = () => {
    if (saveState) saveState.textContent = '…';
    clearTimeout(_authorSaveTimer);
    _authorSaveTimer = setTimeout(doSave, 800);
  };
  body.addEventListener('input', scheduleSave);
}

// Synopsis folded to one line — a per-machine view preference, not vault data.
function authorSynFolded() {
  try { return localStorage.getItem('ddx.auSynFolded') === '1'; } catch { return false; }
}
function toggleAuthorSynFold(btn) {
  const wrap = btn.closest('.au-meta-synwrap');
  const folded = wrap.classList.toggle('folded');
  btn.setAttribute('aria-expanded', String(!folded));
  try { localStorage.setItem('ddx.auSynFolded', folded ? '1' : '0'); } catch { /* private window */ }
}

function authorTitleKey(ev, inp, id, field = 'name') {
  if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
  else if (ev.key === 'Escape') {
    ev.preventDefault();
    const ch = S.authorData?.chapters.find((c) => c.id === id);
    if (ch) inp.value = ch[field] || '';
    inp.blur();
  }
}
// The chapter column shows "<number>. <name>" — redraw that row, not the editor.
function authorRefreshRow(ch) {
  const row = pbQOr(`.author-chapters [data-chid="${ch.id}"] .ls-title`);
  if (row) row.textContent = `${ch.chapter_label || String(S.authorData.chapters.indexOf(ch) + 1)}. ${ch.name}`;
}
async function saveAuthorChapterLabel(inp, id) {
  const ch = S.authorData?.chapters.find((c) => c.id === id);
  const label = inp.value.trim();
  if (!ch || label === (ch.chapter_label || '')) return;
  ch.chapter_label = label;
  await api.author.setChapterLabel(id, label);
  invalidateNestItems(S.authorData.moduleId, 0);
  authorRefreshRow(ch);
}
async function saveAuthorTitle(inp, id) {
  const ch = S.authorData?.chapters.find((c) => c.id === id);
  const name = inp.value.trim();
  if (!ch || !name || name === ch.name) { if (ch) inp.value = ch.name; return; }
  ch.name = name;
  await api.author.renameChapter(id, name);
  invalidateNestItems(S.authorData.moduleId, 0);
  authorRefreshRow(ch);
}

// Plain text of a chapter (HTML or legacy Markdown) for counting.
const authorPlainText = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z0-9#]+;/gi, ' ');
// Intl.Segmenter splits Thai (no spaces) into words too.
// ponytail: a page = 250 words, the usual manuscript estimate; a setting if writers ask for their own.
const AUTHOR_WORDS_PER_PAGE = 250;
const _authorSeg = new Intl.Segmenter(undefined, { granularity: 'word' });
function authorTextStats(text) {
  let words = 0;
  for (const seg of _authorSeg.segment(text)) if (seg.isWordLike) words++;
  return { words, chars: text.replace(/\s/g, '').length, pages: Math.ceil(words / AUTHOR_WORDS_PER_PAGE) };
}

// ── Outline view: markdown headings across every chapter ────────────────
function buildAuthorOutlineHtml(d) {
  let html = '';
  const partsAt = (i) => (d.parts || []).filter((p) => Math.min(p.at, d.chapters.length) === i)
    .map((p) => `<div class="au-outline-part" data-no-i18n>${x(p.label || '—')}</div>`).join('');
  for (const [i, c] of d.chapters.entries()) {
    html += partsAt(i);
    const heads = [...String(c.chapter_content || '').matchAll(/^(#{1,4})\s+(.+)$/gm)]
      .map(mm => ({ depth: mm[1].length, text: mm[2].trim() }));
    html += `<div class="au-outline-sec">
      <div class="au-outline-ch" onclick="selectAuthorChapter(${c.id}).then(()=>setAuthorView('editor'))">${x(c.chapter_label || String(i + 1))}. ${x(c.name)}</div>
      ${heads.map(h2 => `<div class="au-outline-h" style="padding-left:${h2.depth * 14}px">${x(h2.text)}</div>`).join('')
        || `<div class="au-outline-h ghost" data-no-i18n>—</div>`}
    </div>`;
  }
  html += partsAt(d.chapters.length);
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
  const navRows = listHtml({ list: 'author-book', aria: m.name, body: d.chapters.map((c, i) => listRowHtml({ density: 'compact',
    title: `${c.chapter_label || String(i + 1)}. ${c.name}`, onclick: `scrollToAuthorBookChapter(${c.id})`, attrs: 'data-no-i18n' })).join('') });
  return `<div class="author-layout">
    <div class="author-chapters">
      <div class="au-col-label" data-no-i18n>CHAPTERS · ${x(m.name)}</div>
      ${navRows}
      <button class="btn btn-s au-book-export" onclick="openExportModal(${m.id})">${I.export} ${t('exportTitle')}</button>
    </div>
    <div class="author-main au-book-pages" id="au-book-host">
      <div class="empty" style="padding:30px"><p>…</p></div>
    </div>
  </div>`;
}

function scrollToAuthorBookChapter(chapterId) {
  pbQOr(`#au-book-ch-${chapterId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Paginates every chapter's (looksHtml-aware) content into fixed-height
// "page" divs — plain DOM measurement via an offscreen probe container, no
// pagination library. Forced page break at each chapter boundary; within a
// chapter, a new page starts whenever the next node would overflow the
// page box (checked via scrollHeight against the box's fixed height).
async function mountAuthorBook() {
  const d = S.authorData;
  const host = pbQOr('#au-book-host');
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

  // Procress 28 part 5: a Part with a name opens its own page in the book
  const partPages = (i) => {
    for (const p of (d.parts || []).filter((v) => v.label && Math.min(v.at, d.chapters.length) === i)) {
      if (page.childNodes.length) startPage();
      const h = document.createElement('h1');
      h.className = 'au-book-part';
      h.textContent = p.label;
      appendNode(h);
    }
  };
  for (const [i, ch] of d.chapters.entries()) {
    partPages(i);
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
  partPages(d.chapters.length);
  if (page.childNodes.length) pages.push(page);
  document.body.removeChild(measure);

  host.innerHTML = pages.length
    ? pages.map(p => `<div class="au-book-page">${p.innerHTML}</div>`).join('')
    : `<div class="empty" style="padding:30px"><p>${t('nestEmpty')}</p></div>`;
}

// ── Chapter CRUD ────────────────────────────────────────────────────────
// No modal: a new chapter is made at once and its name opens for typing —
// on the board in its card, everywhere else in the editor.
async function newAuthorChapter(moduleId) {
  const id = await api.author.createChapter(moduleId, t('auUntitled'));
  await api.module.setUi(moduleId, 'activeChapter', String(id));
  const d = S.authorData?.moduleId === moduleId ? S.authorData : null;
  if (d) {
    d.selectedId = id;
    if (d.view !== 'editor' && d.view !== 'board') await setAuthorView('editor');
  }
  invalidateNestItems(moduleId, 1); // queues a render — before ours, or it re-renders past the focus below
  await reloadSource(moduleId);
  const inp = pbQOr(`.au-card[data-chid="${id}"] .au-card-name`) || pbQOr('#author-editor .au-title:not(.au-no)');
  inp?.focus();
  inp?.select();
}

// The board's open button: that chapter, in the editor.
async function openAuthorChapterInEditor(id) {
  await selectAuthorChapter(id);
  await setAuthorView('editor');
}

async function deleteAuthorChapter(id) {
  if (!await uiConfirm(t('confirmDeleteItem'))) return;
  await api.author.deleteChapter(id);
  const d = S.authorData;
  const at = d.chapters.findIndex((c) => c.id === id);
  if (at >= 0 && d.parts?.length) await saveAuthorParts(d.moduleId, authorPartsAfterDelete(d.parts, at));
  if (d.selectedId === id) d.selectedId = null;
  await reloadSource(d.moduleId);
  invalidateNestItems(d.moduleId, -1);
  toast(t('deleted'), 'ok');
}
