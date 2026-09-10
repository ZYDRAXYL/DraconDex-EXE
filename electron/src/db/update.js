'use strict';
// A read-only version-update notice, not an auto-updater. Reads the latest
// GitHub Release from the project's PUBLIC release mirror and offers it to the
// user. Plain fetch() against the GitHub REST API, same style as
// sync.js/drive.js. See docs/UPDATE.md.
//
// Plan process1 part2 #1: no longer gated behind either of this app's two
// independent logins (Cloud Sync's Supabase login, Drive Backup's own login)
// — a GitHub Releases check is public data, so there is no reason to require
// login just to see whether a newer version exists.
//
// This used to read a Firestore doc under a project id that was never actually
// registered (it carried a `TODO(maintainer): real Firebase project id`).
// Firebase project ids are globally unique and first-come-first-served, so an
// unclaimed id is a trust root anyone can take over and then serve arbitrary
// `version`/`notes`/`url` to every install. GitHub Releases moves that trust
// root onto the repo the project already owns, and nothing here trusts the
// response shape: see parseGithubRelease below.
const { app, shell } = require('electron');
const { getAppSetting, setAppSetting } = require('./versions');

// This app's own canonical release feed — every install reads the SAME one,
// unlike sync:url/drive:clientId (per-deployment operator config), so this is
// a source constant, not a runtime app_setting.
//
// NOT the source repo (ZYDRAXYL/DraconDex-EXE): that one is PRIVATE, and the
// GitHub REST API answers 404 to every unauthenticated caller — which is every
// install of this app. The check silently reported "you are up to date" no
// matter how many releases had shipped. Releases are therefore mirrored to a
// public repo by .github/scripts/mirror-release.sh (run from the `mirror` job
// in build-electron.yml / build-apk.yml), and this check reads that mirror.
// See docs/UPDATE.md §2.12.
//
// That mirror is ZYDRAXYL/DraconDex-WEB — the website repo, which is also where
// the download page's own release data comes from. It used to be a separate
// releases-only repo, ZYDRAXYL/DraconDex-REL; pointing both consumers at one
// mirror means a release only has to land in one place to be visible
// everywhere, and one token to keep alive instead of two. The assets are the
// same files either way, mirrored by the same script.
// FORKERS: a fork MUST edit this to its own repo, or the update check reports
// the upstream project's releases. Everything else in this app is configurable
// without touching source; this is the one exception.
const REPO = 'ZYDRAXYL/DraconDex-WEB';
// NOT /releases/latest: the mirror carries the Flutter/APK port's own releases
// (tag flutter-vX.Y.Z, see flutter/lib/data/services/update_service.dart and
// .github/workflows/build-apk.yml) alongside this app's, exactly as the source
// repo does. /releases/latest returns the single most-recently-published
// non-draft/non-prerelease release across the whole repo regardless of which
// product it belongs to, so a same-day flutter-v release can shadow a genuinely
// newer electron v release (or the reverse) and make this app see "no update"
// while one exists. List instead and pick the newest release that belongs to
// THIS app's own tag namespace. per_page is generous because BOTH trains share
// the list and the newest release of one may sit well down it.
const RELEASES_LIST_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
// The Flutter/APK port's release tag prefix — never treat one of these as an
// Electron release.
const FOREIGN_TAG_PREFIX = 'flutter-';
// Every URL this module is willing to hand to the browser must start with
// this. Pinning the host alone is not enough — the path prefix is what keeps a
// compromised or unexpected API response from pointing anywhere else.
const RELEASE_URL_PREFIX = `https://github.com/${REPO}/releases`;
const NOTES_MAX = 4000;

const IS_DEV = !app.isPackaged;
const SEEN_KEY = 'update:seenVersion';
const AUTO_CHECK_KEY = 'update:autoCheck';

// ponytail: no in-process mock server (unlike sync-devserver.js/drive-
// devserver.js) — one stateless public GET doesn't need one. Env-var forced
// "latest" mirrors DDX_DEV_DRIVE_QUOTA_PCT; unset = "no update" by default.
function fakeDoc() {
  const version = process.env.DDX_DEV_UPDATE_VERSION || app.getVersion();
  return { version, notes: `Dev mock update notes for v${version}`, url: `${RELEASE_URL_PREFIX}/tag/v${version}` };
}

// A release tag we are willing to compare against app.getVersion(). Anything
// else (a codename, an empty tag, a tag with a path in it) is rejected outright
// rather than coerced — isNewerVersion() would happily parse garbage to 0.
const TAG_RE = /^\d+(\.\d+){0,3}$/;

