/**
 * Financial views (API_CONTRACT.md §9.5). Presentation only: every figure
 * comes from the financial engine; this module resolves the period and turns
 * BigInt minor units into the money wire form.
 */

import { unprocessable } from '../lib/errors.js';
import { daysBetween, requestedPeriod, todayIso } from '../lib/dates.js';
import { changeBasisPoints, moneyJson } from '../lib/money.js';
import * as companies from '../models/companies.js';

/** The period a financial view shows when none is requested. */
export const DEFAULT_PRESET = 'this_month';
/** Longest period a daily cash-flow series is produced for. */
export const MAX_DAILY_SERIES_DAYS = 366;
/** Longest period any financial view accepts (ten years). */
export const MAX_PERIOD_DAYS = 3660;

export function createFinancialsService({ db, engine }) {
  function resolve(companyId, query) {
    const company = companies.getCompany(db, companyId);
    const period = requestedPeriod(
      { ...query, period: query.period ?? DEFAULT_PRESET },
      { fiscalStartMonth: company.fiscalYearStartMonth },
    );
    if (daysBetween(period.start, period.end) > MAX_PERIOD_DAYS) {
      throw unprocessable('The period is too long.', [{ field: 'periodEnd', issue: `period must be at most ${MAX_PERIOD_DAYS} days` }]);
    }
    return { company, period: { ...period, preset: query.period ?? DEFAULT_PRESET } };
  }

  function obligations(companyId, period, currency) {
    const today = todayIso();
    const from = period.start > today ? period.start : today;
    if (from >= period.end) return { from: null, to: period.end, payables: null, receivables: null, warning: false, note: 'The period has ended; no upcoming obligations.' };
    const due = engine.unpaidDueBetween(companyId, { start: from, end: period.end });
    const warning = due.payable.count > 0;
    return {
      from,
      to: period.end,
      payables: { count: due.payable.count, total: moneyJson(due.payable.total, currency) },
      receivables: { count: due.receivable.count, total: moneyJson(due.receivable.total, currency) },
      warning,
      note: warning ? 'Unpaid bills fall due before the period ends and will reduce cash when paid.' : null,
    };
  }

  const figure = (current, previous, currency) => ({
    amount: moneyJson(current - previous, currency),
    basisPoints: changeBasisPoints(current, previous),
  });

  return {
    overview(companyId, query) {
      const { company, period } = resolve(companyId, query);
      const { currency } = company;
      const result = engine.overview(companyId, period);
      const money = (value) => moneyJson(value, currency);
      return {
        data: {
          currency,
          period,
          previousPeriod: { start: result.previousPeriod.start, end: result.previousPeriod.end, basis: result.previousPeriod.basis },
          income: money(result.current.income),
          expenses: money(result.current.expense),
          netResult: money(result.current.net),
          transactionCount: result.current.transactionCount,
          previous: {
            income: money(result.previous.income),
            expenses: money(result.previous.expense),
            netResult: money(result.previous.net),
            transactionCount: result.previous.transactionCount,
          },
          change: {
            income: figure(result.current.income, result.previous.income, currency),
            expenses: figure(result.current.expense, result.previous.expense, currency),
            netResult: figure(result.current.net, result.previous.net, currency),
          },
          cash: {
            opening: money(result.cash.opening),
            closing: money(result.cash.closing),
            netMovement: money(result.cash.closing - result.cash.opening),
          },
        },
        meta: { period },
      };
    },

    cashFlow(companyId, query) {
      const { company, period } = resolve(companyId, query);
      const granularity = query.granularity ?? 'day';
      if (granularity === 'day' && daysBetween(period.start, period.end) > MAX_DAILY_SERIES_DAYS) {
        throw unprocessable('Use granularity=month for periods longer than a year.', [
          { field: 'granularity', issue: `day is limited to ${MAX_DAILY_SERIES_DAYS} days` },
        ]);
      }
      const { currency } = company;
      const money = (value) => moneyJson(value, currency);
      const flow = engine.cashFlow(companyId, { ...period, granularity });
      return {
        data: {
          currency,
          period,
          granularity,
          openingCash: money(flow.opening),
          cashIn: money(flow.cashIn),
          cashOut: money(flow.cashOut),
          netMovement: money(flow.net),
          closingCash: money(flow.closing),
          // Buckets with no cash movement are omitted; the balance carries over.
          series: flow.series.map((bucket) => ({
            start: bucket.bucket,
            cashIn: money(bucket.cashIn),
            cashOut: money(bucket.cashOut),
            netMovement: money(bucket.net),
            closingBalance: money(bucket.closingBalance),
          })),
          // Added in the final backend completion (PRODUCT_REQUIREMENTS.md #7):
          // unpaid invoices falling due in the rest of the period.
          upcomingObligations: obligations(companyId, period, currency),
        },
        meta: { period },
      };
    },
  };
}
