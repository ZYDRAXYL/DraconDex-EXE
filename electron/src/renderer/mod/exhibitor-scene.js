'use strict';
// ═══ Exhibitor — Scene view (v5 Part 2, APP docs/V5.md §3.2–§3.4) ═══════
// The Unity-style canvas: every node is an exhibit_node row, so a layout
// survives closing the module (the pre-v5 Connector kept positions in
// memory only). Three panels:
//   Hierarchy (left)  every node, grouped by parent_id, plus the filtered
//                     items not yet placed — drag one onto the canvas, or +
//   Canvas (middle)   Konva stage; drag nodes, right-drag to pan, wheel to
//                     zoom (the map.js idiom); the camera is exhibit_view
//   Inspector (right) the selected node: label, colour, group, lock/hide,
//                     its relations, "Link to…" and remove
// Relations drawn here are entity_relation rows (solid, arrowed when
// directed); wiki links are dashed and read-only (§3.7). Nest asset rows
// (mod/importdock.js) can be dropped straight onto the canvas too.

let exhStage = null;
let exhViewSaveTimer = null;
const EXH_BOX = { w: 168, h: 46 };
const EXH_NOTE = { w: 170, h: 90 };
const EXH_GROUP = { w: 340, h: 230 };
const EXH_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

// Konva paints on a canvas, so theme colours are read off the live CSS
// variables at mount time — a theme switch re-renders and picks them up.
const exhCss = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();

const exhNodeById = (id) => S.exhibitorData?.nodes.find(n => n.id === id) || null;

function exhNodeTitle(n) {
  if (n.label) return n.label;
  if (n.linker_key) return exhNameOf(n.linker_key);
  return n.node_type === 'group' ? t('exhibitorGroup') : t('exhibitorNote');
}

function exhNodeSize(n) {
  if (n.node_type === 'group') return { w: n.w || EXH_GROUP.w, h: n.h || EXH_GROUP.h };
  if (n.node_type === 'note') return { w: n.w || EXH_NOTE.w, h: n.h || EXH_NOTE.h };
  if (exhIsImageAsset(n)) return { w: n.w || 150, h: n.h || 118 };
  return { w: n.w || EXH_BOX.w, h: n.h || EXH_BOX.h };
}

function exhIsImageAsset(n) {
  const it = n.linker_key && S.exhibitorData?.index.get(n.linker_key);
  return !!(it && it.kind === 'file' && EXH_IMAGE_EXTS.has(String(it.fileType || '').toLowerCase()));
}

