'use strict';
// ═══ Relation "Connector" (progress.md Phase 14) ═══════════════════════
// The saved filter's relation graph (mockup docs/mockups/15-connector.png):
// filtered items become nodes; edges are the Connector's own labeled
// entity_relation rows (solid, labeled) plus wiki_link references between
// the nodes (dashed). The underlying items stay read-only — only the
// relations themselves are authored here. Shares parseFilterDef/
// applyFilterGroups/openSavedFilterPopup with mod/viewer.js.

const CONNECTOR_VIEWS = ['graph', 'edgelist'];
const CONNECTOR_VIEW_LABEL = { graph: 'Graph', edgelist: 'Edges' };

const connectorZoom = {}; // moduleId -> zoom (render-only state)

async function loadConnectorData(m) {
  const [items, relations, graph, ui] = await Promise.all([
    api.viewer.index(S.nexus.id),
    api.viewer.getRelations(S.nexus.id),
    api.wiki.getGraph(S.nexus.id),
    api.module.getUi(m.id),
  ]);
  const def = parseFilterDef(ui);
  const nodes = applyFilterGroups(items, def, m.id);
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const edges = relations
    .filter(r => byKey.has(r.from_key) && byKey.has(r.to_key))
    .map(r => ({ id: r.id, from: r.from_key, to: r.to_key, label: r.label || '', wiki: false }));
  // wiki_link references between filtered nodes, deduped against relations
  const seen = new Set(edges.map(e2 => `${e2.from}→${e2.to}`));
  const keyOfNode = new Map(graph.nodes.map(n => [n.id, n.key]));
  for (const e2 of graph.edges) {
    if (!e2.wiki) continue;
    const a = keyOfNode.get(e2.source), b = keyOfNode.get(e2.target);
    if (!a || !b || !byKey.has(a) || !byKey.has(b)) continue;
    const dk = `${a}→${b}`, dk2 = `${b}→${a}`;
    if (seen.has(dk) || seen.has(dk2)) continue;
    seen.add(dk);
    edges.push({ id: null, from: a, to: b, label: '', wiki: true });
  }
  const view = CONNECTOR_VIEWS.includes(ui.activeView) ? ui.activeView : 'graph';
  S.connectorData = { moduleId: m.id, def, view, nodes, edges };
}

async function setConnectorView(view) {
  const d = S.connectorData;
  d.view = view;
  await api.module.setUi(d.moduleId, 'activeView', view);
  if (S.inspectorData?.moduleId === d.moduleId) S.inspectorData.ui = { ...S.inspectorData.ui, activeView: view };
  renderNexusHome();
}

function buildConnectorMainHtml(m) {
  const d = (S.connectorData && S.connectorData.moduleId === m.id) ? S.connectorData : null;
  if (!d) return `<div class="empty" style="margin-top:40px"><div class="ei">${moduleIconHtml(m)}</div><h3>${x(m.name)}</h3></div>`;
  const viewBar = `<div class="viewbar">
    ${CONNECTOR_VIEWS.map(v => `<span class="vitem${v === d.view ? ' act' : ''}" onclick="setConnectorView('${v}')" data-no-i18n>${CONNECTOR_VIEW_LABEL[v]}</span>`).join('')}
  </div>`;
  const toolbar = `<div class="classifier-toolbar">
    <button class="btn btn-p" onclick="openConnectorRelationModal()">${I.plus} ${t('addRelation')}</button>
    <span class="vw-filterlabel">Filter:</span>${filterChipsHtml(d.def)}
    <button class="btn btn-g btn-i" onclick="openSavedFilterPopup('connector', this)" title="${t('editFilter')}">${I.edit}</button>
    ${viewBar}
  </div>`;
  if (!d.nodes.length) {
    return `${toolbar}<div class="empty" style="margin-top:30px"><div class="ei">${moduleIconHtml(m)}</div>
      <h3>${x(m.name)}</h3><p>${t('noFilterResults')}</p></div>`;
  }
  if (d.view === 'edgelist') return toolbar + buildConnectorEdgeListHtml(d);
  // The pan/zoom pills sit on a non-scrolling wrapper so the board's
  // scroll position (centered on the node circle) can't carry them away.
  return `${toolbar}
    <div class="cn-wrap">
      <div id="cn-board" class="nar-board cn-board">
        <div id="cn-graph"><svg id="cn-edges"></svg></div>
      </div>
      <div class="chint" data-no-i18n>${t('connectorPanHint')}</div>
      <div class="czoom" data-no-i18n>
        <button class="btn btn-g btn-i" onclick="connectorZoomBy(-0.15)">−</button>
        <span id="cn-zoom-label">100%</span>
        <button class="btn btn-g btn-i" onclick="connectorZoomBy(0.15)">＋</button>
        <span class="cn-count">${d.nodes.length} nodes · ${d.edges.length} relations</span>
      </div>
    </div>`;
}

