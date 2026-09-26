import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isIsoDate,
  assertIsoDate,
  addDays,
  addMonths,
  daysBetween,
  eachDay,
  monthKey,
  compareIso,
  startOfMonth,
  startOfNextMonth,
  startOfFiscalYear,
  startOfNextFiscalYear,
  startOfFiscalQuarter,
  startOfNextFiscalQuarter,
  resolvePeriod,
  previousPeriod,
  assertPeriod,
  describePeriod,
  PERIOD_PRESETS,
  INTERNAL_PERIOD_PRESETS,
} from '../src/lib/dates.js';

test('isIsoDate validates real calendar dates', () => {
  assert.equal(isIsoDate('2026-03-14'), true);
  assert.equal(isIsoDate('2026-02-30'), false, 'February has no 30th');
  assert.equal(isIsoDate('2026-13-01'), false);
  assert.equal(isIsoDate('2026-3-14'), false);
  assert.equal(isIsoDate('not-a-date'), false);
  assert.doesNotThrow(() => assertIsoDate('2026-01-01'));
  assert.throws(() => assertIsoDate('2026-02-30'), /valid YYYY-MM-DD/);
});

test('addDays and addMonths handle month ends and leap years', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29', '2024 is a leap year');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'clamps to the shorter month');
  assert.equal(addMonths('2026-03-31', -1), '2026-02-28');
});

test('month boundaries are start-inclusive and end-exclusive', () => {
  assert.equal(startOfMonth('2026-03-14'), '2026-03-01');
  assert.equal(startOfNextMonth('2026-03-14'), '2026-04-01');
  assert.equal(monthKey('2026-03-14'), '2026-03');
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(compareIso('2026-01-01', '2026-02-01'), -1);
  assert.equal(compareIso('2026-02-01', '2026-02-01'), 0);
});

