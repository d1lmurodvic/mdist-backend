/**
 * Date and financial-period handling.
 *
 * Locked rules implemented here:
 *  - Calendar dates are 'YYYY-MM-DD' strings; timestamps are ISO 8601 UTC.
 *  - Timestamps are stored in UTC. The company timezone is used for display
 *    and calendar interpretation only.
 *  - A period is { start, end } where start is INCLUSIVE and end is EXCLUSIVE.
 *    This is the single definition used by every financial calculation, so
 *    period filtering is identical across dashboard, reports and exports.
 *
 * All date math is done in UTC to avoid daylight-saving and offset bugs.
 */

import { badRequest } from './errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86400000;

/** Presets a client may request — exactly the list in API_CONTRACT.md §7. */
export const PERIOD_PRESETS = Object.freeze([
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_30_days',
  'custom',
]);

/**
 * Additional windows resolvePeriod() can compute for services. They are not
 * part of the API contract, and the API boundary (validate.js) rejects them.
 */
export const INTERNAL_PERIOD_PRESETS = Object.freeze(['last_quarter', 'last_year', 'last_90_days']);

export function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function assertIsoDate(value, field = 'date') {
  if (!isIsoDate(value)) {
    throw badRequest('Date must be a valid YYYY-MM-DD date.', [
      { field, issue: 'must be a valid YYYY-MM-DD date' },
    ]);
  }
  return value;
}

/** 'YYYY-MM-DD' -> Date at UTC midnight. */
export function parseIsoDate(value, field = 'date') {
  assertIsoDate(value, field);
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Date -> 'YYYY-MM-DD' in UTC. */
export function toIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw badRequest('Invalid date value.', [{ field: 'date', issue: 'invalid date' }]);
  }
  return date.toISOString().slice(0, 10);
}

export function nowIsoTimestamp() {
  return new Date().toISOString();
}

export function todayIso() {
  return toIsoDate(new Date());
}

