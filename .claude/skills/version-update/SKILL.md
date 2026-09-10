---
name: version-update
description: Bump package.json's (and package-lock.json's mirrored) "version" field per DraconDex's own x.y.z-n scheme — x for a UI/UX or architecture overhaul, y for a whole module/major feature added or removed, z for everything else (bug fixes, small tweaks — the default). Settles the y-vs-z "module or fix" call with an explicit test: a genuinely standalone new function/feature is a module (y) at any size, while merely editing an existing module or its data, or adding something that doesn't reach the app's behavior, is a fix (z) at any size — and anything that just extends what's already there is measured, staying a fix at or under 500 changed lines of app source and only becoming a candidate module past that. Uses a -n suffix while that bump is still mid-flight across several commits (dropped once finished). Recognizes "Pre" commits (nothing in the diff reaches the app's runtime behavior — plan/design write-ups, docs, or a newly-added asset nothing references yet) and skips bumping `package.json` entirely for those, instead suggesting a numbered `v.X.Y.Z-n — <summary>` commit title (`X.Y.Z` a non-binding preview guess, `n` counting prior such commits since the last real bump, resetting once one lands) for the user to commit by hand. Has two flows: a bump-only flow for ad-hoc requests and as the final step procress-writing chains into (never commits when chained-into, and never commits when running in a managed remote/cloud session — but when invoked standalone in a local Claude Code session it also commits + pushes the bump, same as Flow B's mechanics minus the `Part N` tag), and a part checkpoint flow that always commits + pushes — either when a single Part N in Plan.md's body just became fully checked while the rest of the plan is still open, or (far more common day to day) when explicitly asked for a checkpoint mid-way through a still-unfinished Part N, in which case X.Y.Z stays at the last version that actually finished and only a per-part round counter -N advances (re-derived each time from prior "Part N:"-tagged commits, never just incremented blindly). Every version-carrying commit also gets a computed "commit value" trailer line (`V.x.y.z-n a-b-c-dd/mm/yy` — commit round no. today, this month, and since this major version, plus today's date). Use when asked to "bump version", "update the version", "release this as vX.Y.Z", "อัปเดตเวอร์ชัน", "เพิ่มเลขเวอร์ชัน", "ขึ้นเวอร์ชันใหม่", after a commit/set of edits that should carry a version change, or right after a Part N in Plan.md gets its last checkbox ticked.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# version-update — bump package.json's version per DraconDex's x.y.z-n scheme

There is no marker file and no cached state for this skill. The current
`"version"` field in `package.json` is the only state that matters, and it's
always read fresh. Everything else — what changed, how big, whether it's
finished — is re-derived from git (and Plan.md) each run.

This skill has **two flows**, and picking the right one matters:

- **Flow A — bump only, plus commit + push on a standalone local run.** The
  original behavior: for ad-hoc "bump the version" requests, and as the
  final step `.claude/skills/procress-writing/SKILL.md` chains into once
  *the whole* `Plan.md` is finished (all parts, not just one). When chained
  into from `procress-writing`, this skill bumps the field and stops — the
  caller is the one that stages, commits, and pushes afterward, and it also
  writes a new `process/process-N.md` and resets `Plan.md` as part of that
  same close-out. When invoked **standalone** (the user asked this skill
  directly, not via `procress-writing`) **and the session is a local Claude
  Code session** (not one of this repo's managed remote/cloud sessions —
  see "Local vs. remote session" under Flow A step 11 below), it goes
  further: after bumping, it also stages, commits, and pushes, the same way
  Flow B does minus the `Part N` tag. In a managed remote/cloud session,
  standalone Flow A still only bumps and stops — those sessions already
  carry their own repo-level branch/commit/push/PR instructions from
  outside this skill, and doubling up on a push there would conflict with
  that outer workflow.
- **Flow B — part checkpoint, bumps *and* commits + pushes.** Triggers
  either when a single `part N` block in `Plan.md`'s body just had its last
  checklist item ticked (the **fully-finished** case), or when the user
  explicitly asks for a checkpoint/round commit mid-way through a `part N`
  that ISN'T fully checked yet (the **unfinished-part** case — see "Flow B,
  unfinished-part variant" below). Either way `Plan.md`'s body still has at
  least one `- [ ]` left somewhere else (the plan as a whole isn't done
  yet). This is the exception to "never commits" — see Flow B below.

**Which flow applies:**

