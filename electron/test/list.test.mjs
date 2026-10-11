// Procress 21 — core/list.js, the one list (APP docs/UX-LAYOUT.md §12): the
// row's anatomy and its two densities, the header's filter + sort (same rules
// as APK's ddxMatches / ddxSorted), the date groups, and the hand-off to
// lazyRows past 100 rows. The keyboard and the real heights are measured in
// the running app (ui-audit.driver.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../src/renderer/core/list.js', import.meta.url), 'utf8');
const lazyCalls = [];
const ctx = vm.createContext({
  document: { addEventListener() {}, documentElement: {}, querySelectorAll: () => [], getElementById: () => null },
  MutationObserver: class { observe() {} },
  requestAnimationFrame: () => 1,
  localStorage: { getItem: () => null, setItem() {} },
  CSS: { escape: (s) => s },
  t: (k) => ({ moreActions: 'More actions', listCount: '{n} items', listGroupToday: 'Today', listGroupThisWeek: 'This week', listGroupOlder: 'Older' }[k] || k),
  x: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
  I: { options: '<svg class="icon"></svg>', chevronDown: '<svg class="icon"></svg>', list: '<svg class="icon"></svg>', info: '<svg class="icon"></svg>' },
  lazyRows: (items, row, state, opts) => { lazyCalls.push({ n: items.length, opts }); return items.slice(0, opts.step).map(row).join('') + '<div class="lazy-more"></div>'; },
});
ctx.xj = (v) => ctx.x(JSON.stringify(String(v ?? '')));
const L = vm.runInContext(`${src}\n;({ listRowHtml, listActHtml, listGroupHtml, listHeadHtml, emptyStateHtml, listView, listRowsHtml, listDateGroup, listByDate, listState })`, ctx);

test('a row: one option, focusable, named, in one of the two densities', () => {
  const comfy = L.listRowHtml({ icon: '<i></i>', title: 'Mira <3', meta: 'Classifier', onclick: 'go(1)' });
  assert.match(comfy, /class="ls-row ls-comfy"/);
  assert.match(comfy, /role="option" tabindex="-1"/);
  assert.match(comfy, /aria-label="Mira &lt;3 · Classifier"/);
  assert.match(comfy, /<span class="ls-meta">Classifier<\/span>/, 'comfy: meta on the second line');
  const compact = L.listRowHtml({ title: 'a', meta: 'b', density: 'compact' });
  assert.match(compact, /ls-row ls-compact/);
  assert.match(compact, /ls-meta ls-side/, 'compact: meta at the end');
  assert.doesNotMatch(compact, /ls-icon/, 'no icon slot unless asked');
  assert.match(L.listRowHtml({ title: 'a', icon: '' }), /<span class="ls-icon" aria-hidden="true"><\/span>/, "'' keeps the slot");
});

test('a row: selected and disabled states, ⋯ = the right-click menu', () => {
  const r = L.listRowHtml({ title: 'a', state: { selected: true }, menu: 'openCtx(event,1)', onclick: 'go()' });
  assert.match(r, /ls-row ls-comfy sel/);
  assert.match(r, /aria-selected="true"/);
  assert.match(r, /oncontextmenu="openCtx\(event,1\)"/);
  assert.match(r, /class="btn btn-g btn-i ls-act ls-more"[^>]*onclick="event.stopPropagation\(\);openCtx\(event,1\)"/);
  const off = L.listRowHtml({ title: 'a', state: { disabled: true }, onclick: 'go()' });
  assert.match(off, /aria-disabled="true"/);
  assert.doesNotMatch(off, /onclick="go\(\)"/, 'a disabled row does not open');
});

test('an action button carries its key and stops the row click', () => {
  const b = L.listActHtml({ icon: '<i></i>', label: 'Delete', onclick: 'del(3)', key: 'Delete', danger: true });
  assert.match(b, /data-ls-key="Delete"/);
  assert.match(b, /onclick="event.stopPropagation\(\);del\(3\)"/);
  assert.match(b, /aria-label="Delete"/);
  assert.match(b, /ls-danger/);
});

