---
name: ux-researcher
description: Research and improve DraconDex's usability — task flow, information architecture, discoverability, cognitive load. Combines targeted external UX research (competitor apps like Obsidian, Notion, world-building tools) with a live audit of the running app via the run-dracondex driver, scored against usability heuristics. Use when asked to improve UX, simplify a flow, make the app easier to use, evaluate a feature's usability before or after building it, "ปรับ UX ให้ใช้งานง่ายขึ้น", or audit a screen's task flow. For visual/theming/aesthetic questions use ui-researcher instead.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# UX Researcher

Goal: make DraconDex easier and more pleasant to actually *use* — task flow,
information architecture, discoverability, cognitive load. This is about
**how the app behaves and how easy it is to accomplish a task**, not how it
looks.

- For **visual design** (theming, contrast, typography, spacing, component
  polish) use the `ui-researcher` skill instead.
- For **cosmetics/wiring conformance** (hardcoded colors, missing i18n keys,
  wrong button class, broken IPC wiring) that's
  `.claude/skills/dracondex-module-style/` (`check.mjs`) — mention it in
  passing if you notice one, don't re-solve it here.

For a quick, targeted question ("is this dialog's flow OK?", "how should the
kind picker present 15 options?") run this skill inline. For a bigger job —
a full audit across several modules, or research-heavy competitor comparison
— delegate to the `ux-researcher` agent instead (see bottom of this file) so
the screenshots and web research don't eat the main conversation's context.

## Step 1 — Scope the request

Figure out which of these you're doing before starting:

- **(a) Audit** — find usability problems in an existing screen/flow.
- **(b) Pre-build research** — a new feature/pattern doesn't exist yet;
  research how it should work before code gets written.
- **(c) General pass** — no single target, look across the app for the
  highest-impact usability issues.

## Step 2 — External research (targeted, not a survey)

Use WebSearch/WebFetch scoped to the *specific* pattern in question — not a
generic "UX best practices" dump. DraconDex is an Obsidian-style vault +
worldbuilding + light game-design tool, so the most relevant comparisons are:

| App | Relevant for |
|---|---|
| **Obsidian** | vault picker, graph view, `[[wikilinks]]`, backlinks, quick switcher (Ctrl+P), plugin-like nesting mental model |
| **Notion** | block/database hybrid, deeply nested pages, "pick a type for this block" pickers (≈ DraconDex's 15 module kinds) |
| **World Anvil / Campfire / LegendKeeper** | purpose-built worldbuilding tools — DraconDex's actual competitive set, not generic productivity apps |
| **Nielsen Norman Group** | heuristic backing for a specific claim, not general reading |

Cite *why* a finding is relevant to the DraconDex flow in question — don't
link-dump.

## Step 3 — Live audit of the real app

Use the `run-dracondex` driver
(`.claude/skills/run-dracondex/SKILL.md`) to walk through the actual flow —
empty state, populated state, error/edge-case state. **Read the
screenshots. Don't guess what the flow does from the code.**

```bash
node .claude/skills/run-dracondex/driver.mjs --fresh \
  "ss 01-<flow-start>" "click ..." "wait 400" "ss 02-<flow-step>"
```

Also read the actual renderer code for the flow (`electron/src/renderer/*.js`,
`electron/src/renderer/mod/*.js`) to count real steps/clicks/decisions — not the
apparent ones (a picker that *looks* like one click might hide a second
confirmation step, etc.).

## Step 4 — Evaluate against the checklist

See [HEURISTICS.md](HEURISTICS.md) for the full checklist: visibility of
system status, match between the app and real-world/domain vocabulary
(นิยาย/worldbuilding terms, not generic CRUD-speak), user control & error
prevention (destructive actions must confirm specifically), recognition
over recall, efficiency for power users vs. friendliness for new ones,
minimalism/progressive disclosure, error recovery, and discoverability of
nested/hidden features (the 15 module kinds; the 4 legacy modules hidden
from the rail and only reachable via Artisan or migration).

## Step 5 — Report findings

Prioritized list, most severe first. Per finding:

- **Severity** — blocker (can't complete the task) / major (confusing,
  error-prone) / minor (friction) / polish
- **What** — the concrete screen/flow, with a screenshot reference
- **Why it hurts** — which heuristic it violates, or what a comparison app
  does differently/better and why that matters here
- **Fix** — a concrete recommendation pointing at the actual function/file
  to change where possible (e.g. "`openKindPopup` in `hub.js` shows all 15
  kinds flat — group by category or default to the 5 most-used"), not just
  "make it clearer"
- **Effort** — rough: copy/label tweak vs. new interaction pattern vs.
  structural rework

## Running as an agent

For research-heavy or multi-screen work, spawn the `ux-researcher` agent
(`.claude/agents/ux-researcher.md`) via the Agent tool instead of doing it
inline. Brief it with: the specific flow/feature in scope, anything already
tried or ruled out, and whether you want external research, a live audit, or
both — a fresh agent has none of this conversation's context.

## Gotchas

- **Default locale is Thai** — audit with the real default, don't switch to
  English first; that's not what users actually see.
- Don't mistake "the v3 module system is powerful/complex" for "bad UX" on
  its own — propose progressive disclosure (smarter defaults, templates, the
  Artisan wizard) rather than recommending capability get removed.
- `STYLE.md` itself has some drift from current code (e.g. it says 13
  locales / `confirmBox()`; the actual code has 18 locales / `uiConfirm()`)
  — verify a convention against real source before citing it as fact.
- Check `docs/SYSTEMS.md` §11 and `docs/CHANGELOG.md` before reporting
  something as newly discovered — some UX debt is already known and tracked.