// ── HTML shell ──────────────────────────────────────────────────────────
function buildExhibitorSceneHtml(d) {
  const placed = new Set(d.nodes.map(n => n.linker_key).filter(Boolean));
  const palette = d.items.filter(it => !placed.has(it.key));
  const sel = d.sel != null ? exhNodeById(d.sel) : null;
  return `<div class="exh-scene">
    <aside class="exh-hier">
      <div class="exh-hier-head"><span>${t('exhibitorHierarchy')}</span>
        <span class="acts">
          <button class="btn btn-g btn-i" onclick="addExhibitorFreeNode('note')" title="${x(t('exhibitorAddNote'))}">${I.plus}</button>
          <button class="btn btn-g btn-i" onclick="addExhibitorFreeNode('group')" title="${x(t('exhibitorAddGroup'))}">${I.folder || I.plus}</button>
        </span></div>
      <div class="exh-hier-list">${buildExhibitorHierarchyRows(d, null, 0) || `<div class="ghost exh-empty">${t('exhibitorSceneEmpty')}</div>`}</div>
      <div class="exh-hier-head"><span>${t('exhibitorAddFromFilter')}</span><span class="cnt">${palette.length}</span></div>
      <input class="exh-search" placeholder="${x(t('name'))}" oninput="filterExhibitorPalette(this.value)">
      <div class="exh-palette" id="exh-palette">${palette.map(it => `
        <div class="li exh-pal-row" draggable="true" data-name="${x(it.name.toLowerCase())}"
            ondragstart="S.dragExhKey=${xj(it.key)};event.dataTransfer.effectAllowed='copy'" ondragend="S.dragExhKey=null">
          <span class="name" data-no-i18n>${x(it.name)}</span>
          <span class="kind" data-no-i18n>${VIEWER_KIND_LABEL[it.kind] || it.kind}</span>
          <button class="btn btn-g btn-i" onclick="addExhibitorItemAtCenter(${xj(it.key)})" title="${x(t('create'))}">${I.plus}</button>
        </div>`).join('')}</div>
    </aside>
    <div class="exh-stage-wrap${d.linkFrom ? ' exh-linking' : ''}" id="exh-stage-wrap"
        ondragover="if(S.dragExhKey||S.dragAsset){event.preventDefault()}" ondrop="dropOnExhibitorScene(event)">
      <div id="exh-konva"></div>
      ${d.linkFrom ? `<div class="exh-linkbar">${t('exhibitorLinkPick')}
        <button class="btn btn-s btn-sm" onclick="cancelExhibitorLink()">${t('cancel')}</button></div>` : ''}
      <div class="chint" data-no-i18n>${t('exhibitorSceneHint')}</div>
      <div class="czoom" data-no-i18n>
        <button class="btn btn-g btn-i" onclick="zoomExhibitorScene(0.9)">−</button>
        <span id="exh-zoom-label">${Math.round((d.camera.scale || 1) * 100)}%</span>
        <button class="btn btn-g btn-i" onclick="zoomExhibitorScene(1.1)">＋</button>
        <button class="btn btn-g btn-sm" onclick="fitExhibitorScene()">${t('exhibitorFit')}</button>
      </div>
    </div>
    ${sel ? buildExhibitorInspectorHtml(d, sel) : ''}
  </div>`;
}

