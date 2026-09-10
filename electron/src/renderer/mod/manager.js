'use strict';
// ═══ Project "Manager" (progress.md Phase 6) ══════════════════════════
// A Major-kind organizer (any depth) that — unlike Collector — opens to
// browse its child modules. Children already come attached via
// api.module.getTree()'s `.children`, so the only extra data this loads is
// the persisted view preference, the per-child tree counts, and the vault's
// relation edges for the graph.
//
// Process 8 part 2 changed all four views:
//   · Recent → Graph. Recent was the List view re-sorted by update_at and
//     carried no information the list didn't already have.
//   · Table/Cards counted module_attribute rows — a field almost nobody
//     fills in, so the column read "0" everywhere. They now count the tree:
//     how many Major modules sit below a child, and how many Minor elements
//     that child itself holds (module:getChildStats).
//   · List rows expand into a nested file tree of that subtree.

const MANAGER_VIEWS = ['cards', 'list', 'table', 'graph'];
const MANAGER_VIEW_LABEL = { cards: 'Cards', list: 'List', table: 'Table', graph: 'Graph' };

async function loadManagerData(m) {
  const [ui, stats, relations] = await Promise.all([
    api.module.getUi(m.id),
    api.module.getChildStats(m.id),
    api.viewer.getRelations(S.nexus.id),
  ]);
  const prev = (S.managerData && S.managerData.moduleId === m.id) ? S.managerData : null;
  S.managerData = {
    moduleId: m.id,
    stats: new Map(Object.entries(stats).map(([id, v]) => [Number(id), v])),
    relations,
    // The view used to be one global (S.managerView), which two Manager tabs
    // in split panes would fight over. It lives on the module's own data now.
    view: MANAGER_VIEWS.includes(ui.activeView) ? ui.activeView : 'cards',
    // Which List rows are expanded, kept across re-renders like the Import
    // Dock's folder tree does (S.importFolderCollapsed).
    listOpen: prev?.listOpen || new Set(),
    nodePos: prev?.nodePos || null,
  };
}

async function setManagerView(moduleId, view) {
  if (S.managerData?.moduleId === moduleId) S.managerData.view = view;
  await api.module.setUi(moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

function managerStats(id) {
  return S.managerData?.stats.get(id) || { majors: 0, minors: 0 };
}

function buildManagerMainHtml(m) {
  const children = m.children || [];
  const d = (S.managerData && S.managerData.moduleId === m.id) ? S.managerData : null;
  const view = d?.view || 'cards';
  const viewBar = `<div class="viewbar">
    ${MANAGER_VIEWS.map(v => `<span class="vitem${v === view ? ' act' : ''}" onclick="setManagerView(${m.id},'${v}')">${MANAGER_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <button class="btn btn-p" onclick="event.stopPropagation();openMinorModuleModal(${m.id},this)">${I.plus} ${t('addMinorModule')}</button>
    ${viewBar}
  </div>`;
  if (!children.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3><p>${t('nestEmpty')}</p></div>`;
  }
  let body;
  if (view === 'list') body = renderManagerList(children);
  else if (view === 'table') body = renderManagerTable(children);
  else if (view === 'graph') body = renderManagerGraphHtml(m);
  else body = renderManagerCards(children);
  return `${toolbar}${body}`;
}

function renderManagerCards(children) {
  return `<div class="cls-grid">${children.map(c => `
    <div class="cls-card mgr-card" onclick="openModuleNode(${c.id})">
      <span class="disp-thumb"><img data-display-key="module_${c.id}" alt=""></span>
      <div class="mgr-card-icon" style="color:${x(c.icon_color_code || c.color_code || 'var(--accent)')}">${moduleIconHtml(c)}</div>
      <div class="cls-card-name">${x(c.name)}</div>
      <span class="kind">${x(kindLabel(c.kind))}</span>
      <span class="mgr-card-count">${managerStats(c.id).minors} ${t('minorElements')}</span>
    </div>`).join('')}</div>`;
}

function renderManagerTable(children) {
  let html = `<div class="cls-table-wrap"><table class="cls-table">
    <tr><th>${t('name')}</th><th>${t('moduleKind')}</th><th>${t('majorModules')}</th><th>${t('minorElements')}</th></tr>`;
  for (const c of children) {
    const st = managerStats(c.id);
    html += `<tr onclick="openModuleNode(${c.id})" style="cursor:pointer">
      <td><span class="dot" style="background:${x(c.color_code || '#6366f1')}"></span>${x(c.name)}</td>
      <td>${x(kindLabel(c.kind))}</td>
      <td>${st.majors}</td>
      <td>${st.minors}</td>
    </tr>`;
  }
  html += `</table></div>`;
  return html;
}

// ── List view — rows that open into a file tree ─────────────────────────
// The dropdown shows the Major modules and Minor elements under a row,
// nesting further wherever there is more below. Deliberately NOT the hub's
// buildNestRow: this is a read-only lens, so no row here carries drag,
// rename or context-menu wiring — the same reasoning that keeps
// buildNestItemRow out of that recursion.
function renderManagerList(children) {
  return children.map(c => buildManagerListRow(c, 0)).join('');
}

function buildManagerListRow(c, depth) {
  const open = !!S.managerData?.listOpen.has(c.id);
  const st = managerStats(c.id);
  // Content kinds load their items lazily into S.nestItems the same way the
  // Nest tree does; on a freshly loaded tree they are already there.
  const isContentKind = !!ITEM_KIND[c.kind];
  if (isContentKind && open) ensureNestItemsLoaded(c.id);
  const items = Array.isArray(S.nestItems.get(c.id)) ? S.nestItems.get(c.id) : [];
  const kids = c.children || [];
  const hasBelow = kids.length > 0 || st.minors > 0 || items.length > 0;
  const chev = hasBelow
    ? `<svg class="icon tree-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
        onclick="event.stopPropagation();toggleManagerListRow(${c.id})"><polyline points="${open ? '6 9 12 15 18 9' : '9 18 15 12 9 6'}"/></svg>`
    : '<span class="tree-chev-spacer"></span>';
  const indent = depth ? ` indent${Math.min(depth, 5)}` : '';
  const below = open ? `
    ${kids.map(k => buildManagerListRow(k, depth + 1)).join('')}
    ${items.map(it => buildManagerListItemRow(it, c.kind, c.id, depth + 1)).join('')}` : '';
  return `<div class="li${indent}" onclick="openModuleNode(${c.id})">
    ${chev}
    <span class="kicon" style="color:${x(c.icon_color_code || c.color_code || 'var(--accent)')}">${moduleIconHtml(c)}</span>
    <span class="name">${x(c.name)}</span>
    <span class="kind">${x(kindLabel(c.kind))}</span>
    <span class="mgr-row-count" data-no-i18n title="${t('majorModules')} / ${t('minorElements')}">${st.majors} / ${st.minors}</span>
  </div>${below}`;
}

function buildManagerListItemRow(item, kind, moduleId, depth) {
  const reg = ITEM_KIND[kind];
  if (!reg) return '';
  const indentCls = ` indent${Math.min(depth, 5)}`;
  return `<div class="li nest-item-row${indentCls}" onclick="openItemNode('${kind}',${moduleId},${item.id})">
    <span class="tree-chev-spacer"></span>
    <span class="kicon" style="color:var(--t3)">${reg.icon()}</span>
    <span class="name">${x(reg.nameOf(item))}</span>
  </div>`;
}

function toggleManagerListRow(id) {
  const open = S.managerData?.listOpen;
  if (!open) return;
  if (open.has(id)) open.delete(id); else open.add(id);
  renderNexusHome();
}
