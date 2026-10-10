'use strict';
// ═══ Long lists that grow as they scroll (Procress 17 P1) ════════════════
// A 3,000-object Classifier opened as 51,000 DOM nodes in ~2 s. lazyRows()
// renders the first `step` rows plus a sentinel; when the sentinel scrolls
// near view the next `step` are appended in place. `state` is the view
// instance's own state, so the count survives the app's whole-page re-renders
// (a click on row 2,500 keeps rows 1–2,550 on screen) — pass `keep` = the
// index that must be shown (the selected row).
//
// Procress 19 F10: past LAZY_WINDOW_MIN rows the list also recycles. Rows
// further than LAZY_TRIM outside the viewport are removed and their height
// moves into a spacer (data-lazy-top above, the data-lazy sentinel below), so
// a list scrolled to its end holds about one screen's worth of rows instead of
// every one (51,000 nodes → ~800 on the 3,000-row table). Spacer heights are
// measured from the rows they replace, so scrolling never drifts; only a jump
// (a dragged scrollbar, a re-centre on a far `keep`) places rows by the
// average height until trims measure them again. `state` then carries the
// window: from / shown (end) and the two spacers' px. Shorter lists keep the
// plain grow-only behaviour.
const LAZY_WINDOW_MIN = 1000;
const LAZY_WINDOW_STEP = 20; // smaller chunks once recycling: each is a forced layout inside a frame
const LAZY_MARGIN = 800;     // the observer's rootMargin
// Beyond LAZY_MARGIN on purpose: a spacer left by a trim must sit outside the
// observer's reach, or it would grow straight back and trim the other end.
const LAZY_TRIM = 1200;
const _lazy = new Map(); // sentinel id -> { id, items, rowHtml, state, step, more, windowed, cols }
let _lazySeq = 0;
function lazyRows(items, rowHtml, state, { step = 100, keep = -1, more = (id) => `<div class="lazy-more" data-lazy="${id}"></div>` } = {}) {
  for (const k of _lazy.keys()) if (!document.querySelector(`[data-lazy="${k}"],[data-lazy-top="${k}"]`)) _lazy.delete(k);
  if (items.length <= LAZY_WINDOW_MIN) {
    state.from = 0;
    const shown = Math.min(items.length, Math.max(step, state.shown || 0, keep + 1 + step / 2));
    state.shown = shown;
    const head = items.slice(0, shown).map(rowHtml).join('');
    if (shown >= items.length) return head;
    const id = `lz${++_lazySeq}`;
    _lazy.set(id, { id, items, rowHtml, state, step, more });
    return head + more(id);
  }
  step = Math.min(step, LAZY_WINDOW_STEP);
  let from = Math.min(state.from || 0, items.length - 1);
  let shown = Math.min(items.length, Math.max(from + 3 * step, state.shown || 0)); // a screenful to start
  if (keep >= 0 && (keep < from || keep >= shown)) {
    if (keep >= from && keep < from + 4 * step) shown = Math.min(items.length, keep + 1 + step / 2);
    else { // too far to grow to (picked from elsewhere) — re-centre the window on it and reveal it
      from = Math.max(0, keep - step / 2 - (keep - step / 2) % (state.cols || 1));
      shown = Math.min(items.length, keep + 1 + step / 2);
      state.topPx = Math.round(from * (state.itemPx || 0)); // an estimate; lazyReveal measures one if there is none
      state.botPx = 0;
    }
  }
  // A page re-render empties the scroller before it gets here (scrollTop is 0
  // by now), which would leave the viewport inside the spacer above and send
  // the window back to the top — so a kept row is always brought into view.
  if (keep >= 0) state.reveal = keep;
  if (!from) state.topPx = 0;
  if (shown >= items.length) state.botPx = 0;
  Object.assign(state, { from, shown });
  const id = `lz${++_lazySeq}`;
  _lazy.set(id, { id, items, rowHtml, state, step, more, windowed: true });
  const top = more(id).replace(`data-lazy="${id}"`, `data-lazy-top="${id}" style="height:${state.topPx || 0}px"`);
  const bottom = shown < items.length ? more(id).replace(`data-lazy="${id}"`, `data-lazy="${id}"${state.botPx ? ` style="height:${state.botPx}px"` : ''}`) : '';
  return top + items.slice(from, shown).map(rowHtml).join('') + bottom;
}
// The rendered rows: the (shown - from) elements after the top spacer.
function lazyWindowRows(L) {
  const top = document.querySelector(`[data-lazy-top="${L.id}"]`);
  const rows = [];
  for (let r = top?.nextElementSibling, n = L.state.shown - L.state.from; r && n > 0; r = r.nextElementSibling, n--) rows.push(r);
  return { top, rows };
}
const _lazyTop = (el) => el.getBoundingClientRect().top;
// Each step reads layout once, after its rows went in, and only writes after
// that: a forced layout costs ~10 ms on the 3,000-row table (an auto-layout
// table re-measures every row), so a second one would double the step.
function lazyGrow(el) {
  const L = _lazy.get(el.dataset.lazy);
  if (!L) return false;
  const s = L.state;
  if (s.botPx && el.getBoundingClientRect().top < -LAZY_MARGIN) return lazyJump(L); // the viewport is inside the spacer
  const from = s.shown, to = Math.min(L.items.length, from + L.step);
  const prev = el.previousElementSibling;
  const gap = () => _lazyTop(el) - prev.getBoundingClientRect().bottom;
  const g0 = s.botPx ? gap() : 0; // layout is clean here (last frame), so this read is free
  el.insertAdjacentHTML('beforebegin', L.items.slice(from, to).map(L.rowHtml).join(''));
  s.shown = to;
  const trim = L.windowed ? lazyTrimPlan(L, 'top', 0) : null; // the one forced layout
  if (s.botPx) { // the sentinel stood in for these rows — give their height back
    s.botPx = Math.max(0, s.botPx - (gap() - g0));
    el.style.height = s.botPx ? `${s.botPx}px` : '';
  }
  if (to >= L.items.length) { if (!L.windowed) _lazy.delete(el.dataset.lazy); el.remove(); s.botPx = 0; }
  if (trim) lazyTrimApply(L, trim);
  if (typeof hydrateDisplayImages === 'function') hydrateDisplayImages(); // grid thumbnails in the new rows
  return true;
}
function lazyGrowUp(el) {
  const L = _lazy.get(el.dataset.lazyTop);
  const s = L?.state;
  const first = el.nextElementSibling;
  if (!s?.from || !first) return false;
  if (el.getBoundingClientRect().bottom > innerHeight + LAZY_MARGIN) return lazyJump(L); // the viewport is inside the spacer
  const cols = L.cols || 1;
  const n = Math.max(cols, L.step - L.step % cols);
  const to = s.from, from = Math.max(0, to - n);
  // Heights are measured between the spacer and `first`, not against the
  // viewport: Chromium's scroll anchoring may already have scrolled by the
  // inserted height during the forced layout, and a viewport delta would then
  // read 0 and leave the spacer too tall.
  const gap = () => _lazyTop(first) - el.getBoundingClientRect().bottom;
  const y0 = _lazyTop(first), g0 = gap();
  el.insertAdjacentHTML('afterend', L.items.slice(from, to).map(L.rowHtml).join(''));
  s.from = from;
  const added = gap() - g0;
  // Wherever `first` sits now, it ends up back at y0 once the spacer shrinks.
  const trim = lazyTrimPlan(L, 'bottom', _lazyTop(first) - y0);
  s.topPx = from ? Math.max(0, s.topPx - added) : 0;
  el.style.height = `${s.topPx}px`;
  if (trim) lazyTrimApply(L, trim);
  if (typeof hydrateDisplayImages === 'function') hydrateDisplayImages();
  return true;
}
// The scrollbar was dragged (or the window re-centred) so far that the viewport
// lies inside a spacer: growing from the spacer's edge would take one chunk
// per frame to get there. Rebuild the window where the viewport is instead,
// placed by the average row height; the spacers absorb the estimate so the
// list keeps its total height, and get exact again as rows are trimmed.
function lazyJump(L) {
  const s = L.state, { top, rows } = lazyWindowRows(L);
  if (!top || !rows.length) return false;
  const bottom = document.querySelector(`[data-lazy="${L.id}"]`);
  const r0 = top.getBoundingClientRect();
  const end = (bottom || rows[rows.length - 1]).getBoundingClientRect().bottom;
  const px = s.itemPx || (rows[rows.length - 1].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top) / rows.length;
  const cols = L.cols || 1, n = L.items.length;
  let from = Math.floor((-LAZY_MARGIN - r0.top) / px);
  from = Math.max(0, Math.min(n - 1, from) - Math.min(n - 1, Math.max(0, from)) % cols);
  const shown = Math.min(n, from + 2 * L.step + Math.ceil(innerHeight / px));
  for (const r of rows) r.remove();
  top.insertAdjacentHTML('afterend', L.items.slice(from, shown).map(L.rowHtml).join(''));
  Object.assign(s, { from, shown, topPx: Math.round(from * px) });
  top.style.height = `${s.topPx}px`;
  const { rows: now } = lazyWindowRows(L);
  const h = now[now.length - 1].getBoundingClientRect().bottom - now[0].getBoundingClientRect().top;
  s.botPx = shown < n ? Math.max(0, Math.round(end - r0.top - s.topPx - h)) : 0;
  let sentinel = bottom;
  if (shown < n && !sentinel) { now[now.length - 1].insertAdjacentHTML('afterend', L.more(L.id)); sentinel = now[now.length - 1].nextElementSibling; }
  if (shown >= n) sentinel?.remove();
  else sentinel.style.height = `${s.botPx}px`;
  if (typeof hydrateDisplayImages === 'function') hydrateDisplayImages();
  return true;
}
// After a render with a kept row: size the spacer above from the rows just
// drawn if no trim has measured a row yet (a re-centre), then scroll the kept
// row into view.
function lazyReveal(L, top) {
  const s = L.state, keep = s.reveal;
  delete s.reveal;
  const { rows } = lazyWindowRows(L);
  if (!rows.length) return;
  if (!s.itemPx && s.from) {
    s.itemPx = (rows[rows.length - 1].getBoundingClientRect().bottom - rows[0].getBoundingClientRect().top) / rows.length;
    s.topPx = Math.round(s.from * s.itemPx);
    top.style.height = `${s.topPx}px`;
  }
  const r = rows[keep - s.from]?.getBoundingClientRect();
  if (r && (r.top < 0 || r.bottom > innerHeight)) rows[keep - s.from].scrollIntoView({ block: 'center', behavior: 'instant' });
}
// Which rows lie far outside the viewport on one side (read-only). A grid
// only ever loses whole lines (`cols` cards share a top), so the cards below
// never reflow into new columns. `shift` = how far the rows will move up
// once the caller's own pending write lands.
function lazyTrimPlan(L, side, shift) {
  const { top, rows } = lazyWindowRows(L);
  if (!top || rows.length < 2) return null;
  const rects = rows.map((r) => r.getBoundingClientRect());
  let cols = 1;
  while (cols < rows.length && rects[cols].top === rects[0].top) cols++;
  L.cols = L.state.cols = cols;
  if (!L.state.itemPx) L.state.itemPx = (rects[rects.length - 1].bottom - rects[0].top) / rows.length;
  let n = 0;
  if (side === 'top') {
    while (n < rows.length - cols && rects[n].bottom - shift < -LAZY_TRIM) n++;
    n -= n % cols;
    return n ? { side, top, rows: rows.slice(0, n), h: rects[n].top - rects[0].top } : null;
  }
  const limit = innerHeight + LAZY_TRIM;
  while (n < rows.length - cols && rects[rows.length - 1 - n].top - shift > limit) n++;
  if (!n) return null;
  const keep = rows.length - 1 - n;
  return { side, last: rows[keep], rows: rows.slice(keep + 1), h: rects[rows.length - 1].bottom - rects[keep].bottom };
}
// Remove the planned rows and fold their measured height into that side's spacer.
function lazyTrimApply(L, plan) {
  const s = L.state;
  for (const r of plan.rows) r.remove();
  if (plan.side === 'top') {
    s.from += plan.rows.length;
    s.topPx = (s.topPx || 0) + plan.h;
    plan.top.style.height = `${s.topPx}px`;
    s.itemPx = s.topPx / s.from;
    return;
  }
  s.shown -= plan.rows.length;
  s.botPx = (s.botPx || 0) + plan.h;
  let bottom = document.querySelector(`[data-lazy="${L.id}"]`);
  if (!bottom) { plan.last.insertAdjacentHTML('afterend', L.more(L.id)); bottom = plan.last.nextElementSibling; }
  bottom.style.height = `${s.botPx}px`;
}
const _lazyObs = new IntersectionObserver((ents) => {
  for (const e of ents) {
    if (!e.isIntersecting) continue;
    const grew = e.target.dataset.lazyTop ? lazyGrowUp(e.target) : lazyGrow(e.target);
    // still in reach after growing? re-observing makes the observer say so again
    if (grew && e.target.isConnected) { _lazyObs.unobserve(e.target); _lazyObs.observe(e.target); }
  }
}, { rootMargin: `${LAZY_MARGIN}px` });
new MutationObserver(() => {
  for (const el of document.querySelectorAll('[data-lazy]:not([data-lazy-on]),[data-lazy-top]:not([data-lazy-on])')) {
    el.dataset.lazyOn = '1';
    const L = el.dataset.lazyTop && _lazy.get(el.dataset.lazyTop);
    if (L && L.state.reveal != null) lazyReveal(L, el); // before the observer first looks at it
    _lazyObs.observe(el);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
