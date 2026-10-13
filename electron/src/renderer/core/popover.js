'use strict';
// ═══ The one popover (Procress 22, APP docs/COMPONENTS.md "Popover") ═════
// Every small floating thing that is not a modal — a menu, a "pick a value"
// list, a small setting — is opened here and placed by ONE positioner, so
// they all flip, shift, close and take focus the same way. A full form
// (several fields + Save) is openModal() instead.
//
//   openPopover(anchor, html, opts)  build + place + focus a .popover
//   placeFloating(el, anchor, opts)  the positioner: flip on the main axis,
//                                    shift on the cross axis, never off-screen
//   floatingRect(...)                its pure maths (electron/test/popover.test.mjs)
//   pointAnchor(x, y)                an anchor at a point
//   ctxAnchor(ev)                    the right-click point (last one when no event)
//   paletteAnchor()                  upper middle — where Ctrl+P was
//   closeAllPopups()                 hub/popups.js — removes every .popover
//
// Closing is shared with the context-menu engine (hub/ctxmenu.js): an outside
// click (core/boot.js bindPopupDismiss), Escape in the capture phase (focus
// goes back to the opener), closeAllPopups(). Whatever removes it, opts.onClose
// runs once — a MutationObserver watches for the removal, so no close path
// can forget it. Tab stays inside (focus trap). APK: DdxPopover / showDdxPopover.

const POPOVER_MARGIN = 8;

// anchor: an Element, anything with getBoundingClientRect(), or a rect.
function anchorRect(anchor) {
  if (!anchor) return null;
  if (typeof anchor.getBoundingClientRect === 'function') return anchor.getBoundingClientRect();
  if (typeof anchor.left === 'number' && typeof anchor.top === 'number') {
    return { left: anchor.left, top: anchor.top, right: anchor.right ?? anchor.left, bottom: anchor.bottom ?? anchor.top };
  }
  return null;
}

// Pure: where a w×h box goes next to rect r inside a vw×vh viewport.
// placement: 'bottom-start' (default) | 'bottom-end' | 'bottom-center' | 'top-start' | 'top-end'
//            | 'right-start' (a submenu) | 'left-start'
// Returns { left, top, side } — side is the one actually used after a flip.
function floatingRect(r, w, h, vw, vh, placement = 'bottom-start', gap = null, margin = POPOVER_MARGIN) {
  const [side, align = 'start'] = placement.split('-');
  const g = gap ?? (side === 'right' || side === 'left' ? 2 : 6);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  let left, top, used = side;
  if (side === 'bottom' || side === 'top') {
    const below = r.bottom + g, above = r.top - h - g;
    if (side === 'bottom') { top = below; if (top + h > vh - margin && above >= margin) { top = above; used = 'top'; } }
    else { top = above; if (top < margin && below + h <= vh - margin) { top = below; used = 'bottom'; } }
    left = align === 'end' ? r.right - w : align === 'center' ? r.left + (r.right - r.left) / 2 - w / 2 : r.left;
  } else {
    const right = r.right + g, leftSide = r.left - w - g;
    if (side === 'right') { left = right; if (left + w > vw - margin) { left = leftSide; used = 'left'; } }
    else { left = leftSide; if (left < margin) { left = right; used = 'right'; } }
    top = r.top;
  }
  // shift: keep the whole box on screen (the top-left corner wins when it cannot fit)
  left = clamp(left, margin, Math.max(margin, vw - w - margin));
  top = clamp(top, margin, Math.max(margin, vh - h - margin));
  return { left: Math.round(left), top: Math.round(top), side: used };
}

function placeFloating(el, anchor, { placement = 'bottom-start', gap = null } = {}) {
  const r = anchorRect(anchor);
  if (!el || !r) return;
  // taller than the window: cap it and let it scroll rather than run off-screen
  const room = window.innerHeight - 2 * POPOVER_MARGIN;
  if (el.offsetHeight > room) { el.style.maxHeight = `${room}px`; el.style.overflowY = 'auto'; }
  const p = floatingRect(r, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight, placement, gap);
  el.style.left = `${p.left}px`;
  el.style.top = `${p.top}px`;
  el.dataset.side = p.side;
}

