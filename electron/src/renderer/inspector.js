'use strict';
// ═══ Module Inspector (progress.md Phase 4) ═══════════════════════════
// Docked right-side panel for the focused module (a Major module, at any
// depth): detail spec
// (kind + free-text description, wikilink-aware), free-form attributes,
// tag links, module links (outgoing/backlinks via the generic wiki_link
// index — see src/db/wiki.js's `module_<id>` key kind), and a Version
// History entry point (the real history is Phase 21).

// One composite read instead of the four parallel round-trips this used to
// make (Plan part2 #2.1) — src/db/module.js's getModuleInspector returns the
// same {attrs,tags,links,ui} keys, which hub.js / mod/classifier.js /
// mod/manager.js all read (and patch) off S.inspectorData directly.
async function loadInspectorData(moduleId) {
  const d = await api.module.getInspector(moduleId);
  S.inspectorData = { moduleId, ...d };
}

function buildInspectorHtml(m) {
  // A plugin panel replaces the inspector dock while open (v4.3.0) — checked
  // before Version History so an explicitly opened panel wins over a version
  // panel left open on the same module.
  if (S.pluginPanel?.moduleId === m.id && typeof buildPluginPanelHtml === 'function') {
    const html = buildPluginPanelHtml(m);
    if (html) return html;
  }
  // Version History panel replaces the inspector dock while open (Phase 21).
  if (S.versionPanel?.moduleId === m.id && typeof buildVersionPanelHtml === 'function') {
    return buildVersionPanelHtml(m);
  }
  const d = (S.inspectorData && S.inspectorData.moduleId === m.id) ? S.inspectorData : { attrs: [], tags: [], links: { outgoing: [], backlinks: [] }, ui: {} };
  return `<aside class="module-inspector" style="width:${S.inspectorWidth}px">
    <div class="insp-head">${I.fields}<span>${t('moduleInspector')} — ${x(m.name)}</span></div>

    <div class="insp-label">${t('moduleDetailSpec')}</div>
    <div class="prop"><span class="pk">${t('moduleKind')}</span><span class="pv" data-no-i18n>${x(kindLabel(m.kind))}</span></div>
    ${m.kind === 'inspector'
      ? `<div class="insp-desc-wrap insp-desc-static">
          ${m.description ? `<div class="md-preview">${mdRender(m.description)}</div>` : `<p class="pv ghost">${t('addDetail')}</p>`}
          <p class="insp-desc-hint">${t('inspectorDescEditElsewhere')}</p>
        </div>`
      : `<div class="insp-desc-wrap"><div id="insp-desc-editor" class="insp-desc-editor"></div></div>`}
    <div class="prop"><span class="pk">${t('tagLink')}</span></div>
    <div class="insp-chips" id="insp-tag-chips">
      ${d.tags.map(tg => `<span class="htag" style="border-color:${x(tg.color_code || '#6366f1')};color:${x(tg.color_code || '#6366f1')}">#${x(tg.tag_name)}</span>`).join('')}
      <button class="btn btn-g btn-i" onclick="openModuleTagPopup(${m.id}, this)" title="${t('tagLink')}">${I.plus}</button>
    </div>

    <div class="insp-label">${t('moduleAttribute')}</div>
    ${d.attrs.map(a => `
      <div class="prop insp-attr">
        <span class="pk">${x(a.attr_name)}</span><span class="pv">${x(a.attr_value || '')}</span>
        <span class="acts">
          <button class="btn btn-g btn-i" onclick="openAttrModal(${m.id},${a.id})" title="${t('moduleEdit')}">${I.edit}</button>
          <button class="btn btn-g btn-i" onclick="deleteModuleAttrRow(${m.id},${a.id})" title="${t('delete')}">${I.delete}</button>
        </span>
      </div>`).join('')}
    <button class="btn btn-g" style="margin:4px 14px" onclick="openAttrModal(${m.id})">${I.plus} ${t('addAttribute')}</button>

    <div class="insp-label">${t('moduleLink')}</div>
    <div class="prop"><span class="pk">${t('outgoingLinks')}</span></div>
    <div class="insp-chips">${d.links.outgoing.length ? d.links.outgoing.map(l =>
      l.key ? `<span class="htag lk" onclick="openEntityByKey(${xj(l.key)})">[[${x(l.name)}]]</span>` : `<span class="htag" style="opacity:.5">[[${x(l.name)}]]</span>`
    ).join('') : `<span class="pv ghost">—</span>`}</div>
    <div class="prop"><span class="pk">${t('backlinks')}</span></div>
    <div class="insp-chips">${d.links.backlinks.length ? d.links.backlinks.map(l =>
      `<span class="htag lk" onclick="openEntityByKey(${xj(l.key)})">${x(l.name)}</span>`
    ).join('') : `<span class="pv ghost">${t('noBacklinks')}</span>`}</div>

    <div class="insp-label">${t('moduleUiSpec')}</div>
    <div class="prop"><span class="pk" data-no-i18n>View</span><span class="pv" data-no-i18n>${x(inspectorViewLabel(m, d.ui))}</span></div>

    <div class="insp-label">${t('versionHistory')}</div>
    <button class="btn btn-s" style="margin:4px 14px 14px;width:calc(100% - 28px)" onclick="openVersionPanel(${m.id})">${I.timeline} ${t('versionHistory')}</button>
  </aside>`;
}

// ═══ Module Inspector resize (Plan part4 #1) ═══════════════════════════
// Width is persisted in S.inspectorWidth and baked directly into this
// file's buildInspectorHtml (and versions.js's buildVersionPanelHtml)
// template strings rather than reapplied to the live DOM node — the dock
// gets outerHTML-replaced from mod/drafter.js and mod/detail.js after an
// inline edit saves, which would wipe an inline style set only post-render.
// Dragging the LEFT edge leftward increases width (the panel's right edge
// is anchored against the window edge), so the delta is subtracted.
let inspectorResizeState = null;
function startInspectorResize(ev) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const dock = q('.module-inspector');
  if (!dock) return;
  inspectorResizeState = { startX: ev.clientX, startWidth: dock.getBoundingClientRect().width };
  q('#inspector-resize')?.classList.add('is-resizing');
}
document.addEventListener('mousemove', (ev) => {
  if (!inspectorResizeState) return;
  S.inspectorWidth = Math.max(220, Math.min(500, inspectorResizeState.startWidth - (ev.clientX - inspectorResizeState.startX)));
  const dock = q('.module-inspector');
  if (dock) dock.style.width = S.inspectorWidth + 'px';
});
document.addEventListener('mouseup', () => {
  if (!inspectorResizeState) return;
  inspectorResizeState = null;
  q('#inspector-resize')?.classList.remove('is-resizing');
  localStorage.setItem(INSPECTOR_WIDTH_KEY, String(S.inspectorWidth));
});

// The active multi-view pattern (A.3 #4) shown in the UI-spec section —
// resolved through each kind's view-label dict when its renderer is loaded.
function inspectorViewLabel(m, ui) {
  const v = ui?.activeView || ui?.view;
  if (m.kind === 'classifier') return (typeof CLASSIFIER_VIEW_LABEL !== 'undefined' && CLASSIFIER_VIEW_LABEL[v]) || 'Detail';
  if (m.kind === 'manager') return (typeof MANAGER_VIEW_LABEL !== 'undefined' && MANAGER_VIEW_LABEL[v]) || 'Cards';
  if (m.kind === 'chronicler') return (typeof CHRONICLER_VIEW_LABEL !== 'undefined' && CHRONICLER_VIEW_LABEL[v]) || 'One-line';
  if (m.kind === 'wanderer') return (typeof WANDERER_VIEW_LABEL !== 'undefined' && WANDERER_VIEW_LABEL[v]) || 'Area';
  if (m.kind === 'narrator') return (typeof NARRATOR_VIEW_LABEL !== 'undefined' && NARRATOR_VIEW_LABEL[v]) || 'Board';
  if (m.kind === 'author') return (typeof AUTHOR_VIEW_LABEL !== 'undefined' && AUTHOR_VIEW_LABEL[v]) || 'Editor';
  if (m.kind === 'scribe') return (typeof CHATSCRIBE_VIEW_LABEL !== 'undefined' && CHATSCRIBE_VIEW_LABEL[v]) || 'Chat';
  if (m.kind === 'drafter') return (typeof DRAFTER_VIEW_LABEL !== 'undefined' && DRAFTER_VIEW_LABEL[v]) || 'Edit';
  if (m.kind === 'viewer') return (typeof VIEWER_VIEW_LABEL !== 'undefined' && VIEWER_VIEW_LABEL[v]) || 'Table';
  if (m.kind === 'connector') return (typeof CONNECTOR_VIEW_LABEL !== 'undefined' && CONNECTOR_VIEW_LABEL[v]) || 'Graph';
  if (m.kind === 'sketcher') return (typeof SKETCHER_VIEW_LABEL !== 'undefined' && SKETCHER_VIEW_LABEL[v]) || 'Canvas';
  if (m.kind === 'designer') return (typeof DESIGNER_VIEW_LABEL !== 'undefined' && DESIGNER_VIEW_LABEL[v]) || 'Canvas';
  if (m.kind === 'locator') return 'Canvas';
  if (m.kind === 'inspector') return 'Note';
  return '—';
}

// `inspector`-kind modules skip this — mod/detail.js already runs a full
// createMarkdownEditor over the identical module_<id> srcKey in the main
// pane for that kind, and mounting a second live instance here would let
// either one silently clobber the other's unsaved edits.
function mountInspectorDescEditor(m) {
  if (m.kind === 'inspector') return;
  const el = q('#insp-desc-editor');
  if (!el) return;
  createMarkdownEditor(el, {
    title: t('moduleDetailSpec'),
    content: m.description || '',
    srcKey: `module_${m.id}`,
    save: async (content) => {
      await api.module.updateDescription(m.id, content);
      const node = findModuleNode(m.id);
      if (node) node.description = content;
    },
  });
}

function openAttrModal(moduleId, attrId = null) {
  const a = attrId ? (S.inspectorData?.attrs || []).find(x => x.id === attrId) : null;
  openModal(a ? t('moduleEdit') : t('addAttribute'), `
    <div class="fg"><label>${t('name')} *</label><input id="ia-name" value="${x(a?.attr_name || '')}"></div>
    <div class="fg"><label>${t('content')}</label><input id="ia-value" value="${x(a?.attr_value || '')}"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitAttrForm(${moduleId},${attrId ?? 'null'})">${a ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#ia-name').focus(), 60);
}