// ── Graph view: circle-seeded layout, draggable nodes (render-only) ─────
function mountConnectorBoard() {
  const d = S.connectorData;
  if (!d || S.activeModuleNode?.id !== d.moduleId || d.view !== 'graph') return;
  const board = q('#cn-board'), graphEl = q('#cn-graph'), svg = q('#cn-edges');
  if (!board || !graphEl || !svg) return;

  const W = 1600, H = 1100;
  graphEl.style.width = `${W}px`;
  graphEl.style.height = `${H}px`;
  // Session-sticky positions per module so re-renders don't reshuffle.
  S.connectorPos = S.connectorPos || {};
  const posStore = (S.connectorPos[d.moduleId] = S.connectorPos[d.moduleId] || {});
  const cx = W / 2, cy = H / 2;
  const R = Math.min(240, 90 + d.nodes.length * 18); // keep the seed circle inside the viewport
  d.nodes.forEach((n, i) => {
    if (!posStore[n.key]) {
      const a = (2 * Math.PI * i) / d.nodes.length - Math.PI / 2;
      posStore[n.key] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
    }
  });

  const NW = 52; // node circle diameter
  const drawEdges = () => {
    let html = '';
    for (const e2 of d.edges) {
      const a = posStore[e2.from], b = posStore[e2.to];
      if (!a || !b) continue;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      html += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
        stroke="${e2.wiki ? 'var(--t3)' : 'var(--accent)'}" stroke-width="1.5"
        ${e2.wiki ? 'stroke-dasharray="5 4"' : ''} opacity="0.8"></line>`;
      if (e2.label) html += `<foreignObject x="${mx - 70}" y="${my - 11}" width="140" height="22">
        <div class="cn-edge-label" xmlns="http://www.w3.org/1999/xhtml">${x(e2.label)}</div></foreignObject>`;
    }
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.innerHTML = html;
  };
  drawEdges();

  graphEl.querySelectorAll('.cn-node').forEach(el => el.remove());
  for (const n of d.nodes) {
    const p = posStore[n.key];
    const el = document.createElement('div');
    el.className = 'cn-node';
    el.style.left = `${p.x - NW / 2}px`;
    el.style.top = `${p.y - NW / 2}px`;
    el.innerHTML = `<span class="cn-circle" style="border-color:${x(n.color || 'var(--accent)')}">${I.manager || ''}</span>
      <span class="cn-name" data-no-i18n>${x(n.name)}</span>`;
    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      try { el.setPointerCapture(ev.pointerId); } catch (_) {}
      const zoom = connectorZoom[d.moduleId] || 1;
      const sx = ev.clientX, sy = ev.clientY, ox = p.x, oy = p.y;
      let moved = false;
      const mv = (e2) => {
        const dx = (e2.clientX - sx) / zoom, dy = (e2.clientY - sy) / zoom;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        p.x = ox + dx; p.y = oy + dy;
        el.style.left = `${p.x - NW / 2}px`;
        el.style.top = `${p.y - NW / 2}px`;
        drawEdges();
      };
      const up = () => {
        el.removeEventListener('pointermove', mv);
        el.removeEventListener('pointerup', up);
        if (!moved) openViewerItem(n.key, n.moduleId);
      };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', up);
    });
    graphEl.appendChild(el);
  }

  // Right-drag pan + Ctrl-wheel zoom (same chrome as the narrator board).
  const applyZoom = () => {
    const z = connectorZoom[d.moduleId] || 1;
    graphEl.style.transform = `scale(${z})`;
    graphEl.style.transformOrigin = '0 0';
    const lbl = q('#cn-zoom-label');
    if (lbl) lbl.textContent = `${Math.round(z * 100)}%`;
  };
  applyZoom();
  board.addEventListener('contextmenu', (e2) => e2.preventDefault());
  board.addEventListener('pointerdown', (e2) => {
    if (e2.button !== 2) return;
    board.classList.add('is-panning');
    const sx = e2.clientX + board.scrollLeft, sy = e2.clientY + board.scrollTop;
    const mv = (e3) => { board.scrollLeft = sx - e3.clientX; board.scrollTop = sy - e3.clientY; };
    const up = () => {
      board.classList.remove('is-panning');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });
  board.addEventListener('wheel', (e2) => {
    e2.preventDefault();
    connectorZoomBy(e2.deltaY < 0 ? 0.1 : -0.1);
  }, { passive: false });
  // Center the initial scroll on the circle.
  board.scrollLeft = cx - board.clientWidth / 2;
  board.scrollTop = cy - board.clientHeight / 2;
}

function connectorZoomBy(dz) {
  const d = S.connectorData;
  if (!d) return;
  const z = Math.min(2.5, Math.max(0.3, (connectorZoom[d.moduleId] || 1) + dz));
  connectorZoom[d.moduleId] = z;
  const graphEl = q('#cn-graph');
  if (graphEl) {
    graphEl.style.transform = `scale(${z})`;
    graphEl.style.transformOrigin = '0 0';
  }
  const lbl = q('#cn-zoom-label');
  if (lbl) lbl.textContent = `${Math.round(z * 100)}%`;
}

// ── Edge list view ──────────────────────────────────────────────────────
function buildConnectorEdgeListHtml(d) {
  const nameOf = (key) => d.nodes.find(n => n.key === key)?.name || key;
  const rows = d.edges.map(e2 => `
    <tr>
      <td>${x(nameOf(e2.from))}</td>
      <td>${e2.wiki ? `<span class="htag" data-no-i18n>[[wiki]]</span>` : x(e2.label || '—')}</td>
      <td>${x(nameOf(e2.to))}</td>
      <td>${e2.id ? `<span class="acts">
        <button class="btn btn-g btn-i" onclick="editConnectorRelation(${e2.id})" title="${t('edit')}">${I.edit}</button>
        <button class="btn btn-g btn-i" onclick="deleteConnectorRelation(${e2.id})" title="${t('delete')}">${I.delete}</button>
      </span>` : ''}</td>
    </tr>`).join('');
  return `<table class="vw-table">
    <thead><tr><th>${t('relFrom')}</th><th>${t('relationLabel')}</th><th>${t('relTo')}</th><th></th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4" class="ghost">—</td></tr>`}</tbody>
  </table>`;
}

// ── Relation CRUD ───────────────────────────────────────────────────────
function openConnectorRelationModal(relId = null) {
  const d = S.connectorData;
  const rel = relId ? d.edges.find(e2 => e2.id === relId) : null;
  const opts = (sel) => d.nodes.map(n =>
    `<option value="${x(n.key)}" ${sel === n.key ? 'selected' : ''}>${x(n.name)}</option>`).join('');
  openModal(rel ? t('moduleEdit') : t('addRelation'), `
    <div class="fg"><label>${t('relFrom')}</label><select id="cr-from" ${rel ? 'disabled' : ''}>${opts(rel?.from)}</select></div>
    <div class="fg"><label>${t('relTo')}</label><select id="cr-to" ${rel ? 'disabled' : ''}>${opts(rel?.to)}</select></div>
    <div class="fg"><label>${t('relationLabel')}</label><input id="cr-label" value="${x(rel?.label || '')}"></div>
    <div class="mfoot">
      <button class="btn btn-s" onclick="closeModal()">${t('cancel')}</button>
      <button class="btn btn-p" onclick="submitConnectorRelation(${relId ?? 'null'})">${rel ? t('save') : t('create')}</button>
    </div>`);
}

const editConnectorRelation = (id) => openConnectorRelationModal(id);

async function submitConnectorRelation(relId) {
  const d = S.connectorData;
  const label = q('#cr-label').value.trim();
  if (relId) await api.viewer.updateRelation(relId, label);
  else {
    const from = q('#cr-from').value, to = q('#cr-to').value;
    if (!from || !to || from === to) return;
    await api.viewer.createRelation(S.nexus.id, from, to, label);
  }
  closeModal();
  await openModuleNode(d.moduleId);
  toast(relId ? t('saved') : t('created'), 'ok');
}

async function deleteConnectorRelation(id) {
  if (!await uiConfirm(t('moduleDeleteConfirm'))) return;
  await api.viewer.deleteRelation(id);
  await openModuleNode(S.connectorData.moduleId);
  toast(t('deleted'), 'ok');
}
