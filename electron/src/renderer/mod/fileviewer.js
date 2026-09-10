'use strict';
// ═══ Import Dock section + file viewers (progress.md Phase 18) ═════════
// The hub's Import Dock section lists imported files (mockup 29):
// "นำเข้าโฟลเดอร์" scans a folder via the importdock:pickFolder dialog,
// rows show a linker chip (→ entity / ยังไม่ผูก), and clicking a file
// opens a read-only viewer page in the builder (image with zoom pills ·
// markdown via mdRender · plain text). Image files linked to an entity
// can be flagged "use as display image" — Manager cards and Classifier
// grids pick those up through the batched displayImages lookup. Editing
// an imported doc (docx -> Drafter conversion) is deferred to Phase 19's
// builder tabs; the viewer says so in its hint line.

// ── Hub section rows ────────────────────────────────────────────────────
// Lazy cache: loaded the first time the section is open, then kept fresh
// by the mutating actions below.
function ensureImportDock() {
  if (!S.nexus || S.importFiles !== undefined) return;
  S.importFiles = null; // loading marker
  Promise.all([api.importdock.list(S.nexus.id), api.wiki.quickIndex(S.nexus.id)]).then(([files, ix]) => {
    const byKey = new Map(ix.map(e2 => [e2.key, e2]));
    for (const f of files) f.entity = f.linker_key ? (byKey.get(f.linker_key) || null) : null;
    S.importFiles = files;
    renderNexusHome();
  });
}

// Files store their full nested folder path as one string (e.g.
// "Root/sub1/sub2", built by main.js's importdock:pickFolder walk) — build
// a real tree out of that instead of grouping by the exact string, so each
// segment gets its own collapsible row at its own depth (mockup ask: show
// the Dock as an actual folder tree, matching the Nest tree's own look).
function buildImportFolderTree(files) {
  const root = { name: null, path: '', children: new Map(), files: [] };
  for (const f of files) {
    const segs = (f.folder || '').split('/').filter(Boolean);
    let node = root, cum = '';
    for (const seg of segs) {
      cum = cum ? `${cum}/${seg}` : seg;
      if (!node.children.has(seg)) node.children.set(seg, { name: seg, path: cum, children: new Map(), files: [] });
      node = node.children.get(seg);
    }
    node.files.push(f);
  }
  return root;
}

function importNodeFileCount(node) {
  let n = node.files.length;
  for (const c of node.children.values()) n += importNodeFileCount(c);
  return n;
}

function buildImportFolderNode(node, depth) {
  const collapsed = S.importFolderCollapsed.has(node.path);
  const indentCls = depth ? ` indent${Math.min(depth, 5)}` : '';
  let html = `<div class="li dock-folder${indentCls}" data-no-i18n onclick="toggleImportFolder(${x(JSON.stringify(node.path))})">
    <svg class="icon tree-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="${collapsed ? '9 18 15 12 9 6' : '6 9 12 15 18 9'}"/></svg>
    ${I.folder || ''} ${x(node.name)}/<span class="cnt">${importNodeFileCount(node)} files</span></div>`;
  if (!collapsed) {
    for (const child of node.children.values()) html += buildImportFolderNode(child, depth + 1);
    for (const f of node.files) html += buildImportFileRow(f, depth + 1);
  }
  return html;
}

function buildImportFileRow(f, depth) {
  const indentCls = depth ? ` indent${Math.min(depth, 5)}` : '';
  const chip = f.entity
    ? `<span class="dock-chip lk" data-no-i18n>→ ${x(f.entity.name)}</span>`
    : `<span class="dock-chip ghost">${t('notLinked')}</span>`;
  return `<div class="li${indentCls}${S.filePreview?.id === f.id && !S.activeModuleNode ? ' sel' : ''}" onclick="openImportFile(${f.id})" oncontextmenu="openImportFileContextMenu(event,${f.id})">
    <span class="dock-ficon dock-${x(f.file_type || 'file')}" data-no-i18n>▤</span>
    <span class="name" data-no-i18n>${x(f.file_name)}${f.use_as_image ? ' ★' : ''}</span>
    ${chip}
    <span class="acts">
      <button class="btn btn-g btn-i" onclick="event.stopPropagation();deleteImportFileRow(${f.id})" title="${t('delete')}">${I.delete}</button>
    </span>
  </div>`;
}

