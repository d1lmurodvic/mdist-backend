/**
 * Financial health (PRODUCT_REQUIREMENTS.md #21; API_CONTRACT.md §9.5).
 *
 * A transparent aggregation of five fixed components, each measured from the
 * financial engine against a stated threshold. A component without enough data
 * is marked unavailable and left out of the overall indicator, visibly; no
 * score is guessed. The indicator is an estimate, not an assessment or audit.
 *
 * Component scores: good = 100, fair = 60, poor = 20. Overall = the rounded
 * mean of the available component scores (equal weights):
 * ≥ 80 healthy, ≥ 50 fair, otherwise at_risk.
 */

import { addMonths, addDays, startOfMonth, todayIso } from '../lib/dates.js';
import { changeBasisPoints, moneyJson } from '../lib/money.js';
import { shareBasisPoints } from '../lib/ratios.js';
import { resolveCompanyPeriod } from './periodQuery.js';

export const HEALTH_SCORES = Object.freeze({ good: 100, fair: 60, poor: 20 });
export const HEALTH_DISCLAIMER = 'An estimate from your own records, not an assessment or audit.';

const grade = (status) => ({ status, score: HEALTH_SCORES[status] });

export function createHealthService({ db, engine }) {
  function compute(companyId, query) {
    const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
    const { currency } = company;
    const money = (value) => moneyJson(value, currency);
    const today = todayIso();
    const current = engine.periodTotals(companyId, period);
    const previous = engine.periodTotals(companyId, previousPeriod);
    const components = [];

    // 1. Cash position: months of cash at the average monthly spend of the last three full months.
    const cash = engine.cashBalance(companyId, { before: addDays(today, 1) });
    const trailing = { start: addMonths(startOfMonth(today), -3), end: startOfMonth(today) };
    const trailingExpense = engine.periodTotals(companyId, trailing).expense;
    if (trailingExpense > 0n) {
      const runwayMonthsX100 = Number((cash * 300n) / trailingExpense);
      const status = cash < 0n ? 'poor' : runwayMonthsX100 >= 600 ? 'good' : runwayMonthsX100 >= 300 ? 'fair' : 'poor';
      components.push({
        id: 'cash_position', label: 'Cash position', available: true, ...grade(status),
        value: { runwayMonths: runwayMonthsX100 / 100, cash: money(cash), averageMonthlyExpenses: money(trailingExpense / 3n) },
        thresholds: { good: '≥ 6 months of expenses in cash', fair: '≥ 3 months', poor: 'less than 3 months, or negative cash' },
        basis: { averageOver: trailing, asOf: today },
        link: '/api/v1/financials/cash-flow',
      });
    } else {
      components.push({ id: 'cash_position', label: 'Cash position', available: false, reason: 'No expenses in the last three full months, so months of cash cannot be measured.', link: '/api/v1/financials/cash-flow' });
    }

    // 2. Profitability: net margin of the period.
    if (current.income > 0n) {
      const margin = shareBasisPoints(current.net, current.income);
      components.push({
        id: 'profitability', label: 'Profitability', available: true, ...grade(margin >= 1000 ? 'good' : margin >= 0 ? 'fair' : 'poor'),
        value: { netMarginBasisPoints: margin, netResult: money(current.net), income: money(current.income) },
        thresholds: { good: 'net margin ≥ 10%', fair: '0% to 10%', poor: 'a loss' },
        basis: { period },
        link: '/api/v1/reports/profit-and-loss',
      });
    } else {
      components.push({ id: 'profitability', label: 'Profitability', available: false, reason: 'No income in the period, so a margin cannot be measured.', link: '/api/v1/reports/profit-and-loss' });
    }

    // 3. Revenue trend: income against the previous period.
    if (previous.income > 0n) {
      const change = changeBasisPoints(current.income, previous.income);
      components.push({
        id: 'revenue_trend', label: 'Revenue trend', available: true, ...grade(change >= 500 ? 'good' : change >= -500 ? 'fair' : 'poor'),
        value: { changeBasisPoints: change, income: money(current.income), previousIncome: money(previous.income) },
        thresholds: { good: 'income up ≥ 5%', fair: 'within ±5%', poor: 'down more than 5%' },
        basis: { period, previousPeriod },
        link: '/api/v1/financials/revenue-vs-expenses',
      });
    } else {
      components.push({ id: 'revenue_trend', label: 'Revenue trend', available: false, reason: 'No income in the previous period to compare with.', link: '/api/v1/financials/revenue-vs-expenses' });
    }

    // 4. Expense control: expenses against the previous period.
    if (previous.expense > 0n) {
      const change = changeBasisPoints(current.expense, previous.expense);
      components.push({
        id: 'expense_control', label: 'Expense control', available: true, ...grade(change <= 500 ? 'good' : change <= 2000 ? 'fair' : 'poor'),
        value: { changeBasisPoints: change, expenses: money(current.expense), previousExpenses: money(previous.expense) },
        thresholds: { good: 'expenses up ≤ 5% (or down)', fair: 'up 5% to 20%', poor: 'up more than 20%' },
        basis: { period, previousPeriod },
        link: '/api/v1/financials/expense-report',
      });
    } else {
      components.push({ id: 'expense_control', label: 'Expense control', available: false, reason: 'No expenses in the previous period to compare with.', link: '/api/v1/financials/expense-report' });
    }

    // 5. Invoice collection: share of unpaid receivables that is overdue.
    const outstanding = engine.outstandingInvoices(companyId, { today }).receivable;
    if (outstanding.total > 0n) {
      const overdueShare = shareBasisPoints(outstanding.overdueTotal, outstanding.total);
      components.push({
        id: 'invoice_collection', label: 'Invoice collection', available: true,
        ...grade(overdueShare <= 1000 ? 'good' : overdueShare <= 3000 ? 'fair' : 'poor'),
        value: { overdueShareBasisPoints: overdueShare, outstanding: money(outstanding.total), overdue: money(outstanding.overdueTotal), overdueCount: outstanding.overdueCount },
        thresholds: { good: '≤ 10% of unpaid receivables overdue', fair: '10% to 30%', poor: 'more than 30%' },
        basis: { asOf: today },
        link: '/api/v1/invoices?type=receivable&status=overdue',
      });
    } else {
      components.push({ id: 'invoice_collection', label: 'Invoice collection', available: false, reason: 'No unpaid receivables to measure collection on.', link: '/api/v1/invoices?type=receivable' });
    }

    const available = components.filter((component) => component.available);
    const weight = available.length ? Math.round(10000 / available.length) / 100 : null;
    for (const component of components) component.weightPercent = component.available ? weight : 0;
    const overallScore = available.length
      ? Math.round(available.reduce((total, component) => total + component.score, 0) / available.length)
      : null;
    const overall = overallScore === null
      ? { status: 'insufficient_data', score: null }
      : { status: overallScore >= 80 ? 'healthy' : overallScore >= 50 ? 'fair' : 'at_risk', score: overallScore };

    return {
      company,
      period,
      previousPeriod,
      overall: { ...overall, componentsUsed: available.length, componentsExcluded: components.filter((c) => !c.available).map((c) => c.id) },
      components,
    };
  }

  return {
    compute,
    health(companyId, query) {
      const { period, previousPeriod, overall, components, company } = compute(companyId, query);
      return {
        data: { currency: company.currency, period, previousPeriod, overall, components, disclaimer: HEALTH_DISCLAIMER },
        meta: {
          period,
          capability: {
            method: 'rule',
            confidence: null,
            degraded: overall.status === 'insufficient_data',
            note: 'Fixed thresholds over your own figures; unavailable components are excluded, not guessed.',
          },
        },
      };
    },
  };
}
