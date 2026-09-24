'use strict';
// ═══ KIND_PAGE — one registry per kind's page (v5 Part 3, V5.md §7.3) ═══
// Replaces three separate per-kind mechanisms that had to be kept in step by
// hand: KIND_MAIN_BUILDER (hub/open.js, a dict), the loader if-chain in
// openModuleNode (hub/open.js) and the mount if-chain in runBuilderMounts
// (core/views.js). A kind with a page now has ONE entry here:
//   load(m)   async data fetch, awaited by openModuleNode before the repaint
//   main(m)   the page body HTML, wrapped by buildModuleDetailHtml
//   mount(m)  post-DOM hook, run by runBuilderMounts on every render
// Parts are named globals, resolved at call time — the mod/*.js files load
// after this one, and a lazily-loaded kind simply has nothing to call yet.
// Collector has no page (it only expands), so it has no entry.
//
// Also here: viewBarHtml(), the one builder for the view-chip bar that was
// copy-pasted into eleven kinds' toolbars.
//
// v5 Part 6 (APP docs/V5.md §10.4): `start` is the command (core/commands.js)
// a kind's empty page offers as its ONE primary button — kindEmptyStateHtml()
// below draws "what this kind is for + one way to begin" from it, in place
// of the bare `<div class="empty">` that only repeated the module's name.
// Inspector and Drafter are always an editor, so they have no empty page.

const kpFn = (name) => (typeof window[name] === 'function' ? window[name] : null);
const kpCall = (name, ...args) => kpFn(name)?.(...args);

const KIND_PAGE = {
  // v5 Part 8: a scoped page component (mod/classifier.js registers
  // classifier.view, which loads through the page) — only the start command
  // is read from here.
  classifier: { start: 'classifier.quickStart' },
  manager: {
    load: 'loadManagerData', main: 'buildManagerMainHtml', start: 'manager.pick',
    mount: () => { if (S.managerData?.view === 'graph') kpCall('mountManagerGraph'); },
  },
  inspector: { main: 'buildDetailMainHtml', mount: (m) => kpCall('mountDetailEditor', m) },
  locator: { start: 'locator.addArea' }, // scoped: mod/locator.js registers locator.view
  chronicler: { load: 'loadChroniclerData', main: 'buildChroniclerMainHtml', mount: 'mountChroniclerGraph', start: 'chronicler.addLine' },
  wanderer: { load: 'loadWandererData', main: 'buildWandererMainHtml', mount: 'mountWandererBoard', start: 'wanderer.place' },
  narrator: {
    load: 'loadNarratorData', main: 'buildNarratorMainHtml', start: 'narrator.addDialogue',
    mount: () => { if (!kpFn('mountNarratorBoard')) return; kpCall('mountNarratorBoard'); if (S.narratorData?.view === 'reader') kpCall('mountNarratorReader'); },
  },
  author: {
    load: 'loadAuthorData', main: 'buildAuthorMainHtml', start: 'author.newChapter',
    mount: () => { if (!kpFn('mountAuthorEditor')) return; kpCall('mountAuthorEditor'); if (S.authorData?.view === 'book') kpCall('mountAuthorBook'); },
  },
  scribe: { load: 'loadChatScribeData', main: 'buildChatScribeMainHtml', mount: 'mountChatScribe', start: 'scribe.newSession' },
  drafter: { main: 'buildDrafterMainHtml', mount: (m) => kpCall('mountDrafterEditor', m) },
  exhibitor: { load: 'loadExhibitorData', main: 'buildExhibitorMainHtml', mount: 'mountExhibitor', start: 'exhibitor.editFilter' },
  sketcher: {
    load: 'loadSketcherData', main: 'buildSketcherMainHtml', start: 'sketcher.newPage',
    mount: () => { if (!kpFn('mountSketcherBoard')) return; kpCall('mountSketcherBoard'); kpCall('mountSketcherExtras'); },
  },
  designer: { load: 'loadDesignerData', main: 'buildDesignerMainHtml', mount: 'mountDesignerBoard', start: 'designer.addShape' },
  diviner: { load: 'loadDivinerData', main: 'buildDivinerMainHtml', start: 'diviner.newTable' }, // v5 Part 7 (§11.5)
};

// One part of a kind's page as a callable, or null. A string part names a
// global; a function part is already the callable.
function kindPagePart(kind, part) {
  const p = KIND_PAGE[kind]?.[part];
  if (!p) return null;
  return typeof p === 'function' ? p : kpFn(p);
}

// The view-chip bar every kind's toolbar carried its own copy of.
//   views   the view ids, in order
//   active  the current one
//   onclick (v) => the inline onclick JS for that chip
//   label   (v) => the chip's text (already translated or locale-invariant)
//   opts.noI18n  mark the labels as locale-invariant for the i18n sweep
function viewBarHtml(views, active, onclick, label, opts = {}) {
  return `<div class="viewbar">
    ${views.map(v => `<span class="vitem${v === active ? ' act' : ''}" onclick="${onclick(v)}"${opts.noI18n ? ' data-no-i18n' : ''}>${label(v)}</span>`).join('')}
  </div>`;
}

// A kind's empty page (§10.4): icon, what the kind is for (its KIND_DESC_KEY
// sentence — the same line the kind picker shows), then ONE primary button,
// the kind's `start` command. Presets for the kind (hub/presets.js) follow as
// chips — "start from a shape" beside "start empty".
//   o.note   a line about THIS page's state (a filter that matched nothing)
//   o.extra  HTML after the button
//   o.attrs  attributes for the wrapper (a right-click menu)
function kindEmptyStateHtml(m, o = {}) {
  const col = m.icon_color_code || m.color_code || KIND_COLOR[m.kind] || 'var(--accent)';
  const start = KIND_PAGE[m.kind]?.start;
  const presets = typeof presetChipsHtml === 'function' ? presetChipsHtml(m) : '';
  return `<div class="empty kind-empty"${o.attrs ? ` ${o.attrs}` : ''}>
    <div class="ei" style="color:${x(col)}">${moduleIconHtml(m)}</div>
    <h3>${x(m.name)}</h3>
    <p>${t(KIND_DESC_KEY[m.kind])}</p>
    ${o.note ? `<p class="drafter-hint">${o.note}</p>` : ''}
    ${start ? cmdBtn(start, { moduleId: m.id }, { cls: 'btn-p' }) : ''}
    ${o.extra || ''}
    ${presets}
  </div>`;
}