// The response is remote data, so every field is validated, never trusted:
// the version must look like a version, and the URL must live under this
// repo's own releases path. Returning null means "no update", which is the
// same path every other failure takes.
function parseGithubRelease(json) {
  const version = String(json?.tag_name || '').replace(/^v/i, '').trim();
  if (!TAG_RE.test(version)) return null;
  const htmlUrl = String(json?.html_url || '');
  const url = htmlUrl.startsWith(`${RELEASE_URL_PREFIX}/`) ? htmlUrl : RELEASE_URL_PREFIX;
  return { version, notes: String(json?.body || '').slice(0, NOTES_MAX), url };
}

// Picks the HIGHEST version in this app's own tag namespace — deliberately not
// the first list entry.
//
// GET /releases is ordered by the release's created_at, and a release's
// created_at is the date of the COMMIT its tag points at, not the date it was
// published. Tag a fix that sits on an older commit and its release sorts below
// releases published days earlier: in the real feed flutter-v2.10.0/2.10.1 both
// landed underneath flutter-v2.9.0, so "first match wins" reported 2.9.0 as the
// latest Flutter release and every 2.9 install was told it was up to date while
// 2.10.1 was out. Comparing versions has no such failure mode. Kept as a pure
// function (list in, release out) so it's testable without mocking fetch — see
// update-release.test.mjs.
function pickOwnRelease(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const item of list) {
    if (item?.draft || item?.prerelease) continue;
    const tag = String(item?.tag_name || '');
    if (tag.toLowerCase().startsWith(FOREIGN_TAG_PREFIX)) continue;
    const parsed = parseGithubRelease(item);
    if (!parsed) continue;
    // Ties keep the earlier entry, i.e. the one GitHub itself ranks first.
    if (!best || isNewerVersion(parsed.version, best.version)) best = parsed;
  }
  return best;
}

async function fetchLatest() {
  if (IS_DEV) return fakeDoc();
  let res;
  try {
    // Unlike /releases/latest, the list endpoint includes drafts and
    // prereleases, so both are filtered out inside pickOwnRelease(). The API
    // rejects requests without a User-Agent.
    res = await fetch(RELEASES_LIST_URL, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': `DraconDex/${app.getVersion()}`,
      },
    });
  } catch (_) { return null; }
  if (!res.ok) return null;
  let list;
  try { list = await res.json(); } catch (_) { return null; }
  return pickOwnRelease(list);
}

const stripPrerelease = (v) => String(v || '').split('-')[0];
const parts = (v) => stripPrerelease(v).split('.').map((n) => parseInt(n, 10) || 0);
function isNewerVersion(remote, local) {
  const r = parts(remote), l = parts(local);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const d = (r[i] || 0) - (l[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

async function checkForUpdate() {
  const current = app.getVersion();
  const latest = await fetchLatest();
  if (!latest || !isNewerVersion(latest.version, current)) return { ok: true, available: false, current };

  const dismissed = (getAppSetting(SEEN_KEY) || '') === latest.version;
  return { ok: true, available: true, dismissed, version: latest.version, notes: latest.notes, url: latest.url, current };
}

function dismissUpdate(version) { setAppSetting(SEEN_KEY, String(version || '')); return { ok: true }; }

// Plan process1 part2 #1.2: on by default (unset/anything but the literal
// '0' reads as enabled) — same getAppSetting boolean-as-string convention as
// drive.js's own `drive:autoBackup` flag, checked once per app open by
// initVersionCheck() (renderer/update.js) rather than on an interval.
function getAutoCheck() { return getAppSetting(AUTO_CHECK_KEY) !== '0'; }
function setAutoCheck(enabled) { setAppSetting(AUTO_CHECK_KEY, enabled ? '1' : '0'); return { ok: true }; }

// The renderer passes the URL back in, so this re-checks it rather than
// assuming it is the one checkForUpdate() handed out. A bare `^https?://`
// test would let any renderer-side compromise pop the browser at an arbitrary
// site; pinning the releases prefix means the only reachable destination is
// this repo's own release pages.
function openUpdateDownload(url) {
  const u = String(url || '');
  if (u === RELEASE_URL_PREFIX || u.startsWith(`${RELEASE_URL_PREFIX}/`)) shell.openExternal(u);
  return { ok: true };
}

module.exports = { checkForUpdate, dismissUpdate, openUpdateDownload, getAutoCheck, setAutoCheck };
