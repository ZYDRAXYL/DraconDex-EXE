<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# Visual design checklist for DraconDex

Covers aesthetic/visual quality — the flow/behavior heuristics live in
`ux-researcher/HEURISTICS.md` instead. Use this as a scoring rubric during
Step 4 of the `ui-researcher` skill; not every item applies to every
finding, skip what doesn't.

## Aesthetic and minimalist design (Nielsen heuristic 8)

- Is there visual information on screen the current task doesn't need?
  Does a picker/panel give equal visual weight to everything regardless of
  how often each option is actually used (e.g. all 15 module kinds
  presented identically)?
- Does whitespace/density feel intentional, or does content feel cramped
  or, conversely, sparse and empty for no reason?
- Icon-to-label ratio — icons that don't clearly reinforce their label add
  visual noise rather than scannability.

## Theme and contrast coverage

`style.css` defines 30+ theme variants across families (Daylight/Moonlight/
Midnight/Eclipse + sky/star/time). For any finding involving color:

- Check contrast at every surface tier the element can sit on:
  `--bg` → `--surface` → `--raised` → `--hover`, with `--t1/--t2/--t3` text
  on top of each.
- Check `--accent`/`--accentH` usage — does an accent-colored element stay
  legible against both light and dark theme families, or was it only ever
  tested against one?
- The **only** sanctioned raw hex in the app is the user-data color
  fallback `g.color_code || '#6366f1'` (per `STYLE.md`) — any other
  hardcoded color you see is itself both a style-checker finding *and* a
  visual-consistency one, since it can't adapt across themes by definition.
- Chart/graph colors (Sage's force-graph, Relation's whiteboard) are a
  legitimate exception needing a fixed, distinguishable palette — judge
  those on distinguishability *within* a theme, not on token purity.

## Typography and spacing rhythm

- Font sizes: do headings/body/meta text follow a consistent scale across
  modules, or does each module invent its own sizing?
- Radius tokens `--r` (8px) / `--rs` (4px) / `--rl` (12px) — are they
  applied consistently for their apparent purpose (small controls vs. cards
  vs. large containers), or mixed inconsistently?
- Line length and padding in text-heavy areas (markdown editor/preview,
  detail panels) — comfortable to read, or too wide/cramped?

## Icon and component consistency

- Icons sourced from `I.*` (`core.js`) or the icon-picker collection
  (`iconpicker.js`) — do custom-uploaded icons (`img:` data URIs) sit at a
  visually consistent size/weight next to built-in `svg:`/`sym:` icons?
- Buttons: `btn-p`/`btn-s`/`btn-g`/`btn-d` — is the *visual* hierarchy
  (which button draws the eye) matching the *intended* hierarchy (primary
  action should read as primary), not just the correct class name?
- Do the shared shapes from `dracondex-module-style/STYLE.md` (`.ph`
  header, `.li` row, `.empty` state, modal `.fg`/`.mfoot`, `.detail-head`)
  render with consistent visual rhythm across the modules that use them, or
  has one module's version drifted (extra padding, different icon size,
  etc.) even though it technically reuses the class?

## Motion and feedback

- Transitions (`--ease`) — consistent duration/easing across hover states,
  panel collapse/expand, modal open/close, or does one module feel snappier
  or laggier than the rest?
- Toast appearance/dismissal — visually consistent regardless of which
  module triggered it?

## Comparison-app visual cheat sheet

| Visual question in DraconDex | Look at how... |
|---|---|
| Dense sidebar + nested tree readability | Obsidian's file explorer — indentation, hover states, active-item highlighting |
| Empty-state visual treatment | Notion's empty pages/databases — icon + short copy + single clear CTA, low visual noise |
| Graph/whiteboard visual style (Sage, Relation, Connector) | Obsidian's graph view — node/edge color restraint, label legibility at zoom |
| Character/map/timeline visual conventions | World Anvil, Campfire, LegendKeeper — genre-appropriate visual language, not generic SaaS style |
| Theme family coherence | Any app with a documented light/dark *and* accent-family theming system (e.g. Obsidian themes, VS Code color themes) — how they keep families visually related while distinct |