// Plan process3 part2: right-click "delete import" — unlinks this file's
// metadata row from the Nexus without touching the file on disk (same
// action as the row's own left-click delete button above; deleteImportFileRow
// only ever does DELETE FROM import_file, see src/db/importdock.js).
function openImportFileContextMenu(ev, id) {
  ev.preventDefault();
  ev.stopPropagation();
  closeAllPopups();
  const pop = document.createElement('div');
  pop.className = 'kind-popup context-menu-popup';
  pop.innerHTML = `<div class="kind-list-item kli-danger" onclick="closeAllPopups();deleteImportFileRow(${id})"><span class="kli-name">${x(t('delete'))}</span></div>`;
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, ctxAnchor(ev).getBoundingClientRect());
}

function buildImportDockRows() {
  ensureImportDock();
  const files = S.importFiles;
  const importBtn = `<div class="li au-add" onclick="importDockPickFolder()">${I.plus}<span class="name">${t('importFolder')}</span></div>`;
  if (!files || !files.length) {
    return `${files === null || files === undefined ? '' : `<div class="empty" style="padding:14px 10px"><p>${t('nestEmpty')}</p></div>`}${importBtn}`;
  }
  const tree = buildImportFolderTree(files);
  let html = '';
  for (const child of tree.children.values()) html += buildImportFolderNode(child, 0);
  for (const f of tree.files) html += buildImportFileRow(f, 0);
  return html + importBtn;
}

function toggleImportFolder(folder) {
  if (S.importFolderCollapsed.has(folder)) S.importFolderCollapsed.delete(folder);
  else S.importFolderCollapsed.add(folder);
  renderNexusHome();
}

async function importDockPickFolder() {
  const res = await api.importdock.pickFolder();
  if (!res || res.canceled) return;
  const added = await api.importdock.add(S.nexus.id, res.files);
  S.importFiles = undefined; // refetch
  renderNexusHome();
  toast(`${t('created')} +${added}`, 'ok');
}

async function refreshImportDock() {
  S.importFiles = undefined;
  ensureImportDock();
}

// ── Builder file viewer ─────────────────────────────────────────────────
async function openImportFile(id) {
  const f = (S.importFiles || []).find(v => v.id === id);
  if (!f) return;
  const content = await api.importdock.readFile(id);
  S.filePreview = { ...f, content, zoom: 1 };
  S.sageHut = null;
  S.activeModuleNode = null;
  S.activeItemNode = null;
  S.importDockPage = false;
  if (typeof builderNavigate === 'function') builderNavigate({ kind: 'file', id });
  renderNexusHome();
}

const fvBytes = (b) => typeof fmtBytes === 'function' ? fmtBytes(b) : `${b} B`;

function buildFileViewerHtml() {
  const f = S.filePreview;
  const c = f.content || {};
  let body;
  if (c.kind === 'image') {
    body = `<div class="fv-imgwrap"><img id="fv-img" src="${displayImageUrl(f.id)}" onerror="queueDisplayImageFallback(this,${f.id})" style="transform:scale(${f.zoom})" alt=""></div>
      <div class="czoom" data-no-i18n>
        <button class="btn btn-g btn-i" onclick="fileViewerZoom(-0.2)">−</button>
        <span id="fv-zoom-label">${Math.round(f.zoom * 100)}%</span>
        <button class="btn btn-g btn-i" onclick="fileViewerZoom(0.2)">＋</button>
      </div>`;
  } else if (c.kind === 'md') {
    body = `<div class="md-preview au-reading">${mdRender(c.text || '', { resolveLink: typeof resolveWikiNameCached === 'function' ? resolveWikiNameCached : null })}</div>`;
  } else if (c.kind === 'txt') {
    body = `<pre class="fv-pre" data-no-i18n>${x(c.text || '')}</pre>`;
  } else if (c.kind === 'error') {
    body = `<div class="empty" style="margin-top:30px"><p data-no-i18n>${x(c.message || '')}</p></div>`;
  } else {
    // Binary docs (docx): no in-app reader — offer converting into a
    // Drafter module linked to this file (text extraction is out of scope,
    // per the Phase 18/19 deferral note).
    body = `<div class="empty" style="margin-top:30px"><p>${t('importDocxLater')}</p>
      <button class="btn btn-p" style="margin-top:10px" onclick="createDrafterFromFile(${f.id})">${I.plus} ${t('createAsDrafter')}</button></div>`;
  }
  const isImage = c.kind === 'image';
  const linkerChip = f.entity
    ? `<span class="htag lk" data-no-i18n onclick="openEntityByKey(${xj(f.linker_key)})">[[${x(f.entity.name)}]]</span>`
    : `<span class="pv ghost">${t('notLinked')}</span>`;
  return wrapPageView(`<div class="detail-head module-head" style="border-left:4px solid var(--accent);padding-left:12px">
      <h2 style="margin:0;font-size:1.15em" data-no-i18n>${x(f.file_name)} <span class="kind-chip" data-no-i18n>File</span></h2>
      <div class="drafter-hint" data-no-i18n>${fvBytes(f.file_size)}${f.file_type === 'docx' ? ` · ${t('importDocxLater')}` : ''}</div>
    </div>
    <div class="cn-wrap fv-wrap">${body}</div>
    <div class="fv-foot">
      <span class="pk">${t('linkedTo')}</span> ${linkerChip}
      ${isImage && f.linker_key ? `<label class="fv-useimg"><input type="checkbox" ${f.use_as_image ? 'checked' : ''}
        onchange="toggleImportUseAsImage(${f.id}, this.checked)"> ${t('useAsImage')}</label>` : ''}
      <span style="flex:1"></span>
      <button class="btn btn-s" onclick="openImportLinkerModal(${f.id})">${t('changeLinker')}</button>
      <button class="btn btn-d" onclick="deleteImportFileRow(${f.id})">${t('delete')}</button>
    </div>`);
}

