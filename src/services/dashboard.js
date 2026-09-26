/**
 * Dashboard (PRODUCT_REQUIREMENTS.md #4; API_CONTRACT.md §9.4): an aggregation
 * of existing services. It introduces no financial logic: every figure comes
 * from the financial engine or from the insight, anomaly, forecast and health
 * services, and every card carries the link to the screen that explains it.
 */

import { addDays, todayIso } from '../lib/dates.js';
import { changeBasisPoints, moneyJson } from '../lib/money.js';
import * as analytics from '../models/analytics.js';
import * as companies from '../models/companies.js';
import { resolveCompanyPeriod } from './periodQuery.js';
import { INSIGHTS_CAPABILITY } from './insights.js';

export const MAX_ACTIVITY_ITEMS = 50;

const ACTIVITY_PATHS = Object.freeze({
  transaction: (id) => `/api/v1/transactions/${id}`,
  invoice: (id) => `/api/v1/invoices/${id}`,
  document: (id) => `/api/v1/documents/${id}`,
});

export function createDashboardService({ db, engine, insights, anomalies, forecasts, health }) {
  return {
    dashboard(companyId, query) {
      const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
      const { currency } = company;
      const money = (value) => moneyJson(value, currency);
      const today = todayIso();
      const current = engine.periodTotals(companyId, period);
      const previous = engine.periodTotals(companyId, previousPeriod);
      const figure = (now, before) => ({
        amount: money(now), previous: money(before), change: { amount: money(now - before), basisPoints: changeBasisPoints(now, before) },
      });
      const outstanding = engine.outstandingInvoices(companyId, { today });
      const invoiceCard = (figures) => ({
        count: figures.count, total: money(figures.total), overdueCount: figures.overdueCount, overdueTotal: money(figures.overdueTotal),
      });
      const counts = analytics.companyRecordCounts(db, companyId);
      const projection = forecasts.project(companyId, 30).presented;
      const healthResult = health.compute(companyId, query);

      return {
        data: {
          company: { id: company.id, name: company.name, currency, isDemo: company.isDemo },
          period,
          previousPeriod,
          // Nothing recorded yet: the client shows a next step, not zeros as facts.
          empty: counts.accounts === 0 && counts.transactions === 0 && counts.invoices === 0,
          emptyState: {
            hasAccounts: counts.accounts > 0,
            hasTransactions: counts.transactions > 0,
            hasInvoices: counts.invoices > 0,
            periodHasTransactions: current.transactionCount > 0,
          },
          cash: {
            current: money(engine.cashBalance(companyId, { before: addDays(today, 1) })),
            asOf: today,
            opening: money(engine.cashBalance(companyId, { before: period.start })),
            closing: money(engine.cashBalance(companyId, { before: period.end })),
            link: '/api/v1/financials/cash-flow',
          },
          income: { ...figure(current.income, previous.income), link: '/api/v1/financials/revenue-vs-expenses' },
          expenses: { ...figure(current.expense, previous.expense), link: '/api/v1/financials/expense-report' },
          netResult: { ...figure(current.net, previous.net), link: '/api/v1/reports/profit-and-loss' },
          transactionCount: current.transactionCount,
          outstandingInvoices: {
            asOf: today,
            receivable: invoiceCard(outstanding.receivable),
            payable: invoiceCard(outstanding.payable),
            link: '/api/v1/invoices?status=sent&status=overdue',
          },
          insights: {
            items: insights.preview(companyId, query, { limit: 3 }),
            capability: INSIGHTS_CAPABILITY,
            link: '/api/v1/ai/insights',
          },
          anomalies: { ...anomalies.openSummary(companyId, { limit: 3 }), link: '/api/v1/ai/anomalies?status=open' },
          forecast: {
            horizonDays: 30,
            asOf: projection.asOf,
            endingBalance: projection.endingBalance,
            minimum: projection.minimum,
            runway: projection.runway,
            belowZero: projection.belowZero,
            confidence: projection.confidence,
            historySufficient: projection.history.sufficient,
            note: projection.assumptions.lowHistoryNote,
            link: '/api/v1/forecast/latest',
          },
          health: {
            status: healthResult.overall.status,
            score: healthResult.overall.score,
            componentsUsed: healthResult.overall.componentsUsed,
            componentsExcluded: healthResult.overall.componentsExcluded,
            link: '/api/v1/financials/health',
          },
        },
        meta: {
          period,
          capabilities: {
            figures: { method: 'rule', note: 'Calculated from your records by the financial engine.' },
            insights: INSIGHTS_CAPABILITY,
            anomalies: { method: 'statistics' },
            forecast: { method: 'statistics', confidence: projection.confidence, note: 'Deterministic 30-day projection, not an AI prediction.' },
            health: { method: 'rule', note: 'Estimate from fixed thresholds.' },
          },
        },
      };
    },

    activity(companyId, { limit }) {
      const { currency } = companies.getCompany(db, companyId);
      return analytics.recentActivity(db, companyId, { limit }).map((row) => ({
        kind: row.kind,
        at: row.at,
        label: row.label,
        detail: row.detail,
        amount: row.amount_minor === null ? null : moneyJson(BigInt(row.amount_minor), currency),
        entity: { type: row.entity_type, id: row.entity_id, path: ACTIVITY_PATHS[row.entity_type](row.entity_id) },
      }));
    },
  };
}
