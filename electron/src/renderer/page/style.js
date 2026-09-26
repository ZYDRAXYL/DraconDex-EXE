'use strict';
// ═══ Block style (Procress 14, APP docs/TEMPLATES.md §6) ═══════════════
// Every block — a component, text, a heading, columns — carries two
// optional objects in page_block.config, so no schema change and a page
// saved as a template keeps them:
//   config.style  the shared set (§6.1): variant, accent, width, align,
//                 density, header {show, title, icon}, collapsible, anchor,
//                 hideOn
//   config.opts   what the component itself declares with options() (§6.2)
// A value the app does not know (a template from a newer version) is
// dropped here, never an error. Colours come from accent names bound to
// css/page-style.css, never a free hex — so every theme, a user's or a
// package's, still decides the page's colours.

const PB_STYLE = {
  variant: ['plain', 'card', 'outline', 'tinted', 'hero'],
  accent: ['kind', 'accent', 'blue', 'green', 'amber', 'rose', 'violet', 'slate'],
  width: ['narrow', 'normal', 'wide', 'full'],
  align: ['left', 'center', 'right'],
  density: ['comfy', 'compact'],
  collapsible: ['off', 'open', 'closed'],
  hideOn: ['none', 'phone', 'desktop'],
};
const PB_STYLE_DEFAULT = { variant: 'plain', accent: 'accent', width: 'normal', align: 'left', density: 'comfy', collapsible: 'off', hideOn: 'none' };

const pbCap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const pbAnchorClean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// config.style → the known values only, each defaulted.
function blockStyleOf(config) {
  const s = config?.style && typeof config.style === 'object' ? config.style : {};
  const out = {};
  for (const [k, vals] of Object.entries(PB_STYLE)) out[k] = vals.includes(s[k]) ? s[k] : PB_STYLE_DEFAULT[k];
  const h = s.header && typeof s.header === 'object' ? s.header : {};
  out.header = { show: h.show === true, title: typeof h.title === 'string' ? h.title.slice(0, 80) : '', icon: typeof h.icon === 'string' ? h.icon.slice(0, 80) : '' };
  out.anchor = pbAnchorClean(s.anchor);
  return out;
}

const pbAccClass = (a) => `pb-acc-${a}`;

// The section's classes for a style. plain/normal/left/comfy add nothing,
// so a block without a style renders exactly as it did before §6.
function blockStyleClasses(style) {
  const st = style?.variant ? style : blockStyleOf({ style });
  const cls = [];
  if (st.variant !== 'plain') cls.push(`pb-v-${st.variant}`);
  if (st.variant !== 'plain' || st.header.show) cls.push(pbAccClass(st.accent));
  if (st.width !== 'normal') cls.push(`pb-w-${st.width}`);
  if (st.align !== 'left') cls.push(`pb-al-${st.align}`);
  if (st.density !== 'comfy') cls.push(`pb-d-${st.density}`);
  if (st.collapsible !== 'off') cls.push('pb-collapsible');
  return cls;
}

// The block's anchor: the one it was given, else b<id> — what a linkbar,
// the contents or an anchor: link scrolls to.
const pbAnchorOf = (b) => blockStyleOf(b?.config).anchor || `b${b?.id}`;

// hideOn never hides a page's main text (item.body) — a style must not
// hide content (§6.4).
const pbHideOf = (b, st) => (b?.component === 'item.body' ? 'none' : st.hideOn);

// A header's icon: an app icon by name, a symbol (sym:★), or nothing.
function pbIconHtml(icon) {
  if (!icon) return '';
  if (icon.startsWith('sym:')) return `<span class="pb-ico" data-no-i18n>${x(icon.slice(4, 12))}</span>`;
  return I[icon] ? `<span class="pb-ico">${I[icon]}</span>` : '';
}

// The block's name — the header's default title and the arrange bar's text.
function pbBlockName(b) {
  if (b.block_type === 'component') return componentLabel(componentOf(b));
  return t(PB_TYPE_KEY[b.block_type] || 'pbText');
}

