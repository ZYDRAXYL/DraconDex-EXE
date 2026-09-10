import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Windows checkouts have CRLF endings (`.gitattributes` uses `* text=auto`).
const readSource = (relPath) =>
  readFileSync(new URL(relPath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// core/calendar-engine.js is a plain browser script (renderer files are loaded
// by <script> tags, so they have no exports). Every other test in this folder
// asserts on source TEXT for that reason — but a date engine's leap cycles and
// non-resetting weekday alignment are precisely the things regex-matching the
// source cannot check. So evaluate it once and test the real behaviour.
const engine = new Function(`
  ${readSource('../src/renderer/core/calendar-engine.js')}
  return { CAL_DEFAULT_SPEC, calSpecNormalize, calToOrdinal, calFromOrdinal,
           calDayIndex, calCycleSlot, calMonthLength, calDaysInYear,
           calDerivedUnitValue, calRulerTicks, calMonthLabel, calFloorMod };
`)();

const {
  CAL_DEFAULT_SPEC, calSpecNormalize, calToOrdinal, calFromOrdinal,
  calDayIndex, calCycleSlot, calMonthLength, calDaysInYear,
  calDerivedUnitValue, calRulerTicks, calFloorMod,
} = engine;

const GREG = calSpecNormalize(CAL_DEFAULT_SPEC);

// A deliberately un-Gregorian world: 15 months of 40 days, 10-day weeks,
// 20-hour days. Nothing here is expressible through Date.UTC.
const FICTIONAL = calSpecNormalize({
  version: 2,
  anchor: { weekdayIndex: 0 },
  units: [
    { key: 'minute', mode: 'container', of: [] },
    { key: 'hour', mode: 'container', of: [{ unit: 'minute', count: 60 }] },
    { key: 'day', mode: 'container', of: [{ unit: 'hour', count: 20 }] },
    { key: 'week', mode: 'cycle', of: [{ unit: 'day', count: 10 }] },
    { key: 'month', mode: 'container', of: [{ unit: 'day', count: 40 }] },
    { key: 'year', mode: 'container', of: [{ unit: 'month', count: 15 }] },
  ],
});

test('the default spec reproduces real Gregorian month lengths and leap years', () => {
  // 0-based month index; February is 1.
  assert.equal(calMonthLength(GREG, 2001, 1), 28);
  assert.equal(calMonthLength(GREG, 2004, 1), 29, 'year 2004 is a leap year');
  assert.equal(calMonthLength(GREG, 2000, 1), 29);
  assert.equal(calMonthLength(GREG, 2003, 1), 28);
  assert.equal(calDaysInYear(GREG, 2001), 365);
  assert.equal(calDaysInYear(GREG, 2004), 366);
  // The 4-year cycle averages out over its period.
  const cycle = [2001, 2002, 2003, 2004].reduce((n, y) => n + calDaysInYear(GREG, y), 0);
  assert.equal(cycle, 365 * 4 + 1);
});

test('calToOrdinal/calFromOrdinal round-trip, including across a leap boundary', () => {
  const cases = [
    { y: 1, m: 1, d: 1, h: 0, mi: 0 },
    { y: 2004, m: 2, d: 29, h: 13, mi: 45 },   // the leap day itself
    { y: 2004, m: 3, d: 1, h: 0, mi: 0 },      // the day after it
    { y: 2005, m: 1, d: 1, h: 23, mi: 59 },
    { y: 1482, m: 7, d: 3, h: 9, mi: 30 },
  ];
  for (const parts of cases) {
    const ord = calToOrdinal(GREG, parts);
    assert.notEqual(ord, null);
    assert.deepEqual(calFromOrdinal(GREG, ord), parts, `round-trip ${JSON.stringify(parts)}`);
  }
});

test('the leap day is exactly one day after Feb 28 and one before Mar 1', () => {
  const perDay = 24 * 60;
  const feb28 = calToOrdinal(GREG, { y: 2004, m: 2, d: 28, h: 0, mi: 0 });
  const feb29 = calToOrdinal(GREG, { y: 2004, m: 2, d: 29, h: 0, mi: 0 });
  const mar01 = calToOrdinal(GREG, { y: 2004, m: 3, d: 1, h: 0, mi: 0 });
  assert.equal(feb29 - feb28, perDay);
  assert.equal(mar01 - feb29, perDay);
  // ...and in a non-leap year Feb 28 is followed straight by Mar 1.
  const nFeb28 = calToOrdinal(GREG, { y: 2003, m: 2, d: 28, h: 0, mi: 0 });
  const nMar01 = calToOrdinal(GREG, { y: 2003, m: 3, d: 1, h: 0, mi: 0 });
  assert.equal(nMar01 - nFeb28, perDay);
});

// The regression that forced the engine to exist. Date.UTC rolls over rather
// than clamping, so Date.UTC(1200,0,35) === Date.UTC(1200,1,4) — two distinct
// dates in a 40-day-month world landed on one instant, stacking unrelated
// events at the same x on every graph.
test('dates beyond a real month length stay distinct and correctly ordered', () => {
  assert.equal(Date.UTC(1200, 0, 35), Date.UTC(1200, 1, 4), 'precondition: Date.UTC really does collide');

  const a = calToOrdinal(FICTIONAL, { y: 1200, m: 1, d: 35, h: 0, mi: 0 });
  const b = calToOrdinal(FICTIONAL, { y: 1200, m: 2, d: 4, h: 0, mi: 0 });
  assert.notEqual(a, b, 'day 35 of month 1 must not collide with day 4 of month 2');
  assert.ok(a < b, 'month 1 day 35 comes first');

  // Day 40 is the last day of a 40-day month; day 1 of the next month follows it.
  const perDay = 20 * 60;
  const last = calToOrdinal(FICTIONAL, { y: 1200, m: 1, d: 40, h: 0, mi: 0 });
  const next = calToOrdinal(FICTIONAL, { y: 1200, m: 2, d: 1, h: 0, mi: 0 });
  assert.equal(next - last, perDay);
});

test('a 15-month year rolls over at month 15, not month 12', () => {
  const perDay = 20 * 60;
  const m15 = calToOrdinal(FICTIONAL, { y: 1200, m: 15, d: 40, h: 0, mi: 0 });
  const nextYear = calToOrdinal(FICTIONAL, { y: 1201, m: 1, d: 1, h: 0, mi: 0 });
  assert.equal(nextYear - m15, perDay, 'the year ends after month 15');
  assert.equal(calDaysInYear(FICTIONAL, 1200), 15 * 40);
  // Month 13 belongs to its own year, not the next one — Date.UTC rolled it over.
  const m13 = calFromOrdinal(FICTIONAL, calToOrdinal(FICTIONAL, { y: 1200, m: 13, d: 1, h: 0, mi: 0 }));
  assert.equal(m13.y, 1200);
  assert.equal(m13.m, 13);
});

// Date.UTC(50, ...) means 1950, and timelineTsFromParts returned null for
// year 0 (its `!y` guard), collapsing those events onto the axis's left edge.
test('small and non-positive years are ordinary years', () => {
  assert.equal(new Date(Date.UTC(50, 0, 1)).getUTCFullYear(), 1950, 'precondition: Date.UTC remaps 2-digit years');

  const y47 = calToOrdinal(GREG, { y: 47, m: 6, d: 1, h: 0, mi: 0 });
  const y1947 = calToOrdinal(GREG, { y: 1947, m: 6, d: 1, h: 0, mi: 0 });
  assert.ok(y47 < y1947, 'year 47 is not year 1947');
  assert.deepEqual(calFromOrdinal(GREG, y47), { y: 47, m: 6, d: 1, h: 0, mi: 0 });

  // Year 0 and negative years round-trip, and stay in order.
  for (const y of [0, -1, -100]) {
    const ord = calToOrdinal(GREG, { y, m: 3, d: 2, h: 0, mi: 0 });
    assert.notEqual(ord, null, `year ${y} must produce an ordinal`);
    assert.deepEqual(calFromOrdinal(GREG, ord), { y, m: 3, d: 2, h: 0, mi: 0 });
  }
  const order = [-100, -1, 0, 1, 47].map(y => calToOrdinal(GREG, { y, m: 1, d: 1, h: 0, mi: 0 }));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'pre-epoch years sort before later ones');

  // A genuinely absent date is still null — that is the only "no date" case.
  assert.equal(calToOrdinal(GREG, { y: 5, m: 0, d: 0, h: 0, mi: 0 }), null);
});

test('a cycle unit does not reset at its parent boundary', () => {
  // 7-day weeks over 30-day months: 30 % 7 === 2, so day 1 of each month
  // shifts by two slots. This is what makes weekday alignment real; the old
  // grid always put day 1 in column 1.
  const spec = calSpecNormalize({
    version: 2, anchor: { weekdayIndex: 0 },
    units: [
      { key: 'minute', mode: 'container', of: [] },
      { key: 'hour', mode: 'container', of: [{ unit: 'minute', count: 60 }] },
      { key: 'day', mode: 'container', of: [{ unit: 'hour', count: 24 }] },
      { key: 'week', mode: 'cycle', of: [{ unit: 'day', count: 7 }] },
      { key: 'month', mode: 'container', of: [{ unit: 'day', count: 30 }] },
      { key: 'year', mode: 'container', of: [{ unit: 'month', count: 12 }] },
    ],
  });
  const slotOfFirst = (m) => calCycleSlot(spec, 'week', calDayIndex(spec, 1, m, 1));
  assert.equal(slotOfFirst(1), 0);
  assert.equal(slotOfFirst(2), 2);
  assert.equal(slotOfFirst(3), 4);
  assert.equal(slotOfFirst(4), 6);
  // Consecutive days advance one slot and wrap.
  const base = calDayIndex(spec, 1, 1, 7);
  assert.equal(calCycleSlot(spec, 'week', base), 6);
  assert.equal(calCycleSlot(spec, 'week', base + 1), 0, 'the cycle wraps');
  // Pre-epoch days stay on the cycle rather than going negative.
  assert.ok(calCycleSlot(spec, 'week', -1) >= 0);
  assert.equal(calCycleSlot(spec, 'week', -1), 6);
});

test('the weekday anchor shifts the whole cycle', () => {
  const mk = (weekdayIndex) => calSpecNormalize({
    version: 2, anchor: { weekdayIndex },
    units: [
      { key: 'minute', mode: 'container', of: [] },
      { key: 'hour', mode: 'container', of: [{ unit: 'minute', count: 60 }] },
      { key: 'day', mode: 'container', of: [{ unit: 'hour', count: 24 }] },
      { key: 'week', mode: 'cycle', of: [{ unit: 'day', count: 7 }] },
      { key: 'month', mode: 'container', of: [{ unit: 'day', count: 30 }] },
      { key: 'year', mode: 'container', of: [{ unit: 'month', count: 12 }] },
    ],
  });
  assert.equal(calCycleSlot(mk(0), 'week', 0), 0);
  assert.equal(calCycleSlot(mk(3), 'week', 0), 3, 'the epoch day starts on slot 3');
});

test('per-year length overrides beat the month default, and cycle variants beat both', () => {
  const spec = calSpecNormalize({
    version: 2, anchor: { weekdayIndex: 0 },
    units: [
      { key: 'minute', mode: 'container', of: [] },
      { key: 'hour', mode: 'container', of: [{ unit: 'minute', count: 60 }] },
      { key: 'day', mode: 'container', of: [{ unit: 'hour', count: 24 }] },
      { key: 'week', mode: 'cycle', of: [{ unit: 'day', count: 7 }] },
      { key: 'month', mode: 'container', of: [{ unit: 'day', count: 30 }] },
      {
        key: 'year', mode: 'container', of: [{ unit: 'month', count: 3 }],
        lengths: { on: true, values: [31, 28, 30] },
        cycle: { on: true, period: 3, variants: { 2: { 1: 99 } } },
      },
    ],
  });
  assert.equal(calMonthLength(spec, 1, 0), 31, 'flat override');
  assert.equal(calMonthLength(spec, 1, 1), 28);
  assert.equal(calMonthLength(spec, 3, 1), 99, 'cycle variant wins on slot 2');
  assert.equal(calDaysInYear(spec, 1), 31 + 28 + 30);
  assert.equal(calDaysInYear(spec, 3), 31 + 99 + 30);
  // And the ordinal arithmetic actually uses those lengths.
  const perDay = 24 * 60;
  const end = calToOrdinal(spec, { y: 3, m: 2, d: 99, h: 0, mi: 0 });
  const next = calToOrdinal(spec, { y: 3, m: 3, d: 1, h: 0, mi: 0 });
  assert.equal(next - end, perDay);
});

test('a large year number does not walk year by year', () => {
  // calDaysBeforeYear divides by the cycle instead of looping, so this stays
  // instant even far from the epoch.
  const started = Date.now();
  const ord = calToOrdinal(GREG, { y: 400000, m: 6, d: 15, h: 12, mi: 30 });
  assert.deepEqual(calFromOrdinal(GREG, ord), { y: 400000, m: 6, d: 15, h: 12, mi: 30 });
  assert.ok(Date.now() - started < 500, 'must not be O(year)');
});

test('the v1 calendarConfig blob upgrades without changing what it described', () => {
  // Every existing vault holds this shape. Its months were uniform and it had
  // no leap rule, so the upgrade must NOT inherit the Gregorian defaults.
  const v1 = { daysPerWeek: 5, daysPerMonth: 20, monthsPerYear: 8, dayNames: ['A', 'B', 'C', 'D', 'E'], monthNames: ['Frost', 'Thaw'] };
  const spec = calSpecNormalize(v1);
  assert.equal(calDaysInYear(spec, 1), 20 * 8, 'uniform 20-day months, 8 per year');
  assert.equal(calDaysInYear(spec, 4), 20 * 8, 'no leap rule was carried over');
  assert.equal(calMonthLength(spec, 1, 0), 20);
  const week = spec.units.find(u => u.key === 'week');
  assert.equal(week.of[0].count, 5);
  assert.deepEqual(week.naming.names, ['A', 'B', 'C', 'D', 'E']);
  const year = spec.units.find(u => u.key === 'year');
  assert.deepEqual(year.naming.names, ['Frost', 'Thaw']);
  assert.equal(year.lengths.on, false);
  assert.equal(year.cycle.on, false);
});

test('a malformed or empty config falls back to the default instead of throwing', () => {
  for (const bad of [null, undefined, 42, 'nonsense', {}, { units: 'no' }]) {
    const spec = calSpecNormalize(bad);
    assert.equal(calDaysInYear(spec, 2001), 365, `fallback for ${JSON.stringify(bad)}`);
  }
  // A spec missing stored units gets them back rather than breaking arithmetic.
  const partial = calSpecNormalize({ version: 2, units: [{ key: 'year', mode: 'container', of: [{ unit: 'month', count: 4 }] }] });
  assert.notEqual(calToOrdinal(partial, { y: 2, m: 2, d: 2, h: 0, mi: 0 }), null);
});

test('a unit above year is derived from the year, not stored', () => {
  // The plan's "circle" of 12 years, named by zodiac.
  const spec = calSpecNormalize({
    version: 2, anchor: { weekdayIndex: 0 },
    units: [
      ...CAL_DEFAULT_SPEC.units,
      { key: 'circle', mode: 'container', of: [{ unit: 'year', count: 12 }] },
    ],
  });
  assert.deepEqual(calDerivedUnitValue(spec, 'circle', 1), { index: 0, instance: 1 });
  assert.deepEqual(calDerivedUnitValue(spec, 'circle', 12), { index: 11, instance: 1 });
  assert.deepEqual(calDerivedUnitValue(spec, 'circle', 13), { index: 0, instance: 2 });
  // Redefining the circle must not disturb any stored date.
  const before = calToOrdinal(spec, { y: 13, m: 1, d: 1, h: 0, mi: 0 });
  const wider = calSpecNormalize({ ...spec, units: spec.units.map(u => u.key === 'circle' ? { ...u, of: [{ unit: 'year', count: 60 }] } : u) });
  assert.equal(calToOrdinal(wider, { y: 13, m: 1, d: 1, h: 0, mi: 0 }), before);
});

test('ruler ticks step in the calendar own units and stay capped', () => {
  // A short span steps by month and labels with the calendar's month names.
  const from = calToOrdinal(GREG, { y: 1000, m: 1, d: 1, h: 0, mi: 0 });
  const to = calToOrdinal(GREG, { y: 1000, m: 6, d: 1, h: 0, mi: 0 });
  const monthly = calRulerTicks(GREG, from, to);
  assert.ok(monthly.length >= 5 && monthly.length <= 7);
  assert.equal(monthly[0].label, 'January', 'labels come from the spec, not from Date');
  assert.ok(monthly.every(t => t.ordinal >= from && t.ordinal <= to));

  // A long span steps by year.
  const far = calToOrdinal(GREG, { y: 1050, m: 1, d: 1, h: 0, mi: 0 });
  const yearly = calRulerTicks(GREG, from, far);
  assert.equal(yearly[0].label, '1000');
  assert.ok(yearly.length <= 240, 'respects the tick cap');

  // The fictional calendar has 15 months, and the ruler must be able to label
  // past month 12 — a Gregorian stepper never could.
  const fFrom = calToOrdinal(FICTIONAL, { y: 5, m: 1, d: 1, h: 0, mi: 0 });
  const fTo = calToOrdinal(FICTIONAL, { y: 5, m: 15, d: 40, h: 0, mi: 0 });
  const fTicks = calRulerTicks(FICTIONAL, fFrom, fTo);
  assert.ok(fTicks.length > 0);
  assert.ok(fTicks.every(t => t.ordinal >= fFrom && t.ordinal <= fTo), 'ticks stay inside the span');
  assert.ok(fTicks.some(t => Number(t.label) > 12), 'labels reach the 13th-15th months');
  assert.deepEqual(fTicks.map(t => t.ordinal), [...fTicks.map(t => t.ordinal)].sort((a, b) => a - b), 'ticks ascend');

  assert.deepEqual(calRulerTicks(GREG, 100, 100), [], 'an empty span has no ticks');
});

// A fixed one-unit step produced 1200 ticks for a 1200-year span, hit the
// guard, and left the axis labelled across only its first fifth.
test('a very long span is labelled across its whole width, not just the start', () => {
  const from = calToOrdinal(GREG, { y: 0, m: 1, d: 1, h: 0, mi: 0 });
  const to = calToOrdinal(GREG, { y: 1200, m: 1, d: 1, h: 0, mi: 0 });
  const ticks = calRulerTicks(GREG, from, to);
  assert.ok(ticks.length > 1 && ticks.length <= 20, `expected a readable count, got ${ticks.length}`);
  const last = ticks[ticks.length - 1];
  // The final tick should sit near the end of the span, not near the start.
  assert.ok((last.ordinal - from) / (to - from) > 0.8, 'labels reach the far end of the axis');
  // Strides land on round numbers.
  assert.ok(ticks.every(t => Number(t.label) % Number(ticks[1].label - ticks[0].label) === 0));
});

test('calFloorMod keeps negatives on the cycle', () => {
  assert.equal(calFloorMod(-1, 7), 6);
  assert.equal(calFloorMod(-7, 7), 0);
  assert.equal(calFloorMod(8, 7), 1);
});

// ── Calendar templates cross the vault boundary (Process 8 part 1) ──────
// A new nexus-scoped table has to be threaded through four places that all
// enumerate tables BY HAND. Miss one and the failure is silent: templates
// simply vanish on export, or a duplicated vault keeps pointing at the
// original's nexus id. Asserted on source for the same reason
// module-transfer.test.mjs does — these paths need Electron's `app` to run.
test('calendar_template is wired into every hand-maintained table list', () => {
  const sync = readSource('../src/db/sync.js');

  // 1. serializeVault must emit it...
  assert.match(sync, /FROM calendar_template WHERE nexus_ref=\?/, 'serializeVault must read the table');
  // ...and it must actually reach the returned snapshot, not just be a local.
  const snapshot = sync.match(/return \{[\s\S]*?calendarTemplates[\s\S]*?\};/);
  assert.ok(snapshot, 'calendarTemplates must be included in the snapshot payload');

  // 2. the wipe gate must clear it, or a re-pull stacks duplicates.
  const core = sync.match(/function applySnapshotCore\([\s\S]*?\n\}\n/)?.[0] || '';
  const wipeBlock = core.match(/if \(wipe\) \{([\s\S]*?)\n\s*\}/)?.[1] || '';
  assert.match(wipeBlock, /DELETE FROM calendar_template\b/, 'the wipe must clear templates');

  // 3. and applySnapshotCore must write them back.
  assert.match(core, /INSERT OR IGNORE INTO calendar_template/, 'apply must restore templates');

  // 4. duplicateNexus renumbers nexus_ref only for the tables it lists.
  const nexus = readSource('../src/db/nexus.js');
  assert.match(nexus, /NEXUS_REF_TABLES = \[[^\]]*'calendar_template'/,
    'calendar_template must be in NEXUS_REF_TABLES or a duplicated vault keeps the source nexus id');
});

test('the calendar db layer is reachable from database.js', () => {
  // check-arch.mjs enforces this too, but the failure mode is worth naming:
  // db.listCalendarTemplates would be undefined and every IPC call would throw.
  const database = readSource('../database.js');
  assert.match(database, /require\('\.\/src\/db\/calendar'\)/);
  assert.match(database, /\.\.\.calendar,/);
});
