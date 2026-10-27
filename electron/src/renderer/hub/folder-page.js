'use strict';
// ═══ Folder page — the Nest's two-column mode (Procress 16 part 2) ════════
// Unity's Project window: the folder tree on the left (the Nest), and what is
// IN the picked folder as a grid on the right, with a slider for the tile
// size. On only with the Nest option "Folders open as a grid"
// (S.settings.nestTwoColumn); otherwise a folder row just folds and unfolds,
// as it always has. A folder has no page of its own in the data — this is a
// view of the tree, built from S.moduleTree and the asset list.
//   S.folderPage   the open folder's id (builder ref { kind: 'folder', id })

const FOLDER_TILE = { min: 72, max: 200, def: 112 };
// Procress 29 part 2: what is in a folder, the way a file manager shows it —
// large icons (the tile grid, sized by the slider), small icons, a list, or
// details (name · kind · updated · items, sorted by a column). Remembered per
// folder in its module_ui (folderView); a folder never set uses the one
// picked last anywhere (S.settings.folderView).
const FOLDER_VIEWS = [
  { value: 'large', icon: 'grid', key: 'folderViewLarge' },
  { value: 'small', icon: 'gridSmall', key: 'folderViewSmall' },
  { value: 'list', icon: 'list', key: 'folderViewList' },
  { value: 'details', icon: 'table', key: 'folderViewDetails' },
];
const folderViewOf = (id) => S.folderViews?.[id] || S.settings.folderView || 'large';

function openFolderPage(id) {
  const m = findModuleNode(id);
  if (!m || m.kind !== 'collector') return;
  S.folderPage = id; S.categoryPage = null;
  S.activeModuleNode = null; S.activeItemNode = null; S.filePreview = null; S.sageHut = null;
  S.moduleCollapsed.delete(id); // the tree shows where you are
  if (typeof builderNavigate === 'function') builderNavigate({ kind: 'folder', id });
  ensureImportDock(); // its files
  renderNexusHome();
  // its own view, once per folder per session (module_ui is per module)
  S.folderViews ||= {};
  if (!(id in S.folderViews)) {
    S.folderViews[id] = null;
    api.module.getUi(id).then((u) => {
      if (!u?.folderView || S.folderViews[id]) return;
      S.folderViews[id] = u.folderView;
      if (S.folderPage === id) renderNexusHome();
    }).catch(() => {});
  }
}

function setFolderView(id, view) {
  if (!FOLDER_VIEWS.some((v) => v.value === view)) return;
  (S.folderViews ||= {})[id] = view;
  S.settings.folderView = view;
  saveUiSettings();
  api.module.setUi(id, 'folderView', view);
  renderNexusHome();
}

function setFolderSort(key) {
  const cur = S.folderSort || { key: 'name', dir: 1 };
  S.folderSort = { key, dir: cur.key === key ? -cur.dir : 1 };
  renderNexusHome();
}

// One entry of the folder — a module (a sub-folder opens as its page) or a file.
function folderEntries(m) {
  const mods = (m.children || []).map((c) => {
    const items = c.kind === 'collector' ? (c.children || []).length : (S.nestItems?.get(c.id)?.length ?? null);
    return { id: `m${c.id}`, name: c.name, kind: kindLabel(c.kind), updated: c.update_at || c.create_at || '', items,
      color: c.icon_color_code || c.color_code || KIND_COLOR[c.kind] || 'var(--accent)', icon: moduleIconHtml(c),
      open: c.kind === 'collector' ? `openFolderPage(${c.id})` : `openModuleNode(${c.id})`, ctx: `openModuleContextMenu(event,${c.id})`, folder: c.kind === 'collector' };
  });
  const files = nestAssetsOf(m.id).map((f) => ({
    id: `f${f.id}`, name: f.file_name, kind: String(f.file_type || assetClass(f) || '').toUpperCase(), updated: f.create_at || '', items: null,
    thumb: assetClass(f) === 'image' && !f.missing ? displayImageUrl(f.id) : null, icon: assetGlyph(f), color: null,
    open: `openImportFile(${f.id})`, ctx: `openImportFileContextMenu(event,${f.id})`, file: true,
  }));
  return [...mods, ...files];
}

const folderOpenKeys = (open) => `onkeydown="if(event.key==='Enter'){event.preventDefault();${open}}"`;
const folderIconHtml = (e, cls) => `<span class="${cls}"${e.color ? ` style="color:${x(e.color)}"` : ''}>${e.thumb ? `<img src="${e.thumb}" alt="" loading="lazy">` : e.icon}</span>`;
const folderDate = (s) => (s ? String(s).slice(0, 16).replace('T', ' ') : '');