function pointAnchor(x, y) {
  return { getBoundingClientRect: () => ({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 }) };
}
// Cursor-anchored popups — inline onclick= attributes can't close over a live
// event object once the popup's own click handler runs later, so the last
// right-click point is stashed on S and read back here.
function ctxAnchor(ev) {
  return pointAnchor(ev ? ev.clientX : (S.ctxMenuPos?.x ?? 0), ev ? ev.clientY : (S.ctxMenuPos?.y ?? 0));
}
// Where a palette-run command anchors a popup it opens: upper middle of the
// window, where the palette itself was.
function paletteAnchor() {
  return pointAnchor(Math.round(window.innerWidth / 2), Math.round(window.innerHeight * 0.22));
}

const POPOVER_FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="menuitem"], .kind-list-item, .ls-row';

// opts:
//   placement  see floatingRect                    size   'sm' | 'md' | 'lg' | 'menu'
//   cls        extra classes (the popup's own)     role   'dialog' (default) | 'menu' | 'listbox'
//   aria       aria-label                          focus  a selector to focus, or false
//   onClose    runs once when it goes away         keep   true = leave other popovers open (a submenu)
//   onClick    a click handler inside it (clicks never reach the document sweep)
function openPopover(anchor, html, opts = {}) {
  const { placement = 'bottom-start', size = null, cls = '', role = 'dialog', aria = null, focus = null, onClose = null, keep = false, onClick = null } = opts;
  const opener = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (!keep) closeAllPopups();
  // The click that opens a popover must not also reach the document's
  // outside-click sweep (core/boot.js bindPopupDismiss) and close it again —
  // callers used to remember stopPropagation() each; now none has to.
  if (window.event?.type === 'click') window.event.stopPropagation();
  const pop = document.createElement('div');
  pop.className = ['popover', size ? `popover-${size}` : '', cls].filter(Boolean).join(' ');
  pop.setAttribute('role', role);
  if (aria) pop.setAttribute('aria-label', aria);
  pop.tabIndex = -1;
  pop.innerHTML = html;
  pop._ctxOwner = opener;          // Escape (hub/ctxmenu.js) gives focus back here
  if (onClose) pop._onClose = onClose;
  document.body.appendChild(pop);
  pop.addEventListener('click', (e) => { e.stopPropagation(); onClick?.(e, pop); });
  pop.addEventListener('keydown', popoverTrapTab);
  placeFloating(pop, anchor || paletteAnchor(), { placement });
  if (focus !== false) {
    setTimeout(() => {
      if (!pop.isConnected) return;
      const target = (typeof focus === 'string' && pop.querySelector(focus)) || pop.querySelector(POPOVER_FOCUSABLE) || pop;
      try { target.focus({ preventScroll: true }); } catch (_) {}
    }, 0);
  }
  return pop;
}
// Re-place an open popover after its content changed size.
function repositionPopover(pop, anchor, placement = 'bottom-start') { placeFloating(pop, anchor, { placement }); }

function popoverTrapTab(e) {
  if (e.key !== 'Tab') return;
  const pop = e.currentTarget;
  const items = [...pop.querySelectorAll(POPOVER_FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const i = items.indexOf(document.activeElement);
  const next = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : (i === items.length - 1 ? 0 : i + 1);
  e.preventDefault();
  items[next].focus();
}

// onClose, whichever way it closed.
new MutationObserver((muts) => {
  for (const m of muts) for (const n of m.removedNodes) {
    if (n.nodeType === 1 && n._onClose) { const f = n._onClose; n._onClose = null; try { f(); } catch (e) { console.error(e); } }
  }
}).observe(document.body || document.documentElement, { childList: true });
