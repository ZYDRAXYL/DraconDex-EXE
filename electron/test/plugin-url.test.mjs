import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

// src/db/plugin-manifest.js is the electron-free half of the Plugin system
// (src/db/plugin.js requires electron + the DB and cannot be loaded here).
// Everything a malicious repo URL or manifest could do goes through these two
// functions, so they are the two things worth a real regression test.
const require_ = createRequire(import.meta.url);
const {
  parseRepoUrl, validateManifest, rawUrl,
  manifestPanels, manifestNetOrigins, manifestContextKinds, manifestDependencies, netOriginAllowed,
} = require_('../src/db/plugin-manifest.js');

test('parseRepoUrl accepts every shape a user can copy out of GitHub', () => {
  const github = (owner, repo, ref) => ({ ok: true, host: 'github', owner, repo, ref });
  const cases = [
    ['https://github.com/acme/my-plugin.git',        github('acme', 'my-plugin', null)],
    ['https://github.com/acme/my-plugin',            github('acme', 'my-plugin', null)],
    ['https://github.com/acme/my-plugin/',           github('acme', 'my-plugin', null)],
    ['http://github.com/acme/my-plugin.git',         github('acme', 'my-plugin', null)],
    ['https://www.github.com/acme/my-plugin',        github('acme', 'my-plugin', null)],
    ['git@github.com:acme/my-plugin.git',            github('acme', 'my-plugin', null)],
    ['ssh://git@github.com/acme/my-plugin.git',      github('acme', 'my-plugin', null)],
    ['github.com/acme/my-plugin',                    github('acme', 'my-plugin', null)],
    ['acme/my-plugin',                               github('acme', 'my-plugin', null)],
    ['  https://github.com/acme/my-plugin.git  ',    github('acme', 'my-plugin', null)],
    ['https://github.com/acme/my-plugin?tab=readme', github('acme', 'my-plugin', null)],
    ['https://github.com/acme/my-plugin/tree/dev',   github('acme', 'my-plugin', 'dev')],
    ['https://github.com/acme/my-plugin/tree/feat/x', github('acme', 'my-plugin', 'feat/x')],
    ['https://github.com/acme/my-plugin/blob/dev/index.html', github('acme', 'my-plugin', 'dev')],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(parseRepoUrl(input), want, `parseRepoUrl(${JSON.stringify(input)})`);
  }
});

test('parseRepoUrl handles GitLab, including nested groups', () => {
  assert.deepEqual(parseRepoUrl('https://gitlab.com/acme/my-plugin.git'),
    { ok: true, host: 'gitlab', owner: 'acme', repo: 'my-plugin', ref: null });
  assert.deepEqual(parseRepoUrl('https://gitlab.com/acme/team/my-plugin'),
    { ok: true, host: 'gitlab', owner: 'acme/team', repo: 'my-plugin', ref: null });
  assert.deepEqual(parseRepoUrl('https://gitlab.com/acme/my-plugin/-/tree/dev'),
    { ok: true, host: 'gitlab', owner: 'acme', repo: 'my-plugin', ref: 'dev' });
  assert.deepEqual(parseRepoUrl('git@gitlab.com:acme/team/my-plugin.git'),
    { ok: true, host: 'gitlab', owner: 'acme/team', repo: 'my-plugin', ref: null });
});

