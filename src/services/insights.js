/**
 * AI financial insights (PRODUCT_REQUIREMENTS.md #17; API_CONTRACT.md §9.10).
 *
 * Findings come from ai/insights.js over financial-engine figures. Generation
 * is idempotent per period: unchanged data updates the same rows, a dismissal
 * survives regeneration, and findings that no longer hold are removed.
 * No AI provider writes insight text (no narrator adapter exists), and the
 * capability metadata says so.
 */

import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIsoTimestamp, todayIso } from '../lib/dates.js';
import { changeBasisPoints, moneyJson } from '../lib/money.js';
import { shareBasisPoints } from '../lib/ratios.js';
import * as analytics from '../models/analytics.js';
import * as categories from '../models/categories.js';
import * as intelligence from '../models/intelligence.js';
import { detectInsights } from '../ai/insights.js';
import { resolveCompanyPeriod } from './periodQuery.js';

export const INSIGHTS_CAPABILITY = Object.freeze({
  method: 'rule',
  confidence: null,
  degraded: true,
  note: 'Insights are calculated from your records with fixed rules. AI narrative generation is unavailable: no AI provider is configured for it, so the text comes from fixed templates.',
});

export function createInsightService({ db, engine, forecasts }) {
  function findings(companyId, query) {
    const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
    const { currency } = company;
    const today = todayIso();
    const current = engine.periodTotals(companyId, period);
    const previous = engine.periodTotals(companyId, previousPeriod);
    const names = new Map(categories.listCategories(db, companyId).map((category) => [category.id, category.name]));

    const expenseRows = (rows) => new Map(rows.filter((row) => row.type === 'expense').map((row) => [row.categoryId, row.total]));
    const currentExpenses = expenseRows(engine.categoryTotals(companyId, period));
    const previousExpenses = expenseRows(engine.categoryTotals(companyId, previousPeriod));

    let topExpenseCategory = null;
    for (const [id, total] of currentExpenses) {
      if (!topExpenseCategory || total > topExpenseCategory.total) topExpenseCategory = { id, name: names.get(id), total };
    }
    let topIncreaseCategory = null;
    for (const [id, total] of currentExpenses) {
      const increase = total - (previousExpenses.get(id) ?? 0n);
      if (increase > 0n && (!topIncreaseCategory || increase > topIncreaseCategory.increase)) topIncreaseCategory = { id, name: names.get(id), increase };
    }
    const concentration = topExpenseCategory && current.expense > 0n
      ? {
        shareBasisPoints: shareBasisPoints(topExpenseCategory.total, current.expense),
        activeCategories: currentExpenses.size,
        transactions: analytics.largestTransactions(db, companyId, { ...period, type: 'expense', categoryId: topExpenseCategory.id, limit: 3 }),
      }
      : null;

    const outstanding = engine.outstandingInvoices(companyId, { today }).receivable;
    const overdueInvoices = analytics.unpaidInvoices(db, companyId)
      .filter((invoice) => invoice.type === 'receivable' && invoice.dueDate < today).slice(0, 10);
    const includesToday = period.start <= today && today < period.end;

    const detected = detectInsights({
      currency,
      period,
      previousPeriod,
      current,
      previous,
      changes: { income: changeBasisPoints(current.income, previous.income), expense: changeBasisPoints(current.expense, previous.expense) },
      topExpenseCategory,
      topIncreaseCategory,
      concentration,
      margins: {
        current: current.income > 0n ? shareBasisPoints(current.net, current.income) : null,
        previous: previous.income > 0n ? shareBasisPoints(previous.net, previous.income) : null,
      },
      cash: {
        hasActivity: current.transactionCount > 0,
        opening: engine.cashBalance(companyId, { before: period.start }),
        closing: engine.cashBalance(companyId, { before: period.end }),
        previousOpening: engine.cashBalance(companyId, { before: previousPeriod.start }),
        previousClosing: engine.cashBalance(companyId, { before: previousPeriod.end }),
      },
      overdue: { count: outstanding.overdueCount, total: outstanding.overdueTotal, invoices: overdueInvoices },
      // The projection is about the future, so it only informs the period containing today.
      forecast: includesToday ? forecasts.project(companyId, 30).result : null,
    });

    // Money figures leave in the wire form; plain numbers and dates stay as they are.
    const presented = detected.map((finding) => ({
      ...finding,
      figures: Object.fromEntries(Object.entries(finding.figures).map(([key, value]) => [key, typeof value === 'bigint' ? moneyJson(value, currency) : value])),
    }));
    return { period, findings: presented };
  }

  function present(insight) {
    return {
      id: insight.id,
      type: insight.type,
      severity: insight.severity,
      title: insight.title,
      body: insight.body,
      action: insight.action,
      method: insight.method,
      confidence: insight.confidence,
      figures: insight.figures,
      evidence: insight.evidence,
      period: { start: insight.periodStart, end: insight.periodEnd },
      dismissed: insight.dismissedAt !== null,
      dismissedAt: insight.dismissedAt,
      createdAt: insight.createdAt,
      updatedAt: insight.updatedAt,
    };
  }

  return {
    generate(companyId, query) {
      const { period, findings: list } = findings(companyId, query);
      db.transaction(() => intelligence.replaceInsights(db, companyId, period, list, { newId: () => newId('ins'), now: nowIsoTimestamp() }));
      const stored = intelligence.listInsights(db, companyId, { ...period, includeDismissed: true });
      return { data: stored.map(present), meta: { period, generated: true, capability: INSIGHTS_CAPABILITY } };
    },

    list(companyId, query) {
      const { period } = resolveCompanyPeriod(db, companyId, query);
      const stored = intelligence.listInsights(db, companyId, { ...period, includeDismissed: query.includeDismissed === true });
      return { data: stored.map(present), meta: { period, capability: INSIGHTS_CAPABILITY } };
    },

    /** Fresh findings for a period without storing them, minus those dismissed before. */
    preview(companyId, query, { limit }) {
      const { period, findings: list } = findings(companyId, query);
      const dismissed = new Set(intelligence.listInsights(db, companyId, { ...period, includeDismissed: true })
        .filter((insight) => insight.dismissedAt).map((insight) => insight.key));
      return list.filter((finding) => !dismissed.has(finding.key)).slice(0, limit)
        .map(({ key, ...finding }) => ({ ...finding, period: { start: period.start, end: period.end } }));
    },

    dismiss(companyId, insightId) {
      if (!intelligence.findInsight(db, companyId, insightId)) throw notFound('Insight not found.');
      intelligence.dismissInsight(db, companyId, insightId, nowIsoTimestamp());
      return { data: present(intelligence.findInsight(db, companyId, insightId)), meta: { capability: INSIGHTS_CAPABILITY } };
    },
  };
}
