'use strict';
// ═══ Components (v5 Part 8, APP docs/V5.md §12.2–§12.3) ═════════════════
// A page is a stack of page_block rows (db/page-block.js). A `component`
// block names one of these; the other block types (text, heading, divider,
// image, columns) are drawn by page/blocks.js. An entry:
//   kind       the module kind whose data it shows ('core' = any page)
//   labelKey   i18n key for the add-block picker and the arrange bar (or
//   label      () => the text, when it is not one key — a kind's name)
//   presets    () => [preset ids] — what the old view chips switched between
//   presetLabel (p) => the chip's text
//   render(c)  HTML for one instance; c is the instance (page/page.js pbCtx)
//   mount(c)   after the HTML is in the document; c.root is the section
//   borrow     true when another page may show it with source_key (§12.12)
//   once       at most one instance per page
//
// Every kind's view is a component (`<kind>.view`) whose presets are the
// kind's old views, so an existing module opens looking exactly as before:
// its default block's preset is the module's saved activeView. A kind whose
// renderer still reads window-global ids and its S.<kind>Data singleton is
// registered through legacyKindComponent below — shown once, on its own
// module's page only, which is exactly what the pre-Part-8 page did.

const COMPONENTS = {};

function registerComponent(id, spec) { COMPONENTS[id] = { id, ...spec }; }

const componentOf = (b) => (b?.block_type === 'component' ? COMPONENTS[b.component] || null : null);
const componentLabel = (comp) => (comp?.label ? comp.label() : comp ? t(comp.labelKey) : '?');

// The view lists each kind already declares (mod/*.js), resolved at call
// time because those files load after this one.
const KIND_VIEWS = {
  classifier: ['CLASSIFIER_VIEWS', null], manager: ['MANAGER_VIEWS', 'MANAGER_VIEW_LABEL'],
  chronicler: ['CHRONICLER_VIEWS', 'CHRONICLER_VIEW_LABEL'], narrator: ['NARRATOR_VIEWS', 'NARRATOR_VIEW_LABEL'],
  author: ['AUTHOR_VIEWS', 'AUTHOR_VIEW_LABEL'], sketcher: ['SKETCHER_VIEWS', 'SKETCHER_VIEW_LABEL'],
  wanderer: ['WANDERER_VIEWS', 'WANDERER_VIEW_LABEL'], designer: ['DESIGNER_VIEWS', 'DESIGNER_VIEW_LABEL'],
  exhibitor: ['EXH_VIEWS', 'EXH_VIEW_LABEL'], scribe: ['CHATSCRIBE_VIEWS', 'CHATSCRIBE_VIEW_LABEL'],
  drafter: [null, 'DRAFTER_VIEW_LABEL'],
};
const globalOr = (name, dflt) => (name && typeof window[name] !== 'undefined' ? window[name] : dflt);

function kindPresets(kind) {
  const [list, labels] = KIND_VIEWS[kind] || [];
  return globalOr(list, null) || Object.keys(globalOr(labels, {}));
}
function kindPresetLabel(kind, p) {
  if (kind === 'classifier' && typeof CLASSIFIER_VIEW_KEY !== 'undefined') return t(CLASSIFIER_VIEW_KEY[p]);
  return globalOr(KIND_VIEWS[kind]?.[1], {})[p] || p;
}

// A kind not converted to instance scope yet: its page renderer, unchanged.
function legacyKindComponent(kind) {
  registerComponent(`${kind}.view`, {
    kind, label: () => kindLabel(kind), legacy: true, once: true,
    presets: () => kindPresets(kind), presetLabel: (p) => kindPresetLabel(kind, p),
    render: (c) => {
      if (c.source.id !== c.page.moduleId) return `<p class="drafter-hint">${t('pbNotBorrowable')}</p>`;
      const main = kindPagePart(kind, 'main');
      return main ? main(c.source) : '';
    },
    mount: (c) => { if (c.source.id === c.page.moduleId) kindPagePart(kind, 'mount')?.(c.source); },
  });
}
const LEGACY_KINDS = ['classifier', 'manager', 'inspector', 'locator', 'chronicler', 'wanderer', 'narrator',
  'author', 'scribe', 'drafter', 'exhibitor', 'sketcher', 'designer', 'diviner'];

// Registered once every renderer file is in (boot.js calls this) — a kind
// converted to a scoped component registers itself in its own file, and
// wins: legacy fills only the gaps.
function registerLegacyComponents() {
  for (const k of LEGACY_KINDS) if (!COMPONENTS[`${k}.view`]) legacyKindComponent(k);
}

// The layout a page gets the first time it opens (db ensurePage stores it
// once). A module page: Properties at the head, the kind's own view with the
// preset its old activeView named, the related links at the foot.
function defaultPageLayout(m, ui) {
  if (!m || m.kind === 'collector') return [];
  const preset = ui?.activeView || ui?.view || null;
  return [
    { component: 'core.properties' },
    { component: `${m.kind}.view`, config: preset ? { preset } : {} },
    { component: 'core.related' },
  ];
}
