'use strict';
// ═══ Author — corkboard (v5 Part 7, APP docs/V5.md §11.6) ════════════════
// The corkboard / beat-sheet the user chose to fold into Author rather than
// build as a module: every chapter as an index card with the three facts a
// planner moves around — its synopsis, where it stands (idea → done), and
// whose point of view it is told from (pov_key: any entity, usually a
// Classifier character). Cards reorder by drag, with the same handler as
// the chapter column; a card's synopsis edits in place.

const AUTHOR_STATUSES = ['idea', 'draft', 'revised', 'done'];
const AUTHOR_STATUS_KEY = { idea: 'auStatusIdea', draft: 'auStatusDraft', revised: 'auStatusRevised', done: 'auStatusDone' };

function buildAuthorBoardHtml(m, d) {
  const cards = d.chapters.map((c, i) => {
    return `<div class="au-card${c.id === d.selectedId ? ' sel' : ''}" data-status="${x(c.status || '')}"
      data-chid="${c.id}" onpointerdown="onAuthorChapterDown(event,this,${m.id},${c.id},'xy')">
      <div class="au-card-head">
        <input class="au-card-no" value="${x(c.chapter_label || '')}" placeholder="${i + 1}" aria-label="${x(t('chapterLabel'))}" data-no-i18n
          onkeydown="authorTitleKey(event,this,${c.id},'chapter_label')" onblur="saveAuthorChapterLabel(this,${c.id})">
        <input class="au-card-name" value="${x(c.name)}" aria-label="${x(t('name'))}" data-no-i18n
          onkeydown="authorTitleKey(event,this,${c.id})" onblur="saveAuthorTitle(this,${c.id})">
        <button class="btn btn-g btn-i" onclick="openAuthorChapterInEditor(${c.id})" title="${x(t('open'))}" aria-label="${x(t('open'))}">${I.edit}</button>
      </div>
      <textarea class="au-card-syn" rows="4" placeholder="${x(t('auSynopsis'))}" onchange="saveAuthorChapterMeta(${c.id},{synopsis:this.value})">${x(c.synopsis || '')}</textarea>
      <div class="au-card-foot">
        <select class="au-card-status" onchange="saveAuthorChapterMeta(${c.id},{status:this.value},true)">
          <option value="">—</option>
          ${AUTHOR_STATUSES.map(s => `<option value="${s}"${c.status === s ? ' selected' : ''}>${t(AUTHOR_STATUS_KEY[s])}</option>`).join('')}
        </select>
        ${authorPovSelectHtml(d, c, 'au-card-status au-card-pov')}
      </div>
    </div>`;
  }).join('');
  const counts = AUTHOR_STATUSES.map(s => [s, d.chapters.filter(c => c.status === s).length]).filter(([, n]) => n);
  return `${counts.length ? `<div class="au-board-sum">${counts.map(([s, n]) => `<span class="au-status-pill" data-status="${s}">${t(AUTHOR_STATUS_KEY[s])} <b data-no-i18n>${n}</b></span>`).join('')}</div>` : ''}
    <div class="au-board">${cards}
      <div class="au-card au-card-add" onclick="newAuthorChapter(${m.id})">${I.plus}<span>${t('writeChapterNew')}</span></div>
    </div>`;
}

// One field at a time from the board; `repaint` when the card's look changes.
async function saveAuthorChapterMeta(id, meta, repaint = false) {
  await api.author.setChapterMeta(id, meta);
  const c = S.authorData?.chapters.find(ch => ch.id === id);
  if (c) {
    if ('synopsis' in meta) c.synopsis = meta.synopsis;
    if ('status' in meta) c.status = meta.status || null;
    if ('povKey' in meta) c.pov_key = meta.povKey || null;
  }
  if (repaint) renderNexusHome();
}

// Point-of-view choices, loaded with the Author (mod/author.js).
// Procress 28 part 5: the point of view is an object of a Classifier this
// Author is linked to (api.module.linked — the page head's 🔗, or a
// [[link]]), not any object in the Nexus. One already set elsewhere stays
// listed, so a chapter's choice never drops silently.
async function authorPovPeople(moduleId, chapters) {
  const [idx, linked] = await Promise.all([S.nexus ? api.viewer.index(S.nexus.id) : [], api.module.linked(moduleId)]);
  const from = new Set(linked.map((e) => e.id).filter((id) => findModuleNode(id)?.kind === 'classifier'));
  const used = new Set(chapters.map((c) => c.pov_key).filter(Boolean));
  return { linked: from.size > 0, people: idx.filter((e) => e.kind === 'object' && (from.has(e.moduleId) || used.has(e.key))) };
}

function authorPovSelectHtml(d, ch, cls) {
  const people = d.pov?.people || [];
  return `<select class="${cls}" aria-label="${x(t('auPov'))}" title="${x(d.pov?.linked ? t('auPov') : t('auPovNoLink'))}"
    onchange="saveAuthorChapterMeta(${ch.id},{povKey:this.value})">
    <option value="">${t('auPov')} —</option>
    ${people.map((e) => `<option value="${x(e.key)}"${e.key === ch.pov_key ? ' selected' : ''}>${x(e.name)}${e.moduleName ? ` — ${x(e.moduleName)}` : ''}</option>`).join('')}
  </select>`;
}
