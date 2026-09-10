---
name: build-release-git
description: Decide whether the current version is due for a GitHub release, and cut it by pushing a `vX.Y.Z` tag — the `.github/workflows/build-electron.yml` workflow builds the NSIS installer, the single-file portable exe, and the portable app-folder zip, then publishes them as release assets. Uses a release cadence measured against the last released tag, not against every commit — every major (X) bump releases on its own, minor (Y) bumps release every 1–2, and fix (Z) bumps release every 3–5. Use when asked to "cut a release", "build the release", "publish to GitHub releases", "ปล่อยเวอร์ชันใหม่", "อัปเดต release บน github", or after `version-update` bumps a version and you need to know whether that bump is due for a release yet.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# build-release-git

`version-update` decides the *number*. This skill decides whether that number
is worth a **release**, and cuts it. They are separate on purpose — this repo
bumps a version on nearly every checkpoint commit, and every bump does not
deserve a 3-target Windows build.

## The one mechanism

Pushing a `v*` tag is the *entire* release. `.github/workflows/build-electron.yml`
does the rest: `npm ci` → regression tests → `build:installer` + `build:exe` +
`build:portable` → SHA-256 checksums → `gh release create <tag> --generate-notes`
with all four assets attached.

There is no other supported path. Do not build locally and upload by hand.

## Cadence rule — is a release due?

Compare `package.json`'s version against the **last released tag**, not the
last commit:

```bash
git fetch --tags --quiet
git tag --sort=-v:refname | head -5          # last tag
node -p "require('./package.json').version"  # current version
```

Count what has landed since that tag, then:

| Bump since last release | Release when |
|---|---|
| **Major** (X) — UI/UX or architecture overhaul | **Always.** One major = one release, on its own. |
| **Minor** (Y) — a module/major feature added or removed | Every **1–2** minors. Cut at 2 at the latest. |
| **Fix** (Z) — bug fixes, small tweaks | Every **3–5** fixes. Cut at 5 at the latest. |

Higher tier wins: if a major landed, release now regardless of how few fixes
sit on top. Mixed minors and fixes — count the minors and ignore the fixes.

`-N` checkpoint suffixes are **not** releases. A version still carrying `-N`
is mid-flight; wait for it to settle to a clean `X.Y.Z` before tagging.

**Always release, cadence aside**, when any of these is true — the counter is a
floor for routine work, not a ceiling on judgment:

- The user asked for a release outright.
- A crash, data-loss, or security fix landed. Ship it immediately.
- The last release is stale enough that users are running something the repo
  no longer resembles.

## Flow

1. **Confirm the tree is clean and on `main`.** `git status --short` must be
   empty, and HEAD must be the commit you intend to ship. A tag is a pointer
   to a commit — uncommitted work is not in the release.

2. **Check the cadence** with the table above. If a release isn't due, say so
   and stop: *"4.6.0 is 1 minor since v4.5.0 — due at 2. Say the word and I'll
   cut it anyway."* Don't tag on a hunch.

3. **Check the version isn't already released.** `git tag` is the local view
   and can lag; the published list is authoritative:

   ```bash
   curl -s https://api.github.com/repos/ZYDRAXYL/DraconDex-APP/releases | grep '"tag_name"'
   ```

   Tag names are `v<version>` with no extra prefix — `4.7.1` → `v4.7.1`.

4. **Tag and push.**

   ```bash
   git tag -a v4.7.1 -m "DraconDex 4.7.1"
   git push origin v4.7.1
   ```

   Push the tag alone. Never `git push --tags` — it fires every unpushed tag,
   and every one of them starts its own Windows build.

5. **Report the run.** The workflow takes several minutes. Point the user at
   <https://github.com/ZYDRAXYL/DraconDex-APP/actions/workflows/build-electron.yml>
   and confirm the release afterwards via the `releases` API call above —
   four assets are expected:

   - `DraconDex-Setup-<version>.exe` — NSIS installer
   - `DraconDex-Portable-<version>.exe` — single-file portable
   - `DraconDex-<version>-win-x64.zip` — portable app folder
   - `checksums-sha256.txt`

## When it goes wrong

- **Workflow warns "tag does not match package.json version"** — the tag was
  cut off the wrong commit. Delete it (`git push origin :refs/tags/vX.Y.Z`)
  and re-tag the commit that actually carries that version.
- **Tests fail in CI** — the release does not publish, by design. Fix on
  `main`, then delete and re-push the tag; a tag is not a build artifact and
  re-cutting one that never published is safe.
- **Release exists but assets are missing** — re-run the workflow manually
  (`workflow_dispatch` with `tag: vX.Y.Z`, `draft: false`). The publish step
  uploads with `--clobber` onto an existing release rather than failing.
- **Tag already published** — never move a published tag. Bump the version
  and cut the next one.

## What this skill does not do

- It does not bump versions. That's `version-update`; run it first.
- It does not write changelogs. The release notes are `--generate-notes`
  (commit-derived); `docs/CHANGELOG.md` is `write-docs`' job.
- It does not touch `publish-package.yml` (the npm/GitHub Packages publish) or
  `build-apk.yml` (the Flutter port). Those are separate pipelines with their
  own triggers.
