'use strict';
// ═══ Asset Nest — the Import Dock tray + assets in the Nest (v5 Part 1) ═══
// APP docs/V5.md §2: the module tree IS the asset tree. An import_file row
// with module_ref set is an asset filed into that module node and renders as
// a leaf under it in the Nest (buildNestAssetRow, called from hub/tree.js);
// module_ref NULL means unfiled, and the Import Dock section is now just the
// tray for those. Folder import mirrors the directory as collector modules
// (importdock:importFolder). The file viewer page itself stays in
// mod/fileviewer.js.
//
// Split out of fileviewer.js when v5 pushed it past ~500 lines
// (dracondex-file-arch): this file owns the list cache and every action that
// changes which node an asset lives in; fileviewer.js owns rendering one.

// ── Cache ───────────────────────────────────────────────────────────────
// Lazy: loaded the first time the Nest or the Dock renders, then kept fresh
// by the mutating actions below (S.importFiles = undefined -> refetch). The
// same list feeds the tray (module_ref NULL) and the Nest leaves (grouped by
// module_ref into S.assetsByModule), so there is one thing to invalidate.
function ensureImportDock() {
  if (!S.nexus || S.importFiles !== undefined) return;
  S.importFiles = null; // loading marker
  loadImportFiles().then(() => {
    renderNexusHome();
    runAssetSweepOnce();
  });
}

async function loadImportFiles() {
  const [files, ix] = await Promise.all([api.importdock.list(S.nexus.id), api.wiki.quickIndex(S.nexus.id)]);
  const byKey = new Map(ix.map(e2 => [e2.key, e2]));
  const byModule = new Map();
  for (const f of files) {
    f.entity = f.linker_key ? (byKey.get(f.linker_key) || null) : null;
    if (f.module_ref != null) {
      if (!byModule.has(f.module_ref)) byModule.set(f.module_ref, []);
      byModule.get(f.module_ref).push(f);
    }
  }
  for (const list of byModule.values()) list.sort((a, b) => a.file_name.localeCompare(b.file_name));
  S.importFiles = files;
  S.assetsByModule = byModule;
  return files;
}

async function refreshImportDock() {
  S.importFiles = undefined;
  ensureImportDock();
}

const nestAssetsOf = (moduleId) => (S.importFiles && S.assetsByModule?.get(moduleId)) || [];

// §2.5: stat / hash / proxy every asset once per vault per session (and again
// after an import). Runs in main in the background; the list only re-renders
// if a missing flag actually flipped or a new cover proxy exists.
async function runAssetSweepOnce(force) {
  if (!S.nexus) return;
  const nx = S.nexus.id;
  if (!force && S.assetSweptNexus === nx) return;
  S.assetSweptNexus = nx;
  try {
    const st = await api.importdock.sweep(nx);
    if (st && !st.busy && (st.changed || st.proxied) && S.nexus?.id === nx) {
      await loadImportFiles();
      invalidateDisplayImages();
      renderNexusHome();
    }
  } catch (_) { /* a failed sweep only means stale flags until next time */ }
}

// ── Asset icons ─────────────────────────────────────────────────────────
// One glyph per asset class (asset-media.js ASSET_CLASS on the main side).
const ASSET_CLASS_OF_EXT = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video',
  md: 'doc', txt: 'doc', docx: 'doc', pdf: 'doc', url: 'url',
  vtt: 'track', glb: 'model', gltf: 'model', stl: 'model', obj: 'model',
};
const ASSET_GLYPH = { image: '▣', audio: '♪', video: '▶', doc: '▤', url: '↗', track: '≡', model: '◈' };
const assetClass = (f) => (f.source_kind === 'url' ? 'url' : ASSET_CLASS_OF_EXT[(f.file_type || '').toLowerCase()] || 'doc');
const assetGlyph = (f) => ASSET_GLYPH[assetClass(f)] || '▤';

// ── Nest leaves (called from hub/tree.js buildNestRow) ──────────────────
// Draggable onto any module row to re-file it (onNestDragOver/onNestDrop
// branch on S.dragAsset). Not a buildNestRow recursion, like the content-
// item leaves — an asset is never a drop target itself.
function buildNestAssetRow(f, depth) {
  const indentCls = ` indent${Math.min(depth, 5)}`;
  const sel = S.filePreview?.id === f.id && !S.activeModuleNode ? ' sel' : '';
  return `<div class="li${indentCls}${sel} nest-item-row nest-asset-row${f.missing ? ' asset-missing' : ''}"
      draggable="true" ondragstart="onAssetDragStart(event,${f.id})" ondragend="S.dragAsset=null"
      onclick="openImportFile(${f.id})" oncontextmenu="openImportFileContextMenu(event,${f.id})"
      title="${f.missing ? x(t('assetMissing')) : ''}">
    <span class="tree-chev-spacer"></span>
    <span class="kicon dock-ficon dock-${x(assetClass(f))}" aria-hidden="true" data-no-i18n>${nestAssetIcon(f)}</span>
    <span class="name" data-no-i18n>${x(f.file_name)}</span>
  </div>`;
}