function fileViewerZoom(dz) {
  const f = S.filePreview;
  if (!f) return;
  f.zoom = Math.min(4, Math.max(0.2, f.zoom + dz));
  const img = q('#fv-img');
  if (img) img.style.transform = `scale(${f.zoom})`;
  const lbl = q('#fv-zoom-label');
  if (lbl) lbl.textContent = `${Math.round(f.zoom * 100)}%`;
}

async function openImportLinkerModal(id) {
  const f = (S.importFiles || []).find(v => v.id === id);
  const ix = await api.wiki.quickIndex(S.nexus.id);
  openModal(t('changeLinker'), `
    <div class="fg"><label>${t('moduleLink')}</label>
      <select id="il-key">
        <option value="">${t('notLinked')}</option>
        ${ix.map(e2 => `<option value="${x(e2.key)}" ${f?.linker_key === e2.key ? 'selected' : ''}>${x(e2.name)} (${x(e2.type)})</option>`).join('')}
      </select></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitImportLinker(${id})">${t('save')}</button>
    </div>`);
}

async function submitImportLinker(id) {
  const key = q('#il-key').value || null;
  await api.importdock.setLinker(id, key);
  closeModal();
  invalidateDisplayImages();
  await reopenImportFile(id);
  toast(t('saved'), 'ok');
}

async function toggleImportUseAsImage(id, on) {
  await api.importdock.setUseAsImage(id, on);
  invalidateDisplayImages();
  await reopenImportFile(id);
  toast(t('saved'), 'ok');
}

async function reopenImportFile(id) {
  S.importFiles = undefined;
  await new Promise(res => {
    Promise.all([api.importdock.list(S.nexus.id), api.wiki.quickIndex(S.nexus.id)]).then(([files, ix]) => {
      const byKey = new Map(ix.map(e2 => [e2.key, e2]));
      for (const f of files) f.entity = f.linker_key ? (byKey.get(f.linker_key) || null) : null;
      S.importFiles = files;
      res();
    });
  });
  await openImportFile(id);
}

async function deleteImportFileRow(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.importdock.delete(id);
  S.importFiles = undefined;
  // Only close the open preview if the deleted file IS the one being
  // previewed — the dock row's own delete button (any row, not just the
  // open one) shouldn't blow away an unrelated file's open preview.
  if (S.filePreview?.id === id) S.filePreview = null;
  invalidateDisplayImages();
  renderNexusHome();
  toast(t('deleted'), 'ok');
}

// docx → Drafter: creates an empty Drafter module named after the file and
// links the file to it (content stays in the source file — no docx parsing).
async function createDrafterFromFile(id) {
  const f = (S.importFiles || []).find(v => v.id === id);
  if (!f) return;
  const name = f.file_name.replace(/\.[^.]+$/, '');
  const moduleId = await api.module.create({ nexus_ref: S.nexus.id, parent_id: null, name, kind: 'drafter' });
  await api.importdock.setLinker(id, `module_${moduleId}`);
  S.importFiles = undefined;
  await reloadModuleTree();
  await openModuleNode(moduleId);
  toast(t('created'), 'ok');
}

