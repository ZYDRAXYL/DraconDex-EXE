// Scribe module — Obsidian-style markdown notes for the active Nexus vault.
// Left panel: folder tree + note list. Main area: shared markdown editor
// (mdeditor.js) with edit/preview toggle.

async function renderScribeView() {
  S.view = 'scribe';
  await renderScribeSidebar();
  if (S.scribeTab === 'graph') await renderScribeGraph();
  else await renderScribeMain();
  if (typeof updateModuleSubNav === 'function') updateModuleSubNav();
}

// Rail subnav: the graph icon toggles between notes and the vault graph.
async function setScribeTab(tab) {
  S.scribeTab = (S.scribeTab === tab) ? 'notes' : tab;
  await renderScribeView();
}

// ── Vault graph (Obsidian-style) ─────────────────────────
const SCRIBE_GRAPH_COLORS = { director:'#6366f1', navigator:'#22c55e', hero:'#f59e0b', writer:'#8b5cf6', scribe:'#0ea5e9' };
let _scribeGraphHidden = new Set();

async function renderScribeGraph() {
  const el = q('#main-inner');
  if (!el || !S.nexus) return;
  await loadModule('src/renderer/sage.js'); // buildSageGraph lives there
  const data = await api.wiki.getGraph(S.nexus.id);
  el.classList.remove('relation-main');
  el.innerHTML = `
    <div class="scribe-graph-head"><h3>${t('graphView')}</h3></div>
    <div id="scribe-graph-wrap" style="flex:1;position:relative;overflow:hidden;min-height:420px"></div>`;
  if (!data.nodes.length) {
    q('#scribe-graph-wrap').innerHTML = `<div class="empty" style="margin-top:60px"><p>${t('noteEmpty')}</p></div>`;
    return;
  }
  buildSageGraph(data, _scribeGraphHidden, {
    container: '#scribe-graph-wrap',
    colors: SCRIBE_GRAPH_COLORS,
    labels: { scribe: t('scribe'), director: t('director'), navigator: t('navigator'), hero: t('hero'), writer: t('writer') },
    onNodeClick: (n) => { if (n.key) openEntityByKey(n.key); },
  });
}

async function renderScribeSidebar() {
  const el = q('#left-panel-inner');
  if (!el || !S.nexus) return;
  const [folders, notes] = await Promise.all([
    api.note.getFolders(S.nexus.id),
    api.note.getAll(S.nexus.id),
  ]);
  S.scribeFolders = folders;
  S.scribeNotes = notes;

  const noteRow = (n) => `
    <div class="li scribe-note ${S.scribeNote?.id === n.id ? 'active' : ''}" onclick="selectNote(${n.id})" oncontextmenu="openNoteModal(${n.id})">
      <span class="dot" style="background:${n.color_code || 'var(--accent)'}"></span>
      <span class="name">${n.pinned ? '📌 ' : ''}${x(n.title)}</span>
      <button class="btn-icon scribe-row-edit" onclick="event.stopPropagation();openNoteModal(${n.id})" title="${t('edit')}">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      </button>
    </div>`;

  const subtree = (parentId) => {
    let html = '';
    for (const f of folders.filter(v => (v.parent_ref || null) === parentId)) {
      const open = S.scribeOpenFolders.has(f.id);
      const kids = notes.filter(n => n.folder_ref === f.id);
      html += `
        <div class="scribe-folder">
          <div class="li scribe-folder-head" onclick="tglScribeFolder(${f.id})" oncontextmenu="openNoteFolderModal(${f.id})">
            <svg style="width:8px;height:8px;flex-shrink:0;transform:rotate(${open ? 90 : 0}deg);transition:transform .15s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            <span style="color:${f.color_code || 'var(--accent)'};line-height:1;display:flex;align-items:center">${I.folder}</span>
            <span class="name">${x(f.name)}</span>
            <span style="color:var(--t3);font-size:calc(11px * var(--fsc,1))">${kids.length}</span>
          </div>
          ${open ? `<div class="scribe-folder-body">${subtree(f.id)}${kids.map(noteRow).join('')}</div>` : ''}
        </div>`;
    }
    return html;
  };

  const unfiled = notes.filter(n => !n.folder_ref);
  el.innerHTML = `
    <div class="ph"><h4>${t('scribe')}</h4>
      <div style="display:flex;gap:4px">
        <button class="btn btn-g btn-i" onclick="openNoteFolderModal()" title="${t('noteFolderNew')}">${I.folder}</button>
        <button class="btn btn-g btn-i" onclick="openNoteModal()" title="${t('noteNew')}">${I.plus}</button>
      </div>
    </div>
    ${subtree(null)}
    ${unfiled.map(noteRow).join('')}
    ${!folders.length && !notes.length ? `<div class="empty"><p>${t('noteEmpty')}</p></div>` : ''}`;
}

function tglScribeFolder(id) {
  if (S.scribeOpenFolders.has(id)) S.scribeOpenFolders.delete(id);
  else S.scribeOpenFolders.add(id);
  renderScribeSidebar();
}

async function selectNote(id) {
  S.scribeNote = await api.note.get(id);
  if (!S.scribeNote) return;
  upsertEntityTab({ id, name: S.scribeNote.title, color_code: S.scribeNote.color_code }, 'note', 'scribe');
  await renderScribeSidebar();
  await renderScribeMain();
}

