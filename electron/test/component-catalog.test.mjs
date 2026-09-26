// Procress 14 (APP docs/TEMPLATES.md §2, §3.5) — the page components the
// renderer registers against the catalog SDB publishes. A template naming a
// component this app does not have renders a quiet "not in this version"
// block; these keep that to the components SDB itself marks as planned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pages = JSON.parse(readFileSync(join(root, 'templates/pages.json'), 'utf8'));
const bundles = JSON.parse(readFileSync(join(root, 'templates/bundles.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}
const registered = new Set(walk(join(root, 'src/renderer')).flatMap((f) =>
  [...readFileSync(f, 'utf8').matchAll(/register(?:Component|Filled)\('([a-z]+\.[a-z][a-z0-9]*)'/g)].map((m) => m[1])));
const catalog = new Map(pages.components.map((c) => [c.id, c]));

// Every component a list of blocks names, columns' children included.
const namesIn = (blocks) => (blocks || []).flatMap((b) => [b.component, ...(b.children || []).flatMap((col) => namesIn(Array.isArray(col) ? col : [col]))]).filter(Boolean);

test('every registered component is in the catalog', () => {
  const extra = [...registered].filter((id) => !catalog.has(id));
  assert.deepEqual(extra, []);
});

test('every component the catalog marks as built is registered', () => {
  const missing = pages.components.filter((c) => c.since === 'exe' && !registered.has(c.id)).map((c) => c.id);
  assert.deepEqual(missing, []);
});

test('every component a default (★) template uses is registered', () => {
  const missing = new Set();
  for (const tpl of pages.templates.filter((tp) => tp.default)) {
    for (const id of [...namesIn(tpl.page), ...namesIn(tpl.itemPage)]) if (!registered.has(id)) missing.add(`${tpl.id}: ${id}`);
  }
  assert.deepEqual([...missing], []);
});

test('every component a bundle page uses is registered', () => {
  const byId = new Map(pages.templates.map((tp) => [tp.id, tp]));
  const missing = new Set();
  for (const b of bundles.bundles || []) {
    for (const m of b.spec?.modules || []) {
      for (const which of ['page', 'itemPage']) {
        const v = m[which];
        const blocks = typeof v === 'string' ? [...namesIn(byId.get(v)?.page), ...namesIn(byId.get(v)?.itemPage)] : namesIn(v);
        for (const id of blocks) if (!registered.has(id)) missing.add(`${b.id}/${m.ref || m.name}: ${id}`);
      }
    }
  }
  assert.deepEqual([...missing], []);
});
