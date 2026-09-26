/**
 * The financial calculation engine — the single source of every financial
 * figure (DEVELOPMENT_RULES.md §5.3–5.4, ARCHITECTURE.md §5.3).
 *
 *   Opening balances (account configuration, never transactions)
 * + Transactions     (the ledger: income adds, expense subtracts)
 * = Balances, cash position, period results, cash flow, comparisons
 *
 * Rules, stated once:
 *   - Periods are [start, end): a transaction dated `end` is outside.
 *   - A balance "before D" includes the opening balance and every transaction
 *     dated before D. There is no opening-balance date: it is the balance
 *     before the account's first transaction.
 *   - Account balance = opening + income − expense (one formula for all types;
 *     transactions can only be recorded on cash and bank accounts).
 *   - Cash position = the sum of cash and bank account balances.
 *   - Net result = income − expense for the period. Figures are cash basis:
 *     every transaction is a cash movement, and an invoice counts only through
 *     its payment transaction (Phase 4), so the period's cash movement equals
 *     its net result; they are still reported separately.
 *   - The previous period is dates.previousPeriod() (D10: calendar periods).
 *
 * Everything is computed on demand from stored records — nothing is cached —
 * so a created, edited or deleted transaction is reflected in the very next
 * figure. All arithmetic is BigInt; money leaves only through moneyJson().
 */

import { previousPeriod } from '../lib/dates.js';
import * as ledger from '../models/ledger.js';

/** Accounts that hold cash; the only accounts transactions can be recorded on. */
export const CASH_ACCOUNT_TYPES = Object.freeze(['cash', 'bank']);

export function createFinancialEngine({ db }) {
  function periodTotals(companyId, { start, end }) {
    const totals = { income: 0n, expense: 0n, transactionCount: 0 };
    for (const row of ledger.totalsByType(db, companyId, { start, end })) {
      totals[row.type] = row.total;
      totals.transactionCount += Number(row.count);
    }
    return { ...totals, net: totals.income - totals.expense };
  }

  /** Map accountId -> { opening, income, expense, balance } before `before`. */
  function accountBalances(companyId, { before }) {
    const balances = new Map();
    for (const row of ledger.accountTotals(db, companyId, { before })) {
      balances.set(row.account_id, {
        accountType: row.account_type,
        opening: row.opening,
        income: row.income,
        expense: row.expense,
        balance: row.opening + row.income - row.expense,
      });
    }
    return balances;
  }

  function cashBalance(companyId, { before }) {
    let total = 0n;
    for (const account of accountBalances(companyId, { before }).values()) {
      if (CASH_ACCOUNT_TYPES.includes(account.accountType)) total += account.balance;
    }
    return total;
  }

  function cashFlow(companyId, { start, end, granularity }) {
    const opening = cashBalance(companyId, { before: start });
    let running = opening;
    let cashIn = 0n;
    let cashOut = 0n;
    const series = ledger.cashTotalsByBucket(db, companyId, { start, end, bucket: granularity }).map((row) => {
      cashIn += row.income;
      cashOut += row.expense;
      running += row.income - row.expense;
      return { bucket: row.bucket, cashIn: row.income, cashOut: row.expense, net: row.income - row.expense, closingBalance: running };
    });
    return { opening, cashIn, cashOut, net: cashIn - cashOut, closing: running, series };
  }

  function overview(companyId, period) {
    const previous = previousPeriod(period);
    return {
      period,
      previousPeriod: previous,
      current: periodTotals(companyId, period),
      previous: periodTotals(companyId, previous),
      cash: {
        opening: cashBalance(companyId, { before: period.start }),
        closing: cashBalance(companyId, { before: period.end }),
      },
    };
  }

  // ------------------------------------------------------------------------
  // Final backend completion (statements, dashboard, intelligence). Additive:
  // the functions above are unchanged.
  // ------------------------------------------------------------------------

  /** Per category and type: { categoryId, type, total, count } in [start, end). */
  function categoryTotals(companyId, { start, end }) {
    return ledger.totalsByCategory(db, companyId, { start, end }).map((row) => ({
      categoryId: row.category_id, type: row.type, total: row.total, count: Number(row.count),
    }));
  }

  /** Income, expense and net per day, week (Monday) or month, for buckets with activity. */
  function periodSeries(companyId, { start, end, granularity, categoryIds }) {
    return ledger.totalsByBucket(db, companyId, { start, end, bucket: granularity, categoryIds }).map((row) => ({
      bucket: row.bucket, income: row.income, expense: row.expense, net: row.income - row.expense, count: Number(row.count),
    }));
  }

  /** Like periodTotals, restricted to some categories (all when none are given). */
  function periodTotalsForCategories(companyId, { start, end, categoryIds }) {
    const totals = { income: 0n, expense: 0n, transactionCount: 0 };
    for (const row of ledger.totalsByTypeForCategories(db, companyId, { start, end, categoryIds })) {
      totals[row.type] = row.total;
      totals.transactionCount += Number(row.count);
    }
    return { ...totals, net: totals.income - totals.expense };
  }

  const emptyInvoiceTotals = () => ({ count: 0, total: 0n, overdueCount: 0, overdueTotal: 0n });

  /** Unpaid (sent) receivables and payables as of `today`, with their overdue part. */
  function outstandingInvoices(companyId, { today }) {
    const result = { receivable: emptyInvoiceTotals(), payable: emptyInvoiceTotals() };
    for (const row of ledger.outstandingInvoiceTotals(db, companyId, { today })) {
      result[row.type] = {
        count: Number(row.count), total: row.total, overdueCount: Number(row.overdue_count), overdueTotal: row.overdue_total,
      };
    }
    return result;
  }

  /** Receivables and payables that were unpaid at the start of `before`. */
  function unpaidInvoicesAt(companyId, { before }) {
    const result = { receivable: { count: 0, total: 0n }, payable: { count: 0, total: 0n } };
    for (const row of ledger.unpaidInvoiceTotalsAt(db, companyId, { before })) {
      result[row.type] = { count: Number(row.count), total: row.total };
    }
    return result;
  }

  /** Unpaid invoices falling due in [start, end): obligations (payables) and expected receipts. */
  function unpaidDueBetween(companyId, { start, end }) {
    const result = { receivable: { count: 0, total: 0n }, payable: { count: 0, total: 0n } };
    for (const row of ledger.unpaidDueBetween(db, companyId, { start, end })) {
      result[row.type] = { count: Number(row.count), total: row.total };
    }
    return result;
  }

  /** Tax and totals of invoices whose payment is dated in [start, end), per type. */
  function paidInvoiceTax(companyId, { start, end }) {
    const result = { receivable: { count: 0, tax: 0n, total: 0n }, payable: { count: 0, tax: 0n, total: 0n } };
    for (const row of ledger.paidInvoiceTaxBetween(db, companyId, { start, end })) {
      result[row.type] = { count: Number(row.count), tax: row.tax, total: row.total };
    }
    return result;
  }

  return {
    periodTotals, accountBalances, cashBalance, cashFlow, overview,
    unpaidDueBetween, paidInvoiceTax,
    categoryTotals, periodSeries, periodTotalsForCategories, outstandingInvoices, unpaidInvoicesAt,
  };
}
