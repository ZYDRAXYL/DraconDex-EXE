#!/usr/bin/env bash
# Re-publish a release from this (private) repo into the public release repo.
#
# DraconDex-EXE is private, so api.github.com/repos/ZYDRAXYL/DraconDex-EXE/releases
# answers 404 to everyone without a token — which is every install of the app
# and every visitor of the website. The update check and the download page
# therefore read a PUBLIC mirror instead: ZYDRAXYL/DraconDex-REL, which holds
# nothing but releases. This script is what keeps that mirror filled.
#
#   mirror-release.sh v4.13.2      one tag
#   mirror-release.sh --all        every published release in the source repo
#
# Environment:
#   SOURCE_REPO    owner/name to read releases from   (default: $GITHUB_REPOSITORY)
#   TARGET_REPO    owner/name to publish them to      (default: ZYDRAXYL/DraconDex-REL)
#   TARGET_BRANCH  branch the mirrored tag is cut from in the target repo (default: main)
#   SOURCE_TOKEN   token that can READ SOURCE_REPO's releases (the workflow's GITHUB_TOKEN)
#   TARGET_TOKEN   token that can WRITE releases in TARGET_REPO — GITHUB_TOKEN is
#                  scoped to this repo alone and CANNOT do it, so this has to be a
#                  PAT/app token. Which secret holds it follows TARGET_REPO:
#                  RELEASE_REPO_TOKEN for ZYDRAXYL/DraconDex-REL, WEB_REPO_TOKEN
#                  for ZYDRAXYL/DraconDex-WEB
#   OPTIONAL_TARGET  "true" makes a missing TARGET_TOKEN a skip (notice, exit 0)
#                  instead of a hard failure — for the legacy DraconDex-REL
#                  mirror, which nothing reads any more
#   ASSETS_DIR     optional; single-tag mode only. Upload these freshly-built files
#                  instead of re-downloading the ones already on the source release
#   MAX            --all mode: how many releases back to walk (default 100)
#
# The mirrored release keeps the source tag verbatim. Since the multi-repo
# split this script runs from two repos — DraconDex-EXE publishing `vX.Y.Z`
# and DraconDex-APK publishing `flutter-vX.Y.Z` — and both trains still land
# in one target repo, so the apps' existing tag-namespace filtering keeps
# working unchanged against the mirror. SOURCE_REPO defaults to
# \$GITHUB_REPOSITORY, so the script itself needed no edit to serve both.
set -euo pipefail

SOURCE_REPO="${SOURCE_REPO:-${GITHUB_REPOSITORY:-}}"
TARGET_REPO="${TARGET_REPO:-ZYDRAXYL/DraconDex-REL}"
TARGET_BRANCH="${TARGET_BRANCH:-main}"
SOURCE_TOKEN="${SOURCE_TOKEN:-${GITHUB_TOKEN:-}}"
TARGET_TOKEN="${TARGET_TOKEN:-}"
ASSETS_DIR="${ASSETS_DIR:-}"
MAX="${MAX:-100}"

what="${1:-}"
if [[ -z "$what" ]]; then
  echo "::error::usage: mirror-release.sh <tag>|--all"
  exit 2
fi
if [[ -z "$SOURCE_REPO" ]]; then
  echo "::error::SOURCE_REPO is empty and GITHUB_REPOSITORY is unset."
  exit 2
fi
# Which secret feeds TARGET_TOKEN depends on where we are mirroring to, and so
# does what breaks when it is missing. Say the right one: this script runs twice
# per job against two different repos, and a message naming RELEASE_REPO_TOKEN
# while mirroring to DraconDex-WEB sends whoever reads it to the wrong repo's
# settings to create the wrong secret.
case "$TARGET_REPO" in
  */DraconDex-WEB)
    token_secret="WEB_REPO_TOKEN"
    breaks="neither the in-app update check nor the website's download page will see it"
    ;;
  *)
    token_secret="RELEASE_REPO_TOKEN"
    breaks="that mirror will be missing this release"
    ;;
esac

# Trimmed, because an unset secret interpolates to an empty string that a bare
# -z test on a quoted "${{ secrets.X }}" would still catch, but a secret set to
# a stray space would not.
if [[ -z "${TARGET_TOKEN// /}" ]]; then
  # An OPTIONAL target with no token is a deliberate configuration, not a
  # breakage: DraconDex-REL is a legacy second mirror that nothing reads
  # since both update checks moved to DraconDex-WEB, so a repo that never sets
  # RELEASE_REPO_TOKEN must not have a red `mirror` job on every single
  # release. The primary target stays fatal — a silent miss there is exactly
  # the failure this whole script exists to prevent.
  if [[ "${OPTIONAL_TARGET:-}" == "true" ]]; then
    echo "::notice::$token_secret is not set — skipping the optional mirror to $TARGET_REPO. Set that secret if you want this mirror filled."
    exit 0
  fi
  cat >&2 <<MSG
