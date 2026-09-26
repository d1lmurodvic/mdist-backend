/**
 * Deterministic cash-flow projection (PRODUCT_REQUIREMENTS.md #19,
 * AI_CONTEXT.md §4.5). No model and no randomness: the same inputs always give
 * the same projection, and every assumption is returned with it.
 *
 * Method, stated once:
 *   start      = current cash (cash + bank balances, today included);
 *   recurring  = counterparties seen at least 3 times in the last 180 days at a
 *                steady weekly (6–8 days) or monthly (25–35 days) interval with
 *                stable amounts (largest ≤ 1.5 × smallest); projected at the
 *                median amount on the same cadence. A pattern whose next
 *                occurrence is more than 7 days overdue is treated as lapsed;
 *   baseline   = other (non-recurring) income and expenses of the last 90
 *                days, each spread evenly per day in exact integer steps;
 *   invoices   = unpaid receivables on their due date; unpaid payables on their
 *                due date, or tomorrow when already due. Overdue receivables
 *                are excluded (their collection date is unknown);
 *   history    = at least 60 days since the first transaction and 10
 *                transactions; otherwise only balances and invoice due dates
 *                are used, and the projection says so.
 * Confidence  = base × (1 − daysAhead / 180): base 0.9 with enough history,
 *               0.6 without. It is a fixed, documented decay, not a model score.
 * All money is BigInt minor units.
 */

import { addDays, daysBetween } from '../lib/dates.js';

export const FORECAST_HORIZONS = Object.freeze([30, 60, 90]);
export const FORECAST_METHOD = 'deterministic';
const HISTORY_DAYS = 180;
const BASELINE_DAYS = 90;
const MIN_HISTORY_DAYS = 60;
const MIN_HISTORY_TRANSACTIONS = 10;
const LAPSE_DAYS = 7;

export const FORECAST_WINDOWS = Object.freeze({ historyDays: HISTORY_DAYS, baselineDays: BASELINE_DAYS });

function median(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The lower middle for an even count: an amount that actually occurred.
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function cadenceOf(dates) {
  const gaps = [];
  for (let i = 1; i < dates.length; i += 1) gaps.push(daysBetween(dates[i - 1], dates[i]));
  if (gaps.every((gap) => gap >= 25 && gap <= 35)) return { cadence: 'monthly', intervalDays: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) };
  if (gaps.every((gap) => gap >= 6 && gap <= 8)) return { cadence: 'weekly', intervalDays: 7 };
  return null;
}