test('eachDay covers [start, end) without the end date', () => {
  const days = eachDay('2026-03-01', '2026-03-04');
  assert.deepEqual(days, ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.equal(days.length, 3);
});

test('fiscal year respects the company fiscal start month', () => {
  // Calendar year company.
  assert.equal(startOfFiscalYear('2026-03-14', 1), '2026-01-01');
  assert.equal(startOfNextFiscalYear('2026-03-14', 1), '2027-01-01');
  // Company whose fiscal year starts in April.
  assert.equal(startOfFiscalYear('2026-03-14', 4), '2025-04-01');
  assert.equal(startOfFiscalYear('2026-06-14', 4), '2026-04-01');
  assert.equal(startOfNextFiscalYear('2026-06-14', 4), '2027-04-01');
});

test('fiscal quarters follow the fiscal year start', () => {
  assert.equal(startOfFiscalQuarter('2026-03-14', 1), '2026-01-01');
  assert.equal(startOfNextFiscalQuarter('2026-03-14', 1), '2026-04-01');
  assert.equal(startOfFiscalQuarter('2026-05-14', 1), '2026-04-01');
  // April-start company: quarters are Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar.
  assert.equal(startOfFiscalQuarter('2026-05-14', 4), '2026-04-01');
  assert.equal(startOfFiscalQuarter('2026-02-14', 4), '2026-01-01');
  assert.equal(startOfNextFiscalQuarter('2026-02-14', 4), '2026-04-01');
});

test('resolvePeriod returns exclusive end dates for every preset', () => {
  const today = '2026-03-14';

  const month = resolvePeriod('this_month', { today });
  assert.deepEqual(month, { start: '2026-03-01', end: '2026-04-01' });

  const lastMonth = resolvePeriod('last_month', { today });
  assert.deepEqual(lastMonth, { start: '2026-02-01', end: '2026-03-01' });

  const quarter = resolvePeriod('this_quarter', { today, fiscalStartMonth: 1 });
  assert.deepEqual(quarter, { start: '2026-01-01', end: '2026-04-01' });

  const year = resolvePeriod('this_year', { today, fiscalStartMonth: 1 });
  assert.deepEqual(year, { start: '2026-01-01', end: '2027-01-01' });

  const lastYear = resolvePeriod('last_year', { today, fiscalStartMonth: 1 });
  assert.deepEqual(lastYear, { start: '2025-01-01', end: '2026-01-01' });

  // Previously expected start '2026-02-12', which is 31 days. The preset is
  // "the 30 days ending today, today included": 2026-02-13 .. 2026-03-14.
  const last30 = resolvePeriod('last_30_days', { today });
  assert.deepEqual(last30, { start: '2026-02-13', end: '2026-03-15' });

  for (const preset of [...PERIOD_PRESETS, ...INTERNAL_PERIOD_PRESETS]) {
    if (preset === 'custom') continue;
    const period = resolvePeriod(preset, { today, fiscalStartMonth: 1 });
    assert.ok(compareIso(period.start, period.end) < 0, `${preset} must have start < end`);
  }

  assert.throws(() => resolvePeriod('nonsense', { today }), /Unknown period preset/);
});

test('rolling presets cover exactly N days and include today', () => {
  for (const today of ['2026-03-14', '2024-03-01', '2026-01-01', '2026-12-31']) {
    const last30 = resolvePeriod('last_30_days', { today });
    assert.equal(daysBetween(last30.start, last30.end), 30, `last_30_days on ${today}`);
    assert.equal(eachDay(last30.start, last30.end).length, 30);
    assert.equal(eachDay(last30.start, last30.end).at(-1), today, 'today is the last included day');

    const last90 = resolvePeriod('last_90_days', { today });
    assert.equal(daysBetween(last90.start, last90.end), 90, `last_90_days on ${today}`);
    assert.equal(last90.end, addDays(today, 1), 'the exclusive end is tomorrow');
  }
});

test('API presets match API_CONTRACT.md §7; extra windows stay internal', () => {
  assert.deepEqual(
    [...PERIOD_PRESETS],
    ['this_month', 'last_month', 'this_quarter', 'this_year', 'last_30_days', 'custom'],
  );
  for (const internal of INTERNAL_PERIOD_PRESETS) {
    assert.equal(PERIOD_PRESETS.includes(internal), false, `${internal} must not be client-facing`);
  }
});

// D10 is now LOCKED: the previous period is the preceding equivalent CALENDAR
// period. This test used to assert the old equal-length window (March ->
// 2026-01-29..2026-03-01), which was the pending, unapproved behaviour.
test('previousPeriod is the preceding calendar period (D10)', () => {
  const cases = [
    // [period, expected previous period]
    [{ start: '2026-03-01', end: '2026-04-01' }, { start: '2026-02-01', end: '2026-03-01' }], // March -> February
    [{ start: '2026-02-01', end: '2026-03-01' }, { start: '2026-01-01', end: '2026-02-01' }], // February -> January
    [{ start: '2026-01-01', end: '2026-02-01' }, { start: '2025-12-01', end: '2026-01-01' }], // across a year
    [{ start: '2026-04-01', end: '2026-07-01' }, { start: '2026-01-01', end: '2026-04-01' }], // Q2 -> Q1
    [{ start: '2026-01-01', end: '2027-01-01' }, { start: '2025-01-01', end: '2026-01-01' }], // 2026 -> 2025
    [{ start: '2025-04-01', end: '2026-04-01' }, { start: '2024-04-01', end: '2025-04-01' }], // fiscal year from April
    [{ start: '2024-03-01', end: '2024-04-01' }, { start: '2024-02-01', end: '2024-03-01' }], // leap February
  ];
  for (const [period, expected] of cases) {
    const previous = previousPeriod(period);
    assert.deepEqual({ start: previous.start, end: previous.end }, expected, `${period.start}..${period.end}`);
    assert.equal(previous.basis, 'calendar');
    assert.equal(previous.end, period.start, 'no gap and no overlap: previous ends where current starts');
  }
  assert.equal(previousPeriod({ start: '2024-03-01', end: '2024-04-01' }).lengthDays, 29, 'February 2024 has 29 days');
});

test('the presets compare with their calendar predecessors', () => {
  const today = '2026-05-14';
  assert.deepEqual(previousPeriod(resolvePeriod('this_month', { today })), {
    start: '2026-04-01', end: '2026-05-01', basis: 'calendar', lengthDays: 30,
  });
  const quarter = previousPeriod(resolvePeriod('this_quarter', { today, fiscalStartMonth: 1 }));
  assert.deepEqual([quarter.start, quarter.end], ['2026-01-01', '2026-04-01']);
  const year = previousPeriod(resolvePeriod('this_year', { today, fiscalStartMonth: 4 }));
  assert.deepEqual([year.start, year.end], ['2025-04-01', '2026-04-01']);
});

test('a period that is not whole calendar months compares with the equally long window before it', () => {
  const last30 = resolvePeriod('last_30_days', { today: '2026-03-14' }); // 2026-02-13 .. 2026-03-15
  const previous = previousPeriod(last30);
  assert.deepEqual(previous, { start: '2026-01-14', end: '2026-02-13', basis: 'equal_length', lengthDays: 30 });

  const custom = previousPeriod({ start: '2026-03-10', end: '2026-03-20' });
  assert.deepEqual(custom, { start: '2026-02-28', end: '2026-03-10', basis: 'equal_length', lengthDays: 10 });
});

test('assertPeriod enforces start before exclusive end', () => {
  assert.deepEqual(assertPeriod({ start: '2026-01-01', end: '2026-02-01' }), {
    start: '2026-01-01',
    end: '2026-02-01',
  });
  assert.throws(() => assertPeriod({ start: '2026-02-01', end: '2026-01-01' }), /must be before/);
  assert.throws(() => assertPeriod({ start: '2026-01-01', end: '2026-01-01' }), /must be before/);
});

test('describePeriod states that the end is exclusive', () => {
  assert.match(describePeriod({ start: '2026-01-01', end: '2026-02-01' }), /end exclusive/);
});