// ── Display-image lookup for cards/grids ────────────────────────────────
// One batched fetch per session (invalidated on linker/image changes);
// returns linker_key -> import_file id. Callers then hydrate <img> tags
// through hydrateDisplayImages().
// Drops both the key->file map and the fallback data-URL cache. The
// protocol path needs no invalidation (the handler's ETag covers it), but
// the fallback Map would otherwise go stale exactly like the old one did.
function invalidateDisplayImages() {
  S.displayImageCache = null;
  S.displayImageData = null;
}

async function getDisplayImageMap() {
  if (S.displayImageCache) return S.displayImageCache;
  if (!S.nexus) return new Map();
  const rows = await api.importdock.displayImages(S.nexus.id);
  S.displayImageCache = new Map(rows.map(r => [r.linker_key, r.id]));
  return S.displayImageCache;
}

// Fills every <img data-display-key="..."> in the current DOM with its
// entity's display image (if one is flagged).
//
// Plan part2 #2.2: this used to await one importdock:readFile per image,
// sequentially, and stash the base64 data URL in an S.displayImageData Map
// that was never invalidated (so a file replaced on disk stayed stale for
// the whole session and the blobs accumulated). Now each <img> just points
// at ddx-file://<fileId> — no IPC at all, the bytes never cross the bridge,
// and Chromium caches/revalidates them via the handler's ETag.
//
// The onerror hook is the fallback for renderers where that protocol isn't
// registered — notably the Playwright web-driver harness, which loads
// index.html over plain file:// with no Electron main process behind it.
// There it degrades to ONE batched importdock:readFiles for the whole page.
async function hydrateDisplayImages() {
  const imgs = [...document.querySelectorAll('img[data-display-key]')];
  if (!imgs.length) return;
  const map = await getDisplayImageMap();
  for (const img of imgs) {
    const fileId = map.get(img.dataset.displayKey);
    if (!fileId) { img.closest('.card-thumb, .disp-thumb')?.classList.add('disp-empty'); continue; }
    img.onerror = () => queueDisplayImageFallback(img, fileId);
    img.src = displayImageUrl(fileId);
    img.closest('.disp-thumb')?.classList.remove('disp-empty');
  }
}

// The vault id is part of the URL because the protocol handler in main.js is
// not an IPC handler — it receives a bare Request with no calling window, so
// it cannot infer which vault's import_file to look the id up in (v4.9.0, one
// .ddx per Nexus). See registerDisplayImageProtocol.
const displayImageUrl = (fileId) => `ddx-file://${S.nexus?.id ?? 0}-${fileId}`;

// Collects every <img> that failed to load in this tick and resolves them
// with a single readFiles round-trip. S.displayImageData only ever holds
// fallback-path data URLs, and is dropped whenever the key->file map is.
let _dispFallbackQueue = null;
function queueDisplayImageFallback(img, fileId) {
  img.onerror = null; // a failed data URL must not re-queue forever
  S.displayImageData = S.displayImageData || new Map();
  const cached = S.displayImageData.get(fileId);
  if (cached !== undefined) {
    if (cached) img.src = cached; else img.closest('.card-thumb, .disp-thumb')?.classList.add('disp-empty');
    return;
  }
  if (!_dispFallbackQueue) {
    _dispFallbackQueue = [];
    queueMicrotask(flushDisplayImageFallback);
  }
  _dispFallbackQueue.push([img, fileId]);
}

async function flushDisplayImageFallback() {
  const pending = _dispFallbackQueue || [];
  _dispFallbackQueue = null;
  if (!pending.length) return;
  const ids = [...new Set(pending.map(([, id]) => id))];
  const urls = await api.importdock.readFiles(ids);
  for (const id of ids) S.displayImageData.set(id, urls[id] || null);
  for (const [img, id] of pending) {
    const url = urls[id];
    if (url) { img.src = url; img.closest('.disp-thumb')?.classList.remove('disp-empty'); }
    else img.closest('.card-thumb, .disp-thumb')?.classList.add('disp-empty');
  }
}
