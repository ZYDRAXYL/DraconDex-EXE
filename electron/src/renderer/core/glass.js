'use strict';
// Glass (Procress 23, APP Plan.md · docs/UX-LAYOUT.md) — the runtime half of
// css/glass.css. The stylesheet decides WHAT is glass; this file keeps blur
// affordable, which a stylesheet cannot do on its own:
//
//   · at most GLASS_BLUR_MAX blurred layers on screen at once — the newest
//     (topmost) keep their blur, older ones are marked data-glass-flat and
//     fall back to tint only (the same look a machine without backdrop-filter
//     gets). A context menu + its submenu + a picker over a modal is 4.
//   · no blur while the window is being resized or something is being dragged
//     (body.glass-moving) — every frame of either repaints what is under each
//     blurred layer.
//
// Runs only while glass is on (the built-in style, or a uistyle package that
// carries the glass tokens — body[data-glass]); glassSync() is called by
// applyUiSettings() on every change and starts or stops both watchers.
const GLASS_BLUR_MAX = 4;
// Must name the same layers css/glass.css blurs.
const GLASS_BLUR_SEL = '.popover, .floating-panel, #qs-box, #toast.show, #modal-overlay:not(.hidden), #confirm-overlay, #settings-menu:not(.hidden), #layout-menu:not(.hidden)';
let _glassObs = null, _glassRaf = 0, _glassMoveTimer = 0;

function glassOn() {
  const b = document.body;
  return !!b && (b.dataset.uiStyle === 'glass' || 'glass' in b.dataset);
}

// The blurred layers, bottom first: by z-index, then by document order (a
// later sibling paints over an earlier one at the same z).
function glassBlurredLayers() {
  const els = [...document.querySelectorAll(GLASS_BLUR_SEL)].filter(el => el.getClientRects().length);
  const z = el => Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
  return els.map((el, i) => ({ el, i, z: z(el) })).sort((a, b) => a.z - b.z || a.i - b.i).map(o => o.el);
}

function glassEnforceBudget() {
  _glassRaf = 0;
  const layers = glassOn() ? glassBlurredLayers() : [];
  const flat = new Set(layers.slice(0, Math.max(0, layers.length - GLASS_BLUR_MAX)));
  for (const el of document.querySelectorAll('[data-glass-flat]')) if (!flat.has(el)) delete el.dataset.glassFlat;
  for (const el of flat) el.dataset.glassFlat = '';
}
function glassSchedule() {
  if (!_glassRaf) _glassRaf = requestAnimationFrame(glassEnforceBudget);
}

function glassMoving() {
  document.body.classList.add('glass-moving');
  clearTimeout(_glassMoveTimer);
  _glassMoveTimer = setTimeout(glassStill, 200);
}
function glassStill() {
  clearTimeout(_glassMoveTimer);
  document.body.classList.remove('glass-moving');
}
// A drag holds the class until it ends; a resize-handle drag likewise until
// the button comes up. A window resize has no end event, so it times out.
function glassDragStart() { clearTimeout(_glassMoveTimer); document.body.classList.add('glass-moving'); }
function glassHandleDown(e) { if (e.target.closest?.('.panel-resize-handle')) glassDragStart(); }

function glassSync() {
  if (!document.body) return;
  const on = glassOn();
  if (on && !_glassObs) {
    _glassObs = new MutationObserver(glassSchedule);
    _glassObs.observe(document.body, { childList: true });
    // the layers that live in index.html and only toggle a class
    for (const id of ['modal-overlay', 'toast', 'settings-menu', 'layout-menu']) {
      const el = document.getElementById(id);
      if (el) _glassObs.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    window.addEventListener('resize', glassMoving);
    document.addEventListener('dragstart', glassDragStart, true);
    document.addEventListener('dragend', glassStill, true);
    document.addEventListener('drop', glassStill, true);
    document.addEventListener('mousedown', glassHandleDown, true);
    document.addEventListener('mouseup', glassStill, true);
  } else if (!on && _glassObs) {
    _glassObs.disconnect();
    _glassObs = null;
    window.removeEventListener('resize', glassMoving);
    document.removeEventListener('dragstart', glassDragStart, true);
    document.removeEventListener('dragend', glassStill, true);
    document.removeEventListener('drop', glassStill, true);
    document.removeEventListener('mousedown', glassHandleDown, true);
    document.removeEventListener('mouseup', glassStill, true);
    glassStill();
  }
  glassSchedule();
}
glassSync();
