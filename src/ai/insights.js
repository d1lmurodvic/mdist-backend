/**
 * Insight detection (PRODUCT_REQUIREMENTS.md #17; AI_CONTEXT.md §4.3): the
 * deterministic `InsightDetector`. Every finding is computed from figures the
 * financial engine produced, cites them, and names the records behind them.
 * Wording comes from fixed templates; no AI provider writes any text, and a
 * template can only print numbers that are in the finding's figures.
 *
 * Findings (thresholds are fixed):
 *   revenue_change          income moved ≥ 10% against the previous period
 *   expense_increase        expenses rose ≥ 10%
 *   category_concentration  one expense category is ≥ 40% of the period's
 *                           expenses, with at least two categories active
 *   margin_movement         net margin moved ≥ 5 percentage points
 *   overdue_receivables     unpaid receivables past their due date
 *   declining_cash          cash fell in this period and the previous one
 *   forecast_shortfall      the 30-day projection falls below zero
 * Confidence is 1 for findings that are exact calculations over stored
 * records; a forecast finding carries the projection's own confidence.
 */

import { formatMajor } from '../lib/money.js';

const pct = (bp) => `${(Math.abs(bp) / 100).toFixed(2)}%`;

/**
 * @param {object} input figures from the financial engine (BigInt minor units)
 */
