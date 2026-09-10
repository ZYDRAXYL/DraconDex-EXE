import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Same CRLF guard the other tests use — `.gitattributes` sets `* text=auto`,
// so a Windows checkout has CRLF and `\n`-anchored regexes stop matching.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Tests that assert things about dracondex_setup.sql itself — that the two
// generated constants match it, that every `$` in the Dart is escaped, that the
// installer is idempotent, and that the grants/revokes are right — moved to
// ZYDRAXYL/DraconDex-SDB (test/supabase-setup.test.mjs) in the multi-repo split.
// They were always generator invariants rather than Electron ones, and SDB is
// the only tree where the SQL and BOTH generated outputs exist together.
//
// What guards this repo instead: `npm run sdb:check` verifies that the vendored
// electron/src/db/supabase-schema.js is byte-identical to the artifact SDB
// published at the version sdb.lock.json pins.
//
// What remains below is genuinely this repo's: the security properties of
// electron/src/db/supabase-setup.js.


// The Management API access token is the one credential in this feature that
// can rewrite the user's whole database. It is a plain argument on purpose:
// used for one request, never persisted. A future edit that parks it in
// app_setting or the secret store has to fail loudly here.
test('the install access token is never stored', () => {
  const src = readSource('../src/db/supabase-setup.js');
  const fn = /async function installSupabaseSchema\([\s\S]*?\n\}\n/.exec(src)?.[0] || '';
  assert.ok(fn, 'installSupabaseSchema not found');
  assert.doesNotMatch(fn, /setAppSetting|setSecret/, 'installSupabaseSchema must not persist the access token');
  assert.doesNotMatch(src, /accessToken.*(setSecret|setAppSetting)|setSecret\([^)]*accessToken/);
});

// openExternal will launch anything handed to it, including non-http schemes.
// The renderer picks a page id from a fixed table; it must never be able to
// pass a URL through.
test('openSupabaseDashboard takes a page id, not a URL', () => {
  const src = readSource('../src/db/supabase-setup.js');
  const fn = /async function openSupabaseDashboard\([\s\S]*?\n\}\n/.exec(src)?.[0] || '';
  assert.ok(fn, 'openSupabaseDashboard not found');
  assert.match(fn, /DASHBOARD_PAGES\[String\(page\)\]/, 'page must be looked up in the allowlist');
  assert.match(fn, /if \(!build\) return \{ ok: false, code: 'bad_page' \};/);
  assert.doesNotMatch(fn, /openExternal\((?!build\()/, 'openExternal must only ever receive an allowlisted URL');
});
