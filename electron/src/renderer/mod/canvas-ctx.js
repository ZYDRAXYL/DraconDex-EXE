'use strict';
// ═══ Canvas context menus (v5 Part 3, APP docs/V5.md §7.2 / §7.6) ═══════
// The eight boards that used to swallow right-click with preventDefault()
// and offer nothing. Each board binds itself with bindCanvasCtx (hub/
// ctxmenu.js) in its own mount; the menus live here so the whole "what can I
// do on an empty canvas" answer reads in one place. Per §7.1 these are the
// Contextual/Advanced tiers — nothing here is new capability, every item is
// an action the board's toolbar or modal already had.

const ctxZoomPair = (zoomIn, zoomOut) => [
  { label: t('ctxZoomIn'), icon: 'plus', onClick: zoomIn },
  { label: t('ctxZoomOut'), icon: 'minus', onClick: zoomOut },
];

CTX_PROVIDERS['designer.canvas'] = () => {
  const d = S.designerData;
  if (!d) return [];
  return [
    { label: t('ctxAddShape'), icon: 'plus', sub: () => DG_SHAPES.map(sh => ({ label: `${DG_SHAPE_GLYPH[sh] || ''}  ${sh}`, onClick: () => addDesignNode(sh) })) },
    { label: t('pinModuleLink'), icon: 'relation', onClick: () => openDesignPinModal() },
    { label: t('edgeTool'), icon: 'move', onClick: () => startDesignEdge() },
    { sep: true },
    ...ctxZoomPair(() => designerZoomBy(0.15), () => designerZoomBy(-0.15)),
    { sep: true },
    { label: t('narratorLinkFilter'), icon: 'options', onClick: () => openDesignerLinkFilterModal(d.moduleId) },
  ];
};

CTX_PROVIDERS['sketcher.canvas'] = () => {
  const d = S.sketcherData;
  if (!d) return [];
  return [
    { label: t('penTool'), checked: skTool.mode === 'pen', onClick: () => setSketchTool('pen') },
    { label: t('eraserTool'), checked: skTool.mode === 'eraser', onClick: () => setSketchTool('eraser') },
    { label: t('pinModuleLink'), icon: 'relation', onClick: () => openSketchPinModal() },
    { sep: true },
    { label: t('newPage'), icon: 'plus', onClick: () => openSketchPageModal(d.moduleId) },
    { label: t('exportPng'), icon: 'export', onClick: () => exportSketchPng() },
    { sep: true },
    ...ctxZoomPair(() => sketchZoomBy(0.15), () => sketchZoomBy(-0.15)),
  ];
};

CTX_PROVIDERS['narrator.canvas'] = () => {
  const d = S.narratorData;
  if (!d) return [];
  return [
    { label: t('addDialogue'), icon: 'plus', onClick: () => openNarratorDialogueModal(d.moduleId) },
    { sep: true },
    ...ctxZoomPair(() => zoomNarrator(1), () => zoomNarrator(-1)),
  ];
};

CTX_PROVIDERS['manager.graph'] = () => ctxZoomPair(() => managerZoomBy(0.15), () => managerZoomBy(-0.15));

// Chronicler's downline graph and the one-line / compare timeline share a
// menu: both are views of the same line.
CTX_PROVIDERS['chronicler.graph'] = ({ resettable } = {}) => {
  const d = S.chroniclerData;
  if (!d) return [];
  return [
    d.activeId ? { label: t('addEvent'), icon: 'plus', onClick: () => openChroniclerEventModal(d.activeId) } : null,
    { label: t('chrGraphOptions'), icon: 'options', onClick: () => openChroniclerGraphOptions(ctxAnchor()) },
    resettable ? { label: t('chrResetView'), icon: 'return', onClick: () => resetChroniclerDownlineView() } : null,
  ].filter(Boolean);
};

CTX_PROVIDERS['sagehut.graph'] = () => SAGEHUT_VIEWS.map(v => ({
  label: SAGEHUT_VIEW_LABEL[v], checked: S.sageHut?.tab === v, onClick: () => openSageTab(v),
}));

CTX_PROVIDERS['exhibitor.graph'] = () => [
  { label: t('addRelation'), icon: 'plus', onClick: () => openExhibitorRelationModal() },
  { label: t('exhibitorOpenScene'), icon: 'relation', onClick: () => setExhibitorView('scene') },
  { sep: true },
  ...ctxZoomPair(() => exhibitorGraphZoomBy(0.1), () => exhibitorGraphZoomBy(-0.1)),
];
