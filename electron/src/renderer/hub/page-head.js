'use strict';
// ═══ Page head (v5 Part 4, APP docs/V5.md §8.2; v5 Part 8, §12.10) ═══════
// The one builder for the header every page opens with — the module page,
// an element (item) page, a file, the Import Dock, Sage Hut, Wyvern and
// Dragon each carried their own copy of the same `.detail-head.module-head`
// markup before.
//
// Since v5 Part 8 it is two parts: the ADDRESS ROW (page/address.js) is the
// sticky one — the scroller is .bpane-body / #main-inner, so it pins to the
// top of the pane while the page scrolls under it — and the title below it
// scrolls away with the page. The old sticky title and its fold toggle
// went: a one-line address row has nothing to fold.
//
//   o.addr       which page this is, for the address row (page/address.js)
//   o.color      accent for the left rule and the icon
//   o.icon       icon HTML; o.iconOnclick makes it a button
//   o.title      title HTML (already escaped — may be an inline input)
//   o.titleText  plain title
//   o.after      HTML after the title on the same line (handle, kind chip)
//   o.sub        a second line (hint text)
//   o.tags       the chips row (.mtags)
//   o.acts       the page's own buttons, at the end of the address row
//   o.cls        extra class names
//   o.bare       o.sub is the whole head (Wyvern / Dragon breadcrumbs —
//                those workspaces have no panes, so no address row)

function pageHeadHtml(o = {}) {
  const col = o.color || 'var(--accent)';
  const icon = o.icon ? `<span class="kicon" style="color:${x(col)}${o.iconOnclick ? ';cursor:pointer' : ''}"${o.iconOnclick ? ` onclick="event.stopPropagation();${o.iconOnclick}"` : ''} data-no-i18n>${o.icon}</span>` : '';
  const cls = ['detail-head', 'module-head', o.cls || ''].filter(Boolean).join(' ');
  if (o.bare) {
    return `<div class="${cls} page-navbar" style="border-left:4px solid ${x(col)}">
      <div class="navbar-row"><div class="navbar-grow">${o.sub || ''}</div></div>
    </div>`;
  }
  return `<div class="page-navbar addr-bar">${addressRowHtml(o.addr || { label: o.titleText }, o.acts)}</div>
    <div class="${cls} page-title" style="border-left:4px solid ${x(col)}">
      <div class="navbar-row"><h2 class="navbar-h">${icon}${o.title || ''}${o.after || ''}</h2></div>
      ${o.sub ? `<div class="drafter-hint navbar-sub">${o.sub}</div>` : ''}
      ${o.tags ? `<div class="mtags">${o.tags}</div>` : ''}
    </div>`;
}
