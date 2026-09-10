---
name: ui-researcher
description: Research and improve DraconDex's visual design — theming/contrast across its 30+ theme families, typography, spacing, icon consistency, visual hierarchy, and component polish. Combines targeted external visual-design research (competitor apps like Obsidian, Notion, world-building tools) with a live multi-theme audit of the running app via the run-dracondex driver. Use when asked to make the app look better, review a theme, check contrast/accessibility, polish a new component's visuals, or evaluate whether a screen looks consistent/modern. For flow/usability/information-architecture questions use ux-researcher instead.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# UI Researcher

Goal: make DraconDex *look* good — visual hierarchy, theming/contrast,
typography, spacing, icon and component consistency, aesthetic polish. This
is about **how the app looks**, not how it behaves.

- For **task flow / usability / information architecture** use the
  `ux-researcher` skill instead.
- For **automated tokenization conformance** (hardcoded hex instead of
  `var(--…)`, `<button>` missing `.btn`, undefined CSS classes) that's
  `.claude/skills/dracondex-module-style/` (`check.mjs`) — it catches
  whether a token was used, not whether the *result* looks good. Run it
  after any change you recommend; don't re-do its job here.

For a quick, targeted question ("does this new modal look right in dark
themes?") run this skill inline. For a bigger job — a full visual audit
across many screens/themes, or research-heavy competitor visual comparison —
delegate to the `ui-researcher` agent instead (see bottom of this file) so
the many screenshots don't eat the main conversation's context.

## Step 1 — Scope the request

- **(a) Audit** — find visual inconsistencies/polish issues in an existing
  screen or component.
- **(b) Pre-build research** — a new component/screen doesn't exist yet;
  research what it should look like before code gets written.
- **(c) Theme sweep** — check contrast/legibility across theme families,
  not tied to one screen.

## Step 2 — External research (targeted, not a mood board dump)

Use WebSearch/WebFetch scoped to the *specific* visual question — not
generic "modern UI trends" reading. Relevant comparisons for a themeable
desktop creative tool:

| App | Relevant for |
|---|---|
| **Obsidian** | dense sidebar + graph view visual language, theme/CSS-snippet ecosystem, dark-mode-first design |
| **Notion** | block visual hierarchy, empty-state illustration/copy style, subtle color use in a mostly-neutral palette |
| **World Anvil / Campfire / LegendKeeper** | worldbuilding-tool-specific visual conventions (map/timeline/character-sheet aesthetics) — the actual competitive set |
| **WCAG contrast guidelines** | objective backing for a contrast finding, not just "looks low-contrast to me" |

Cite *why* a finding is relevant to the DraconDex component in question —
don't link-dump a Dribbble search.

## Step 3 — Live multi-theme audit of the real app

Use the `run-dracondex` driver (`.claude/skills/run-dracondex/SKILL.md`) to
screenshot the actual component/screen. **A single-theme screenshot is not
enough for a visual finding** — switch themes (⚙ settings menu) and
re-screenshot, covering at least one theme from each family
(Daylight/Moonlight/Midnight/Eclipse) when the finding is about contrast or
color, since `style.css` defines 30+ theme variants and a color that reads
fine in one can fail in another.

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh \
  "ss 01-<component>-daylight" \
  "click <theme-menu-selector>" "click <theme-option>" "wait 300" \
  "ss 02-<component>-midnight"
```

**Read the screenshots side by side.** Don't infer visual quality from
`style.css` variable names alone — verify the rendered result.

## Step 4 — Evaluate against the checklist

See [VISUAL-CHECKLIST.md](VISUAL-CHECKLIST.md) for the full checklist:
aesthetic/minimalist design (Nielsen heuristic 8), theme/contrast coverage
across surface tiers (`--bg/--surface/--raised/--hover`), typography and
spacing rhythm, icon set consistency (`iconpicker.js`), visual-pattern
consistency against the shapes documented in
`dracondex-module-style/STYLE.md` (`.ph` header, `.li` row, empty state,
modal, detail-head), and motion/animation feel.

## Step 5 — Report findings

Prioritized list, most severe first. Per finding:

- **Severity** — blocker (illegible/inaccessible in some theme) / major
  (visually inconsistent or jarring) / minor (polish) / nice-to-have
- **What** — the concrete screen/component, with screenshot references
  (ideally 2+ themes if the finding is color/contrast-related)
- **Why it hurts** — which visual principle it violates, contrast ratio if
  measurable, or what a comparison app does visually that reads better and
  why that matters here
- **Fix** — a concrete recommendation, ideally naming the actual CSS
  variable/selector or component to change (e.g. "`.detail-head` left-
  border uses the entity's raw hex at full opacity — on Midnight themes
  this clips against `--raised`; blend toward `--border` at low
  saturation instead"), not just "make it prettier"
- **Effort** — rough: token/value tweak vs. new visual pattern vs.
  structural rework

## Running as an agent

For a full visual audit or heavy competitor-visual research, spawn the
`ui-researcher` agent (`.claude/agents/ui-researcher.md`) via the Agent
tool instead of doing it inline — multi-theme screenshot sets add up fast.
Brief it with: the specific screen/component in scope, which themes matter
most, and whether you want external visual research, a live audit, or both.

## Gotchas

- **Don't just re-run `check.mjs`'s job.** A hardcoded-color warning from
  the style checker is a wiring problem; a "this reads muddy in Moonlight"
  finding from you is a design judgment — different kinds of findings, both
  useful, don't conflate them in your report.
- **Default locale is Thai** — Thai text runs longer/shorter than English in
  places; check that layouts don't clip or leave awkward whitespace with
  real Thai strings, not lorem-ipsum-length English ones.
- `sage.js`'s ~20 hex chart colors and a few in `core.js` are accepted
  baseline (documented in `dracondex-module-style/SKILL.md`), not new
  findings — check that skill's gotchas before flagging them again.
- Check `docs/SYSTEMS.md` §11 and `docs/CHANGELOG.md` before reporting a
  visual issue as newly discovered — some is already known and tracked.
