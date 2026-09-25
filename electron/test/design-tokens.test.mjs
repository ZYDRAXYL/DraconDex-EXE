// Procress 13 part 4 (APP docs/REDESIGN.md C4/C5). Two things a later edit
// can silently undo: text going back to the sub-AA --t3, and the vendored
// token file slipping behind css/tokens.css (then it could override the
// app's own values instead of being overridden by them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const cssDir = new URL('../css/', import.meta.url);

test('no stylesheet colours text with the sub-AA --t3', () => {
  for (const f of readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
    const hits = read(`../css/${f}`).match(/(?<![-\w])color:\s*var\(--t3\)/g) || [];
    assert.equal(hits.length, 0, `${f}: use var(--t3-aa,var(--t2)) for text (--t3 stays for borders/backgrounds)`);
  }
});

test('vendored tokens load first, fluent.css after every component file', () => {
  const links = [...read('../index.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(links[0], '../src/design/generated/tokens.css');
  assert.equal(links[1], 'css/tokens.css');
  assert.deepEqual(links.slice(-2), ['css/fluent.css', 'css/welcome.css']);
});

test('every Fluent 2 rule is scoped to the fluent UI style', () => {
  const body = read('../css/fluent.css').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of body.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean)) {
    for (const part of sel.split(',')) assert.match(part.trim(), /^body\[data-ui-style="fluent"\]/, part);
  }
});