test('a group: its count, folds, named for a screen reader', () => {
  const g = L.listGroupHtml({ list: 'trash', id: 'today', title: 'Today', count: 3, rows: '<x>' });
  assert.match(g, /role="group" aria-label="Today"/);
  assert.match(g, /class="ls-count" data-no-i18n>3</);
  assert.match(g, /aria-expanded="true"/);
  assert.match(g, /<div class="ls-group-body"><x><\/div>/);
});

test('the header: filter, then sort, then total', () => {
  const h = L.listHeadHtml({ list: 'h1', count: 7, sorts: ['name', 'edited'], manual: true });
  assert.ok(h.indexOf('ls-filter') < h.indexOf('ls-sort') && h.indexOf('ls-sort') < h.indexOf('ls-total'));
  assert.match(h, /<option value="manual" selected>listSortManual<\/option>/);
  assert.doesNotMatch(L.listHeadHtml({ list: 'h2', count: 1, sorts: ['name'] }), /ls-sort/, 'one order is no choice');
});

test('listView: filter on any field, sorts stable, dates newest first', () => {
  const items = [{ name: 'beta', at: '2026-01-02', k: 'b' }, { name: 'Alpha', at: '2026-01-03', k: 'b' }, { name: 'gamma', at: '2026-01-01', k: 'a' }];
  const o = { edited: (i) => i.at, kind: (i) => i.k };
  assert.deepEqual([...L.listView('v', items, o)].map((i) => i.name), ['beta', 'Alpha', 'gamma'], 'no sort = as given');
  L.listState('v').sort = 'name';
  assert.deepEqual([...L.listView('v', items, o)].map((i) => i.name), ['Alpha', 'beta', 'gamma']);
  L.listState('v').sort = 'edited';
  assert.deepEqual([...L.listView('v', items, o)].map((i) => i.name), ['Alpha', 'beta', 'gamma']);
  L.listState('v').sort = 'kind';
  assert.deepEqual([...L.listView('v', items, o)].map((i) => i.name), ['gamma', 'Alpha', 'beta']);
  L.listState('v').q = 'AL';
  assert.deepEqual([...L.listView('v', items, o)].map((i) => i.name), ['Alpha']);
  assert.equal(L.listState('v').shownCount, 1);
});

test('date groups: today / this week (from Monday) / older', () => {
  const now = new Date(2026, 9, 14, 15, 0); // Wednesday 14 Oct 2026, local
  const db = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(L.listDateGroup(db(new Date(2026, 9, 14, 0, 1)), now), 'today');
  assert.equal(L.listDateGroup(db(new Date(2026, 9, 12, 9, 0)), now), 'week');
  assert.equal(L.listDateGroup(db(new Date(2026, 9, 11, 23, 0)), now), 'older');
  assert.equal(L.listDateGroup('garbage', now), 'older');
});

test('past 100 rows the list goes through lazyRows; 100 or fewer are drawn whole', () => {
  const row = (i) => `<r${i}>`;
  assert.equal(L.listRowsHtml('z', Array.from({ length: 100 }, (_, i) => i), row).split('<r').length - 1, 100);
  assert.equal(lazyCalls.length, 0);
  L.listRowsHtml('z', Array.from({ length: 101 }, (_, i) => i), row);
  assert.deepEqual(lazyCalls.map((c) => [c.n, Number(c.opts.step)]), [[101, 100]]);
});

test('empty state: one sentence, at most one button', () => {
  const e = L.emptyStateHtml({ text: 'Nothing here.', action: { label: 'Create', onclick: 'make()' } });
  assert.equal((e.match(/<button/g) || []).length, 1);
  assert.match(e, /<p>Nothing here\.<\/p>/);
  assert.doesNotMatch(L.emptyStateHtml({ text: 'x' }), /<button/);
});
