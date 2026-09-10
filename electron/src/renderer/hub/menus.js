// Right-click context menus (nest row / nav sidebar), the move-to list,
// pane-direction submenu, and the kind-picker popup that creates a module
// instantly instead of opening the full form.
// ═══ Right-click context menus (Nest row / Nav-sidebar) ════════════════
// Plan process3 part2: shared row-builder for the simple (non-submenu,
// non-icon) context-menu rows — same shape as core/nexus-options.js's own
// local row() helper, so every "row of text that closes the menu and runs
// one action" in the app looks and behaves identically. Named ctxRow (not
// row) to avoid shadowing buildNestOptionsPopupHtml's own local `row` below.
const ctxRow = (onclick, label, cls = '') =>
  `<div class="kind-list-item ${cls}" onclick="closeAllPopups();${onclick}"><span class="kli-name">${label}</span></div>`;

function openModuleContextMenu(ev, id) {
  ev.preventDefault();
  ev.stopPropagation();
  closeAllPopups();
  S.ctxMenuPos = { x: ev.clientX, y: ev.clientY };
  const m = findModuleNode(id);
  if (!m) return;
  const pop = document.createElement('div');
  pop.className = 'kind-popup context-menu-popup';
  pop.innerHTML = buildModuleContextMenuHtml(id, !!m.pinned);
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, ctxAnchor(ev).getBoundingClientRect());
}

// Plan part1 #3: pop a module's own Builder page into a fresh floating
// window — mirrors builderPopOutTab's own api.window.openBuilderTab call,
// but without its builderCloseTab step, since nothing existing is being
// moved/closed here (the module opens in the new window while the current
// pane/tab, if any, is left untouched).
// Plan procress1 part2 #1: explicit escape hatch for tab-accumulation now
// that builderNavigate's default open REPLACES the pane's active tab —
// pushes the key into pane.tabs itself first so builderNavigate's own
// "already includes" branch just switches to it instead of replacing.
async function openModuleInNewTab(id) {
  const m = findModuleNode(id);
  if (!m) return;
  const key = builderPageKey({ kind: 'module', id });
  const pane = builderState().panes[builderState().focused];
  if (!pane.tabs.includes(key)) pane.tabs.push(key);
  await openModuleNode(id);
}

async function openModuleInNewWindow(id) {
  const m = findModuleNode(id);
  if (!m) return;
  await api.window.openBuilderTab(S.nexus.id, builderPageKey({ kind: 'module', id }));
}

const PANE_DIR_MAP = { left: ['h', true], right: ['h', false], top: ['v', true], bottom: ['v', false] };
// Plan part1 #3: split the currently-focused Builder pane in the requested
// direction and open the module straight into the freshly created pane —
// same (dir,newFirst) convention already used by the drag-to-edge auto-split
// (onBodyDrop): left/top put the new pane before the original, right/bottom
// put it after.
async function openModuleInNewPane(id, dir) {
  const m = findModuleNode(id);
  if (!m) return;
  const [axis, newFirst] = PANE_DIR_MAP[dir];
  const newIdx = builderSplitPane(builderState().focused, axis, newFirst);
  if (newIdx == null) return;
  await builderFocusPane(newIdx, { kind: 'module', id });
}