test('parseRepoUrl rejects anything it cannot safely turn into a raw URL', () => {
  const rejects = {
    '': 'bad_url',
    '   ': 'bad_url',
    'acme': 'bad_url',
    'https://github.com/acme': 'bad_url',
    'https://github.com/acme/repo/extra': 'bad_url',       // not a tree/blob URL
    'https://github.com/../../etc/passwd': 'bad_url',
    'https://github.com/acme/../secret': 'bad_url',
    'https://github.com/ac me/repo': 'bad_url',            // whitespace
    'https://github.com/acme/re%2Fpo': 'bad_url',          // percent-encoding
    'https://github.com/acme/repo/tree/..': 'bad_url',
    'https://evil.com/acme/repo': 'unsupported_host',
    'https://bitbucket.org/acme/repo.git': 'unsupported_host',
    'git@evil.com:acme/repo.git': 'unsupported_host',
    'https://gitlab.example.com/acme/repo.git': 'unsupported_host', // self-hosted, out of scope
  };
  for (const [input, code] of Object.entries(rejects)) {
    const r = parseRepoUrl(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} should be rejected`);
    assert.equal(r.code, code, `${JSON.stringify(input)} error code`);
  }
  assert.equal(parseRepoUrl(null).ok, false);
  assert.equal(parseRepoUrl(undefined).ok, false);
  assert.equal(parseRepoUrl({}).ok, false);
});

test('rawUrl encodes per segment and never collapses a nested GitLab namespace', () => {
  assert.equal(
    rawUrl({ host: 'github', owner: 'acme', repo: 'my-plugin', ref: 'feat/x' }, 'sub/app.js'),
    'https://raw.githubusercontent.com/acme/my-plugin/feat/x/sub/app.js');
  assert.equal(
    rawUrl({ host: 'gitlab', owner: 'acme/team', repo: 'my-plugin', ref: 'main' }, 'index.html'),
    'https://gitlab.com/acme/team/my-plugin/-/raw/main/index.html');
});

const goodManifest = () => ({
  id: 'myplugin', name: 'My Plugin', version: '1.0.0',
  entry: 'index.html', files: ['index.html', 'app.js'],
  tables: [{ name: 'notes', columns: [{ name: 'title', type: 'TEXT' }, { name: 'rating', type: 'INTEGER' }] }],
});

test('validateManifest accepts a well-formed manifest', () => {
  assert.deepEqual(validateManifest(goodManifest()), { ok: true });
  const noTables = goodManifest(); delete noTables.tables;
  assert.equal(validateManifest(noTables).ok, true, 'tables are optional');
});

test('validateManifest rejects every shape that could reach SQL or the filesystem', () => {
  const bad = (mutate) => { const m = goodManifest(); mutate(m); return validateManifest(m); };

  // id — composed into a table identifier, so the strictest gate of all.
  assert.equal(bad((m) => { m.id = 'My Plugin'; }).ok, false);
  assert.equal(bad((m) => { m.id = 'drop;--'; }).ok, false);
  assert.equal(bad((m) => { m.id = 'x'.repeat(21); }).ok, false);
  assert.equal(bad((m) => { delete m.id; }).ok, false);

  // file paths — written straight to disk under the plugin's own directory.
  assert.equal(bad((m) => { m.files = ['../../etc/passwd']; m.entry = '../../etc/passwd'; }).ok, false);
  assert.equal(bad((m) => { m.files = ['/etc/passwd']; m.entry = '/etc/passwd'; }).ok, false);
  assert.equal(bad((m) => { m.files = ['sub\\win.js']; m.entry = 'sub\\win.js'; }).ok, false);
  assert.equal(bad((m) => { m.entry = 'not-listed.html'; }).ok, false);
  assert.equal(bad((m) => { m.files = []; }).ok, false);
  assert.equal(bad((m) => { m.files = Array.from({ length: 31 }, (_, i) => `f${i}.js`); m.entry = 'f0.js'; }).ok, false);

  // table + column identifiers.
  assert.equal(bad((m) => { m.tables[0].name = 'notes; DROP TABLE plugin'; }).ok, false);
  assert.equal(bad((m) => { m.tables[0].columns[0].name = 'id'; }).ok, false, 'reserved column');
  assert.equal(bad((m) => { m.tables[0].columns[0].name = 'rowid'; }).ok, false, 'reserved column');
  assert.equal(bad((m) => { m.tables[0].columns[0].name = '1bad'; }).ok, false);
  assert.equal(bad((m) => { m.tables[0].columns[0].type = 'BLOB'; }).ok, false);
  assert.equal(bad((m) => { m.tables[0].columns[0].type = 'TEXT DEFAULT (x)'; }).ok, false);
  assert.equal(bad((m) => { m.tables[0].columns.push({ name: 'title', type: 'TEXT' }); }).ok, false, 'duplicate column');
  assert.equal(bad((m) => { m.tables.push({ name: 'notes', columns: [{ name: 'a', type: 'TEXT' }] }); }).ok, false, 'duplicate table');
  assert.equal(bad((m) => {
    m.tables = Array.from({ length: 11 }, (_, i) => ({ name: `t${i}`, columns: [{ name: 'a', type: 'TEXT' }] }));
  }).ok, false, 'too many tables');
  assert.equal(bad((m) => {
    m.tables[0].columns = Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, type: 'TEXT' }));
  }).ok, false, 'too many columns');

  assert.equal(validateManifest(null).ok, false);
  assert.equal(validateManifest('nope').ok, false);
});

// --- v4.3.0: panels + permissions ------------------------------------------
// Both fields are optional, so the first thing to protect is that every plugin
// written before v4.3.0 still validates untouched.

const panelManifest = () => {
  const m = goodManifest();
  m.files = ['index.html', 'app.js', 'panel.html'];
  m.panels = [{ id: 'chat', title: 'Chat', icon: '💬', entry: 'panel.html' }];
  m.permissions = { net: ['https://api.example.com'], context: ['module'] };
  return m;
};

test('validateManifest keeps pre-v4.3.0 manifests valid and accepts the new fields', () => {
  assert.deepEqual(validateManifest(goodManifest()), { ok: true }, 'no panels/permissions is still valid');
  assert.deepEqual(validateManifest(panelManifest()), { ok: true });

  const noIcon = panelManifest(); delete noIcon.panels[0].icon;
  assert.equal(validateManifest(noIcon).ok, true, 'icon is optional');
  const noContext = panelManifest(); delete noContext.permissions.context;
  assert.equal(validateManifest(noContext).ok, true, 'context is optional');
  const noNet = panelManifest(); delete noNet.permissions.net;
  assert.equal(validateManifest(noNet).ok, true, 'net is optional');
});

test('validateManifest rejects panels that could be loaded or labelled unsafely', () => {
  const bad = (mutate) => { const m = panelManifest(); mutate(m); return validateManifest(m); };

  assert.equal(bad((m) => { m.panels[0].id = 'Chat Panel'; }).ok, false, 'id must be the safe character class');
  assert.equal(bad((m) => { m.panels[0].id = '../x'; }).ok, false);
  assert.equal(bad((m) => { m.panels[0].id = 'x'.repeat(25); }).ok, false);
  assert.equal(bad((m) => { m.panels.push({ id: 'chat', title: 'Dup', entry: 'panel.html' }); }).ok, false, 'duplicate panel id');
  assert.equal(bad((m) => { delete m.panels[0].title; }).ok, false);
  assert.equal(bad((m) => { m.panels[0].title = 'x'.repeat(41); }).ok, false);
  assert.equal(bad((m) => { m.panels[0].icon = 'x'.repeat(9); }).ok, false);

  // The entry gate is what stops a panel pointing anywhere the app didn't
  // download, and what main.js's attach check ultimately relies on.
  assert.equal(bad((m) => { m.panels[0].entry = 'not-listed.html'; }).ok, false, 'entry must be in files');
  assert.equal(bad((m) => { m.panels[0].entry = 'app.js'; }).ok, false, 'entry must be HTML');
  assert.equal(bad((m) => { m.panels[0].entry = '../../index.html'; }).ok, false);
  assert.equal(bad((m) => { delete m.panels[0].entry; }).ok, false);

  assert.equal(bad((m) => { m.panels = 'chat'; }).ok, false);
  assert.equal(bad((m) => {
    m.panels = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, title: 'P', entry: 'panel.html' }));
  }).ok, false, 'too many panels');
});

test('validateManifest rejects any net origin that is not a bare https origin', () => {
  const bad = (net) => validateManifest({ ...panelManifest(), permissions: { net } }).ok;

  assert.equal(bad(['http://api.example.com']), false, 'plaintext http');
  assert.equal(bad(['https://api.example.com/v1']), false, 'a path would make the check a prefix match');
  assert.equal(bad(['https://api.example.com/']), true, 'a bare trailing slash is still an origin');
  assert.equal(bad(['https://api.example.com?x=1']), false);
  assert.equal(bad(['https://api.example.com#f']), false);
  assert.equal(bad(['https://user:pw@api.example.com']), false);
  assert.equal(bad(['file:///etc/passwd']), false);
  assert.equal(bad(['not a url']), false);
  assert.equal(bad(['']), false);
  assert.equal(bad('https://api.example.com'), false, 'must be an array');
  assert.equal(bad(Array.from({ length: 11 }, (_, i) => `https://h${i}.example.com`)), false, 'too many origins');

  assert.equal(validateManifest({ ...panelManifest(), permissions: { context: ['everything'] } }).ok, false);
  assert.equal(validateManifest({ ...panelManifest(), permissions: ['module'] }).ok, false, 'permissions is an object');
});

// v4.4.0: the one plaintext exception, added so a plugin can name a local model
// server (Ollama listens on http://localhost:11434 and offers no https).
test('validateManifest accepts http only on loopback, and only with a port', () => {
  const ok = (net) => validateManifest({ ...panelManifest(), permissions: { net } }).ok;

  assert.equal(ok(['http://localhost:11434']), true);
  assert.equal(ok(['http://127.0.0.1:11434']), true);
  assert.equal(ok(['http://[::1]:11434']), true, 'IPv6 loopback stays bracketed through new URL()');
  assert.equal(ok(['http://localhost:11434/']), true, 'a bare trailing slash is still an origin');

  // No port means port 80 — a grant far wider than the one service being named.
  assert.equal(ok(['http://localhost']), false, 'an explicit port is required');
  assert.equal(ok(['http://127.0.0.1']), false);
  // Everything that is not actually loopback stays plaintext-rejected: allowing
  // it would be a downgrade plus an SSRF path into the user's network.
  assert.equal(ok(['http://192.168.1.5:11434']), false, 'a LAN address is not loopback');
  assert.equal(ok(['http://0.0.0.0:11434']), false, 'binding any-address is not loopback');
  assert.equal(ok(['http://localhost.evil.test:11434']), false, 'a lookalike host is not loopback');
  assert.equal(ok(['http://evil.test:11434']), false);
  // The other origin rules still apply to the loopback form.
  assert.equal(ok(['http://localhost:11434/api']), false, 'a path would make the check a prefix match');
  assert.equal(ok(['http://user:pw@localhost:11434']), false);
  assert.equal(ok(['http://localhost:11434?x=1']), false);

  assert.equal(ok(['https://api.example.com']), true, 'https is unaffected');
});

test('netOriginAllowed agrees with the manifest rules about loopback http', () => {
  const m = { ...panelManifest(), permissions: { net: ['http://localhost:11434'] } };
  assert.equal(netOriginAllowed(m, 'http://localhost:11434/api/chat'), true);
  assert.equal(netOriginAllowed(m, 'http://localhost:11434/api/tags'), true);
  // Port and host are both part of the origin, so neither is interchangeable.
  assert.equal(netOriginAllowed(m, 'http://localhost:11435/api/chat'), false, 'another port is another origin');
  assert.equal(netOriginAllowed(m, 'http://127.0.0.1:11434/api/chat'), false, 'a different loopback spelling is a different origin');
  assert.equal(netOriginAllowed(m, 'http://localhost.evil.test:11434/api/chat'), false);
  // A stored manifest that predates the current rules must not be trusted to
  // have been validated by them — the runtime re-checks the scheme itself.
  const stale = { ...panelManifest(), permissions: { net: ['http://evil.test:80'] } };
  assert.equal(netOriginAllowed(stale, 'http://evil.test:80/x'), false, 'non-loopback http stays refused at runtime');
  assert.deepEqual(manifestNetOrigins(stale), [], 'and is dropped when the row is read back');
});

test('netOriginAllowed compares origins, never prefixes', () => {
  const m = panelManifest();
  assert.equal(netOriginAllowed(m, 'https://api.example.com/v1/messages'), true);
  assert.equal(netOriginAllowed(m, 'https://api.example.com'), true);
  // The whole reason a path is rejected at declare time: a prefix match would
  // let a lookalike host satisfy the allowlist.
  assert.equal(netOriginAllowed(m, 'https://api.example.com.evil.test/v1'), false);
  assert.equal(netOriginAllowed(m, 'https://evil.test/?x=https://api.example.com'), false);
  assert.equal(netOriginAllowed(m, 'http://api.example.com/v1'), false, 'scheme is part of the origin');
  assert.equal(netOriginAllowed(m, 'https://api.example.com:8443/v1'), false, 'port is part of the origin');
  assert.equal(netOriginAllowed(m, 'garbage'), false);
  assert.equal(netOriginAllowed({}, 'https://api.example.com'), false, 'no permissions means no access');
});

test('manifest readers drop anything malformed rather than trusting the stored row', () => {
  assert.deepEqual(manifestPanels(panelManifest()), [
    { id: 'chat', title: 'Chat', icon: '💬', entry: 'panel.html' },
  ]);
  assert.deepEqual(manifestPanels({}), []);
  assert.deepEqual(manifestPanels({ panels: [{ id: 'BAD ID', entry: 'x.html' }] }), [], 'a bad id is dropped, not surfaced');
  assert.deepEqual(manifestNetOrigins(panelManifest()), ['https://api.example.com']);
  assert.deepEqual(manifestNetOrigins({ permissions: { net: ['http://x.test'] } }), []);
  assert.deepEqual(manifestContextKinds(panelManifest()), ['module']);
  assert.deepEqual(manifestContextKinds({ permissions: { context: ['module', 'secrets'] } }), ['module']);
});

// --- v4.8.0: dependencies ---------------------------------------------------
// Another plugin (by repo URL) this one wants auto-installed alongside it —
// the AI chat plugins use this to pull in AI Native. Same URL shapes as the
// paste-a-link install box, since parseRepoUrl is reused verbatim; actually
// installing them (src/db/plugin.js, not covered here — it needs electron+DB)
// is exercised manually per docs/PLUGINS.md §2.7.
test('validateManifest accepts and rejects "dependencies"', () => {
  const withDeps = (dependencies) => validateManifest({ ...goodManifest(), dependencies });

  assert.equal(validateManifest(goodManifest()).ok, true, 'omitted entirely is still valid');
  assert.equal(withDeps(['acme/other-plugin']).ok, true, 'shorthand owner/repo is accepted');
  assert.equal(withDeps(['https://github.com/acme/other-plugin']).ok, true);
  assert.equal(withDeps(['https://gitlab.com/acme/team/other-plugin']).ok, true, 'nested GitLab namespace');
  assert.equal(withDeps([]).ok, true, 'an empty array is valid');

  assert.equal(withDeps('acme/other-plugin').ok, false, 'must be an array');
  assert.equal(withDeps([123]).ok, false, 'entries must be strings');
  assert.equal(withDeps(['']).ok, false);
  assert.equal(withDeps(['not a url']).ok, false, 'must parse like a repo URL');
  assert.equal(withDeps(['https://evil.com/acme/repo']).ok, false, 'same host allowlist as install');
  assert.equal(withDeps(['acme/x', 'acme/x']).ok, false, 'duplicate dependency');
  assert.equal(withDeps(['acme/x', 'ACME/X']).ok, false, 'duplicate check is case-insensitive');
  assert.equal(withDeps(['acme/x', 'github.com/acme/x']).ok, false, 'same repo via a different URL shape is still a duplicate');
  assert.equal(withDeps(Array.from({ length: 6 }, (_, i) => `acme/plugin-${i}`)).ok, false, 'too many dependencies');
  assert.equal(withDeps(Array.from({ length: 5 }, (_, i) => `acme/plugin-${i}`)).ok, true, 'exactly the max is fine');
});

test('manifestDependencies reads back a stored manifest\'s dependency URLs', () => {
  assert.deepEqual(manifestDependencies({}), []);
  assert.deepEqual(manifestDependencies({ dependencies: ['acme/x', 'acme/y'] }), ['acme/x', 'acme/y']);
  assert.deepEqual(manifestDependencies({ dependencies: ['acme/x', '', 42, null] }), ['acme/x'], 'malformed entries dropped, not surfaced');
  assert.deepEqual(manifestDependencies({ dependencies: 'acme/x' }), [], 'must be an array');
});