function buildExhibitorHierarchyRows(d, parentId, depth) {
  return d.nodes.filter(n => (n.parent_id ?? null) === parentId).map(n => {
    const kids = n.node_type === 'group' ? buildExhibitorHierarchyRows(d, n.id, depth + 1) : '';
    const missing = n.linker_key && !d.index.has(n.linker_key);
    const cls = ['li', depth ? `indent${Math.min(depth, 5)}` : '', d.sel === n.id ? 'sel' : '',
      n.hidden ? 'exh-hidden' : '', missing ? 'asset-missing' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}"
        onclick="selectExhibitorNode(${n.id})" ondblclick="openExhibitorNodeTarget(${n.id})">
      <span class="name" data-no-i18n>${x(exhNodeTitle(n))}</span>
      <span class="acts">
        <button class="btn btn-g btn-i" onclick="event.stopPropagation();patchExhibitorNode(${n.id},{hidden:${n.hidden ? 0 : 1}})" title="${x(t('exhibitorHidden'))}" data-no-i18n>${n.hidden ? '◌' : '●'}</button>
        <button class="btn btn-g btn-i" onclick="event.stopPropagation();patchExhibitorNode(${n.id},{locked:${n.locked ? 0 : 1}})" title="${x(t('exhibitorLocked'))}" data-no-i18n>${n.locked ? '⊠' : '□'}</button>
      </span>
    </div>${kids}`;
  }).join('');
}

function buildExhibitorInspectorHtml(d, n) {
  const it = n.linker_key ? d.index.get(n.linker_key) : null;
  const groups = d.nodes.filter(g => g.node_type === 'group' && g.id !== n.id);
  const rels = n.linker_key ? d.relations.filter(r => r.from_key === n.linker_key || r.to_key === n.linker_key) : [];
  const relRows = rels.map(r => {
    const out = r.from_key === n.linker_key;
    const other = out ? r.to_key : r.from_key;
    const arrow = r.directed === 0 ? '—' : out ? '→' : '←';
    return `<div class="cls-link-row">
      <span data-no-i18n>${arrow}</span>
      <span class="cls-link-name" onclick="openExhibitorRelationModal(${r.id})">${x(exhNameOf(other))}</span>
      ${r.label || r.rel_type ? `<span class="cls-link-lbl">${x([r.label, r.rel_type && `(${r.rel_type})`].filter(Boolean).join(' '))}</span>` : ''}
    </div>`;
  }).join('');
  return `<aside class="exh-insp">
    <div class="exh-hier-head"><span data-no-i18n>${x(exhNodeTitle(n))}</span>
      <button class="btn btn-g btn-i" onclick="selectExhibitorNode(null)" title="${x(t('cancel'))}" data-no-i18n>✕</button></div>
    ${it ? `<div class="drafter-hint" data-no-i18n>${VIEWER_KIND_LABEL[it.kind] || it.kind}${it.moduleName ? ` · ${x(it.moduleName)}` : ''}</div>
      <button class="btn btn-s btn-sm" onclick="openExhibitorNodeTarget(${n.id})">${t('exhibitorOpenItem')}</button>` : ''}
    <div class="fg"><label>${t('exhibitorLabel')}</label>
      <input value="${x(n.label || '')}" placeholder="${x(it ? it.name : '')}" onchange="patchExhibitorNode(${n.id},{label:this.value.trim()||null})"></div>
    <div class="fg"><label>${t('color')}</label>
      <input type="color" value="${x(n.color || (exhCss('--accent') || '#6366f1'))}" onchange="patchExhibitorNode(${n.id},{color:this.value})"></div>
    ${n.node_type !== 'group' ? `<div class="fg"><label>${t('exhibitorGroup')}</label>
      <select onchange="patchExhibitorNode(${n.id},{parent_id:this.value?Number(this.value):null})">
        <option value="">—</option>
        ${groups.map(g => `<option value="${g.id}" ${n.parent_id === g.id ? 'selected' : ''}>${x(exhNodeTitle(g))}</option>`).join('')}
      </select></div>` : ''}
    <label class="fv-useimg"><input type="checkbox" ${n.locked ? 'checked' : ''} onchange="patchExhibitorNode(${n.id},{locked:this.checked?1:0})"> ${t('exhibitorLocked')}</label>
    <label class="fv-useimg"><input type="checkbox" ${n.hidden ? 'checked' : ''} onchange="patchExhibitorNode(${n.id},{hidden:this.checked?1:0})"> ${t('exhibitorHidden')}</label>
    ${n.linker_key ? `<div class="insp-label cls-link-label">${t('linkedElements')}</div>
      <div class="cls-link-list">${relRows || `<div class="cls-lv-empty">${t('noLinkedElements')}</div>`}</div>
      <button class="btn btn-p btn-sm" onclick="startExhibitorLink(${n.id})">${I.relation} ${t('exhibitorLinkTo')}</button>` : ''}
    <button class="btn btn-d btn-sm" onclick="removeExhibitorNode(${n.id})">${t('exhibitorRemoveNode')}</button>
  </aside>`;
}

function filterExhibitorPalette(v) {
  const needle = String(v || '').trim().toLowerCase();
  document.querySelectorAll('#exh-palette .exh-pal-row').forEach(row => {
    row.style.display = !needle || row.dataset.name.includes(needle) ? '' : 'none';
  });
}

// ── Canvas ──────────────────────────────────────────────────────────────
async function mountExhibitorScene() {
  const d = S.exhibitorData;
  const host = q('#exh-konva');
  const wrap = q('#exh-stage-wrap');
  if (!d || !host || !wrap) return;
  await ensureKonva();
  if (S.exhibitorData !== d || !document.body.contains(host)) return; // re-rendered while loading
  if (exhStage) { try { exhStage.destroy(); } catch (_) {} }
  const stage = new Konva.Stage({ container: host, width: wrap.clientWidth, height: Math.max(360, wrap.clientHeight) });
  exhStage = stage;
  const cam = d.camera || {};
  const fresh = !cam.tx && !cam.ty;
  stage.scale({ x: cam.scale || 1, y: cam.scale || 1 });
  stage.position(fresh ? { x: stage.width() / 2, y: stage.height() / 2 } : { x: cam.tx, y: cam.ty });
  const edgeLayer = new Konva.Layer();
  const nodeLayer = new Konva.Layer();
  stage.add(edgeLayer);
  stage.add(nodeLayer);

  const col = {
    accent: (exhCss('--accent') || '#6366f1'), text: (exhCss('--t1') || '#e5e7eb'), dim: (exhCss('--t3') || '#6b7280'),
    surface: (exhCss('--surface') || '#1f2937'), raised: (exhCss('--raised') || '#374151'), border: (exhCss('--border') || '#4b5563'),
  };
  const shapes = new Map();   // node id -> Konva.Group
  const byKey = new Map();    // linker_key -> node
  const visible = d.nodes.filter(n => !n.hidden);
  for (const n of visible) if (n.linker_key) byKey.set(n.linker_key, n);
  // Groups first so they sit underneath their members.
  const ordered = [...visible].sort((a, b) => (a.node_type === 'group' ? 0 : 1) - (b.node_type === 'group' ? 0 : 1) || a.z - b.z);
  for (const n of ordered) {
    const g = exhDrawNode(n, col, d);
    shapes.set(n.id, g);
    nodeLayer.add(g);
    exhWireNode(g, n, d, shapes, () => drawEdges());
  }

  const center = (n) => { const s = exhNodeSize(n); return { x: n.x + s.w / 2, y: n.y + s.h / 2, hw: s.w / 2, hh: s.h / 2 }; };
  function drawEdges() {
    edgeLayer.destroyChildren();
    for (const e2 of exhibitorEdgesAmong(new Set(byKey.keys()))) {
      const a = center(byKey.get(e2.from)), b = center(byKey.get(e2.to));
      const end = exhClipToBox(a, b);
      const stroke = e2.wiki ? col.dim : (e2.color || col.accent);
      const arrow = new Konva.Arrow({
        points: [a.x, a.y, end.x, end.y], stroke, fill: stroke, strokeWidth: 1.6,
        pointerLength: e2.directed ? 9 : 0, pointerWidth: e2.directed ? 8 : 0,
        dash: e2.wiki ? [6, 5] : undefined, hitStrokeWidth: 10, opacity: 0.85,
      });
      if (e2.id) {
        arrow.on('click', () => openExhibitorRelationModal(e2.id));
        arrow.on('mouseenter', () => { stage.container().style.cursor = 'pointer'; });
        arrow.on('mouseleave', () => { stage.container().style.cursor = ''; });
      }
      edgeLayer.add(arrow);
      const text = [e2.label, e2.relType && `(${e2.relType})`].filter(Boolean).join(' ');
      if (text) {
        edgeLayer.add(new Konva.Text({
          x: (a.x + end.x) / 2 - 70, y: (a.y + end.y) / 2 - 8, width: 140, align: 'center',
          text, fontSize: 11, fill: col.text, listening: false,
        }));
      }
    }
    edgeLayer.batchDraw();
  }
  drawEdges();
  nodeLayer.draw();

  // Empty-canvas click clears the selection (and a pending link).
  stage.on('click', (ev) => {
    if (ev.target !== stage || ev.evt.button !== 0) return;
    if (d.linkFrom) { cancelExhibitorLink(); return; }
    if (d.sel != null) selectExhibitorNode(null);
  });
  // Right-drag pan + wheel zoom toward the pointer — the map.js idiom.
  const box = stage.container();
  box.addEventListener('contextmenu', (e) => e.preventDefault());
  box.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return;
    const sx = e.clientX, sy = e.clientY, ox = stage.x(), oy = stage.y();
    box.classList.add('is-panning');
    const mv = (e2) => { stage.position({ x: ox + e2.clientX - sx, y: oy + e2.clientY - sy }); stage.batchDraw(); };
    const up = () => {
      box.classList.remove('is-panning');
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      saveExhibitorCamera();
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });
  stage.on('wheel', (ev) => {
    ev.evt.preventDefault();
    zoomExhibitorScene(ev.evt.deltaY < 0 ? 1.1 : 0.9, stage.getPointerPosition());
  });
}

// Where the edge from a's centre meets b's box, so the arrowhead shows
// instead of hiding under the target node.
function exhClipToBox(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  if (!dx && !dy) return { x: b.x, y: b.y };
  const tx = dx ? b.hw / Math.abs(dx) : Infinity, ty = dy ? b.hh / Math.abs(dy) : Infinity;
  const k = Math.min(tx, ty, 1);
  return { x: b.x + dx * k, y: b.y + dy * k };
}

function exhDrawNode(n, col, d) {
  const size = exhNodeSize(n);
  const stroke = n.color || col.accent;
  const selected = d.sel === n.id || d.linkFrom === n.id;
  const g = new Konva.Group({ x: n.x, y: n.y, draggable: !n.locked, id: `exh-${n.id}` });
  const title = exhNodeTitle(n);
  if (n.node_type === 'group') {
    g.add(new Konva.Rect({ width: size.w, height: size.h, stroke, strokeWidth: selected ? 3 : 1.5, dash: [8, 5], cornerRadius: 10, fill: col.surface, opacity: 0.55 }));
    g.add(new Konva.Text({ x: 10, y: 8, text: title, fontSize: 13, fontStyle: 'bold', fill: col.text }));
    return g;
  }
  if (n.node_type === 'note') {
    g.add(new Konva.Rect({ width: size.w, height: size.h, fill: col.raised, stroke, strokeWidth: selected ? 3 : 1, cornerRadius: 4 }));
    g.add(new Konva.Text({ x: 8, y: 8, width: size.w - 16, height: size.h - 16, text: title, fontSize: 12, fill: col.text, ellipsis: true }));
    return g;
  }
  const it = n.linker_key ? d.index.get(n.linker_key) : null;
  const missing = n.linker_key && !it;
  if (exhIsImageAsset(n)) {
    const frame = new Konva.Rect({ width: size.w, height: size.h, fill: col.surface, stroke, strokeWidth: selected ? 3 : 1, cornerRadius: 6 });
    g.add(frame);
    const fileId = Number(n.linker_key.slice(5));
    const img = new Image();
    img.onload = () => {
      const pad = 6, capH = 20;
      const s = Math.min((size.w - pad * 2) / img.width, (size.h - pad * 2 - capH) / img.height, 1);
      g.add(new Konva.Image({ image: img, x: (size.w - img.width * s) / 2, y: pad, width: img.width * s, height: img.height * s, listening: false }));
      g.getLayer()?.batchDraw();
    };
    // A missing original falls back to the stored cover proxy (§2.5).
    img.onerror = () => { if (!img.src.includes('proxy=1')) img.src = `${displayImageUrl(fileId)}?proxy=1`; };
    img.src = displayImageUrl(fileId);
    g.add(new Konva.Text({ x: 6, y: size.h - 18, width: size.w - 12, text: title, fontSize: 11, fill: col.text, ellipsis: true, wrap: 'none' }));
    return g;
  }
  g.add(new Konva.Rect({ width: size.w, height: size.h, fill: col.surface, stroke, strokeWidth: selected ? 3 : 1.4, cornerRadius: 8, opacity: missing ? 0.5 : 1 }));
  g.add(new Konva.Text({ x: 10, y: 7, width: size.w - 20, text: title, fontSize: 13, fill: col.text, ellipsis: true, wrap: 'none' }));
  g.add(new Konva.Text({
    x: 10, y: 26, width: size.w - 20, fontSize: 10, fill: col.dim, ellipsis: true, wrap: 'none',
    text: missing ? '?' : `${VIEWER_KIND_LABEL[it?.kind] || it?.kind || n.node_type}${it?.moduleName ? ` · ${it.moduleName}` : ''}`,
  }));
  return g;
}

function exhWireNode(g, n, d, shapes, redrawEdges) {
  // A group carries its members along: their offsets are captured at drag
  // start and re-applied on every move, then all of them save in one write.
  let members = [];
  g.on('dragstart', () => {
    members = n.node_type === 'group'
      ? d.nodes.filter(m => m.parent_id === n.id && shapes.has(m.id)).map(m => ({ m, dx: m.x - n.x, dy: m.y - n.y }))
      : [];
  });
  g.on('dragmove', () => {
    n.x = g.x(); n.y = g.y();
    for (const { m, dx, dy } of members) {
      if (m.locked) continue;
      m.x = n.x + dx; m.y = n.y + dy;
      shapes.get(m.id).position({ x: m.x, y: m.y });
    }
    redrawEdges();
  });
  g.on('dragend', () => {
    const moves = [{ id: n.id, x: n.x, y: n.y }, ...members.filter(({ m }) => !m.locked).map(({ m }) => ({ id: m.id, x: m.x, y: m.y }))];
    api.exhibitor.moveNodes(moves);
  });
  g.on('click', (ev) => {
    if (ev.evt.button !== 0) return;
    ev.cancelBubble = true;
    if (d.linkFrom != null) { finishExhibitorLink(n.id); return; }
    selectExhibitorNode(n.id);
  });
  g.on('dblclick', () => openExhibitorNodeTarget(n.id));
  g.on('mouseenter', () => { g.getStage().container().style.cursor = n.locked ? 'pointer' : 'move'; });
  g.on('mouseleave', () => { g.getStage().container().style.cursor = ''; });
}

// ── Camera ──────────────────────────────────────────────────────────────
function saveExhibitorCamera() {
  const d = S.exhibitorData;
  if (!d || !exhStage) return;
  d.camera = { ...d.camera, scale: exhStage.scaleX(), tx: exhStage.x(), ty: exhStage.y() };
  const lbl = q('#exh-zoom-label');
  if (lbl) lbl.textContent = `${Math.round(exhStage.scaleX() * 100)}%`;
  clearTimeout(exhViewSaveTimer);
  const { moduleId } = d;
  const patch = { scale: d.camera.scale, tx: d.camera.tx, ty: d.camera.ty };
  exhViewSaveTimer = setTimeout(() => api.exhibitor.setView(moduleId, patch), 400);
}

function zoomExhibitorScene(factor, pointer) {
  const stage = exhStage;
  if (!stage) return;
  const old = stage.scaleX();
  const next = Math.min(4, Math.max(0.2, old * factor));
  const p = pointer || { x: stage.width() / 2, y: stage.height() / 2 };
  const world = { x: (p.x - stage.x()) / old, y: (p.y - stage.y()) / old };
  stage.scale({ x: next, y: next });
  stage.position({ x: p.x - world.x * next, y: p.y - world.y * next });
  stage.batchDraw();
  saveExhibitorCamera();
}

function fitExhibitorScene() {
  const d = S.exhibitorData;
  const stage = exhStage;
  const shown = d?.nodes.filter(n => !n.hidden) || [];
  if (!stage || !shown.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of shown) {
    const s = exhNodeSize(n);
    x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + s.w); y1 = Math.max(y1, n.y + s.h);
  }
  const pad = 60;
  const scale = Math.min(2, Math.max(0.2, Math.min(stage.width() / (x1 - x0 + pad * 2), stage.height() / (y1 - y0 + pad * 2))));
  stage.scale({ x: scale, y: scale });
  stage.position({ x: stage.width() / 2 - ((x0 + x1) / 2) * scale, y: stage.height() / 2 - ((y0 + y1) / 2) * scale });
  stage.batchDraw();
  saveExhibitorCamera();
}

// World coordinates of the visible centre, for "+" adds.
function exhViewCenter() {
  const s = exhStage;
  if (!s) return { x: 0, y: 0 };
  return { x: (s.width() / 2 - s.x()) / s.scaleX(), y: (s.height() / 2 - s.y()) / s.scaleX() };
}

// ── Node actions ────────────────────────────────────────────────────────
async function addExhibitorNodesAndRefresh(nodes) {
  const d = S.exhibitorData;
  if (!d || !nodes.length) return;
  const ids = await api.exhibitor.addNodes(d.moduleId, nodes);
  await refreshExhibitor();
  if (ids?.length === 1) selectExhibitorNode(ids[0]);
}

function exhTypeForKey(key) {
  return S.exhibitorData?.index.get(key)?.kind === 'file' ? 'asset' : 'entity';
}

function addExhibitorItemAtCenter(key) {
  const c = exhViewCenter();
  addExhibitorNodesAndRefresh([{ linker_key: key, node_type: exhTypeForKey(key), x: c.x - EXH_BOX.w / 2, y: c.y - EXH_BOX.h / 2 }]);
}

function addExhibitorFreeNode(type) {
  const c = exhViewCenter();
  const size = type === 'group' ? EXH_GROUP : EXH_NOTE;
  addExhibitorNodesAndRefresh([{ node_type: type, label: type === 'group' ? t('exhibitorGroup') : t('exhibitorNote'), x: c.x - size.w / 2, y: c.y - size.h / 2 }]);
}

// Drop target for the palette rows here and for Nest asset rows
// (mod/importdock.js sets S.dragAsset) — an asset lands as file_<id>.
function dropOnExhibitorScene(ev) {
  ev.preventDefault();
  const key = S.dragExhKey || (S.dragAsset != null ? `file_${S.dragAsset}` : null);
  S.dragExhKey = null;
  S.dragAsset = null;
  if (!key || !exhStage) return;
  exhStage.setPointersPositions(ev);
  const p = exhStage.getPointerPosition() || { x: exhStage.width() / 2, y: exhStage.height() / 2 };
  const s = exhStage.scaleX();
  addExhibitorNodesAndRefresh([{
    linker_key: key, node_type: key.startsWith('file_') ? 'asset' : exhTypeForKey(key),
    x: (p.x - exhStage.x()) / s - EXH_BOX.w / 2, y: (p.y - exhStage.y()) / s - EXH_BOX.h / 2,
  }]);
}

function selectExhibitorNode(id) {
  const d = S.exhibitorData;
  if (!d) return;
  d.sel = id;
  renderNexusHome();
}

async function patchExhibitorNode(id, patch) {
  const n = exhNodeById(id);
  if (!n) return;
  if (patch.parent_id === id) return; // a group cannot contain itself
  Object.assign(n, patch);
  await api.exhibitor.updateNode(id, patch);
  renderNexusHome();
}

// Removes the node from this scene only — the entity or asset it shows is
// untouched, and so are its relations (they are vault-wide).
async function removeExhibitorNode(id) {
  if (!await uiConfirm(t('exhibitorRemoveConfirm'))) return;
  const d = S.exhibitorData;
  await api.exhibitor.deleteNode(id);
  if (d.sel === id) d.sel = null;
  await refreshExhibitor();
}

function openExhibitorNodeTarget(id) {
  const n = exhNodeById(id);
  const it = n?.linker_key ? S.exhibitorData.index.get(n.linker_key) : null;
  if (it) openViewerItem(it.key, it.moduleId);
}

// "Link to…": pick the source in the Inspector, then click the target on
// the canvas; the relation form opens with both ends filled in.
function startExhibitorLink(id) {
  const d = S.exhibitorData;
  if (!d || !exhNodeById(id)?.linker_key) return;
  d.linkFrom = id;
  renderNexusHome();
}

function cancelExhibitorLink() {
  const d = S.exhibitorData;
  if (!d) return;
  d.linkFrom = null;
  renderNexusHome();
}

function finishExhibitorLink(targetId) {
  const d = S.exhibitorData;
  const from = exhNodeById(d.linkFrom), to = exhNodeById(targetId);
  d.linkFrom = null;
  if (!from?.linker_key || !to?.linker_key || from.id === to.id) { renderNexusHome(); return; }
  renderNexusHome();
  openExhibitorRelationModal(null, from.linker_key, to.linker_key);
}