// Plan process3 part2: every module is "Major" now (the term no longer means
// top-level-only, see Process 3 Part 1's rename) — Create/Import/Export/Pin
// used to be gated behind parent_id==null and are now unconditional.
function buildModuleContextMenuHtml(id, pinned) {
  let html = '';
  // The create-list used to sit inline at the top of the menu (every kind,
  // always visible) — moved behind one "Create" row with a hover submenu
  // instead, decluttering the menu the same way a native app's context
  // menu nests a submenu rather than flattening every option.
  // Plan part1 #5: auto-parent to the right-clicked module — this used to
  // hardcode parentId=null regardless of which module's menu was open,
  // always creating a new top-level sibling instead of a child of `id`.
  html += `<div class="kind-list-item kli-submenu-parent" onmouseenter="openCreateSubmenu(event,${id})" onmouseleave="scheduleCtxSubmenuClose()">
      <span class="kli-name">${x(t('create'))}</span><span class="kli-arrow">›</span>
    </div>
    ${ctxRow(`ctxImportModule(${id})`, x(t('settingDbImportModule')))}
    ${ctxRow(`ctxExportModule(${id})`, x(t('settingDbExportModule')))}
    <div class="ctx-sep"></div>`;
  // Plan part1 #3: modules with their own Builder page (any kind except the
  // pure-folder Collector, see KIND_MAIN_BUILDER) get "open in a new window"
  // and a hover "open in a new pane" direction submenu. The pane submenu is
  // meaningless in Wyvern (Plan part2 #New Workspace — no split panes at
  // all there), so it's hidden rather than offering an action that would
  // silently no-op or fight the single-pane guard in builderNavigate.
  const m = findModuleNode(id);
  if (m && m.kind !== 'collector') {
    html += `
    <div class="kind-list-item" onclick="closeAllPopups();openModuleInNewTab(${id})"><span class="kli-name">${x(t('openInNewTab'))}</span></div>
    <div class="kind-list-item" onclick="closeAllPopups();openModuleInNewWindow(${id})"><span class="kli-name">${x(t('openInNewWindow'))}</span></div>
    ${S.settings.workspaceStyle !== 'drake' ? '' : `<div class="kind-list-item kli-submenu-parent" onmouseenter="openPaneDirectionSubmenu(event,${id})" onmouseleave="scheduleCtxSubmenuClose()">
      <span class="kli-name">${x(t('openInNewPane'))}</span><span class="kli-arrow">›</span>
    </div>`}
    <div class="ctx-sep"></div>`;
  }
  html += `
    ${ctxRow(`openModuleEditModal(${id})`, x(t('moduleEdit')))}
    ${ctxRow(`startRenameModule(${id})`, x(t('rename')))}
    ${ctxRow(`duplicateModuleNode(${id})`, x(t('duplicate')))}
    <div class="kind-list-item kli-submenu-parent" onmouseenter="openMoveToSubmenu(event,${id})" onmouseleave="scheduleCtxSubmenuClose()">
      <span class="kli-name">${x(t('moveTo'))}</span><span class="kli-arrow">›</span>
    </div>
    <div class="ctx-sep"></div>
    ${ctxRow(`deleteModuleNode(${id})`, x(t('delete')), 'kli-danger')}
    <div class="ctx-sep"></div>
    ${ctxRow(`toggleModulePin(${id})`, x(pinned ? t('unpin') : t('pin')))}`;
  return html;
}

async function ctxExportModule(id) {
  const m = findModuleNode(id);
  const r = await api.db.exportModuleFile(S.nexus.id, id, m?.name);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbExportOk'), 'ok');
}
async function ctxImportModule(id) {
  const r = await api.db.importModuleFile(S.nexus.id, id);
  if (r.canceled) return;
  if (!r.ok) return toast(t('driveErrServer'), 'error');
  toast(t('settingDbImportOk'), 'ok');
  await reloadModuleTree();
}

function flattenModuleTree(nodes, depth, out) {
  out = out || [];
  for (const m of nodes) {
    out.push({ m, depth });
    if (m.children?.length) flattenModuleTree(m.children, depth + 1, out);
  }
  return out;
}
function buildMoveToListHtml(id) {
  const node = findModuleNode(id);
  if (!node) return '';
  let html = '';
  if (node.parent_id != null) {
    html += `<div class="kind-list-item" onclick="moveModuleTo(${id},null)"><span class="kli-name">${x(t('moveToTopLevel'))}</span></div>`;
  }
  const all = flattenModuleTree(S.moduleTree, 0);
  for (const { m: target, depth } of all) {
    if (target.id === id || isSelfOrDescendant(node, target.id)) continue;
    html += `<div class="kind-list-item" style="padding-left:${10 + depth * 14}px" onclick="moveModuleTo(${id},${target.id})"><span class="kli-name">${x(target.name)}</span></div>`;
  }
  return html || `<div class="kind-list-item" style="opacity:.6;pointer-events:none"><span class="kli-name">${x(t('moveToNoTargets'))}</span></div>`;
}
async function moveModuleTo(id, newParentId) {
  closeAllPopups();
  if (!S.nexus) return;
  const siblings = (newParentId == null ? S.moduleTree : findModuleNode(newParentId)?.children || [])
    .map(m => m.id).filter(mid => mid !== id);
  siblings.push(id);
  await api.module.move(S.nexus.id, id, newParentId, siblings);
  await reloadModuleTree();
}
async function duplicateModuleNode(id) {
  await api.module.duplicate(id);
  await reloadModuleTree();
  toast(t('duplicated'), 'ok');
}