async function renderScribeMain() {
  const el = q('#main-inner');
  if (!el) return;
  el.classList.remove('relation-main');
  const n = S.scribeNote;
  if (!n) {
    el.innerHTML = `<div class="empty" style="margin-top:80px">
      <div class="ei" style="font-size:calc(28px * var(--fsc,1))">📝</div>
      <h3>${t('scribe')}</h3><p>${t('notePick')}</p>
    </div>`;
    return;
  }
  el.innerHTML = `<div class="scribe-editor" id="scribe-editor"></div>`;
  createMarkdownEditor(q('#scribe-editor'), {
    title: n.title,
    content: n.content || '',
    srcKey: `note_${n.id}`,
    save: (content) => api.note.updateContent(n.id, content),
  });
}

// ── Note modal (create / edit meta) ─────────────────────
async function openNoteModal(id = null) {
  const n = id ? await api.note.get(id) : null;
  const folders = S.scribeFolders || await api.note.getFolders(S.nexus.id);
  openModal(n ? `✏️ ${t('noteEdit')}` : `📝 ${t('noteNew')}`, `
    <div class="fg"><label>${t('title')} *</label><input id="sn-title" value="${x(n?.title || '')}"></div>
    <div class="fg"><label>${t('noteFolder')}</label>
      <select id="sn-folder"><option value="">--</option>
        ${folders.map(f => `<option value="${f.id}" ${n?.folder_ref === f.id ? 'selected' : ''}>${x(f.name)}</option>`).join('')}
      </select></div>
    <div class="fg"><label><input type="checkbox" id="sn-pinned" ${n?.pinned ? 'checked' : ''}> ${t('notePinned')}</label></div>
    <div class="fg"><label>${t('color')}</label>${await colorPicker(n?.color)}</div>
    <div class="mfoot">
      ${n ? `<button class="btn btn-d" onclick="delNote(${id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="${n ? `saveNoteMeta(${id})` : 'createNoteSubmit()'}">${n ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#sn-title').focus(), 60);
}

async function createNoteSubmit() {
  const title = q('#sn-title').value.trim() || 'Untitled';
  const newId = await api.note.create(S.nexus.id, title, q('#sn-folder').value || null, q('#sel-color').value || null);
  closeModal();
  toast(t('created'), 'ok');
  await selectNote(newId);
}

async function saveNoteMeta(id) {
  const title = q('#sn-title').value.trim();
  if (!title) return;
  const before = await api.note.get(id);
  try {
    await api.note.update(id, title, q('#sn-folder').value || null, q('#sel-color').value || null, q('#sn-pinned').checked);
  } catch (e) { toast(t('noteTitleTaken'), 'error'); return; }
  // keep [[links]] pointing here working after a rename
  if (before && before.title !== title) {
    const refs = await api.wiki.backlinks(`note_${id}`);
    if (refs.length && await uiConfirm(t('renameUpdateLinks'), { danger: false })) {
      await api.wiki.renameTarget(`note_${id}`, before.title, title);
    }
  }
  closeModal();
  if (S.scribeNote?.id === id) S.scribeNote = await api.note.get(id);
  const idx = S.entityTabs.findIndex(v => v.key === `note-${id}`);
  if (idx >= 0) { S.entityTabs[idx].name = title; renderProjectTabs(); }
  toast(t('saved'), 'ok');
  await renderScribeView();
}

async function delNote(id) {
  if (!await uiConfirm(t('noteDeleteConfirm'))) return;
  await api.note.delete(id);
  closeModal();
  S.entityTabs = S.entityTabs.filter(v => v.key !== `note-${id}`);
  if (S.activeEntityTabKey === `note-${id}`) S.activeEntityTabKey = null;
  if (S.scribeNote?.id === id) S.scribeNote = null;
  renderProjectTabs();
  toast(t('deleted'), 'ok');
  await renderScribeView();
}

// ── Folder modal ─────────────────────────────────────────
async function openNoteFolderModal(id = null) {
  const f = id ? (S.scribeFolders || []).find(v => v.id === id) : null;
  const folders = (S.scribeFolders || []).filter(v => v.id !== id);
  openModal(f ? `✏️ ${t('noteFolderEdit')}` : `📁 ${t('noteFolderNew')}`, `
    <div class="fg"><label>${t('name')} *</label><input id="snf-name" value="${x(f?.name || '')}"></div>
    <div class="fg"><label>${t('noteFolder')}</label>
      <select id="snf-parent"><option value="">--</option>
        ${folders.map(v => `<option value="${v.id}" ${f?.parent_ref === v.id ? 'selected' : ''}>${x(v.name)}</option>`).join('')}
      </select></div>
    <div class="fg"><label>${t('color')}</label>${await colorPicker(f?.color)}</div>
    <div class="mfoot">
      ${f ? `<button class="btn btn-d" onclick="delNoteFolder(${id})">${t('delete')}</button>` : ''}
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="${f ? `saveNoteFolder(${id})` : 'createNoteFolderSubmit()'}">${f ? t('save') : t('create')}</button>
    </div>`);
  setTimeout(() => q('#snf-name').focus(), 60);
}

async function createNoteFolderSubmit() {
  const name = q('#snf-name').value.trim();
  if (!name) return;
  const newId = await api.note.createFolder(S.nexus.id, name, q('#snf-parent').value || null, q('#sel-color').value || null);
  closeModal();
  S.scribeOpenFolders.add(newId);
  toast(t('created'), 'ok');
  await renderScribeSidebar();
}

async function saveNoteFolder(id) {
  const name = q('#snf-name').value.trim();
  if (!name) return;
  await api.note.updateFolder(id, name, q('#snf-parent').value || null, q('#sel-color').value || null);
  closeModal();
  toast(t('saved'), 'ok');
  await renderScribeSidebar();
}

async function delNoteFolder(id) {
  if (!await uiConfirm(t('noteFolderDeleteConfirm'))) return;
  await api.note.deleteFolder(id);
  closeModal();
  toast(t('deleted'), 'ok');
  await renderScribeView();
}