| Situation | Flow |
|---|---|
| User explicitly asks to bump/release the version, unrelated to a Plan.md part, in a **local** session | A — bumps, then also commits + pushes (see step 11's "Local vs. remote session") |
| Same, but in a **managed remote/cloud** session | A — bumps only, same as before |
| Invoked by `procress-writing` as its own step 7, after it already confirmed *every* checklist item in `Plan.md` is checked | A (procress-writing owns the commit — never commit here, local or not) |
| A single `part N` block just became fully checked, and other `- [ ]` items remain elsewhere in `Plan.md`'s body | **B** (fully-finished case) |
| User explicitly requests a checkpoint/round commit for a `part N` that is NOT fully checked yet — most day-to-day work lands here, since a part is usually many sessions of partial progress | **B** (unfinished-part variant — see below; never fires automatically, only on an explicit ask) |
| A single `part N` block just became fully checked, and it was the *last* unchecked block (finishing it finishes the whole plan) | Not this skill directly — hand off to `procress-writing`, which does its full write-up/reset/bump/commit close-out. Don't also fire Flow B here; that would double-bump and double-commit. |

## Flow A — bump only (unchanged)

1. **Read the current version** straight from `package.json`'s `"version"`
   field. If it doesn't parse as `X.Y.Z` or `X.Y.Z-N`, stop and ask the user
   what it should be — don't guess.

2. **Find the anchor commit** — the commit that introduced the *current*
   `X.Y.Z` base (ignoring any existing `-N` suffix). Use a content pickaxe
   on the version line itself, not a plain path filter — `git log --
   package.json` overcounts badly in this repo (many commits touch
   `package.json` for unrelated reasons — deps, scripts — without touching
   the version line):

   ```bash
   git log -G'"version":\s*"' -- package.json
   ```

   Walk back from HEAD to the first commit in that log whose new value's
   `X.Y.Z` (ignoring suffix) equals the current `X.Y.Z`. That's the start of
   "this cycle," even if there have been several `-N` checkpoints since.

3. **Gather the real diff since that anchor**: `git log --oneline
   <anchor>..HEAD`, `git diff <anchor>..HEAD`, plus any uncommitted work
   (`git status --porcelain`, `git diff`, `git diff --staged`). Read the
   actual diff — don't classify from commit subjects alone, a message can
   undersell what changed.

4. **Pre gate**: does every file in that diff fail to reach the app's actual
   runtime behavior? Two ways a file qualifies:
   - **Bookkeeping/planning/doc file** — `Plan.md`, `process/`, `docs/`,
     `.claude/`, and similarly-purposed files. (This was the whole test
     before — still the common case.)
   - **A newly-added asset/resource** (image, font, other binary) that
     nothing in this diff — and nothing already shipped — actually
     imports/requires/references by path or filename yet. A png dropped
     into `src/assets/` with no `<img>`/`url()`/`require()` pointing at it
     anywhere is inert; it doesn't matter that `src/` is normally "app
     source."

   If **every** changed file qualifies (either way), this is a **Pre**
   commit: `package.json` stays untouched — **stop here**, but first
   compute the required `v.X.Y.Z-n` commit title per "Pre commits" below
   and report it. If even one changed file reaches the app (edits an
   *existing*, already-referenced file's behavior, or wires up a
   previously-inert asset), this is **not** Pre — fall through to step 5
   and classify normally.

5. If app source *is* touched, check `Plan.md` (checkbox list, "Part N"
   sections) and `process/` (prose log per cycle, ending "Part N complete"
   when done) for a finished/in-progress signal if they're relevant to this
   diff — an all-checked Part with a matching "complete" line is strong
   FINISHED evidence; a partially-checked Part is strong IN-PROGRESS
   evidence. Treat this as a hint, not an oracle — reconcile against the
   actual diff, a repo change doesn't have to route through these files.

6. **Classify scope**: MAJOR / MINOR / PATCH — see the decision table
   below, and for the MINOR-vs-PATCH call specifically run the
   "module or fix" test in the section right after that table (new
   standalone feature vs extension of something existing, then the
   500-changed-line threshold). Default to PATCH when genuinely unsure.

7. **Classify finished vs in-progress.** If it's not obvious from the diff
   or the Plan.md/process/ signal, ask the user directly rather than
   guess — this decision changes what ships in the version string.

8. **Escalation check**: if the current version already has a `-N` suffix
   (an in-flight series), compare the *whole* accumulated diff since the
   anchor (step 3) against the segment level already reflected in `X.Y.Z`.
   If it now looks like it deserves a bigger segment than what's already
   there, **stop and ask the user** how to reclassify — concretely, show
   them the accumulated diff and ask "still `z`-level, or has this grown
   into `y`/`x`?" Never silently re-decide mid-series.

9. **Apply the transition table** below to compute the exact target
   version string.

10. **Write it**:

    ```bash
    npm version <target> --no-git-tag-version
    ```

    `--no-git-tag-version` is mandatory on every invocation — it updates
    `package.json`'s `version` field and both mirrored `"version"` fields in
    `package-lock.json` (top-level and `packages[""]`) in one step, matching
    this repo's own historical convention, without creating a commit or tag.

11. **Local vs. remote session.** Before deciding whether to commit, check
    which kind of session this is:
    - **Managed remote/cloud session** — the system prompt describes running
      in a managed remote execution environment (Claude Code on the web, a
      GitHub Action, or similar), typically with its own explicit
      "designated branch" / "always create a pull request" instructions
      layered on top of this skill. **Stop here, same as before** — bump
      only, do not commit. That outer workflow owns staging/committing/
      pushing/PR'ing for the whole session, not just this one file; a commit
      from inside this skill would race or duplicate it.
    - **Local Claude Code session** — no such remote-environment framing;
      this is a normal local CLI/desktop invocation. Continue to step 12.

12. **Commit + push (local sessions only).** Skip this step entirely for a
    remote/cloud session or when chained into from `procress-writing` (go
    straight to the report below instead). Otherwise:
    - Run `git status` first. Stage by filename — `package.json`,
      `package-lock.json`, plus whatever implementation files are part of
      the diff gathered in step 3 (including any that were only
      uncommitted, not yet part of an earlier commit). Never `git add
      -A`/`git add -u`. If other dirty/untracked files are clearly unrelated
      to this bump, leave them unstaged and mention them in the report.
    - Commit, message format `v.X.Y.Z — <one-line summary of what changed>`
      (or `v.X.Y.Z-N — ...` if the target kept/gained a suffix) — this
      repo's own convention, no `Part N` tag since this isn't tied to a
      `Plan.md` part. Body: a blank line, then the **commit value** trailer
      computed fresh per the section below, then a blank line, then the
      standard `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
      trailer — passed via heredoc per this project's own commit
      conventions.
    - Push the current branch (`git push`, or `git push -u origin <branch>`
      if it has no upstream yet). This is pre-authorized for this specific
      case — a standalone local bump is exactly the "explicitly authorized
      in advance" case, the same way Flow B's checkpoint push is. Surface a
      real push failure (rejected, no remote, auth error) rather than
      reporting success.

13. **Report**: old → new version, one-line rationale for the
    classification, and note that `build.nsis.artifactName` (installer
    filename) and `electron/scripts/finish-portable.mjs` (portable build's output
    folder name) both read this field — so the next build's artifact names
    will change too.
    - **Remote/cloud session, or chained from `procress-writing`**: do not
      commit. If useful, suggest (don't run) a commit message matching this
      repo's own style — subject `v.X.Y.Z` or `v.X.Y.Z-N`, plus the
      **commit value** trailer computed per the section below, for whoever
      runs the actual commit to paste in as-is.
    - **Local session**: report the commit hash and confirm the push
      succeeded, same shape as Flow B's own report.

## Flow B — part-finished checkpoint (bump + commit + push)

Same classification machinery as Flow A, scoped to one `part N` block, plus
a commit and push at the end. Use this the moment a part's last checkbox
gets ticked during a work session — don't wait for someone to ask. (For a
checkpoint mid-way through a part that ISN'T fully checked yet, see "Flow B,
unfinished-part variant" right after step 7 — that's the far more common
case day to day, since most sessions only finish a slice of a part.)

1. **Confirm the trigger.** Re-read `Plan.md`'s body. The `part N` block
   that just finished must have every checklist line under it `[x]`/`[X]`,
   **and** at least one `- [ ]` must still exist somewhere else in the body.
   If the whole body is now fully checked instead, stop — this is a full
   close-out, hand off to `procress-writing` instead of proceeding here.

2. **Run Flow A steps 1–9** (read version, find anchor, gather the diff
   since anchor, Pre gate, classify scope, classify finished/in-progress,
   escalation check, compute target version) with one substitution: the
   "finished" signal for step 7 is simply this part's checklist being fully
   checked — that's decisive on its own, no need to ask the user for a part
   checkpoint the way step 7 might for an ambiguous ad-hoc bump.

   If the Pre gate (step 4) fires — the accumulated diff really is
   non-functional — stop entirely: no version bump, no commit. A part
   whose "finish" produced zero app-reaching changes isn't this flow's job;
   report the numbered `v.X.Y.Z-n` title (see "Pre commits" below) for the
   user to commit by hand.

3. **Write the version** the same way as Flow A step 10 (`npm version
   <target> --no-git-tag-version`).

4. **Stage this part's files.** Add by name, never `git add -A`/`git add
   -u`: `package.json`, `package-lock.json`, `Plan.md` (its checkbox states
   changed), and whatever implementation files were part of the diff
   gathered in step 2. Run `git status` first; if it shows other
   dirty/untracked files clearly unrelated to this part's diff, leave them
   unstaged and mention them to the user rather than sweeping them in.
   Never stage anything under `process/` here — that only gets written at
   the full plan close-out owned by `procress-writing`.

5. **Commit**, message format `v.X.Y.Z — Part N: <one-line summary of what
   that part shipped>`, matching this repo's `v.X.Y.Z — <summary>`
   convention with a `Part N` tag so it's traceable back to `Plan.md`. Body:
   a blank line, then the **commit value** trailer computed per the section
   below, then a blank line, then the standard `Co-Authored-By: Claude
   Sonnet 5 <noreply@anthropic.com>` trailer — passed via heredoc per this
   project's own commit conventions.

6. **Push** the current branch to its remote (`git push`, or `git push -u
   origin <branch>` if it has no upstream yet). This is pre-authorized for
   this specific checkpoint flow, the same way `procress-writing`'s own
   close-out push is pre-authorized — closing out a finished part is the
   "explicitly authorized in advance" case. Do still surface a real push
   failure (rejected, no remote, auth error) rather than reporting success.

7. **Report**: old → new version, which part finished, the commit hash, and
   confirmation the push succeeded. Note that `Plan.md`'s checkboxes for
   this part stay as-is (checked) — only the full close-out in
   `procress-writing` ever resets `Plan.md`.

## Flow B, unfinished-part variant (checkpoint mid-part)

The far more common shape in practice: the user wants to commit+push a
slice of real, working progress toward a `part N` that's still mostly
unchecked — Drake/Dragon/the Setting page might all still be open while
Wyvern alone just shipped, say. This never fires on its own; it only runs
on an **explicit** ask (the user saying something like "flow b", "checkpoint
this", "commit this round") — Plan.md's checklist state here is a *label*
for which part is open, not a decisive trigger the way the fully-finished
case's "every line just got checked" is.

Differs from the fully-finished flow (steps 1–3 above) in exactly two
ways — steps 4–7 (stage/commit/push/report) are otherwise identical:

1. **No "every line checked" requirement.** Identify which `part N` the
   work belongs to (the part block the diff's own files/behavior match —
   usually obvious, and it's the same `N` that goes in the commit message's
   `Part N:` tag). Most of Plan.md's body can still be unchecked elsewhere,
   including inside this same part.

2. **Version computation is different from both Flow A's generic
   IN-PROGRESS rows and Flow B's fully-finished case** — deliberately
   *skip* the classify-scope-and-bump-segment step entirely:
   - **Base `X.Y.Z`**: the anchor version's own base (Flow A step 2's
     anchor — i.e. whatever `X.Y.Z` is *already* in `package.json`, the
     last version that actually finished and shipped clean). Do **not**
     bump it, and do **not** jump ahead to the part's own `### part N
     version.X.Y.Z` header label — that label is only earned once the
     whole part finishes (see the fully-finished case above); a mid-part
     checkpoint hasn't earned it yet regardless of how big this round's
     diff looks.
   - **`N`**: the round number *for this specific part*, re-derived from
     git every time rather than trusted from whatever's currently in
     `package.json` (a manual override, like an explicit target the user
     hands you, can otherwise desync a blindly-incremented counter):
     ```bash
     # anchor = Flow A step 2's anchor commit for the CURRENT X.Y.Z base
     # P = the part number this checkpoint belongs to, e.g. 2
     priorRounds=$(git log --oneline "$anchor..HEAD" --grep="Part $P:" | wc -l)
     N=$(( priorRounds + 1 ))
     target="$X.$Y.$Z-$N"
     ```
     This naturally resets to `-1` the moment a *new* anchor exists (the
     part before this one finished and shipped clean, moving `X.Y.Z`
     forward) — no separate counter/marker file needed, same
     re-derive-from-git philosophy as the rest of this skill.
   - If the user hands you an explicit target version directly (e.g. "set
     it to v.4.0.0-1"), that instruction wins outright — don't re-derive
     and second-guess it, just apply it (still via `npm version <target>
     --no-git-tag-version`, still no commit until they separately ask for
     one).

Worked example (real): Part 1 finished clean at `4.0.0` (anchor commit
`4996cc5`). Part 2 ("New Workspace") starts; only its Wyvern line item
finishes this round, everything else in Part 2 stays unchecked. First
checkpoint: `git log 4996cc5..HEAD --grep="Part 2:"` finds 0 prior
commits → `N=1` → `4.0.0-1`, committed as `v.4.0.0-1 — Part 2: New
Workspace — Wyvern (simple/newcomer layout)`. A later session ships Drake's
selectability as its own checkpoint, Part 2 still not fully done: the same
grep now finds 1 prior `Part 2:` commit → `N=2` → `4.0.0-2`. Only once every
line in Part 2 (Drake, Dragon, the Setting page) is finally checked does the
fully-finished case above take over: classify the *whole* accumulated diff
since `4996cc5` fresh, drop the suffix, and land on whatever `X.Y.Z` that
classification actually earns (`4.1.0` if Plan.md's own pre-announced label
turns out right, but the classification step still decides that for real —
never just copy the label unchecked).

## Commit value — the `V.x.y.z-n a-b-c-dd/mm/yy` trailer

Every commit that carries a version bump (Flow B's own commits, and the
message `procress-writing` uses for its full close-out) gets one extra
trailer line beyond the standard `Co-Authored-By:` — a compact,
grep-able "commit value" that answers "which version, and which commit is
this in the day/month/major-version" at a glance:

```
V.x.y.z-n a-b-c-dd/mm/yy
```

| Field | Meaning |
|---|---|
| `x.y.z-n` | The exact target version string this run just computed (Flow A step 9 / Flow B step 2), prefixed with capital `V.` instead of the lowercase `v.` used in the human-readable subject line — this is what makes the trailer visually distinct from the subject. Omit `-n` when the target has no in-progress suffix. |
| `a` | This commit's round number **today** — how many commits (any author) already exist in the repo since midnight, plus 1 for the commit being made now. |
| `b` | This commit's round number **this month** — same idea, counted from the 1st of the current month. |
| `c` | This commit's round number **since this major version started** — counted from the commit that first introduced the current major segment `x` (the "major anchor," distinct from Flow A step 2's per-cycle anchor, which tracks the full `X.Y.Z`). |
| `dd/mm/yy` | Today's date, zero-padded day and month, 2-digit year — deliberately not this project's usual ISO style, matching the format the user specified for this trailer specifically. |

Placement: a blank line after the subject, the trailer on its own line, a
blank line, then `Co-Authored-By:`. Example subject + trailer:

```
v.3.7.4 — Part 2: fix wikilink resolver

V.3.7.4 2-5-13-19/07/26

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
```

**Computing it**, run fresh immediately before the commit (never cached,
never reused from an earlier report in the same session — the counters
shift every time another commit lands):

```bash
# a — commits today, inclusive of the one about to be made
a=$(( $(git log --since=midnight --oneline | wc -l) + 1 ))

# b — commits this month, inclusive
b=$(( $(git log --since="$(date +%Y-%m-01)" --oneline | wc -l) + 1 ))

# c — commits since the current major version's anchor, inclusive
# majorAnchor: walk the same pickaxe log as Flow A step 2, but match only
# the major segment X instead of the full X.Y.Z — find the oldest commit
# in that log still carrying today's major X (i.e. one commit past the
# most recent transition away from X, or the log's oldest entry if X has
# never changed). If package.json's version history doesn't reach back to
# X's true introduction (tracking started mid-way), fall back to the
# oldest commit the pickaxe log returns.
if git rev-parse "$majorAnchor^" >/dev/null 2>&1; then
  c=$(( $(git rev-list --count "$majorAnchor^..HEAD") + 1 ))
else
  # majorAnchor is the repo's root commit — no parent to diff from
  c=$(( $(git rev-list --count HEAD) + 1 ))
fi

d=$(date +%d/%m/%y)

commit_value="V.$target $a-$b-$c-$d"   # $target = this run's computed X.Y.Z[-N]
```

This trailer is purely informational bookkeeping — it never feeds back into
the MAJOR/MINOR/PATCH classification or the IN-PROGRESS/FINISHED decision,
and a wrong `majorAnchor` heuristic only skews a display counter, not the
actual `package.json` version.

## Pre commits — the `v.X.Y.Z-n` numbered title

A **Pre** commit (Flow A step 4) never touches `package.json` — but it still
needs a commit title, and a bare "Pre" report isn't one. Every Pre commit's
suggested title is `v.X.Y.Z-n — <one-line summary>`, where `X.Y.Z` is a
**preview guess**, not a real version, and `n` counts how many Pre commits
have already used that same guess since the last real bump. This replaces
the old ad-hoc `pre v.X.Y.Z` convention (no counter, freely incremented by
hand — real precedent in this repo's history: `pre v.4.9.3` then, later,
`pre v.4.9.4`, for two unrelated doc-only commits that never should have
consumed two different guesses).

**Computing the target guess, `X.Y.Z`:**
- Default: current `package.json` version with the patch segment `+1` —
  the same "default to Patch when unsure" bias the rest of this skill
  already uses. Current `4.9.2` → guess `4.9.3`.
- Prefer an explicit label over the default when one exists: if `Plan.md`'s
  current cycle (or the specific part this diff maps to) names a target
  version directly — this repo's own historical convention, e.g. a
  `procress`/`process` write-up section titled `Part 2 — New Workspace
  (v4.1.0)` — use that instead of guessing patch+1.
- This guess is **never binding**. It's a label for humans skimming `git
  log`, not a commitment — the eventual *real* bump (whenever app source
  actually changes) reclassifies fresh via the normal MAJOR/MINOR/PATCH
  steps regardless of what any Pre commit guessed.

**Computing `n`**, re-derived from git every time, never cached:
```bash
# anchor = Flow A step 2's anchor (the last commit that actually changed
# package.json's version line) — same anchor already in hand from step 2.
# target = the X.Y.Z guess computed above.
priorPre=$(git log --oneline "$anchor..HEAD" --grep="^v\.$target-[0-9]\+" -E | wc -l)
n=$(( priorPre + 1 ))
```
This naturally resets to `-1` the moment a *real* bump lands (a new commit
changes `package.json`'s version line, moving the anchor forward) — no
separate counter or marker file, same re-derive-from-git philosophy as
every other counter in this skill.

**Report**, don't commit — same as every other Flow A outcome: state the
suggested title (`v.X.Y.Z-n — <summary>`) for the user to paste in
themselves. Never write the guessed `X.Y.Z-n` to `package.json` — that
field only ever holds a real, classified version.

Worked example: current version `4.9.2` (no real app change since). A docs
sync commit lands (`docs/` only) → guess `4.9.3`, no prior `v.4.9.3-`
commits since the anchor → `v.4.9.3-1 — sync docs`. A second, unrelated
doc-only commit lands before any real app change → same guess, one prior
match → `v.4.9.3-2 — ...`. A real Patch-scale app change then lands and
actually bumps `package.json` to `4.9.3` → the anchor moves to that commit,
and the next Pre commit after *that* starts over at `v.4.9.4-1` (a fresh
patch+1 guess off the new real `4.9.3`).

**Mixed diffs.** The Pre gate (step 4) only fires when the *entire*
accumulated diff since the anchor is non-functional. If real app-source
changes and Pre-eligible changes are mixed together since the same anchor,
the whole thing falls through to normal classification (step 5 onward) —
this numbered scheme only applies to a diff that is Pre in full.

## Decision table — scope

| Signal in the diff | Classification |
|---|---|
| Diff touches only `Plan.md`/`process/`/`docs/`/unwired new assets, no app source reached | **Pre** — no bump, suggest a numbered `v.X.Y.Z-n` title, see step 4 |
| Restructures the module system, nav rail, or overall UI/UX architecture | **Major** — e.g. `2.7.3 → 3.0.0`, the collector→IDE-shell rework |
| Adds or removes a whole module (own renderer + db + IPC + preload) or a major existing function | **Minor** |
| Anything else — bug fix, CSS tweak, i18n key fix, small refactor, doc sync | **Patch** — the default when unsure |

## Module or fix — the MINOR-vs-PATCH test

The two middle rows above are the ones that get misread, so decide between
them with this test rather than by gut feel or by how the commit message
happens to be phrased. Work the steps **in order** — the first step that
lands decides, and step 2 only ever runs if step 1 sends it there.

### Step 1 — what does the diff *create*?

Ask what capability exists after the change that didn't exist before, not
how much code moved:

- **Only edits an existing module, or only edits data/content** — seed rows,
  i18n strings, theme values, copy, config, an existing renderer's markup —
  and creates no new function or feature → **Patch.** Stop here. The line
  count in step 2 never rescues this case: a 900-line rewrite of an existing
  module that ships no new capability is still a Patch.
- **Adds something new that doesn't actually affect the app** — an internal
  helper nothing user-facing calls yet, a dev-only script, a flag nothing
  reads, a test-only fixture → **Patch** as well. "New" isn't enough on its
  own; it has to reach the app's behavior.
- **Adds a standalone function/feature** — a user can reach and use it
  without going through some existing feature, and it isn't built as an
  option/branch/setting *of* something already there → **Minor.** This is
  the "module" case the scope table's Minor row means. Size is irrelevant
  here in the other direction too: a compact, genuinely standalone feature
  is Minor even if it's only 80 lines.
- **Adds a function/feature that only builds on what's already there** — a
  new option on an existing panel, another column on an existing table, more
  cases in an existing renderer, a deeper version of an existing flow → this
  is an *extension*, so go to **step 2**.

### Step 2 — measure the extension (the 500-line threshold)

Only for the extension case. Count changed lines — insertions **plus**
deletions — of real app source across the whole accumulated diff since the
anchor (the same diff Flow A step 3 gathered), plus any uncommitted work:

```bash
paths='src electron/main.js electron/preload.js electron/database.js electron/index.html css scripts test flutter'
git diff --shortstat <anchor>..HEAD -- $paths
git diff --shortstat -- $paths            # unstaged
git diff --shortstat --staged -- $paths   # staged
```

Excluded from the count, deliberately: `package.json`, `package-lock.json`,
`docs/`, `Plan.md`, `process/`, `.claude/`, and `electron/vendor/` — bookkeeping,
documentation, and vendored third-party code aren't the change's own weight,
and `package-lock.json` alone would swamp the number.

- **≤ 500 changed lines → Patch.** An extension this size is a fix/tweak
  regardless of how it's described. This is the common outcome.
- **> 500 changed lines → *candidate* Minor, not an automatic one.** Take
  the whole accumulated diff back to step 1's question: does this much
  extension add up to something a user would call a new capability? If yes,
  **Minor**. If it's still visibly the same feature, just bigger — a large
  refactor, a mechanical sweep across all 18 locales, a CSS restyle, a file
  split — stay at **Patch** and say why in the report. If it's genuinely
  50/50 after that, ask the user instead of deciding silently.

Measure across the **whole** cycle, not just this round: in an in-flight
`-N` series each round can be under 500 while the accumulated diff crosses
it, which is exactly what Flow A step 8's escalation check exists to catch.
Flow B's unfinished-part variant is the one place this test doesn't run at
all — that variant deliberately skips scope classification and only moves
the round counter.

## Decision table — transitions

| Current state | This change is... | New version |
|---|---|---|
| no `-N` suffix | IN-PROGRESS | bump the classified segment, reset lower segments to 0, append `-1` |
| existing `-N` suffix | IN-PROGRESS | keep `X.Y.Z`, increment `N` |
| existing `-N` suffix | FINISHED | drop `-N`, keep `X.Y.Z` as-is (already bumped when the series started) |
| no `-N` suffix | FINISHED | bump the classified segment, reset lower segments to 0, no suffix |

Worked examples:
- `3.7.3`, a commit that only edits `Plan.md`/`process/` → **Pre**,
  version stays `3.7.3`, no `npm version` call, suggested title
  `v.3.7.4-1 — <summary>` (patch+1 guess, first Pre commit since anchor —
  see "Pre commits" above).
- `3.7.3`, a self-contained bug fix, finished in one commit → `3.7.4`.
- `3.7.3`, starting a multi-commit fix, not done yet → `3.7.4-1`.
- `3.7.4-1`, still not done → `3.7.4-2`.
- `3.7.4-2`, this commit finishes it → `3.7.4`.
- `3.7.3`, a new module added in one commit, finished → `3.8.0`.
- `3.8.0`, a UI/architecture overhaul, finished → `4.0.0`.
- `3.7.3`, Part 2 of a multi-part `Plan.md` finishes (Part 1 already shipped
  earlier, Part 3 still unchecked) and Part 2's diff is a bug-fix-scale
  change → Flow B: `3.7.4`, committed as `v.3.7.4 — Part 2: <summary>`,
  pushed. Part 3 finishing later, if it also empties the whole checklist,
  routes to `procress-writing`'s full close-out instead of Flow B.
- `4.0.0` (Part 1 shipped clean), Part 2 is wide open with only one line
  item done, user explicitly asks for a checkpoint → Flow B unfinished-part
  variant: `X.Y.Z` stays `4.0.0` (not bumped, not jumped to Part 2's own
  `4.1.0` label), `N` = 1 (no prior `Part 2:` commits since the `4.0.0`
  anchor) → `4.0.0-1`. A second Part-2 checkpoint later → `N`=2 (1 prior
  `Part 2:` commit found) → `4.0.0-2`. Neither of these is Flow A's generic
  "`3.7.3` → `3.7.4-1`" pattern — that row bumps the segment immediately
  because a single self-contained fix defines the next version outright;
  here, several unrelated slices are all converging on one not-yet-earned
  future target, so the base stays put and only the round counter moves.

## Gotchas

- `git log -- package.json` overcounts — always pickaxe the version line
  itself (`-G'"version":\s*"'`), not a plain path filter. A meaningful
  fraction of commits touch `package.json` for deps/scripts without
  touching the version line, and those aren't cycle boundaries.
- No marker file, by design — unlike `write-docs` (which needs one to
  survive rebases/squashes), there's no persisted belief to protect here.
  The version field itself is the only state, always read fresh; nothing
  to seed on a "first run."
- `package-lock.json`'s two mirrored version fields get updated too, via
  `npm version` — not by hand-editing JSON. This matches 100% of this
  repo's historical version-bump commits; it's intentionally broader than
  "package.json only," not an oversight.
- `--no-git-tag-version` is mandatory on every `npm version` call — neither
  flow ever creates a tag.
- **Flow A never commits when chained-into or when running remote/cloud.**
  When `procress-writing` chains into Flow A, or when Flow A runs in a
  managed remote/cloud session, it never commits — that invariant is
  unconditional in those two cases. Flow B (a single part finished, the
  rest of the plan hasn't) and Flow A's own standalone-local case (step
  11–12) are the two deliberate exceptions — don't generalize their
  commit-and-push behavior back onto a chained-into or remote-session Flow
  A run.
- Deciding local vs. remote is a one-time check per invocation (step 11),
  not something to re-derive per file — a session doesn't change kind
  mid-run. When genuinely unsure which kind of session this is, don't
  guess: bump only and say so, the same as the remote-session behavior,
  rather than risk an unwanted commit+push.
- A non-functional diff is **Pre**, not Patch — never fold "doesn't reach
  the app" into the PATCH default just because PATCH is the fallback for
  ambiguous *app* changes. Pre means no bump either way, but it does mean
  reporting the numbered `v.X.Y.Z-n` title (see "Pre commits" above) — that
  step doesn't skip, only the `npm version` call does.
- The Pre gate is broader than file path alone — a newly-added, not-yet-
  wired asset under an otherwise-"app" directory (an unused png, an unused
  font) is still Pre. Don't classify by directory prefix without checking
  whether anything in the diff (or already-shipped code) actually
  references the new file.
- Mixed/dirty diffs spanning clearly unrelated systems: surface that to the
  user and ask what should count toward this bump, rather than silently
  picking the loudest change.
- **The 500-line threshold only applies to extensions.** It's step 2 of the
  module-or-fix test, reachable only from step 1's "builds on what's already
  there" branch. Never run the line count first and classify off it: a huge
  diff that creates nothing new is a Patch, and a small diff that adds a
  standalone feature is a Minor. Size settles ambiguous extensions, it
  doesn't outrank what the change actually creates.
- **Crossing 500 lines makes Minor a candidate, not a verdict.** Re-check
  the whole accumulated diff for a genuinely new capability before bumping
  `y`; big refactors, 18-locale i18n sweeps, CSS restyles, and file splits
  routinely blow past 500 lines while shipping nothing new — those stay
  Patch, with the reason stated in the report.
- Count changed lines as insertions + deletions of app source only, over the
  whole cycle since the anchor (including uncommitted work) — excluding
  `package-lock.json`, `docs/`, `Plan.md`, `process/`, `.claude/`, and
  `electron/vendor/`. Counting a lockfile or a doc sync into the threshold is the
  easiest way to accidentally promote a Patch to a Minor.
- Malformed/unparseable current version field, or nothing changed since the
  anchor: stop and say so — don't guess, don't bump on an empty diff.
- `Plan.md`/`process/` are a hint for finished/in-progress in Flow A, not
  ground truth — a change might not route through them at all. In Flow B,
  by contrast, the part's checklist state *is* the finished signal —
  decisive, not just a hint.
- **Don't double-fire on the last part.** If the part that just finished was
  the only one left unchecked, Flow B must not run — that scenario belongs
  entirely to `procress-writing`'s full close-out (write-up, `Plan.md`
  reset, Flow A bump, commit, push). Firing Flow B there would bump and
  commit twice for the same close-out.
- Stage by filename in Flow B, never `git add -A`/`-u` — same rationale as
  `procress-writing`'s own staging step: the working tree can have unrelated
  dirty files that aren't part of this part's diff.
- Flow B's push is pre-authorized the same way `procress-writing`'s is —
  scoped to this checkpoint flow only, not a general license to push
  elsewhere.
- The commit-value trailer's `a`/`b`/`c` counters must be recomputed at the
  moment of each actual commit, not once and reused — if Flow B fires twice
  in one day (two different parts), the second commit's `a` must be one
  higher than the first's, not a stale copy.
- The commit-value trailer's `dd/mm/yy` is intentionally day-month-year with
  2-digit year — don't normalize it to this project's usual ISO date style
  elsewhere in docs; this format is specific to the trailer.
- **The unfinished-part variant's `N` is a per-part round counter, not the
  same thing as Flow A's generic IN-PROGRESS `-N`.** Flow A's "no suffix +
  IN-PROGRESS → bump the segment, append `-1`" describes a single
  self-contained fix/feature spanning several commits before *it* finishes
  — the segment bumps immediately because that fix *is* what the next
  version will be. The unfinished-part variant is different: many unrelated
  slices (Wyvern, then Drake, then Dragon, ...) all converge on one
  not-yet-classified future target, so `X.Y.Z` deliberately stays at the
  last *finished* anchor and only `N` moves, recomputed via `git log
  <anchor>..HEAD --grep="Part $P:"` rather than trusted from whatever's
  currently sitting in `package.json`. Don't reach for Flow A's "just
  increment the existing suffix" instinct here — re-derive `N` from git
  every time, exactly as documented in "Flow B, unfinished-part variant."
- The unfinished-part variant never auto-fires — always require an explicit
  ask (the user saying "flow b" / "checkpoint this" / equivalent). Plan.md's
  checklist state for that part is context here, not a trigger, unlike the
  fully-finished case where "every line just got checked" *is* decisive.