// Procress 16 part 2: a picture shows itself (a 16 px thumbnail, the cover
// proxy main already serves at ddx-file://) — every other file its type glyph.
function nestAssetIcon(f) {
  if (assetClass(f) !== 'image' || f.missing) return assetGlyph(f);
  return `<img class="nest-thumb" src="${displayImageUrl(f.id)}" alt="" loading="lazy" onerror="this.replaceWith(${x(JSON.stringify(assetGlyph(f)))})">`;
}

function onAssetDragStart(ev, id) {
  S.dragAsset = id;
  S.dragNest = null;
  ev.dataTransfer.effectAllowed = 'move';
  ev.stopPropagation();
}

async function moveAssetToModule(id, moduleId) {
  closeAllPopups();
  await api.importdock.setModule(id, moduleId);
  await loadImportFiles();
  renderNexusHome();
  toast(t('saved'), 'ok');
}

// ── Dock tray (unfiled) ─────────────────────────────────────────────────
// Procress 21: the unfiled files are one list of the shared kind
// (core/list.js), grouped by what they are — images, audio, video, … — each
// group with its count, folding; one thumbnail size (--icon-sm) for every
// picture, here and in the Nest leaves. Where a file came from (its import
// folder) is the row's meta.
const ASSET_GROUPS = [['image', 'assetGroupImage'], ['audio', 'assetGroupAudio'], ['video', 'assetGroupVideo'], ['doc', 'assetGroupDoc'],
  ['track', 'assetGroupTrack'], ['model', 'assetGroupModel'], ['url', 'assetGroupUrl']];

function buildImportFileRow(f) {
  return listRowHtml({
    density: 'compact', onclick: `openImportFile(${f.id})`, menu: `openImportFileContextMenu(event,${f.id})`,
    icon: `<span class="dock-ficon dock-${x(assetClass(f))}" data-no-i18n>${nestAssetIcon(f)}</span>`,
    title: `${f.file_name}${f.use_as_image ? ' ★' : ''}`, meta: f.folder || '',
    tip: f.missing ? t('assetMissing') : f.file_name,
    trailing: f.entity ? `<span class="ls-chip ls-on" data-no-i18n>→ ${x(f.entity.name)}</span>` : `<span class="ls-chip">${t('notLinked')}</span>`,
    actions: listActHtml({ icon: I.delete, name: t('delete'), danger: true, key: 'Delete', onclick: `deleteImportFileRow(${f.id})` }),
    state: { selected: S.filePreview?.id === f.id && !S.activeModuleNode }, cls: f.missing ? 'ls-missing' : '',
    attrs: `data-no-i18n draggable="true" ondragstart="onAssetDragStart(event,${f.id})" ondragend="S.dragAsset=null"`,
  });
}

// Procress 16 B6: the Import Dock is gone — files not yet filed under any
// module are one virtual folder, "Unsorted (N)", at the end of the Nest
// (folded until opened). Importing lives in the Nest's [+▾]; a missing
// file's relink lives in Problems (hub/problems.js).
const UNSORTED_OPEN = '#unsorted:open'; // in S.importFolderCollapsed = the folder is open
function nestUnsortedHtml() {
  ensureImportDock();
  const unfiled = (S.importFiles || []).filter(f => f.module_ref == null);
  if (!unfiled.length) return '';
  const open = S.importFolderCollapsed.has(UNSORTED_OPEN);
  const html = `<div class="li nest-unsorted" onclick="toggleImportFolder('${UNSORTED_OPEN}')">
    <svg class="icon tree-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="${open ? '6 9 12 15 18 9' : '9 18 15 12 9 6'}"/></svg>
    <span class="kicon" aria-hidden="true">${I.folder || ''}</span><span class="name">${x(t('nestUnsorted'))}</span><span class="cnt" data-no-i18n>${unfiled.length}</span></div>`;
  if (!open) return html;
  const byName = (a, b) => a.file_name.localeCompare(b.file_name);
  const body = ASSET_GROUPS.map(([cls, key]) => [cls, key, unfiled.filter(f => assetClass(f) === cls).sort(byName)]).filter(([, , fs]) => fs.length)
    .map(([cls, key, fs]) => listGroupHtml({ list: 'assets', id: cls, title: t(key), count: fs.length, rows: listRowsHtml('assets', fs, buildImportFileRow, { key: cls }) }))
    .join('');
  return html + listHtml({ list: 'assets', aria: t('nestUnsorted'), cls: 'nest-unsorted-list', body });
}

function toggleImportFolder(folder) {
  if (S.importFolderCollapsed.has(folder)) S.importFolderCollapsed.delete(folder);
  else S.importFolderCollapsed.add(folder);
  renderNexusHome();
}

// ── Context menu (Dock rows and Nest leaves alike) ──────────────────────
// Plan process3 part2: "delete import" only unlinks this file's metadata row
// from the Nexus — the file on disk is never touched.
// v5 Part 6: built from COMMANDS, so each row is also a palette command
// while that file is open in the viewer.
function openImportFileContextMenu(ev, id) {
  openCtx('asset.file', ev, { fileId: id });
}