/** Recurring counterparties in `history` (transactions of the last HISTORY_DAYS). */
export function detectRecurring(history) {
  const groups = new Map();
  for (const txn of history) {
    if (!txn.counterpartyKey) continue;
    const key = `${txn.type}|${txn.counterpartyKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(txn);
  }
  const patterns = [];
  for (const [key, txns] of groups) {
    if (txns.length < 3) continue;
    const ordered = [...txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const cadence = cadenceOf(ordered.map((txn) => txn.date));
    if (!cadence) continue;
    const amounts = ordered.map((txn) => txn.amountMinor);
    const smallest = amounts.reduce((a, b) => (b < a ? b : a));
    const largest = amounts.reduce((a, b) => (b > a ? b : a));
    if (largest * 2n > smallest * 3n) continue;
    const last = ordered[ordered.length - 1];
    patterns.push({
      key,
      type: last.type,
      counterparty: last.payee ?? last.description ?? last.counterpartyKey,
      cadence: cadence.cadence,
      intervalDays: cadence.intervalDays,
      amountMinor: median(amounts),
      occurrences: ordered.length,
      lastDate: last.date,
      transactionIds: ordered.map((txn) => txn.id),
    });
  }
  return patterns.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/**
 * @param {{ today: string, horizonDays: number, currentCash: bigint,
 *   history: Array, firstTransactionDate: string|null, unpaidInvoices: Array }} input
 */
export function projectCashFlow({ today, horizonDays, currentCash, history, firstTransactionDate, unpaidInvoices }) {
  const tomorrow = addDays(today, 1);
  const lastDay = addDays(today, horizonDays);
  const historyDays = firstTransactionDate ? daysBetween(firstTransactionDate, tomorrow) : 0;
  const sufficientHistory = historyDays >= MIN_HISTORY_DAYS && history.length >= MIN_HISTORY_TRANSACTIONS;

  const inflow = new Map();
  const outflow = new Map();
  const book = (map, date, amount) => map.set(date, (map.get(date) ?? 0n) + amount);

  const recurring = [];
  const lapsed = [];
  const recurringIds = new Set();
  if (sufficientHistory) {
    for (const pattern of detectRecurring(history)) {
      let next = addDays(pattern.lastDate, pattern.intervalDays);
      if (daysBetween(next, today) > LAPSE_DAYS) {
        lapsed.push({ counterparty: pattern.counterparty, type: pattern.type, cadence: pattern.cadence, lastDate: pattern.lastDate });
        continue;
      }
      for (const id of pattern.transactionIds) recurringIds.add(id);
      // Due but not seen yet (within the lapse window): expected tomorrow.
      if (next < tomorrow) next = tomorrow;
      const dates = [];
      while (next <= lastDay) {
        dates.push(next);
        book(pattern.type === 'income' ? inflow : outflow, next, pattern.amountMinor);
        next = addDays(next, pattern.intervalDays);
      }
      recurring.push({
        counterparty: pattern.counterparty,
        type: pattern.type,
        cadence: pattern.cadence,
        amountMinor: pattern.amountMinor,
        basedOnTransactions: pattern.occurrences,
        lastDate: pattern.lastDate,
        projectedDates: dates,
      });
    }
  }

  let baseline = null;
  if (sufficientHistory) {
    const windowStart = addDays(tomorrow, -BASELINE_DAYS);
    const windowDays = Math.min(BASELINE_DAYS, historyDays);
    const days = BigInt(windowDays);
    baseline = { windowDays };
    for (const type of ['income', 'expense']) {
      let total = 0n;
      let count = 0;
      for (const txn of history) {
        if (txn.type !== type || recurringIds.has(txn.id) || txn.date < windowStart) continue;
        total += txn.amountMinor;
        count += 1;
      }
      // Exact spread: day d carries floor(total·d/W) − floor(total·(d−1)/W).
      for (let d = 1; d <= horizonDays && total > 0n; d += 1) {
        const amount = (total * BigInt(d)) / days - (total * BigInt(d - 1)) / days;
        if (amount > 0n) book(type === 'income' ? inflow : outflow, addDays(today, d), amount);
      }
      baseline[type] = { transactions: count, totalMinor: total, dailyAverageMinor: total / days };
    }
  }

  const invoicesIncluded = [];
  const invoicesExcluded = [];
  for (const invoice of unpaidInvoices) {
    const overdue = invoice.dueDate < today;
    if (invoice.type === 'receivable' && overdue) {
      invoicesExcluded.push({ ...invoice, reason: 'overdue_receivable' });
      continue;
    }
    const date = invoice.dueDate < tomorrow ? tomorrow : invoice.dueDate;
    if (date > lastDay) {
      invoicesExcluded.push({ ...invoice, reason: 'due_after_horizon' });
      continue;
    }
    book(invoice.type === 'receivable' ? inflow : outflow, date, invoice.totalMinor);
    invoicesIncluded.push({ ...invoice, expectedDate: date });
  }

  const base = sufficientHistory ? 0.9 : 0.6;
  const confidenceAt = (daysAhead) => Math.round(base * (1 - daysAhead / 180) * 1000) / 1000;
  let balance = currentCash;
  let minimum = { balanceMinor: currentCash, date: today };
  let firstBelowZero = currentCash < 0n ? today : null;
  const series = [];
  for (let d = 1; d <= horizonDays; d += 1) {
    const date = addDays(today, d);
    const dayIn = inflow.get(date) ?? 0n;
    const dayOut = outflow.get(date) ?? 0n;
    balance += dayIn - dayOut;
    if (balance < minimum.balanceMinor) minimum = { balanceMinor: balance, date };
    if (balance < 0n && firstBelowZero === null) firstBelowZero = date;
    series.push({ date, inflowMinor: dayIn, outflowMinor: dayOut, balanceMinor: balance, confidence: confidenceAt(d) });
  }

  return {
    asOf: today,
    horizonDays,
    startingCashMinor: currentCash,
    endingBalanceMinor: balance,
    minimum,
    runway: firstBelowZero === null
      ? { days: null, beyondHorizon: true }
      : { days: daysBetween(today, firstBelowZero), beyondHorizon: false, date: firstBelowZero },
    belowZero: { crosses: firstBelowZero !== null, firstDate: firstBelowZero },
    confidence: confidenceAt(horizonDays),
    series,
    history: { sufficient: sufficientHistory, days: historyDays, transactions: history.length, firstTransactionDate },
    assumptions: {
      recurring,
      lapsedPatterns: lapsed,
      baseline,
      invoicesIncluded,
      invoicesExcluded,
      rules: [
        'Starts from current cash: the balance of cash and bank accounts, today included.',
        'Recurring income and expenses: counterparties seen at least 3 times in the last 180 days on a steady weekly or monthly cadence with stable amounts, projected at their median amount.',
        'Other (non-recurring) income and expenses of the last 90 days are each spread evenly per day.',
        'Unpaid receivables arrive on their due date; overdue receivables are excluded. Unpaid payables are paid on their due date, or tomorrow when already due.',
        'Draft and cancelled invoices are excluded.',
        'Confidence falls with distance: base × (1 − days ahead / 180), base 0.9 with at least 60 days and 10 transactions of history, otherwise 0.6.',
      ],
      lowHistoryNote: sufficientHistory ? null
        : 'Not enough history for patterns (needs 60 days and 10 transactions): only current cash and invoice due dates are projected.',
    },
  };
}
