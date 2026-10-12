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

// ── legibility guard ───────────────────────────────────────────────────
// SDB raises --glass-tint per built-in theme so text on a pane keeps 4.5:1
// over the worst point of the backdrop (generated tokens.css). A custom
// theme, a theme package or a glass uistyle package has no such override —
// so the same check runs here, on the palette actually applied, and raises
// the tint inline (never lowers it) when the stylesheet's value falls short.
// --danger: menus write "Delete" in it. A token that already misses 4.5:1 on
// the solid surface is the theme's own problem, not glass's — it is left out,
// or one weak colour would push the tint to 100 % and switch glass off.
const GLASS_TEXT_TOKENS = ['--t1', '--t2', '--t3-aa', '--danger'];
// Resolved through the (invisible) screen-reader live region's own colour,
// so var()/color-mix() computes exactly as the panes will — then restored.
function glassRgb(css) {
  const probe = document.getElementById('sr-live') || document.body;
  const was = probe.style.color;
  probe.style.color = css;
  const c = getComputedStyle(probe).color;
  probe.style.color = was;
  let m = /rgba?\(([^)]+)\)/.exec(c);
  if (m) return m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number);
  m = /color\(srgb ([^)]+)\)/.exec(c);
  return m ? m[1].split(/[ /]+/).filter(Boolean).slice(0, 3).map(v => Number(v) * 255) : null;
}
function glassContrast(a, b) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = ([r, g, b2]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b2);
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// The lowest tint (%, whole) from `from` up at which every text token reads
// ≥ 4.5:1 on the surface mixed over both ends of the backdrop.
function glassTintNeeded(from) {
  const surface = glassRgb('var(--surface)');
  const ends = [glassRgb('var(--glass-backdrop-from, var(--bg))'), glassRgb('var(--glass-backdrop-to, var(--bg))')];
  if (!surface || ends.some(e => !e)) return from;
  const texts = GLASS_TEXT_TOKENS.map(k => glassRgb(`var(${k}, var(--t2))`)).filter(c => c && glassContrast(c, surface) >= 4.5);
  for (let tint = from; tint < 100; tint++) {
    const a = tint / 100;
    const ok = ends.every(e => {
      const pane = surface.map((v, i) => v * a + e[i] * (1 - a));
      return texts.every(tx => glassContrast(tx, pane) >= 4.5);
    });
    if (ok) return tint;
  }
  return 100;
}
function glassGuardTint() {
  const b = document.body;
  // undo a previous raise (applyUiSettings() drops the marker itself when it
  // has just re-set the tokens, so this only runs on a bare glassSync())
  if ('glassTint' in b.dataset) {
    const orig = b.dataset.glassTint;
    delete b.dataset.glassTint;
    if (orig) b.style.setProperty('--glass-tint', orig); else b.style.removeProperty('--glass-tint');
  }
  if (!glassOn()) return;
  const pkgTint = b.style.getPropertyValue('--glass-tint'); // a glass package's own
  const have = parseFloat(pkgTint || getComputedStyle(b).getPropertyValue('--glass-tint')) || 72;
  const need = glassTintNeeded(Math.ceil(have));
  if (need > have) { b.style.setProperty('--glass-tint', `${need}%`); b.dataset.glassTint = pkgTint || ''; }
}

function glassSync() {
  if (!document.body) return;
  glassGuardTint();
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
