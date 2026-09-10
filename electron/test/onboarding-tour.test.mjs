import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Windows checkouts have CRLF endings (`.gitattributes` uses `* text=auto`), which
// breaks source regexes anchored on `\n` — normalize before matching.
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('first-run Nexus creation offers an inline guide choice without a nested confirmation', () => {
  const core = readSource('../src/renderer/core/nexus.js');
  // welcomeCreateNexus moved to the Welcome screen's own file (v4.6.0) when
  // the welcome modal became its own window; the create FORM it opens, and
  // the tour checkbox in it, still live with the rest of the vault CRUD.
  const welcome = readSource('../src/renderer/core/welcome.js');
  const css = readSource('../css/components.css');
  const welcomeCreateNexus = welcome.match(/async function welcomeCreateNexus\(\) \{([\s\S]*?)\n\}/)?.[1] || '';

  assert.doesNotMatch(welcomeCreateNexus, /uiConfirm\(/);
  assert.match(core, /id="nx-guide"/);
  assert.match(core, /S\._guideAfterCreate\s*=\s*Boolean\(q\('#nx-guide'\)\?\.checked\)/);
  assert.match(css, /\.fg input\[type="checkbox"\]\{width:auto/);
});
