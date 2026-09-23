'use strict';
// ═══ Page navbar (v5 Part 4, APP docs/V5.md §8.2) ═══════════════════════
// The one builder for the header every page opens with — the module page,
// an element (item) page, a file, the Import Dock, Sage Hut, Wyvern and
// Dragon each carried their own copy of the same `.detail-head.module-head`
// markup before. It is the app's first position:sticky element: the scroller
// is .bpane-body / #main-inner, so the head pins to the top of the pane
// while the page scrolls under it.
//
// Folding it is machine chrome, not vault data: one boolean in S.settings
// (localStorage, the core/tool-toggle.js tier), shared by every page. The
// folded bar keeps the icon and the title — folded, you still know where
// you are — and the unfold button, which is sticky with it so it can be
// reached from any scroll position.
//
//   o.color      accent for the left rule and the icon
//   o.icon       icon HTML; o.iconOnclick makes it a button
//   o.title      title HTML (already escaped — may be an inline input)
//   o.titleText  plain title, for the folded bar
//   o.after      HTML after the title on the same line (handle, kind chip)
//   o.sub        a second line (hint text, breadcrumb)
//   o.tags       the chips row (.mtags) — hidden while folded
//   o.cls        extra class names
//   o.bare       o.sub replaces the title row (Wyvern / Dragon breadcrumbs)
//   o.forceOpen  render unfolded regardless — an inline rename / handle edit
//                needs its input on screen

function pageHeadHtml(o = {}) {
  const col = o.color || 'var(--accent)';
  const folded = !!S.settings.navbarFolded && !o.forceOpen;
  const fold = `<button class="btn btn-g btn-i navbar-fold" onclick="togglePageHeadFold()"
    title="${x(t(folded ? 'navbarUnfold' : 'navbarFold'))}" aria-expanded="${folded ? 'false' : 'true'}">${folded ? I.chevronDown : I.chevronUp}</button>`;
  const icon = o.icon ? `<span class="kicon" style="color:${x(col)}${o.iconOnclick ? ';cursor:pointer' : ''}"${o.iconOnclick ? ` onclick="event.stopPropagation();${o.iconOnclick}"` : ''} data-no-i18n>${o.icon}</span>` : '';
  const cls = ['detail-head', 'module-head', 'page-navbar', folded ? 'is-folded' : '', o.cls || ''].filter(Boolean).join(' ');
  if (folded) {
    return `<div class="${cls}" style="border-left:4px solid ${x(col)}">
      <div class="navbar-row">${icon}<span class="navbar-title" data-no-i18n>${x(o.titleText || '')}</span>${fold}</div>
    </div>`;
  }
  const row = o.bare
    ? `<div class="navbar-row"><div class="navbar-grow">${o.sub || ''}</div>${fold}</div>`
    : `<div class="navbar-row">
        <h2 class="navbar-h">${icon}${o.title || ''}${o.after || ''}</h2>${fold}
      </div>${o.sub ? `<div class="drafter-hint navbar-sub">${o.sub}</div>` : ''}`;
  return `<div class="${cls}" style="border-left:4px solid ${x(col)}">
    ${row}
    ${o.tags ? `<div class="mtags">${o.tags}</div>` : ''}
  </div>`;
}

function togglePageHeadFold() {
  S.settings.navbarFolded = !S.settings.navbarFolded;
  saveUiSettings();
  renderNexusHome();
}