export function addDays(isoDate, days) {
  const date = parseIsoDate(isoDate);
  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

export function addMonths(isoDate, months) {
  const date = parseIsoDate(isoDate);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return toIsoDate(date);
}

export function compareIso(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whole days from start (inclusive) to end (exclusive). */
export function daysBetween(start, end) {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / MS_PER_DAY);
}

/** Every date in [start, end). */
export function eachDay(start, end) {
  const days = [];
  for (let cursor = start; compareIso(cursor, end) < 0; cursor = addDays(cursor, 1)) {
    days.push(cursor);
  }
  return days;
}

/** 'YYYY-MM' key, used to group transactions into months. */
export function monthKey(isoDate) {
  return isoDate.slice(0, 7);
}

export function startOfMonth(isoDate) {
  return `${isoDate.slice(0, 7)}-01`;
}

export function startOfNextMonth(isoDate) {
  return startOfMonth(addMonths(`${isoDate.slice(0, 7)}-01`, 1));
}

/** First day of the fiscal year containing `isoDate`. `fiscalStartMonth` is 1-12. */
export function startOfFiscalYear(isoDate, fiscalStartMonth = 1) {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= fiscalStartMonth ? year : year - 1;
  return `${startYear}-${String(fiscalStartMonth).padStart(2, '0')}-01`;
}

export function startOfNextFiscalYear(isoDate, fiscalStartMonth = 1) {
  return addMonths(startOfFiscalYear(isoDate, fiscalStartMonth), 12);
}

/** Start of the fiscal quarter containing `isoDate`. */
export function startOfFiscalQuarter(isoDate, fiscalStartMonth = 1) {
  const fiscalYearStart = startOfFiscalYear(isoDate, fiscalStartMonth);
  const monthIndex = (Number(isoDate.slice(5, 7)) - fiscalStartMonth + 12) % 12;
  const quarterOffset = Math.floor(monthIndex / 3) * 3;
  return addMonths(fiscalYearStart, quarterOffset);
}

export function startOfNextFiscalQuarter(isoDate, fiscalStartMonth = 1) {
  return addMonths(startOfFiscalQuarter(isoDate, fiscalStartMonth), 3);
}

/**
 * The `days` calendar days ending with `today`, today included:
 * [today − (days − 1), today + 1). last_30_days on 2026-03-14 is
 * 2026-02-13 (inclusive) → 2026-03-15 (exclusive): exactly 30 days.
 */
function rollingDays(today, days) {
  return { start: addDays(today, -(days - 1)), end: addDays(today, 1) };
}

/**
 * Resolve a named period preset into { start, end } with an EXCLUSIVE end.
 * `custom` is not resolved here — the caller supplies explicit boundaries.
 */
export function resolvePeriod(preset, { today = todayIso(), fiscalStartMonth = 1 } = {}) {
  switch (preset) {
    case 'this_month':
      return { start: startOfMonth(today), end: startOfNextMonth(today) };
    case 'last_month': {
      const thisMonthStart = startOfMonth(today);
      return { start: startOfMonth(addMonths(thisMonthStart, -1)), end: thisMonthStart };
    }
    case 'this_quarter':
      return {
        start: startOfFiscalQuarter(today, fiscalStartMonth),
        end: startOfNextFiscalQuarter(today, fiscalStartMonth),
      };
    case 'last_quarter': {
      const thisQuarterStart = startOfFiscalQuarter(today, fiscalStartMonth);
      return {
        start: addMonths(thisQuarterStart, -3),
        end: thisQuarterStart,
      };
    }
    case 'this_year':
      return {
        start: startOfFiscalYear(today, fiscalStartMonth),
        end: startOfNextFiscalYear(today, fiscalStartMonth),
      };
    case 'last_year': {
      const thisYearStart = startOfFiscalYear(today, fiscalStartMonth);
      return { start: addMonths(thisYearStart, -12), end: thisYearStart };
    }
    case 'last_30_days':
      return rollingDays(today, 30);
    case 'last_90_days':
      return rollingDays(today, 90);
    default:
      throw badRequest('Unknown period preset.', [
        { field: 'period', issue: `must be one of: ${[...PERIOD_PRESETS, ...INTERNAL_PERIOD_PRESETS].join(', ')}` },
      ]);
  }
}

/** Whole calendar months in [start, end) when both fall on the 1st, else null. */
function wholeMonthsBetween(start, end) {
  if (start.slice(8) !== '01' || end.slice(8) !== '01') return null;
  const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12
    + (Number(end.slice(5, 7)) - Number(start.slice(5, 7)));
  return months > 0 ? months : null;
}

/**
 * The "previous comparable period" used by every period-over-period
 * comparison, so the comparison basis is defined once.
 *
 * LOCKED (ARCHITECTURE.md D10): a period made of whole calendar months — a
 * month, a (fiscal) quarter, a (fiscal) year, or any run of whole months — is
 * compared with the immediately preceding calendar period of the same number
 * of months: March 2026 -> February 2026, Q2 -> Q1, 2026 -> 2025.
 *
 * A period that is not whole months (last_30_days, a custom day range) has no
 * calendar equivalent; it is compared with the equally long window just
 * before it. `basis` says which rule applied.
 */
export function previousPeriod({ start, end }) {
  const months = wholeMonthsBetween(start, end);
  if (months !== null) {
    const previousStart = addMonths(start, -months);
    return { start: previousStart, end: start, basis: 'calendar', lengthDays: daysBetween(previousStart, start) };
  }
  const length = daysBetween(start, end);
  return { start: addDays(start, -length), end: start, basis: 'equal_length', lengthDays: length };
}

/** Validate an explicit { start, end } period. start is inclusive, end exclusive. */
export function assertPeriod({ start, end }) {
  assertIsoDate(start, 'periodStart');
  assertIsoDate(end, 'periodEnd');
  if (compareIso(start, end) >= 0) {
    throw badRequest('periodStart must be before periodEnd.', [
      { field: 'periodStart', issue: 'must be earlier than periodEnd (end is exclusive)' },
    ]);
  }
  return { start, end };
}

/**
 * The period a request asks for (API_CONTRACT.md §7): a preset, or
 * period=custom with explicit periodStart/periodEnd (end-exclusive).
 */
export function requestedPeriod({ period, periodStart, periodEnd }, { today = todayIso(), fiscalStartMonth = 1 } = {}) {
  if (period === 'custom') {
    if (!periodStart || !periodEnd) {
      throw badRequest('A custom period needs periodStart and periodEnd.', [
        { field: periodStart ? 'periodEnd' : 'periodStart', issue: 'required when period=custom' },
      ]);
    }
    return assertPeriod({ start: periodStart, end: periodEnd });
  }
  return resolvePeriod(period, { today, fiscalStartMonth });
}

/** Human label for a period, e.g. '2026-01-01 → 2026-02-01 (exclusive)'. */
export function describePeriod({ start, end }) {
  return `${start} → ${end} (end exclusive)`;
}
