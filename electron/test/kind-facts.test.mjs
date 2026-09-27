// Procress 14 part 4 (APP docs/TEMPLATES.md §2.2) — the last two
// components: inspector.facts reads `key: value` lines out of a note, and
// locator.placecard crops the map to one area and names what it borders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { t: (k) => k, x: (s) => String(s), xj: JSON.stringify };
vm.createContext(ctx);
vm.runInContext(`${readFileSync(join(root, 'src/renderer/page/components/common.js'), 'utf8')}
this.pcFactsOf = pcFactsOf; this.pcPickArea = pcPickArea; this.pcPlaceGeom = pcPlaceGeom;`, ctx);
const { pcFactsOf, pcPickArea, pcPlaceGeom } = ctx;
const plain = (v) => JSON.parse(JSON.stringify(v));

test('facts: key: value lines, markdown or the editor HTML', () => {
  const md = '# Tarven\nFounded: year −300\n- **Ruler**: the Seven Towers\n* Language : Tarvin\n\nSome prose, no colon.';
  assert.deepEqual(plain(pcFactsOf(md)), [
    { k: 'Founded', v: 'year −300' }, { k: 'Ruler', v: 'the Seven Towers' }, { k: 'Language', v: 'Tarvin' }]);
  const html = '<p>ก่อตั้ง: ปีที่ −300</p><p>Trade &amp; law: open</p>';
  assert.deepEqual(plain(pcFactsOf(html)), [{ k: 'ก่อตั้ง', v: 'ปีที่ −300' }, { k: 'Trade & law', v: 'open' }]);
});

test('facts: links, times, tasks, headings and code are not facts', () => {
  const md = 'See https://example.com\nhttps: //x\nAt 10:30 sharp\n- [ ] Task: not a fact\n## Heading: no\n```\nkey: in code\n```\n12: 34\nReal: yes';
  assert.deepEqual(plain(pcFactsOf(md)), [{ k: 'Real', v: 'yes' }]);
  assert.equal(pcFactsOf('a: 1\nb: 2\nc: 3', 2).length, 2);
  assert.deepEqual(plain(pcFactsOf('')), []);
});

const sq = (x, y, s = 10) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
const areas = [
  { id: 1, area_name: 'North', points: sq(0, 0) },
  { id: 2, area_name: 'Tarven', points: sq(10, 0) },
  { id: 3, area_name: 'Far isle', points: sq(100, 100) },
  { id: 4, area_name: 'Unmapped', points: [] },
];

test('placecard: the area by name (any case), else the first', () => {
  assert.equal(pcPickArea(areas, ' tarven ').id, 2);
  assert.equal(pcPickArea(areas, 'nowhere').id, 1);
  assert.equal(pcPickArea([], 'x'), null);
});

test('placecard: the crop is the area with 40% around it; borders touch it', () => {
  const g = pcPlaceGeom(areas, areas[1]);
  assert.deepEqual(plain(g.view), [1, -9, 28, 28], 'at least 20 across, centred, times 1.4');
  assert.deepEqual(g.borders.map((a) => a.area_name), ['North']);
  const none = pcPlaceGeom(areas, areas[3]);
  assert.ok(none.view, 'an area with no outline still shows the whole map');
  assert.deepEqual(plain(none.borders), []);
  assert.equal(pcPlaceGeom([{ id: 9, points: [] }], { id: 9, points: [] }).view, null);
});
