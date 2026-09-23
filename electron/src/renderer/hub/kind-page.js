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

const kpFn = (name) => (typeof window[name] === 'function' ? window[name] : null);
const kpCall = (name, ...args) => kpFn(name)?.(...args);

const KIND_PAGE = {
  classifier: {
    load: 'loadClassifierData', main: 'buildClassifierMainHtml',
    mount: () => { if (S.classifierView === 'relationCat') kpCall('mountClassifierRelationGraph'); },
  },
  manager: {
    load: 'loadManagerData', main: 'buildManagerMainHtml',
    mount: () => { if (S.managerData?.view === 'graph') kpCall('mountManagerGraph'); },
  },
  inspector: { main: 'buildDetailMainHtml', mount: (m) => kpCall('mountDetailEditor', m) },
  locator: { load: 'loadLocatorData', main: 'buildLocatorMainHtml', mount: 'mountLocatorBoard' },
  chronicler: { load: 'loadChroniclerData', main: 'buildChroniclerMainHtml', mount: 'mountChroniclerGraph' },
  wanderer: { load: 'loadWandererData', main: 'buildWandererMainHtml', mount: 'mountWandererBoard' },
  narrator: {
    load: 'loadNarratorData', main: 'buildNarratorMainHtml',
    mount: () => { if (!kpFn('mountNarratorBoard')) return; kpCall('mountNarratorBoard'); if (S.narratorData?.view === 'reader') kpCall('mountNarratorReader'); },
  },
  author: {
    load: 'loadAuthorData', main: 'buildAuthorMainHtml',
    mount: () => { if (!kpFn('mountAuthorEditor')) return; kpCall('mountAuthorEditor'); if (S.authorData?.view === 'book') kpCall('mountAuthorBook'); },
  },
  scribe: { load: 'loadChatScribeData', main: 'buildChatScribeMainHtml', mount: 'mountChatScribe' },
  drafter: { main: 'buildDrafterMainHtml', mount: (m) => kpCall('mountDrafterEditor', m) },
  exhibitor: { load: 'loadExhibitorData', main: 'buildExhibitorMainHtml', mount: 'mountExhibitor' },
  sketcher: {
    load: 'loadSketcherData', main: 'buildSketcherMainHtml',
    mount: () => { if (!kpFn('mountSketcherBoard')) return; kpCall('mountSketcherBoard'); kpCall('mountSketcherExtras'); },
  },
  designer: { load: 'loadDesignerData', main: 'buildDesignerMainHtml', mount: 'mountDesignerBoard' },
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