::error::$token_secret is not set. The release was published in this repo, but NOT mirrored to $TARGET_REPO — so $breaks. Create a token with \`contents: write\` on $TARGET_REPO and save it as the $token_secret secret, then re-run this workflow (or run the "Mirror releases" workflow for the affected tag).
MSG
  exit 1
fi

src_gh() { GH_TOKEN="$SOURCE_TOKEN" gh "$@"; }
tgt_gh() { GH_TOKEN="$TARGET_TOKEN" gh "$@"; }

mirror_one() {
  local tag="$1"
  local assets_dir="${2:-}"
  local work notes title
  work="$(mktemp -d)"

  # `gh release view --json` fails loudly on a tag that does not exist, which
  # is what we want: a typo'd tag must not create an empty mirror release.
  src_gh release view "$tag" -R "$SOURCE_REPO" \
    --json body,name,isDraft,isPrerelease > "$work/meta.json"

  if [[ "$(jq -r '.isDraft' "$work/meta.json")" == "true" ]]; then
    echo "Skipping $tag — still a draft in $SOURCE_REPO."
    rm -rf "$work"
    return 0
  fi

  title="$(jq -r '.name // ""' "$work/meta.json")"
  [[ -n "$title" ]] || title="$tag"
  notes="$work/notes.md"
  jq -r '.body // ""' "$work/meta.json" > "$notes"
  # Release notes generated with --generate-notes link back to compare views
  # and PRs in the PRIVATE source repo, which 404 for the public reading the
  # mirror. Say where they lead rather than silently shipping dead links.
  {
    echo
    echo "---"
    echo
    echo "Mirrored from the DraconDex app repository. Links in the notes above point into that repository and are not public."
  } >> "$notes"

  # Fresh build outputs when the calling workflow has them (no re-download, and
  # no window in which the source release is missing an asset), otherwise pull
  # back what is already attached upstream.
  local upload_dir=""
  if [[ -n "$assets_dir" && -d "$assets_dir" ]] && compgen -G "$assets_dir/*" > /dev/null; then
    upload_dir="$assets_dir"
  else
    mkdir -p "$work/assets"
    # A release with no assets at all is legitimate (a notes-only release), so
    # a failed download is not fatal — the emptiness check below decides.
    src_gh release download "$tag" -R "$SOURCE_REPO" -D "$work/assets" --clobber || true
    if compgen -G "$work/assets/*" > /dev/null; then
      upload_dir="$work/assets"
    fi
  fi

  local files=()
  if [[ -n "$upload_dir" ]]; then
    while IFS= read -r -d '' f; do files+=("$f"); done \
      < <(find "$upload_dir" -maxdepth 1 -type f -print0)
  fi

  local prerelease_args=()
  if [[ "$(jq -r '.isPrerelease' "$work/meta.json")" == "true" ]]; then
    prerelease_args+=(--prerelease)
  fi

  if tgt_gh release view "$tag" -R "$TARGET_REPO" >/dev/null 2>&1; then
    echo "Updating existing $TARGET_REPO release $tag."
    tgt_gh release edit "$tag" -R "$TARGET_REPO" --title "$title" --notes-file "$notes" >/dev/null
    if [[ ${#files[@]} -gt 0 ]]; then
      tgt_gh release upload "$tag" -R "$TARGET_REPO" --clobber "${files[@]}"
    fi
  else
    echo "Creating $TARGET_REPO release $tag."
    # --target, not --verify-tag: the target repo carries no source history, so
    # the tag does not exist there yet and gh cuts it from this branch's head.
    tgt_gh release create "$tag" -R "$TARGET_REPO" \
      --target "$TARGET_BRANCH" \
      --title "$title" \
      --notes-file "$notes" \
      "${prerelease_args[@]}" \
      ${files[@]+"${files[@]}"}
  fi

  echo "Mirrored $tag -> https://github.com/$TARGET_REPO/releases/tag/$tag (${#files[@]} asset(s))"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "- \`$tag\` → [$TARGET_REPO](https://github.com/$TARGET_REPO/releases/tag/$tag) — ${#files[@]} asset(s)" >> "$GITHUB_STEP_SUMMARY"
  fi
  rm -rf "$work"
}

if [[ "$what" == "--all" ]]; then
  # `gh release list` omits drafts only with --exclude-drafts; keep them out
  # here so mirror_one's own draft check is a second line of defence, not the
  # only one.
  # Oldest PUBLISHED first. Every tag this script cuts in the target repo
  # points at the same branch head, so all mirrored releases share one
  # created_at and GitHub breaks the tie — including the "Latest" badge — by
  # creation order; mirroring in publish order therefore leaves the genuinely
  # newest release on top instead of buried. Note this deliberately does NOT
  # reverse the list gh hands back: that order is created_at (the date of the
  # commit each tag points at), which is the very thing that put
  # flutter-v2.10.1 below flutter-v2.9.0 in the first place. The apps do not
  # rely on any of this — they compare version numbers — but a human browsing
  # the mirror does.
  mapfile -t tags < <(src_gh release list -R "$SOURCE_REPO" \
    --limit "$MAX" --exclude-drafts --json tagName,publishedAt \
    --jq 'sort_by(.publishedAt) | .[].tagName')
  echo "Mirroring ${#tags[@]} release(s) from $SOURCE_REPO to $TARGET_REPO."
  for tag in "${tags[@]}"; do
    mirror_one "$tag" ""
  done
else
  mirror_one "$what" "$ASSETS_DIR"
fi