function folderBodyHtml(m, view, entries) {
  if (view === 'large' || view === 'small') {
    const size = Number(S.settings.folderTileSize) || FOLDER_TILE.def;
    return `<div class="folder-grid${view === 'small' ? ' folder-small' : ''}" role="list" style="--tile:${size}px">${entries.map((e) => `<div class="folder-tile" role="listitem" tabindex="0" onclick="${e.open}" oncontextmenu="${e.ctx}" ${folderOpenKeys(e.open)} title="${x(e.name)}">
      ${folderIconHtml(e, 'folder-tile-icon')}<span class="folder-tile-name" data-no-i18n>${x(e.name)}</span>${view === 'large' && !e.file ? `<span class="folder-tile-kind">${x(e.kind)}</span>` : ''}</div>`).join('')}</div>`;
  }
  if (view === 'list') {
    const st = ((S.folderLazy ||= {})[m.id] ||= {});
    const rows = lazyRows(entries, (e) => listRowHtml({ density: 'compact', icon: folderIconHtml(e, 'folder-list-icon'), title: e.name, meta: e.kind,
      onclick: e.open, attrs: `tabindex="0" oncontextmenu="${e.ctx}" ${folderOpenKeys(e.open)} data-no-i18n` }), st);
    return listHtml({ list: `folder-${m.id}`, aria: m.name, body: rows, cls: 'folder-list' });
  }
  // details
  const sort = S.folderSort || { key: 'name', dir: 1 };
  const val = (e) => (sort.key === 'items' ? e.items ?? -1 : String(e[sort.key] ?? '').toLowerCase());
  const sorted = [...entries].sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : 0) || (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * sort.dir);
  const th = (key, label) => `<th aria-sort="${sort.key === key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="btn btn-g btn-sm" onclick="setFolderSort('${key}')">${t(label)}${sort.key === key ? (sort.dir > 0 ? I.chevronUp : I.chevronDown) : ''}</button></th>`;
  const st = ((S.folderLazy ||= {})[`d${m.id}`] ||= {});
  const rows = lazyRows(sorted, (e) => `<tr tabindex="0" onclick="${e.open}" oncontextmenu="${e.ctx}" ${folderOpenKeys(e.open)}>
      <td class="folder-d-name"><span class="folder-d-cell">${folderIconHtml(e, 'folder-list-icon')}<span data-no-i18n>${x(e.name)}</span></span></td><td>${x(e.kind)}</td>
      <td data-no-i18n>${x(folderDate(e.updated))}</td><td class="cls-num" data-no-i18n>${e.items ?? ''}</td></tr>`, st,
    { more: (id) => `<tr class="lazy-more" data-lazy="${id}"><td colspan="4"></td></tr>` });
  return `<div class="folder-details-wrap" data-scroll-key="folder-${m.id}"><table class="folder-details"><thead><tr>${th('name', 'name')}${th('kind', 'folderColKind')}${th('updated', 'propsUpdated')}${th('items', 'folderColItems')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function buildFolderPageHtml() {
  const m = findModuleNode(S.folderPage);
  if (!m) { S.folderPage = null; return builderEmptyPaneHtml(); }
  const view = folderViewOf(m.id);
  const entries = folderEntries(m);
  const body = entries.length ? folderBodyHtml(m, view, entries) : `<div class="empty"><p>${t('folderEmpty')}</p></div>`;
  const size = Number(S.settings.folderTileSize) || FOLDER_TILE.def;
  const acts = `${segmentedHtml(FOLDER_VIEWS.map((v) => ({ value: v.value, icon: v.icon, title: t(v.key) })), view, { size: 'sm', aria: t('folderView'), onclick: (v) => `setFolderView(${m.id},'${v}')` })}
    ${view === 'large' ? `<label class="folder-size" title="${x(t('folderTileSize'))}">${I.layer || ''}
      <input type="range" min="${FOLDER_TILE.min}" max="${FOLDER_TILE.max}" value="${size}" aria-label="${x(t('folderTileSize'))}" oninput="setFolderTileSize(this.value)"></label>` : ''}
    ${hasLocate() && S.nexus?.locate_dir ? `<button class="btn btn-g btn-i" onclick="revealInExplorer({moduleId:${m.id}})" title="${t('revealInExplorer')}" aria-label="${t('revealInExplorer')}">${I.folder || ''}</button>` : ''}`;
  return wrapPageView(`${pageHeadHtml({
      addr: { moduleId: m.id }, title: x(m.name), titleText: m.name, icon: moduleIconHtml(m),
      color: m.icon_color_code || m.color_code || KIND_COLOR.collector,
      after: `<span class="chip">${x(kindLabel('collector'))}</span>`, acts,
    })}<div class="folder-page" data-view="${view}">${body}</div>`);
}

// The slider moves the tiles live (a CSS variable) and remembers the size.
function setFolderTileSize(v) {
  S.settings.folderTileSize = Math.max(FOLDER_TILE.min, Math.min(FOLDER_TILE.max, Number(v) || FOLDER_TILE.def));
  document.querySelectorAll('.folder-grid').forEach((g) => g.style.setProperty('--tile', `${S.settings.folderTileSize}px`));
  clearTimeout(setFolderTileSize._t);
  setFolderTileSize._t = setTimeout(saveUiSettings, 300);
}

// "Show in Explorer" (Procress 16 part 2): a file where it is on disk, or a
// folder's own directory inside the Locate folder.
async function revealInExplorer(target) {
  const r = await api.importdock.reveal(S.nexus.id, target);
  if (!r?.ok) toast(t('assetMissing'), 'warn');
}
