/**
 * Unusual transaction detection (PRODUCT_REQUIREMENTS.md #18, AI_CONTEXT.md
 * §4.4). Deterministic rules and robust statistics over the company's own
 * history. Every flag names its rule and the comparison it used; nothing is
 * changed, merged or deleted.
 *
 * Rules:
 *   amount_outlier     robust z-score 0.6745·(x − median)/MAD ≥ 3.5 against at
 *                      least 6 earlier transactions of the same type and
 *                      category (high at ≥ 7). Only unusually HIGH amounts.
 *   first_time_payee   an expense to a counterparty never seen before, at or
 *                      above the median expense, once the company has at least
 *                      20 earlier transactions over at least 60 days.
 *   possible_duplicate same type, amount and counterparty within 3 days of
 *                      another transaction; the later one is flagged and linked.
 *   large_expense      one expense ≥ 30% of the period's expenses, when the
 *                      period has at least 5 expenses (high at ≥ 50%) — unless
 *                      it is a usual payment: at least 2 earlier expenses to
 *                      the same counterparty of at least 80% of its amount
 *                      (a regular salary or rent is not unusual).
 * With too little history the history-based rules do not run, and the result
 * says so instead of producing flags.
 */

import { daysBetween } from '../lib/dates.js';
import { divideRoundHalfAway } from '../lib/ratios.js';

export const ANOMALY_RULES = Object.freeze(['amount_outlier', 'first_time_payee', 'possible_duplicate', 'large_expense']);
export const MIN_PEERS = 6;
export const OUTLIER_THRESHOLD = 3.5;
export const MIN_HISTORY_TRANSACTIONS = 20;
export const MIN_HISTORY_DAYS = 60;
export const DUPLICATE_WINDOW_DAYS = 3;
export const LARGE_SHARE_BP = 3000;
export const MIN_PERIOD_EXPENSES = 5;

function medianBig(values) {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

const earlier = (a, b) => a.date < b.date || (a.date === b.date && (a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)));

/**
 * @param {{ targets: Array, history: Array, period: {start: string, end: string}, periodExpenseTotal: bigint }} input
 *   targets: transactions in the detection period; history: transactions from
 *   up to a year before the period through its end (targets included);
 *   periodExpenseTotal: the period's expense total from the financial engine.
 */
export function detectAnomalies({ targets, history, period, periodExpenseTotal }) {
  const findings = [];
  const beforePeriod = history.filter((txn) => txn.date < period.start);
  const firstDate = history.length ? history[0].date : null;
  const historyDays = firstDate ? daysBetween(firstDate, period.start) : 0;
  const sufficientHistory = beforePeriod.length >= MIN_HISTORY_TRANSACTIONS && historyDays >= MIN_HISTORY_DAYS;

  const periodExpenses = targets.filter((txn) => txn.type === 'expense');

  for (const txn of targets) {
    const prior = history.filter((other) => other.id !== txn.id && earlier(other, txn));

    if (sufficientHistory) {
      const peers = prior.filter((other) => other.type === txn.type && other.categoryId === txn.categoryId);
      if (peers.length >= MIN_PEERS) {
        const med = medianBig(peers.map((other) => other.amountMinor));
        const mad = medianBig(peers.map((other) => (other.amountMinor > med ? other.amountMinor - med : med - other.amountMinor)));
        if (mad > 0n && txn.amountMinor > med) {
          const z = (0.6745 * Number(txn.amountMinor - med)) / Number(mad);
          if (z >= OUTLIER_THRESHOLD) {
            findings.push({
              transactionId: txn.id,
              ruleId: 'amount_outlier',
              severity: z >= OUTLIER_THRESHOLD * 2 ? 'high' : 'medium',
              score: Math.round(z * 100) / 100,
              explanation: `This ${txn.type} is far above the usual amount for its category: robust z-score ${(Math.round(z * 100) / 100).toFixed(2)} against ${peers.length} earlier transactions (threshold ${OUTLIER_THRESHOLD}).`,
              comparison: { peerCount: peers.length, medianMinor: med, madMinor: mad, robustZ: Math.round(z * 100) / 100, threshold: OUTLIER_THRESHOLD, scope: 'same type and category, earlier transactions' },
            });
          }
        }
      }

      if (txn.type === 'expense' && txn.counterpartyKey && !prior.some((other) => other.counterpartyKey === txn.counterpartyKey)) {
        const expenseAmounts = prior.filter((other) => other.type === 'expense').map((other) => other.amountMinor);
        if (expenseAmounts.length > 0) {
          const med = medianBig(expenseAmounts);
          if (txn.amountMinor >= med) {
            findings.push({
              transactionId: txn.id,
              ruleId: 'first_time_payee',
              severity: 'low',
              score: 1,
              explanation: `First payment to "${txn.payee ?? txn.description}", at or above the median expense of ${expenseAmounts.length} earlier expenses.`,
              comparison: { earlierTransactions: prior.length, medianExpenseMinor: med },
            });
          }
        }
      }
    }

    if (txn.counterpartyKey) {
      const twin = history.find((other) => other.id !== txn.id && earlier(other, txn)
        && other.type === txn.type && other.amountMinor === txn.amountMinor && other.counterpartyKey === txn.counterpartyKey
        && Math.abs(daysBetween(other.date, txn.date)) <= DUPLICATE_WINDOW_DAYS);
      if (twin) {
        findings.push({
          transactionId: txn.id,
          relatedTransactionId: twin.id,
          ruleId: 'possible_duplicate',
          severity: 'medium',
          score: 1,
          explanation: `Same type, amount and counterparty as a transaction on ${twin.date} (within ${DUPLICATE_WINDOW_DAYS} days). Nothing was merged or deleted.`,
          comparison: { relatedDate: twin.date, windowDays: DUPLICATE_WINDOW_DAYS },
        });
      }
    }

    const usualPayment = txn.counterpartyKey !== null && prior.filter((other) => other.type === 'expense'
      && other.counterpartyKey === txn.counterpartyKey && other.amountMinor * 5n >= txn.amountMinor * 4n).length >= 2;
    if (txn.type === 'expense' && !usualPayment && periodExpenses.length >= MIN_PERIOD_EXPENSES && periodExpenseTotal > 0n) {
      const shareBp = Number(divideRoundHalfAway(txn.amountMinor * 10000n, periodExpenseTotal));
      if (shareBp >= LARGE_SHARE_BP) {
        findings.push({
          transactionId: txn.id,
          ruleId: 'large_expense',
          severity: shareBp >= 5000 ? 'high' : 'medium',
          score: shareBp / 10000,
          explanation: `This single expense is ${(shareBp / 100).toFixed(2)}% of all ${periodExpenses.length} expenses in the period (threshold ${LARGE_SHARE_BP / 100}%).`,
          comparison: { shareBasisPoints: shareBp, periodExpenseCount: periodExpenses.length, periodExpenseTotalMinor: periodExpenseTotal, thresholdBasisPoints: LARGE_SHARE_BP },
        });
      }
    }
  }

  return {
    findings,
    history: {
      sufficient: sufficientHistory,
      earlierTransactions: beforePeriod.length,
      days: historyDays,
      note: sufficientHistory ? null
        : `Not enough history for amount and first-payee rules (needs ${MIN_HISTORY_TRANSACTIONS} earlier transactions over ${MIN_HISTORY_DAYS} days); only duplicate and large-expense rules ran.`,
    },
  };
}
