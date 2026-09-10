#!/usr/bin/env bash
# Snapshot ZYDRAXYL/DraconDex-WEB's own release list into a static JSON file
# committed inside that repo, so the download pages there can read a
# same-origin file instead of calling api.github.com from every visitor's
# browser.
#
# assets/js/releases.js used to fetch api.github.com/repos/ZYDRAXYL/DraconDex-REL
# live at page load. That is a public repo, so it works, but anonymous GitHub
# API requests are capped at 60/hour PER IP — fine for one visitor, but a
# shared office/campus NAT or a traffic spike can exhaust it for everyone
# behind that IP at once, and every download entry point then falls back to a
# plain link instead of the asset list. A file served by GitHub Pages carries
# no such limit.
#
# This script runs AFTER mirror-release.sh has published/updated the release
# (with its assets) on ZYDRAXYL/DraconDex-WEB itself — see the `mirror` jobs in
# build-electron.yml / build-apk.yml, and mirror-releases.yml. It re-reads
# that repo's own release list (so the file always matches exactly what
# mirror-release.sh just published, drafts already excluded) and writes it
# via the Contents API — no local git checkout needed.
#
# Environment:
#   WEB_REPO    owner/name of the site repo (default: ZYDRAXYL/DraconDex-WEB)
#   WEB_BRANCH  branch to commit the JSON to (default: main)
#   WEB_TOKEN   token with `contents: write` on WEB_REPO — same secret
#               (RELEASE_REPO_TOKEN-style PAT) mirror-release.sh needs, kept
#               in the WEB_REPO_TOKEN secret since it is a different target
#               repo than RELEASE_REPO_TOKEN's ZYDRAXYL/DraconDex-REL
#   JSON_PATH   path inside WEB_REPO to write (default: assets/data/releases.json)
set -euo pipefail

WEB_REPO="${WEB_REPO:-ZYDRAXYL/DraconDex-WEB}"
WEB_BRANCH="${WEB_BRANCH:-main}"
WEB_TOKEN="${WEB_TOKEN:-}"
JSON_PATH="${JSON_PATH:-assets/data/releases.json}"

if [[ -z "${WEB_TOKEN// /}" ]]; then
  cat >&2 <<'MSG'
::error::WEB_REPO_TOKEN is not set. The site's assets/data/releases.json was NOT refreshed — the download pages will keep showing the previous release until this is fixed. Create a token with `contents: write` on ZYDRAXYL/DraconDex-WEB and save it as the WEB_REPO_TOKEN secret, then re-run this workflow.
MSG
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# per_page goes in the URL, NOT as a `-F per_page=100` field: `gh api` treats
# -F as a request BODY field and silently switches the method to POST, and
# POST /repos/{owner}/{repo}/releases is "create a release" — which answers
# 422 `"tag_name" wasn't supplied` instead of listing anything. That is a GET
# with a query string.
# The 100 ceiling is the whole list this file ever carries; revisit with
# --paginate if the repo ever holds more than that many releases.
GH_TOKEN="$WEB_TOKEN" gh api "repos/$WEB_REPO/releases?per_page=100" \
  -H "Accept: application/vnd.github+json" > "$work/raw.json"

# Belt-and-braces: mirror-release.sh already refuses to publish a draft, but
# a release created by hand in the GitHub UI could still be one.
jq '[.[] | select(.draft == false)]' "$work/raw.json" > "$work/releases.json"

count="$(jq 'length' "$work/releases.json")"
echo "Snapshotting $count published release(s) from $WEB_REPO into $JSON_PATH."

existing_sha="$(
  GH_TOKEN="$WEB_TOKEN" gh api "repos/$WEB_REPO/contents/$JSON_PATH?ref=$WEB_BRANCH" \
    --jq '.sha' 2>/dev/null || true
)"

# The request body goes through a FILE, never the command line. The Contents
# API wants the whole file base64'd in `content`, and Linux caps a single
# argument at MAX_ARG_STRLEN (128 KiB) regardless of how high the total
# ARG_MAX is — so `-f content="$blob"` dies with "Argument list too long"
# (exit 126) once the snapshot outgrows that. It did: 16 releases of full API
# JSON base64 to well over 128 KiB. jq --rawfile keeps the blob off jq's
# argv too, so nothing on this path scales with the file's size.
base64 -w0 "$work/releases.json" > "$work/content.b64"

jq -n \
  --rawfile content "$work/content.b64" \
  --arg message "Update mirrored release data" \
  --arg branch "$WEB_BRANCH" \
  --arg sha "$existing_sha" \
  '{message: $message, content: ($content | rtrimstr("\n")), branch: $branch}
   + (if $sha == "" then {} else {sha: $sha} end)' > "$work/body.json"

GH_TOKEN="$WEB_TOKEN" gh api -X PUT "repos/$WEB_REPO/contents/$JSON_PATH" \
  --input "$work/body.json" >/dev/null
echo "Updated https://github.com/$WEB_REPO/blob/$WEB_BRANCH/$JSON_PATH"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- Refreshed \`$JSON_PATH\` on \`$WEB_REPO\` ($count release(s))" >> "$GITHUB_STEP_SUMMARY"
fi