function openNavSidebarContextMenu(ev) {
  ev.preventDefault();
  closeAllPopups();
  S.ctxMenuPos = { x: ev.clientX, y: ev.clientY };
  const pop = document.createElement('div');
  pop.className = 'kind-popup context-menu-popup nav-pin-popup';
  pop.innerHTML = buildNavPinListHtml();
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, ctxAnchor(ev).getBoundingClientRect());
}
function buildNavPinListHtml() {
  if (!S.moduleTree.length) return `<div class="kind-list-item" style="opacity:.6;pointer-events:none"><span class="kli-name">${x(t('nestEmpty'))}</span></div>`;
  // Process 6 part 1: every module can be pinned at any depth (see
  // buildModuleContextMenuHtml) — flatten the tree so this picker can list
  // and toggle nested modules too, not just root-level ones.
  return flattenModuleTree(S.moduleTree, 0).map(({ m, depth }) => `
    <div class="kind-list-item" style="padding-left:${10 + depth * 14}px" onclick="toggleNavPinAndRefresh(${m.id})">
      <span class="kicon" style="color:${x(m.icon_color_code || m.color_code || '#6366f1')}">${moduleIconHtml(m)}</span>
      <span class="kli-name">${x(m.name)}</span>
      <span class="ctx-check">${m.pinned ? '✓' : ''}</span>
    </div>`).join('');
}
async function toggleNavPinAndRefresh(id) {
  const m = findModuleNode(id);
  if (!m) return;
  await api.module.update(id, { pinned: m.pinned ? 0 : 1 });
  await reloadModuleTree();
  const pop = document.querySelector('.nav-pin-popup');
  if (pop) pop.innerHTML = buildNavPinListHtml();
}

// Plan process4 part2 #1: right-click menu on the rail's Hub quick-menu
// buttons (Kind Browser/Sage Hut/Import Dock) to toggle which of them show
// on the rail — Nexus Nest is the rail's home button and can't be toggled
// off, so it's left out of this list entirely. Scoped to those buttons
// (not the whole #nav-sidebar, which openNavSidebarContextMenu already owns
// for module pinning) via stopPropagation so the two menus never collide.
const HUB_QUICK_MENU_ITEMS = [
  ['kinds', 'kindBrowser', 'layer'],
  ['sage', 'sageHut', 'sage'],
  ['dock', 'importDock', 'import'],
];
function openHubQuickMenuContextMenu(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  closeAllPopups();
  S.ctxMenuPos = { x: ev.clientX, y: ev.clientY };
  const pop = document.createElement('div');
  pop.className = 'kind-popup context-menu-popup hub-quickmenu-popup';
  pop.innerHTML = buildHubQuickMenuToggleHtml();
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, ctxAnchor(ev).getBoundingClientRect());
}
function buildHubQuickMenuToggleHtml() {
  const hqt = S.settings.hubQuickToggles || {};
  return HUB_QUICK_MENU_ITEMS.map(([key, labelKey, icon]) => `
    <div class="kind-list-item" onclick="toggleHubQuickMenuAndRefresh('${key}')">
      <span class="kicon">${I[icon]}</span>
      <span class="kli-name">${x(t(labelKey))}</span>
      <span class="ctx-check">${hqt[key] !== false ? '✓' : ''}</span>
    </div>`).join('');
}
function toggleHubQuickMenuAndRefresh(key) {
  const cur = (S.settings.hubQuickToggles || {})[key] !== false;
  S.settings.hubQuickToggles = Object.assign({}, S.settings.hubQuickToggles, { [key]: !cur });
  saveUiSettings();
  renderModuleRail();
  const pop = document.querySelector('.hub-quickmenu-popup');
  if (pop) pop.innerHTML = buildHubQuickMenuToggleHtml();
}

// Nexus Nest display options popup (Plan part1 #2) — 4 toggles driven by
// S.settings, same .kind-popup + positionPopupNear idiom as every other
// popup in this file.
function openNestOptionsPopup(anchor) {
  closeAllPopups();
  if (!anchor) return;
  const pop = document.createElement('div');
  pop.className = 'kind-popup nest-options-popup';
  pop.innerHTML = buildNestOptionsPopupHtml();
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, anchor.getBoundingClientRect());
}
function buildNestOptionsPopupHtml() {
  const s = S.settings;
  const row = (onclick, on, labelKey) =>
    `<div class="togglerow nest-opt-row" onclick="${onclick}"><span class="tg${on ? ' on' : ''}"></span>${t(labelKey)}</div>`;
  // Same .name-mode-seg control the Preferences panel uses (nameModeSegHtml,
  // core/settings.js) — btn-p marks the active option, btn-s the rest.
  const sig = (mode, labelKey) =>
    `<button class="btn ${s.nestSignatureMode === mode ? 'btn-p' : 'btn-s'}" onclick="setNestSignatureMode('${mode}')">${t(labelKey)}</button>`;
  return [
    row("toggleNestOption('nestShowItems')", s.nestShowItems !== false, 'nestOptShowItems'),
    row("toggleNestOption('nestShowMajorIcon')", s.nestShowMajorIcon !== false, 'nestOptShowMajorIcon'),
    row("toggleNestOption('nestShowMinorIcon')", !!s.nestShowMinorIcon, 'nestOptShowMinorIcon'),
    // 3-way, so a segmented row rather than a 4th toggle switch — the other
    // three rows above are genuine booleans and stay as they are.
    `<div class="nest-opt-row nest-sig-row"><div class="nest-sig-label">${t('nestOptSignature')}</div>
      <div class="name-mode-seg">${sig('name', 'nestSigName')}${sig('icon', 'nestSigIcon')}${sig('handle', 'nestSigHandle')}</div></div>`,
  ].join('');
}