export function detectInsights(input) {
  const { currency, period, previousPeriod, current, previous, changes, topExpenseCategory, topIncreaseCategory,
    concentration, margins, cash, overdue, forecast } = input;
  const fmt = (value) => `${formatMajor(value, currency)} ${currency}`;
  const periodRef = { ref: `period:${period.start}..${period.end}`, label: `Period ${period.start} to ${period.end} (end exclusive)` };
  const previousRef = { ref: `period:${previousPeriod.start}..${previousPeriod.end}`, label: `Previous period ${previousPeriod.start} to ${previousPeriod.end}` };
  const findings = [];

  if (changes.income !== null && Math.abs(changes.income) >= 1000) {
    const up = changes.income > 0;
    findings.push({
      key: 'revenue_change',
      type: 'revenue_change',
      severity: up ? 'info' : changes.income <= -2000 ? 'high' : 'medium',
      title: `Income ${up ? 'up' : 'down'} ${pct(changes.income)} on the previous period`,
      body: `Income was ${fmt(current.income)} against ${fmt(previous.income)} in the previous period.`,
      action: up ? 'Check which customers or categories drove the increase and whether it will repeat.' : 'Review which income sources fell and follow up on unpaid receivables.',
      figures: { income: current.income, previousIncome: previous.income, changeBasisPoints: changes.income },
      evidence: [periodRef, previousRef],
    });
  }

  if (changes.expense !== null && changes.expense >= 1000) {
    findings.push({
      key: 'expense_increase',
      type: 'expense_increase',
      severity: changes.expense >= 2500 ? 'high' : 'medium',
      title: `Expenses up ${pct(changes.expense)} on the previous period`,
      body: `Expenses were ${fmt(current.expense)} against ${fmt(previous.expense)}.${topIncreaseCategory ? ` The largest increase was in ${topIncreaseCategory.name} (+${fmt(topIncreaseCategory.increase)}).` : ''}`,
      action: 'Open the expense report to see which categories grew and whether the growth was planned.',
      figures: {
        expenses: current.expense, previousExpenses: previous.expense, changeBasisPoints: changes.expense,
        ...(topIncreaseCategory ? { largestIncreaseCategoryId: topIncreaseCategory.id, largestIncrease: topIncreaseCategory.increase } : {}),
      },
      evidence: [periodRef, previousRef, ...(topIncreaseCategory ? [{ ref: `category:${topIncreaseCategory.id}`, label: topIncreaseCategory.name }] : [])],
    });
  }

  if (concentration && concentration.shareBasisPoints >= 4000 && concentration.activeCategories >= 2) {
    findings.push({
      key: `category_concentration:${topExpenseCategory.id}`,
      type: 'category_concentration',
      severity: concentration.shareBasisPoints >= 6000 ? 'medium' : 'low',
      title: `${topExpenseCategory.name} is ${pct(concentration.shareBasisPoints)} of expenses`,
      body: `${topExpenseCategory.name} accounts for ${fmt(topExpenseCategory.total)} of ${fmt(current.expense)} spent in the period.`,
      action: `Review the largest ${topExpenseCategory.name} payments and whether they can be reduced or renegotiated.`,
      figures: { categoryId: topExpenseCategory.id, categoryTotal: topExpenseCategory.total, expenses: current.expense, shareBasisPoints: concentration.shareBasisPoints },
      evidence: [periodRef, { ref: `category:${topExpenseCategory.id}`, label: topExpenseCategory.name },
        ...concentration.transactions.map((txn) => ({ ref: `transaction:${txn.id}`, label: `${txn.payee ?? txn.description ?? 'Transaction'} — ${txn.date}` }))],
    });
  }

  if (margins.current !== null && margins.previous !== null && Math.abs(margins.current - margins.previous) >= 500) {
    const falling = margins.current < margins.previous;
    findings.push({
      key: 'margin_movement',
      type: 'margin_movement',
      severity: falling ? 'medium' : 'info',
      title: `Net margin ${falling ? 'fell' : 'rose'} from ${(margins.previous / 100).toFixed(2)}% to ${(margins.current / 100).toFixed(2)}%`,
      body: `Net result was ${fmt(current.net)} on income of ${fmt(current.income)}, against ${fmt(previous.net)} on ${fmt(previous.income)} before.`,
      action: falling ? 'Compare income and expense changes to see which one moved the margin.' : 'Check whether the improvement comes from higher income or lower costs.',
      figures: { netMarginBasisPoints: margins.current, previousNetMarginBasisPoints: margins.previous, netResult: current.net, previousNetResult: previous.net },
      evidence: [periodRef, previousRef],
    });
  }

  if (overdue.count > 0) {
    findings.push({
      key: 'overdue_receivables',
      type: 'overdue_receivables',
      severity: overdue.count >= 3 ? 'high' : 'medium',
      title: `${overdue.count} receivable invoice${overdue.count === 1 ? ' is' : 's are'} overdue`,
      body: `${fmt(overdue.total)} owed to you is past its due date.`,
      action: 'Follow up with these customers; overdue receivables are left out of the cash forecast.',
      figures: { overdueCount: overdue.count, overdueTotal: overdue.total },
      evidence: overdue.invoices.map((invoice) => ({ ref: `invoice:${invoice.id}`, label: `${invoice.number} — ${invoice.contactName}, due ${invoice.dueDate}` })),
    });
  }

  if (cash.hasActivity && cash.closing < cash.opening && cash.previousClosing < cash.previousOpening) {
    findings.push({
      key: 'declining_cash',
      type: 'declining_cash',
      severity: 'medium',
      title: 'Cash has fallen two periods in a row',
      body: `Cash went from ${fmt(cash.previousOpening)} to ${fmt(cash.previousClosing)} in the previous period and from ${fmt(cash.opening)} to ${fmt(cash.closing)} in this one.`,
      action: 'Check the cash-flow forecast and upcoming payables.',
      figures: { openingCash: cash.opening, closingCash: cash.closing, previousOpeningCash: cash.previousOpening, previousClosingCash: cash.previousClosing },
      evidence: [periodRef, previousRef],
    });
  }

  if (forecast && forecast.belowZero.crosses) {
    findings.push({
      key: 'forecast_shortfall',
      type: 'forecast_shortfall',
      severity: 'high',
      title: `Cash is projected to go below zero on ${forecast.belowZero.firstDate}`,
      body: `The 30-day projection reaches its minimum of ${fmt(forecast.minimum.balanceMinor)} on ${forecast.minimum.date}.`,
      action: 'Open the forecast to see which payments cause the shortfall and consider collecting receivables earlier.',
      figures: { minimumBalance: forecast.minimum.balanceMinor, minimumDate: forecast.minimum.date, firstBelowZero: forecast.belowZero.firstDate },
      evidence: [{ ref: `forecast:30d:${forecast.asOf}`, label: `30-day projection as of ${forecast.asOf}` }],
      confidence: forecast.confidence,
      method: 'statistics',
    });
  }

  return findings.map((finding) => ({ method: 'rule', confidence: 1, ...finding }));
}
