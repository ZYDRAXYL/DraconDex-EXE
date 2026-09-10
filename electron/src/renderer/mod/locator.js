'use strict';
// ═══ Map "Locator" (progress.md Phase 7) ══════════════════════════════
// Reuses src/renderer/map.js's existing Konva canvas renderer wholesale —
// right-drag pan, wheel zoom, polygon areas with vertex dots were already
// built for Director's Map. selectMapArea/setMapTool/createMapArea/
// saveMapArea/delMapArea were generalized (see refreshMapHost() in
// map.js) to refresh this view instead of Director's renderMapView() when
// the active module is a Locator, so the area list/modal/tools are fully
// shared, not duplicated. A Locator module IS its map — one row,
// auto-created on first open — so Director's map-switcher UI
// (openMapModal et al.) doesn't apply here and isn't used.

async function loadLocatorData(m) {
  await loadModule('src/renderer/map.js');
  await ensureKonva();
  S.map = await api.map.getOrCreateModuleMap(m.id);
  const areas = await api.map.getAreas(S.map.id);
  await Promise.all(areas.map(async (a) => { mapState.pointsByArea[a.id] = await api.map.getPoints(a.id); }));
  if (S.mapAreaId && !areas.find(a => a.id === S.mapAreaId)) S.mapAreaId = null;
  S.locatorAreas = areas;
}

function buildLocatorMainHtml(m) {
  if (!S.map) return `<div class="empty" style="margin-top:40px"><p>${t('nestEmpty')}</p></div>`;
  return `
  <div id="map-board" class="map-whiteboard locator-board">
    <div id="map-konva-container" style="width:100%;height:100%"></div>
    <div class="ctoolbar-float">
      <button class="btn btn-i ${S.mapTool === 'move' ? 'btn-p' : 'btn-s'}" onclick="setMapTool('move')" title="${t('locatorToolMove')}">${I.move}</button>
      <button class="btn btn-i ${S.mapTool === 'create' ? 'btn-p' : 'btn-s'}" onclick="setMapTool('create')" title="${t('locatorToolCreate')}">${I.plus}</button>
      <button class="btn btn-i ${S.mapTool === 'delete' ? 'btn-p' : 'btn-s'}" onclick="setMapTool('delete')" title="${t('locatorToolDelete')}">${I.delete}</button>
    </div>
    <div class="chint">${t('locatorPanHint')}</div>
    <div class="czoom">
      <span class="zbtn" onclick="zoomLocator(-1)">−</span>
      <span class="zlvl" id="locator-zoom-lvl">100%</span>
      <span class="zbtn" onclick="zoomLocator(1)">+</span>
      <span class="zsep"></span>
      <span class="locator-scalelbl" data-no-i18n>24px = 10 km</span>
    </div>
  </div>
  <div class="rel-underboard">
    <div class="ph"><h4>${t('locatorAreas')}</h4><div class="acts"><button class="btn btn-g" onclick="openMapAreaModal()">${I.plus} ${t('locatorAddArea')}</button></div></div>
    <div class="map-area-list" id="locator-area-list">${renderAreaList(S.locatorAreas || [])}</div>
  </div>`;
}

async function mountLocatorBoard() {
  if (!S.map) return;
  const areas = await api.map.getAreas(S.map.id);
  await Promise.all(areas.map(async (a) => { mapState.pointsByArea[a.id] = await api.map.getPoints(a.id); }));
  S.locatorAreas = areas;
  const list = q('#locator-area-list');
  if (list) list.innerHTML = renderAreaList(areas);
  await renderMapBoard();
  updateLocatorZoomLabel();
}

function updateLocatorZoomLabel() {
  const el = q('#locator-zoom-lvl');
  if (el && S.map) el.textContent = `${Math.round(getMapViewState(S.map.id).scale * 100)}%`;
}

function zoomLocator(dir) {
  if (!konvaStage || !S.map) return;
  const v = getMapViewState(S.map.id);
  const center = { x: konvaStage.width() / 2, y: konvaStage.height() / 2 };
  const oldScale = konvaStage.scaleX();
  const focal = { x: (center.x - konvaStage.x()) / oldScale, y: (center.y - konvaStage.y()) / oldScale };
  const newScale = Math.max(0.3, Math.min(4, oldScale * (dir > 0 ? 1.15 : 1 / 1.15)));
  konvaStage.scale({ x: newScale, y: newScale });
  const newPos = { x: center.x - focal.x * newScale, y: center.y - focal.y * newScale };
  konvaStage.position(newPos);
  v.scale = newScale; v.tx = newPos.x; v.ty = newPos.y;
  const layer = konvaStage.getLayers()[0];
  rescaleMapLayer(layer, newScale);
  layer?.batchDraw();
  updateLocatorZoomLabel();
}