// ═══ Kind-picker popup — instant create ════════════════════════════════
function openKindPopup(parentId, anchor) {
  closeAllPopups();
  if (!anchor) return;
  const pop = document.createElement('div');
  pop.className = 'kind-popup kind-list-popup';
  pop.innerHTML = buildKindListHtml(parentId);
  document.body.appendChild(pop);
  pop.addEventListener('click', e => e.stopPropagation());
  positionPopupNear(pop, anchor.getBoundingClientRect());
}

function buildKindListHtml(parentId, excludeCollector = false) {
  // Plan part2 #1: Artisan's create-wizard ("start from template") only
  // ever builds a top-level Manager (parent_id always null) — only offer it
  // where a brand-new top-level module is being created, never on a Minor-
  // create popup or the module context-menu's "Create" submenu (both
  // always pass a real parentId).
  let html = '';
  if (parentId == null) {
    html += `<div class="kind-list-item" onclick="openArtisanTemplateList(this)">
      <span class="kicon" style="color:${x(KIND_COLOR.manager)}">${I.artisan}</span>
      <span class="kli-text"><span class="kli-name">${t('artStartTemplate')}</span><span class="kli-desc">${t('artV3CardD')}</span></span>
    </div><div class="ctx-sep"></div>`;
  }
  html += MODULE_KINDS.filter(k => !(excludeCollector && k === 'collector')).map(k => `
    <div class="kind-list-item" onclick="quickCreateModule('${k}',${parentId ?? 'null'})">
      <span class="kicon" style="color:${x(KIND_COLOR[k])}">${I[KIND_ICON[k]]}</span>
      <span class="kli-text"><span class="kli-name">${x(kindLabel(k))}</span><span class="kli-desc">${t(KIND_DESC_KEY[k])}</span></span>
    </div>`).join('');
  return html;
}

// Swaps the same popup's content to the 4 template targets (same swap-
// innerHTML idiom as buildCatTypeListHtml below) — artisan.js isn't in
// index.html's eager <script> list, so it needs a lazy-load before its
// startArtisanWizard/ARTISAN_TARGETS-consuming markup can run.
async function openArtisanTemplateList(anchor) {
  const pop = document.querySelector('.kind-popup');
  if (!pop) return;
  await loadModule('src/renderer/artisan.js');
  pop.innerHTML = buildArtisanTemplateListHtml();
}
function buildArtisanTemplateListHtml() {
  return ARTISAN_TARGETS.map(tg => `
    <div class="kind-list-item" onclick="closeAllPopups();startArtisanWizard('${tg.id}')">
      <span class="kicon">${I[tg.icon]}</span>
      <span class="kli-text"><span class="kli-name">${t(tg.labelKey)}</span></span>
    </div>`).join('');
}

// Classifier needs one more decision (cat_type) before it can be created —
// swap the popup's content to those 3 cards instead of a second popup, so
// there's still only ever one `.kind-popup` open at a time.
function buildCatTypeListHtml(parentId) {
  const types = [
    ['object', I.layer, 'catTypeObject', 'catTypeObjectDesc'],
    ['element', I.relation, 'catTypeElement', 'catTypeElementDesc'],
    ['character', I.person, 'catTypeCharacter', 'catTypeCharacterDesc'],
  ];
  return types.map(([ct, icon, labelKey, descKey]) => `
    <div class="kind-list-item" onclick="quickCreateModule('classifier',${parentId ?? 'null'},'${ct}')">
      <span class="kicon">${icon}</span>
      <span class="kli-text"><span class="kli-name">${t(labelKey)}</span><span class="kli-desc">${t(descKey)}</span></span>
    </div>`).join('');
}

async function quickCreateModule(kind, parentId, catType) {
  const pop = document.querySelector('.kind-popup');
  if (kind === 'classifier' && !catType) {
    if (pop) pop.innerHTML = buildCatTypeListHtml(parentId);
    return;
  }
  const name = t('newModuleName').replace('{kind}', kindLabel(kind));
  const moduleId = await api.module.create({
    nexus_ref: S.nexus.id, parent_id: parentId, name, kind,
    color: null, icon_color: null, icon: null,
    cat_type: kind === 'classifier' ? catType : null,
  });
  closeAllPopups();
  if (parentId != null) S.moduleCollapsed.delete(parentId);
  await reloadModuleTree();
  S.renamingModuleId = moduleId;
  const created = findModuleNode(moduleId);
  if (created && created.kind !== 'collector') await openModuleNode(moduleId);
  else renderNexusHome();
  focusRenameInput(moduleId);
}