async function submitAttrForm(moduleId, attrId) {
  const name = q('#ia-name').value.trim();
  if (!name) return;
  const value = q('#ia-value').value;
  await api.module.upsertAttr(moduleId, attrId, name, value);
  closeModal();
  await loadInspectorData(moduleId);
  renderNexusHome();
  toast(attrId ? t('saved') : t('created'), 'ok');
}

async function deleteModuleAttrRow(moduleId, attrId) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.module.deleteAttr(attrId);
  await loadInspectorData(moduleId);
  renderNexusHome();
  toast(t('deleted'), 'ok');
}

// Live-saves on every tag add/remove (matches every other .kind-popup) —
// no Save/Cancel footer. hashtagSelector/addModalTag/removeModalTag
// (core.js) are shared by 11 other legacy modals expecting deferred
// Save-button persistence, so this wraps them with a delegated click
// listener instead of modifying those shared functions.
async function openModuleTagPopup(moduleId, anchor) {
  closeAllPopups();
  if (!anchor) return;
  const current = (S.inspectorData?.tags || []).map(t => t.id);
  const pop = document.createElement('div');
  pop.className = 'kind-popup tag-link-popup';
  pop.innerHTML = await hashtagSelector('modtag', current);
  document.body.appendChild(pop);
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('.htag-item') || e.target.closest('.htag-chip button')) {
      api.module.setTags(moduleId, getModalTagIds('modtag'));
      refreshInspectorTagChips(moduleId);
    }
  });
  renderModalTagSuggestions('modtag');
  positionPopupNear(pop, anchor.getBoundingClientRect());
}