CTX_PROVIDERS['asset.file'] = (c) => [
  cmdItem('asset.moveTo', c),
  cmdItem('asset.toTray', c),
  cmdItem('asset.relink', c),
  cmdItem('asset.reveal', c),
  { sep: true },
  cmdItem('asset.delete', c),
];

// Filing targets for "Move to module" — every module node except the one the
// file is already in (same list shape as the module menu's "Move to").
function assetMoveTargets(id) {
  const cur = (S.importFiles || []).find(v => v.id === id)?.module_ref ?? null;
  return flattenModuleTree(S.moduleTree, 0)
    .filter(({ m }) => m.id !== cur)
    .map(({ m, depth }) => ({ label: `${'  '.repeat(depth)}${m.name}`, onClick: () => moveAssetToModule(id, m.id) }));
}

// ── Import ──────────────────────────────────────────────────────────────
// §2.3 "locate folder asset": the picked folder becomes a collector tree
// under parentModuleId (null = top level, from the Dock), every file filed
// into its own folder's collector.
async function importDockPickFolder(parentModuleId) {
  closeAllPopups();
  if (!S.nexus) return;
  const res = await api.importdock.importFolder(S.nexus.id, parentModuleId ?? null);
  if (!res || res.canceled) return;
  if (parentModuleId != null) S.moduleCollapsed.delete(parentModuleId);
  await reloadModuleTree();
  await loadImportFiles();
  renderNexusHome();
  toast(`${t('created')} +${res.added}`, 'ok');
  runAssetSweepOnce(true);
}

// URL asset (§2.2): metadata only; opening is shell.openExternal in main.
function openAddAssetUrlModal(moduleId) {
  closeAllPopups();
  openModal(t('addAssetLink'), `
    <div class="fg"><label>${t('assetUrl')}</label><input id="au-url" type="url" placeholder="https://"></div>
    <div class="fg"><label>${t('assetNameOptional')}</label><input id="au-name"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitAddAssetUrl(${moduleId ?? 'null'})">${t('save')}</button>
    </div>`);
  setTimeout(() => q('#au-url')?.focus(), 0);
}

async function submitAddAssetUrl(moduleId) {
  const url = q('#au-url')?.value || '';
  const name = q('#au-name')?.value || '';
  const res = await api.importdock.addUrl(S.nexus.id, url, name, moduleId);
  if (!res || res.error) { toast(t('assetUrlInvalid'), 'error'); return; }
  closeModal();
  if (moduleId != null) S.moduleCollapsed.delete(moduleId);
  await loadImportFiles();
  renderNexusHome();
  toast(t('created'), 'ok');
}

// ── Relink (§2.5) ───────────────────────────────────────────────────────
// Both dialogs run in main; the renderer never names a path. A content
// mismatch against the stored sha256 needs an explicit second confirm.
async function relinkImportFile(id) {
  const res = await api.importdock.relink(id);
  if (!res || res.canceled) return;
  if (res.error === 'type') { toast(t('assetRelinkWrongType'), 'error'); return; }
  if (res.mismatch) {
    if (!await uiConfirm(t('assetRelinkMismatch'))) return;
    await api.importdock.relinkConfirm(id);
  } else if (!res.ok) {
    return;
  }
  await afterRelink(id);
  toast(t('assetRelinked'), 'ok');
}

async function relinkMissingFromFolder() {
  const res = await api.importdock.relinkFolder(S.nexus.id);
  if (!res || res.canceled) return;
  await afterRelink(null);
  toast(`${t('assetRelinked')} ${res.relinked}`, res.relinked ? 'ok' : 'error');
}

async function afterRelink(openId) {
  await loadImportFiles();
  invalidateDisplayImages();
  runAssetSweepOnce(true);
  if (openId != null && S.filePreview?.id === openId) await openImportFile(openId);
  else renderNexusHome();
}

// ── Delete ──────────────────────────────────────────────────────────────
async function deleteImportFileRow(id) {
  if (!await uiConfirm(t('confirmDeleteAsset'))) return;
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

// ── Module page "Assets" strip (hub/open.js buildModuleDetailHtml) ──────
// Every kind with a page lists what is filed directly under it, with the two
// ways to add more in place. Collectors have no page — their assets are the
// Nest leaves.
function buildModuleAssetsStripHtml(m) {
  const list = nestAssetsOf(m.id);
  const chips = list.map(f => `<span class="chip chip-link${f.missing ? ' asset-missing' : ''}" role="link" tabindex="0" data-no-i18n draggable="true"
      ondragstart="onAssetDragStart(event,${f.id})" ondragend="S.dragAsset=null"
      onclick="openImportFile(${f.id})" oncontextmenu="openImportFileContextMenu(event,${f.id})">${assetGlyph(f)} ${x(f.file_name)}</span>`).join('');
  return `<div class="module-assets">
    <span class="pk">${t('assetsHeader')}</span>
    ${chips}
    ${cmdBtn('module.importFolder', { moduleId: m.id }, { iconOnly: true })}
    ${cmdBtn('module.addLink', { moduleId: m.id }, { iconOnly: true })}
  </div>`;
}
