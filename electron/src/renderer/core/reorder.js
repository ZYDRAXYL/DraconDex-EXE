'use strict';
// ═══ Drag to reorder — one helper for every list (Procress 27 part 5) ═══
// Before this, every list reordered through HTML5 drag-and-drop: the OS drew
// a ghost that went wherever the mouse went, and the rows themselves sat
// still until the drop. Here the row itself is picked up and follows the
// pointer on ONE axis only, and the rows it passes slide out of its way —
// the phone-list feel. Pointer events, not DnD, because a DnD ghost can be
// neither axis-locked nor styled.
//
//   reorderDrag(event, el, { items, axis, linked, into, onDrop })
//     event   the pointerdown on the row or its grip
//     el      the item being dragged (one of `items`)
//     items   every item of the list, in order (elements, or a function)
//     axis    'y' (lists) · 'x' (columns, tabs) · 'xy' (a wrapping grid — no lock)
//     linked  item → elements that move with it (a column's cells, a Nest
//             folder's children)
//     into    item → true when dropping in its middle half nests inside it
//             (Nest collectors); the rest of the row still reorders
//     onDrop  ({ target, before, into }) — target is an item element. The
//             rows keep their new places until onDrop settles, so a caller
//             that saves first and re-renders after never flickers back.
//     move    true for a list nobody re-renders (a modal holding a half-filled
//             form): the item is moved in the DOM itself before onDrop.
//
// Nothing moves until the pointer has travelled REORDER_THRESHOLD px, so a
// click on the same row still clicks. Esc puts everything back.

const REORDER_THRESHOLD = 4;
const REORDER_EDGE = 36;    // px from a scroller's edge that starts auto-scroll
const REORDER_SPEED = 14;   // px per frame at the very edge

// ids with `id` moved next to `targetId` — the one splice every caller did.
function reorderIds(ids, id, targetId, before) {
  const out = ids.filter((v) => v !== id);
  const at = out.indexOf(targetId);
  if (at < 0) return null;
  out.splice(before ? at : at + 1, 0, id);
  return out;
}

// Where the dragged item would land. `spans` are the items' ORIGINAL
// [start, end] on the axis, `from` the dragged one's index, `pos` its centre
// now (same coordinates). Returns the number of other items before it — its
// final index — and, when `canInto` allows, the item it is held over the
// middle of.
function reorderSlot(spans, from, pos, canInto) {
  for (let i = 0; i < spans.length; i++) {
    if (i === from || !canInto?.(i)) continue;
    const [a, b] = spans[i], quarter = (b - a) / 4;
    if (pos > a + quarter && pos < b - quarter) return { to: null, into: i };
  }
  let to = 0;
  for (let i = 0; i < spans.length; i++) if (i !== from && pos > (spans[i][0] + spans[i][1]) / 2) to++;
  return { to, into: -1 };
}

// How far item i slides to make room when the dragged item (index `from`,
// `size` long with its gap) is going to index `to`.
function reorderShift(i, from, to, size) {
  if (i < from && i >= to) return size;
  if (i > from && i <= to) return -size;
  return 0;
}

// The grid case: the slot nearest the dragged item's centre.
function reorderNearest(rects, from, cx, cy) {
  let best = from, dist = Infinity;
  rects.forEach((r, i) => {
    const d = Math.hypot((r.left + r.right) / 2 - cx, (r.top + r.bottom) / 2 - cy);
    if (d < dist) { dist = d; best = i; }
  });
  return best;
}

// The grip every reorderable row carries. `down` is its pointerdown handler.
function reorderGripHtml(down) {
  return `<span class="nar-grip" title="${x(t('dragReorder'))}" onpointerdown="${down}">${I.grip}</span>`;
}

function reorderScroller(el, axis) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const ov = axis === 'x' ? cs.overflowX : cs.overflowY;
    const more = axis === 'x' ? p.scrollWidth > p.clientWidth : p.scrollHeight > p.clientHeight;
    if (/(auto|scroll)/.test(ov) && more) return p;
  }
  return null;
}

