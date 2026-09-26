/**
 * The one way a report-like endpoint turns a query into a period: the same
 * presets, custom ranges, fiscal year start and maximum length as the Phase 3
 * financial views (API_CONTRACT.md §7, §9.5).
 */

import { unprocessable } from '../lib/errors.js';
import { daysBetween, previousPeriod, requestedPeriod } from '../lib/dates.js';
import { DEFAULT_PRESET, MAX_PERIOD_DAYS } from './financials.js';
import * as companies from '../models/companies.js';

export function resolveCompanyPeriod(db, companyId, query) {
  const company = companies.getCompany(db, companyId);
  const preset = query.period ?? DEFAULT_PRESET;
  const period = requestedPeriod({ ...query, period: preset }, { fiscalStartMonth: company.fiscalYearStartMonth });
  if (daysBetween(period.start, period.end) > MAX_PERIOD_DAYS) {
    throw unprocessable('The period is too long.', [{ field: 'periodEnd', issue: `period must be at most ${MAX_PERIOD_DAYS} days` }]);
  }
  const previous = previousPeriod(period);
  return {
    company,
    period: { ...period, preset },
    previousPeriod: { start: previous.start, end: previous.end, basis: previous.basis },
  };
}
