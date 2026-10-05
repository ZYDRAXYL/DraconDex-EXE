// Procress 18 part 5 — the contrast meter (on top of 17 R7's audit): every
// visible piece of text on the page, its colour against the background it
// actually sits on (ancestors' fills composited, alpha included), measured
// with the WCAG 2.x formula. Normal text needs 4.5:1, large text (≥ 24 px,
// or ≥ 18.66 px bold) 3:1. Disabled controls and placeholders are exempt, as
// WCAG has them, and so is text in a colour the user picked (an inline
// style colour — a Designer free text): content, not the app's palette.
// A Designer shape's label is skipped too: it sits over a sibling plate (the
// diamond / polygon box) that no ancestor walk can see.
// Runs in the page: win.evaluate(contrastProbe).
export function contrastProbe() {
  // rgb()/rgba(), and color(srgb r g b / a) — what a color-mix() computes to
  const parse = (c) => {
    let m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (m) { const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; }
    m = /color\(srgb ([^)]+)\)/.exec(c || '');
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[ /]+/).filter(Boolean).map(Number);
    return { r: r * 255, g: g * 255, b: b * 255, a };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1,
  });
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const ratio = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  // the fill under an element: its own and its ancestors', composited
  const bgOf = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const out = [];
  const seen = new Set();
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const el = t.parentElement;
    const text = t.nodeValue.trim();
    if (!text || !el || seen.has(el) || !el.offsetParent) continue;
    seen.add(el);
    if (el.closest('[aria-hidden="true"], [disabled], .sr-only, #qs-overlay, .hidden, svg, option, .dg-node')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) continue;
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) < 0.95 || cs.visibility === 'hidden' || el.style.color) continue;
    let fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    if (fg.a < 1) fg = over(fg, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got + 0.005 < need) {
      const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
      const hex = (c) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
      out.push({ text: text.slice(0, 30), sel: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`, ratio: Math.round(got * 100) / 100, need, size, fg: hex(fg), bg: hex(bg) });
    }
  }
  return out;
}