function reorderDrag(ev, el, opts) {
  if (ev.button !== 0 || ev.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const axis = opts.axis || 'y';
  const x0 = ev.clientX, y0 = ev.clientY;
  let d = null; // the drag, once it has started
  let px = x0, py = y0, raf = 0;

  // A native drag (an <img>, a link) would steal the gesture as pointercancel.
  const noNative = (e) => e.preventDefault();
  const onMove = (e) => {
    px = e.clientX; py = e.clientY;
    if (!d) {
      if (Math.hypot(px - x0, py - y0) < (opts.threshold ?? REORDER_THRESHOLD)) return;
      d = start();
      if (!d) return finish(false);
    }
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    finish(false);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('dragstart', noNative, true);

  function start() {
    const items = (typeof opts.items === 'function' ? opts.items() : [...opts.items]).filter((it) => it.isConnected);
    const from = items.indexOf(el);
    if (from < 0 || items.length < 2) return null;
    const linked = items.map((it) => (opts.linked?.(it) || []).filter(Boolean));
    // An item's extent includes what moves with it (a folder's children).
    const rects = items.map((it, i) => linked[i].reduce((r, l) => {
      const b = l.getBoundingClientRect();
      if (!b.width && !b.height) return r;
      return { left: Math.min(r.left, b.left), top: Math.min(r.top, b.top), right: Math.max(r.right, b.right), bottom: Math.max(r.bottom, b.bottom) };
    }, it.getBoundingClientRect()));
    const lo = axis === 'x' ? 'left' : 'top', hi = axis === 'x' ? 'right' : 'bottom';
    const spans = rects.map((r) => [r[lo], r[hi]]);
    const gap = from < items.length - 1 ? spans[from + 1][0] - spans[from][1] : spans[from][0] - spans[from - 1][1];
    const scroller = opts.scroller ?? reorderScroller(el, axis === 'x' ? 'x' : 'y');
    try { el.setPointerCapture(ev.pointerId); } catch (_) {}
    getSelection()?.removeAllRanges();
    document.documentElement.classList.add('reorder-active');
    window.addEventListener('keydown', onKey, true);
    const moving = (i) => [items[i], ...linked[i]];
    items.forEach((_, i) => moving(i).forEach((m) => m.classList.add(i === from ? 'reorder-drag' : 'reorder-slide')));
    return {
      items, from, linked, rects, spans, moving, scroller,
      size: spans[from][1] - spans[from][0] + Math.max(0, gap),
      centre0: (spans[from][0] + spans[from][1]) / 2, // moves 1:1 with the pointer
      s0: scroller ? (axis === 'x' ? scroller.scrollLeft : scroller.scrollTop) : 0,
      to: from, into: -1, sd: 0,
    };
  }

  function tick() {
    raf = 0;
    if (!d) return;
    if (d.scroller) {
      const r = d.scroller.getBoundingClientRect();
      const p = axis === 'x' ? px : py, a = axis === 'x' ? r.left : r.top, b = axis === 'x' ? r.right : r.bottom;
      const v = p < a + REORDER_EDGE ? -(a + REORDER_EDGE - p) : p > b - REORDER_EDGE ? p - (b - REORDER_EDGE) : 0;
      if (v) {
        const step = Math.sign(v) * Math.min(REORDER_SPEED, Math.ceil(Math.abs(v) / 2));
        if (axis === 'x') d.scroller.scrollLeft += step; else d.scroller.scrollTop += step;
        raf = requestAnimationFrame(tick);
      }
      d.sd = (axis === 'x' ? d.scroller.scrollLeft : d.scroller.scrollTop) - d.s0;
    }
    paint();
  }

  function paint() {
    const dx = px - x0, dy = py - y0;
    const move = (els, tx, ty) => els.forEach((m) => { m.style.transform = tx || ty ? `translate(${tx}px,${ty}px)` : ''; });
    if (axis === 'xy') {
      const r0 = d.rects[d.from];
      const to = reorderNearest(d.rects, d.from, (r0.left + r0.right) / 2 + dx, (r0.top + r0.bottom) / 2 + dy + d.sd);
      d.to = to;
      d.items.forEach((_, i) => {
        if (i === d.from) return move(d.moving(i), dx, dy + d.sd);
        const k = i < d.from ? (i >= to ? i + 1 : i) : (i <= to ? i - 1 : i);
        move(d.moving(i), d.rects[k].left - d.rects[i].left, d.rects[k].top - d.rects[i].top);
      });
      return;
    }
    const delta = (axis === 'x' ? dx : dy) + d.sd;
    const slot = reorderSlot(d.spans, d.from, d.centre0 + delta, opts.into && ((i) => opts.into(d.items[i])));
    // Over a folder's middle: nest there, and keep the rows where they are —
    // re-sliding them now would move the folder out from under the pointer.
    if (slot.into >= 0) d.into = slot.into;
    else { d.into = -1; d.to = slot.to; }
    d.items.forEach((it, i) => it.classList.toggle('drop-in', i === d.into));
    d.items.forEach((_, i) => {
      const s = i === d.from ? delta : reorderShift(i, d.from, d.to, d.size);
      move(d.moving(i), axis === 'x' ? s : 0, axis === 'x' ? 0 : s);
    });
  }

  function finish(commit) {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('dragstart', noNative, true);
    window.removeEventListener('keydown', onKey, true);
    if (raf) cancelAnimationFrame(raf);
    if (!d) return;
    if (commit) paint(); // a fast flick can end before its first frame
    document.documentElement.classList.remove('reorder-active');
    // The pointerup that ends a drag must not also click the row under it.
    const eat = (e) => { e.stopPropagation(); e.preventDefault(); };
    window.addEventListener('click', eat, true);
    setTimeout(() => window.removeEventListener('click', eat, true), 0);

    const { items, from, to, into } = d;
    const all = items.flatMap((_, i) => d.moving(i));
    const settle = () => all.forEach((m) => {
      m.classList.remove('reorder-slide', 'reorder-drag', 'drop-in');
      m.style.transform = '';
    });
    const moved = commit && (into >= 0 || to !== from);
    if (!moved) return settle();
    // Glide the dragged item into its slot; the others are already there.
    if (into < 0 && axis !== 'xy' && !opts.move) {
      const end = to > from ? d.spans[to][1] - d.spans[from][1] : d.spans[to][0] - d.spans[from][0];
      d.moving(from).forEach((m) => {
        m.classList.replace('reorder-drag', 'reorder-slide');
        m.style.transform = axis === 'x' ? `translate(${end}px,0)` : `translate(0,${end}px)`;
      });
    }
    if (opts.move && into < 0) {
      settle();
      const ref = items[to];
      if (to < from) ref.before(...d.moving(from)); else ref.after(...d.moving(from));
    }
    const drop = into >= 0
      ? { target: items[into], before: false, into: true }
      : { target: items[to], before: to < from, into: false };
    Promise.resolve()
      .then(() => opts.onDrop(drop))
      .catch((e) => console.error('reorder drop failed', e))
      .finally(() => requestAnimationFrame(settle));
  }
}
