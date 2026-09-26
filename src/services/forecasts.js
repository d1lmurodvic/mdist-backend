/**
 * Cash-flow forecasting (PRODUCT_REQUIREMENTS.md #19; API_CONTRACT.md §9.9).
 *
 * Inputs come from the financial engine (current cash) and the stored records
 * (recent transactions, unpaid invoices); the projection itself is the
 * deterministic method in ai/forecast.js. A generated projection is stored.
 * GET /forecast/latest returns the stored projection and says whether it is
 * still current: `stale` is true once the inputs it was built from changed.
 */

import { createHash } from 'node:crypto';
import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { addDays, nowIsoTimestamp, todayIso } from '../lib/dates.js';
import { moneyJson } from '../lib/money.js';
import * as analytics from '../models/analytics.js';
import * as intelligence from '../models/intelligence.js';
import * as companies from '../models/companies.js';
import { FORECAST_METHOD, FORECAST_WINDOWS, projectCashFlow } from '../ai/forecast.js';

export const FORECAST_CAPABILITY = Object.freeze({
  method: 'statistics',
  degraded: false,
  note: 'Deterministic projection from your balances, recurring patterns and unpaid invoices. It is a projection, not an AI prediction.',
});

export function createForecastService({ db, engine, notifications }) {
  function inputs(companyId, today) {
    const tomorrow = addDays(today, 1);
    return {
      today,
      currentCash: engine.cashBalance(companyId, { before: tomorrow }),
      history: analytics.transactionsBetween(db, companyId, { start: addDays(tomorrow, -FORECAST_WINDOWS.historyDays), end: tomorrow }),
      firstTransactionDate: analytics.firstTransactionDate(db, companyId),
      unpaidInvoices: analytics.unpaidInvoices(db, companyId),
    };
  }

  function fingerprint(input, horizonDays) {
    const text = JSON.stringify(
      { ...input, horizonDays },
      (_, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
    return createHash('sha256').update(text).digest('hex');
  }

  function present(result, currency) {
    const money = (value) => moneyJson(value, currency);
    const { assumptions } = result;
    return {
      currency,
      asOf: result.asOf,
      horizonDays: result.horizonDays,
      method: FORECAST_METHOD,
      startingCash: money(result.startingCashMinor),
      endingBalance: money(result.endingBalanceMinor),
      minimum: { balance: money(result.minimum.balanceMinor), date: result.minimum.date },
      runway: result.runway,
      belowZero: result.belowZero,
      confidence: result.confidence,
      series: result.series.map((point) => ({
        date: point.date, inflow: money(point.inflowMinor), outflow: money(point.outflowMinor), balance: money(point.balanceMinor), confidence: point.confidence,
      })),
      history: result.history,
      assumptions: {
        recurring: assumptions.recurring.map((pattern) => ({ ...pattern, amount: money(pattern.amountMinor), amountMinor: undefined })),
        lapsedPatterns: assumptions.lapsedPatterns,
        baseline: assumptions.baseline && {
          windowDays: assumptions.baseline.windowDays,
          ...Object.fromEntries(['income', 'expense'].map((type) => [type, {
            transactions: assumptions.baseline[type].transactions,
            total: money(assumptions.baseline[type].totalMinor),
            dailyAverage: money(assumptions.baseline[type].dailyAverageMinor),
          }])),
        },
        invoicesIncluded: assumptions.invoicesIncluded.map((invoice) => ({
          id: invoice.id, number: invoice.number, type: invoice.type, contact: invoice.contactName, dueDate: invoice.dueDate,
          expectedDate: invoice.expectedDate, total: money(invoice.totalMinor),
        })),
        invoicesExcluded: assumptions.invoicesExcluded.map((invoice) => ({
          id: invoice.id, number: invoice.number, type: invoice.type, contact: invoice.contactName, dueDate: invoice.dueDate,
          total: money(invoice.totalMinor), reason: invoice.reason,
        })),
        rules: assumptions.rules,
        lowHistoryNote: assumptions.lowHistoryNote,
      },
    };
  }

  function capability(result) {
    return {
      ...FORECAST_CAPABILITY,
      confidence: result.confidence,
      degraded: !result.history.sufficient,
      note: result.history.sufficient ? FORECAST_CAPABILITY.note : result.assumptions.lowHistoryNote,
    };
  }

  /** A fresh projection, not stored (used by the dashboard, insights and the assistant). */
  function project(companyId, horizonDays) {
    const { currency } = companies.getCompany(db, companyId);
    const input = inputs(companyId, todayIso());
    const result = projectCashFlow({ ...input, horizonDays });
    return { result, presented: present(result, currency), fingerprint: fingerprint(input, horizonDays) };
  }

  return {
    project,

    generate(companyId, { horizonDays }) {
      const { presented, fingerprint: print } = project(companyId, horizonDays);
      const id = newId('fct');
      const now = nowIsoTimestamp();
      intelligence.insertForecast(db, companyId, {
        id, asOf: presented.asOf, horizonDays, method: FORECAST_METHOD, result: { ...presented, fingerprint: print }, now,
      });
      if (presented.belowZero.crosses) {
        notifications.notify(companyId, {
          type: 'forecast_below_zero',
          severity: 'critical',
          title: 'Cash is projected to fall below zero',
          body: `The ${horizonDays}-day projection from ${presented.asOf} falls below zero on ${presented.belowZero.firstDate}.`,
          entityType: 'forecast',
          entityId: id,
          dedupeKey: `forecast_below_zero:${presented.asOf}:${presented.belowZero.firstDate}`,
        });
      }
      return { data: { id, ...presented, generatedAt: now, stale: false }, meta: { capability: capability(presented) } };
    },

    latest(companyId) {
      const stored = intelligence.latestForecast(db, companyId);
      if (!stored) throw notFound('No forecast has been generated yet. Generate one with POST /forecast.');
      const { fingerprint: print, ...presented } = stored.result;
      const current = fingerprint(inputs(companyId, todayIso()), stored.horizonDays);
      return {
        data: { id: stored.id, ...presented, generatedAt: stored.createdAt, stale: current !== print },
        meta: { capability: capability(presented) },
      };
    },

    methods(companyId) {
      const used = intelligence.listForecastMethods(db, companyId);
      return {
        data: {
          available: [{ method: 'deterministic', available: true, description: 'Balances, detected recurring patterns and unpaid invoice due dates.' }],
          unavailable: [
            { method: 'ai', reason: 'No AI forecasting provider exists in IFRSmart.' },
            { method: 'hybrid', reason: 'Requires an AI method.' },
          ],
          used: used.map((row) => ({ method: row.method, projections: row.count, latest: row.latest })),
        },
        meta: { capability: { ...FORECAST_CAPABILITY, confidence: null } },
      };
    },
  };
}
