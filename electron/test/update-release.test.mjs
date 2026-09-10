import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Same CRLF-safe read the other tests use — see module-transfer.test.mjs.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// src/db/update.js can't be imported directly here (it pulls in electron, and
// transitively sync.js/drive.js/the DB), so the pure parsing half is lifted out
// of the source and exercised on its own. That keeps the assertions about real
// behaviour rather than about the text of the file.
function loadParser() {
  const src = readSource('../src/db/update.js');
  const prefix = src.match(/const RELEASE_URL_PREFIX = ([^\n]+);/)?.[1];
  const tagRe = src.match(/const TAG_RE = ([^\n]+);/)?.[1];
  const notesMax = src.match(/const NOTES_MAX = ([^\n]+);/)?.[1];
  const repo = src.match(/const REPO = ([^\n]+);/)?.[1];
  const fn = src.match(/function parseGithubRelease\(json\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(prefix && tagRe && notesMax && repo && fn, 'update.js parser pieces not found');
  // eslint-disable-next-line no-new-func
  return new Function(`
    const REPO = ${repo};
    const RELEASE_URL_PREFIX = ${prefix};
    const TAG_RE = ${tagRe};
    const NOTES_MAX = ${notesMax};
    ${fn}
    return { parseGithubRelease, RELEASE_URL_PREFIX };
  `)();
}

// The shape below is a real response from
// GET /repos/ZYDRAXYL/DraconDex-WEB/releases, trimmed to the fields the
// parser reads. The feed is the PUBLIC release mirror, not the private app
// repo — see the REPO comment in src/db/update.js.
const REAL_RELEASE = {
  tag_name: 'v4.7.1',
  name: 'DraconDex 4.7.1',
  draft: false,
  prerelease: false,
  body: "## What's Changed\n* CI: publish @zydraxyl/dracondex to GitHub Packages\n",
  html_url: 'https://github.com/ZYDRAXYL/DraconDex-WEB/releases/tag/v4.7.1',
};

test('parseGithubRelease reads a real GitHub release payload', () => {
  const { parseGithubRelease } = loadParser();
  const r = parseGithubRelease(REAL_RELEASE);
  assert.equal(r.version, '4.7.1', 'leading v is stripped off tag_name');
  assert.equal(r.url, REAL_RELEASE.html_url);
  assert.match(r.notes, /What's Changed/);
});

// The whole point of moving off the old Firestore doc was that its project id
// was never registered, so ANY response had to be treated as attacker-shaped.
// These are the checks that make the new source safe to trust.
test('parseGithubRelease rejects a version that is not a version', () => {
  const { parseGithubRelease } = loadParser();
  for (const tag of ['', 'latest', 'v', '4.7.1-rc1; DROP', '../../etc', 'v4.7.1/../..', 'nightly']) {
    assert.equal(parseGithubRelease({ ...REAL_RELEASE, tag_name: tag }), null, `tag ${JSON.stringify(tag)} must be rejected`);
  }
  assert.equal(parseGithubRelease({}), null, 'an empty payload is not an update');
  assert.equal(parseGithubRelease(null), null);
});

test('parseGithubRelease pins the download URL to this repo releases path', () => {
  const { parseGithubRelease, RELEASE_URL_PREFIX } = loadParser();
  const hostile = [
    'https://evil.example/pwn',
    'https://github.com/evil/repo/releases/tag/v1',
    'https://github.com.evil.example/ZYDRAXYL/DraconDex-WEB/releases/tag/v1',
    'javascript:alert(1)',
    '',
  ];
  for (const html_url of hostile) {
    const r = parseGithubRelease({ ...REAL_RELEASE, html_url });
    assert.equal(r.url, RELEASE_URL_PREFIX, `${JSON.stringify(html_url)} must fall back to the pinned prefix`);
  }
});

test('parseGithubRelease caps the length of remote release notes', () => {
  const { parseGithubRelease } = loadParser();
  const r = parseGithubRelease({ ...REAL_RELEASE, body: 'x'.repeat(50000) });
  assert.ok(r.notes.length <= 4000, `notes should be capped, got ${r.notes.length}`);
});

test('openUpdateDownload only opens the pinned releases prefix', () => {
  const src = readSource('../src/db/update.js');
  const fn = src.match(/function openUpdateDownload\(url\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn, 'openUpdateDownload not found');
  // A bare protocol test would let a compromised renderer open any site.
  assert.doesNotMatch(fn, /\^https\?:\\\/\\\//, 'must not fall back to a bare ^https?:// check');
  assert.match(fn, /RELEASE_URL_PREFIX/, 'must gate on the pinned prefix');
});

test('the old unregistered Firestore trust root is gone', () => {
  const src = readSource('../src/db/update.js');
  assert.doesNotMatch(src, /firestore\.googleapis\.com/, 'Firestore endpoint must not come back');
  assert.doesNotMatch(src, /FIRESTORE_PROJECT_ID/, 'the unowned project id constant must not come back');
});

// ZYDRAXYL/DraconDex-APP is private: api.github.com answers 404 to every install,
// and fetchLatest() turns any non-200 into "no update", so pointing the feed
// back at it silently disables the update check for everyone. Releases are
// mirrored to the public ZYDRAXYL/DraconDex-WEB instead.
test('the release feed is the public mirror, not the private app repo', () => {
  const { parseGithubRelease, RELEASE_URL_PREFIX } = loadParser();
  assert.equal(RELEASE_URL_PREFIX, 'https://github.com/ZYDRAXYL/DraconDex-WEB/releases');
  // ...and the private repo's own URLs must not pass the pin either.
  const r = parseGithubRelease({
    ...REAL_RELEASE,
    html_url: 'https://github.com/ZYDRAXYL/DraconDex-APP/releases/tag/v4.7.1',
  });
  assert.equal(r.url, RELEASE_URL_PREFIX);
});

// This repo also publishes the Flutter/APK port's releases (tag
// flutter-vX.Y.Z) alongside the Electron app's own (tag vX.Y.Z). A single
// GET /releases/latest can't tell the two apart — whichever train published
// most recently wins for the WHOLE repo — so the Electron app must list
// releases and pick the newest one in its own tag namespace instead.
function loadPicker() {
  const src = readSource('../src/db/update.js');
  const prefix = src.match(/const RELEASE_URL_PREFIX = ([^\n]+);/)?.[1];
  const tagRe = src.match(/const TAG_RE = ([^\n]+);/)?.[1];
  const notesMax = src.match(/const NOTES_MAX = ([^\n]+);/)?.[1];
  const repo = src.match(/const REPO = ([^\n]+);/)?.[1];
  const foreignPrefix = src.match(/const FOREIGN_TAG_PREFIX = ([^\n]+);/)?.[1];
  const parseFn = src.match(/function parseGithubRelease\(json\) \{[\s\S]*?\n\}/)?.[0];
  const pickFn = src.match(/function pickOwnRelease\(list\) \{[\s\S]*?\n\}/)?.[0];
  // pickOwnRelease ranks candidates by version now, so its comparison helpers
  // have to come along too.
  const stripFn = src.match(/const stripPrerelease = [^\n]+;/)?.[0];
  const partsFn = src.match(/const parts = [^\n]+;/)?.[0];
  const newerFn = src.match(/function isNewerVersion\(remote, local\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(prefix && tagRe && notesMax && repo && foreignPrefix && parseFn && pickFn, 'update.js picker pieces not found');
  assert.ok(stripFn && partsFn && newerFn, 'update.js version-comparison pieces not found');
  // eslint-disable-next-line no-new-func
  return new Function(`
    const REPO = ${repo};
    const RELEASE_URL_PREFIX = ${prefix};
    const TAG_RE = ${tagRe};
    const NOTES_MAX = ${notesMax};
    const FOREIGN_TAG_PREFIX = ${foreignPrefix};
    ${stripFn}
    ${partsFn}
    ${newerFn}
    ${parseFn}
    ${pickFn}
    return { pickOwnRelease };
  `)();
}

const published = (tag_name, overrides = {}) => ({
  tag_name,
  draft: false,
  prerelease: false,
  body: '',
  html_url: `https://github.com/ZYDRAXYL/DraconDex-WEB/releases/tag/${tag_name}`,
  ...overrides,
});

test('pickOwnRelease skips a more-recent flutter-v* release and finds the electron one', () => {
  const { pickOwnRelease } = loadPicker();
  const list = [published('flutter-v2.4.0'), published('v4.10.1'), published('flutter-v2.3.0')];
  const r = pickOwnRelease(list);
  assert.equal(r.version, '4.10.1');
});

test('pickOwnRelease skips draft and prerelease entries', () => {
  const { pickOwnRelease } = loadPicker();
  const list = [
    published('v5.0.0', { draft: true }),
    published('v4.9.0', { prerelease: true }),
    published('v4.8.0'),
  ];
  assert.equal(pickOwnRelease(list).version, '4.8.0');
});

test('pickOwnRelease returns null when only foreign or malformed releases exist', () => {
  const { pickOwnRelease } = loadPicker();
  assert.equal(pickOwnRelease([published('flutter-v2.4.0')]), null);
  assert.equal(pickOwnRelease([published('not-a-version')]), null);
  assert.equal(pickOwnRelease([]), null);
  assert.equal(pickOwnRelease(null), null);
});

// The bug this ranking replaced. GET /releases is ordered by created_at, and a
// release's created_at is the date of the COMMIT its tag points at — not the
// date it was published. Cut a tag on an older commit and its release sorts
// below ones published days earlier, which is exactly what the real feed did:
// flutter-v2.10.0/2.10.1 both sat underneath flutter-v2.9.0, and "first match
// wins" told every 2.9 install it was up to date. The same trap is one
// badly-timed tag away on the Electron stream.
test('pickOwnRelease ranks by version, not by the order GitHub returns', () => {
  const { pickOwnRelease } = loadPicker();
  const list = [published('v4.9.0'), published('v4.11.0'), published('v4.10.6')];
  assert.equal(pickOwnRelease(list).version, '4.11.0', 'a later entry must win when its version is higher');
});

test('pickOwnRelease compares version parts numerically, not as text', () => {
  const { pickOwnRelease } = loadPicker();
  // 4.9.0 sorts after 4.10.0 as a string, and first in the list to boot.
  assert.equal(pickOwnRelease([published('v4.9.0'), published('v4.10.0')]).version, '4.10.0');
});

test('pickOwnRelease keeps ranking past a newer foreign release', () => {
  const { pickOwnRelease } = loadPicker();
  const list = [
    published('v4.11.0'),
    published('flutter-v2.9.0'),
    published('flutter-v2.10.1'),
    published('v4.12.0'),
  ];
  assert.equal(pickOwnRelease(list).version, '4.12.0');
});
