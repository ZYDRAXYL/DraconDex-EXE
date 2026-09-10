---
name: merge-release
description: After a pull request merges in a DraconDex chain repo, decide whether the merged work has earned a release and cut it — reading the repo's own tag namespace and version source from chain/chain.json (sdb-v*, v*, flutter-v*, pkg-v*) rather than assuming the Electron train. Applies a cadence measured against the last released tag, not against every merge. Use after merging a PR, when asked "release ให้หน่อย", "ตัด version ใหม่", "cut a release", "should this be released", "auto release after merge", or when a chained-update PR lands and you need to know whether it ships.
---

<!-- mirrored-from-app: do not edit here -->
> **Mirrored file — edit this in `ZYDRAXYL/DraconDex-APP`, not here.**
> `tools/mirror-claude.mjs` regenerates it and any local edit is lost on the
> next mirror. ดูสัญญาของ chain ที่ `chain/README.md`

# merge-release — is this merge due for a release, and cut it if so

Four repos in the chain publish releases, each on its own tag namespace. This
skill reads which one it is from `chain/chain.json` rather than assuming:

| Repo | Tag | Version source | Built by |
|---|---|---|---|
| SDB | `sdb-v*` | `sdb.json` → `sdbVersion` | schema artifacts |
| EXE | `v*` | `package.json` → `version` | NSIS installer, portable exe, portable zip |
| APK | `flutter-v*` | `flutter/pubspec.yaml` → `version` | signed APKs |
| PKG | `pkg-v*` | `package.json` → `version` | package catalog + payloads |

`node tools/chain-lib.mjs` prints the current repo's train.

## Step 1 — did this merge reach the product at all?

A merge that changes no shipped behaviour is not a release candidate, no matter
how large the diff. Docs, plans, process write-ups, skills, CI config and
comment-only changes are all "Pre" merges — record them, do not bump, do not tag.

`version-update` already encodes this test in detail, including the path
allowlist that decides what counts as app source. Defer to it rather than
re-deriving the rule here.

## Step 2 — is a release due yet?

Cadence is measured **against the last released tag in this repo's namespace**,
not against every merge. Releasing every fix trains people to ignore releases.

| Bump since last release | Release when |
|---|---|
| major (X) | immediately, on its own |
| minor (Y) | every 1–2 |
| fix (Z) | every 3–5 |

For SDB the trigger is sharper, because two live apps pin it: a
`vaultSchemaVersion` bump releases immediately, so consumers have something to
pin to. A generator-formatting change can wait.

Find the last released tag in this repo's own namespace — never
`/releases/latest`, which returns whichever release was published most recently
across every namespace in the mirror. The apps' update checkers already filter
this way for exactly that reason, and so must this.

## Step 3 — cut it

1. Confirm the working tree is clean and on the default branch.
2. Confirm the version source and the tag agree — `v4.16.1` must mean
   `package.json` says `4.16.1`. The publish workflow enforces this too; failing
   locally first is faster than failing in CI.
3. Prepend a dated entry to `docs/CHANGELOG.md` in APP (Thai, matching the
   existing format) — the changelog stays project-wide in the hub.
4. Push the tag. The repo's build workflow does the rest: it builds the
   artifacts, publishes the release, and mirrors it to WEB, which is where both
   update checkers and the download page read from.

## Step 4 — tell the chain

A release is an edge event. After the tag lands, run `chained-updated`: an SDB
release means EXE and APK need a pin bump, and an EXE or APK release means PWA
needs a source-pin bump. The release mirror to WEB happens inside the build
workflow already — do not run it again here.

## What this skill will not do

- **Never cut a release to make a red build green.** A failing check is a
  failing check.
- **Never move an existing tag.** Consumers pin by tag; a moved tag silently
  changes what they resolved. Cut the next number instead.
- **Never release from a branch other than the default one.**
- **Never publish a release whose version source and tag disagree** — that
  mismatch is what makes an installer announce the wrong version to users.