// Header + body around what a block draws. A collapsible block always has
// a header, since that is the only way to open it again (§6.4).
function pbStyledInner(c, inner) {
  const st = blockStyleOf(c.config);
  const coll = st.collapsible !== 'off';
  if (!st.header.show && !coll) return `<div class="pb-body">${inner}</div>`;
  const open = pbIsOpen(c, st);
  const title = st.header.title || pbBlockName(c.block);
  const head = coll
    ? `<div class="pb-head" role="button" tabindex="0" aria-expanded="${open}" onclick="pbToggleOpen(${xj(c.iid)})"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();pbToggleOpen(${xj(c.iid)})}">`
    : '<div class="pb-head">';
  return `${head}${pbIconHtml(st.header.icon)}<span class="pb-head-t" data-no-i18n>${x(title)}</span>${coll ? '<span class="pb-chev" aria-hidden="true">▾</span>' : ''}</div>
    <div class="pb-body">${inner}</div>`;
}

// Open or closed: what the user did this session, else the style's start.
const pbIsOpen = (c, st = blockStyleOf(c.config)) => (st.collapsible === 'off' ? true : (c.state.open ?? st.collapsible === 'open'));

function pbToggleOpen(iid) {
  const root = pbRoot(iid);
  if (!root) return;
  const s = pbState(iid);
  s.open = root.classList.contains('pb-closed');
  root.classList.toggle('pb-closed', !s.open);
  root.querySelector(':scope > .pb-head')?.setAttribute('aria-expanded', String(s.open));
  // a canvas or stage mounted while hidden measured nothing; let it re-fit
  if (s.open) window.dispatchEvent(new Event('resize'));
}

// The section's attributes for a style: classes, data-anchor, data-hide.
function pbStyleAttrs(c) {
  const st = blockStyleOf(c.config);
  const cls = blockStyleClasses(st);
  if (st.collapsible !== 'off' && !pbIsOpen(c, st)) cls.push('pb-closed');
  const hide = pbHideOf(c.block, st);
  return { cls, attrs: ` data-anchor="${x(pbAnchorOf(c.block))}"${hide !== 'none' ? ` data-hide="${hide}"` : ''}` };
}

// Scroll to a block on the open page by its anchor.
function pbScrollToAnchor(anchor, scope = document) {
  const a = pbAnchorClean(anchor);
  const el = a && scope.querySelector(`#main-inner .pblock[data-anchor="${CSS.escape(a)}"]`);
  if (!el) return false;
  if (el.classList.contains('pb-closed')) pbToggleOpen(el.dataset.iid);
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

// ── options() (§6.2) ────────────────────────────────────────────────────
// A component's own settings. Kept in config.opts; a template written before
// §6 put the same keys at the top of config, so those still count.
const pbOptionDefs = (b) => {
  const comp = componentOf(b);
  try { return comp?.options ? comp.options() || [] : []; } catch (_) { return []; }
};

function pbOptValid(def, v) {
  if (v === undefined || v === null) return undefined;
  switch (def.type) {
    case 'select': return def.choices.includes(v) ? v : undefined;
    case 'toggle': return typeof v === 'boolean' ? v : undefined;
    case 'number': {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n)) return undefined;
      return Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, n));
    }
    case 'text': return typeof v === 'string' ? v.slice(0, def.max || 200) : undefined;
    case 'fields': return Array.isArray(v) ? v.filter((k) => typeof k === 'string').slice(0, 40) : (typeof v === 'string' && def.single ? v : undefined);
    case 'module': return Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined;
    case 'links': return Array.isArray(v) ? v : undefined;
    case 'list': return Array.isArray(v) ? v.map((x2) => String(x2 ?? '').slice(0, 40)).slice(0, def.max || 12) : undefined;
    default: return undefined;
  }
}

// One option's value for an instance: config.opts, the older top-level
// config key, then the declared default.
function pbOpt(c, key) {
  const def = pbOptionDefs(c.block).find((d) => d.key === key);
  const cfg = c.config || {};
  const raw = cfg.opts && cfg.opts[key] !== undefined ? cfg.opts[key] : cfg[key];
  if (!def) return raw;
  const v = pbOptValid(def, raw);
  return v === undefined ? def.default : v;
}