// Patches just the tag-chip fragments in the dock and the main-pane header
// instead of a full renderNexusHome() — that would rebuild #main-inner
// (including this popup's own anchor button) out from under an open popup.
async function refreshInspectorTagChips(moduleId) {
  const tags = await api.module.getTags(moduleId);
  if (S.inspectorData?.moduleId === moduleId) S.inspectorData.tags = tags;
  const chipsHtml = tags.map(tg => `<span class="htag" style="border-color:${x(tg.color_code || '#6366f1')};color:${x(tg.color_code || '#6366f1')}">#${x(tg.tag_name)}</span>`).join('');
  const dockChips = q('#insp-tag-chips');
  if (dockChips) dockChips.innerHTML = `${chipsHtml}<button class="btn btn-g btn-i" onclick="openModuleTagPopup(${moduleId}, this)" title="${t('tagLink')}">${I.plus}</button>`;
  const headTags = q('.module-head .mtags');
  if (headTags) {
    const d = S.inspectorData;
    const linkCount = d ? (d.links.outgoing.length + d.links.backlinks.length) : 0;
    const linkChip = `<span class="htag lk" data-no-i18n title="${t('moduleLink')}">🔗 ${linkCount} links</span>`;
    headTags.innerHTML = `${chipsHtml}${linkChip}<button class="btn btn-g btn-i" onclick="openModuleTagPopup(${moduleId}, this)" title="${t('tagLink')}">${I.plus}</button>`;
  }
}
