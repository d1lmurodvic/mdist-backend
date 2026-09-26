/**
 * Financial statements and breakdowns (PRODUCT_REQUIREMENTS.md #6, #12–#16;
 * API_CONTRACT.md §9.5, §9.8).
 *
 * Presentation only: every figure comes from the financial engine, over the
 * same periods (start-inclusive, end-exclusive; previous period per D10) as
 * the overview and the dashboard. Totals are read from the engine's period
 * totals and the lines from its per-category totals, so a statement's lines
 * always add up to the figure every other screen shows.
 *
 * The statements are practical owner-facing statements on a cash basis, not
 * certified statutory filings; each says so.
 */

import { badRequest, unprocessable } from '../lib/errors.js';
import { addDays, daysBetween, isIsoDate, todayIso } from '../lib/dates.js';
import { changeBasisPoints, moneyJson } from '../lib/money.js';
import { shareBasisPoints } from '../lib/ratios.js';
import * as categories from '../models/categories.js';
import { resolveCompanyPeriod } from './periodQuery.js';
import { CASH_ACCOUNT_TYPES } from './financialEngine.js';
import * as accounts from '../models/accounts.js';
import * as companies from '../models/companies.js';

export const STATEMENT_DISCLAIMER = 'Practical owner-facing financial statements, not certified statutory filings.';
export const CASH_BASIS_NOTE = 'Cash basis: income and expenses are recorded when money moves. An invoice counts only when it is paid.';
export const MAX_DAILY_SERIES_DAYS = 366;

export const REPORTS = Object.freeze([
  { id: 'profit-and-loss', title: 'Profit & loss', path: '/api/v1/reports/profit-and-loss', dateBasis: 'period' },
  { id: 'balance-sheet', title: 'Balance sheet', path: '/api/v1/reports/balance-sheet', dateBasis: 'asOf' },
  { id: 'cash-flow-statement', title: 'Cash flow statement', path: '/api/v1/reports/cash-flow-statement', dateBasis: 'period' },
  { id: 'expense-report', title: 'Expense report', path: '/api/v1/reports/expense-report', dateBasis: 'period' },
]);

export function createReportsService({ db, engine }) {
  /**
   * Category lines for one type: top-level categories with their
   * subcategories nested, each with current and previous totals. A
   * category with no activity in either period is omitted, consistently.
   */
  function categoryLines(companyId, type, { current, previous, periodTotal }, currency, period) {
    const money = (value) => moneyJson(value, currency);
    const all = categories.listCategories(db, companyId);
    const byId = new Map(all.map((category) => [category.id, category]));
    const figures = new Map();
    const figureFor = (id) => {
      if (!figures.has(id)) figures.set(id, { own: 0n, ownCount: 0, previous: 0n, total: 0n, count: 0, previousTotal: 0n });
      return figures.get(id);
    };
    for (const [rows, field] of [[current, 'own'], [previous, 'previous']]) {
      for (const row of rows) {
        if (row.type !== type) continue;
        const entry = figureFor(row.categoryId);
        entry[field] += row.total;
        if (field === 'own') entry.ownCount += row.count;
      }
    }
    // Roll subcategories up into their parent.
    for (const [id, entry] of [...figures]) {
      const category = byId.get(id);
      const targets = category?.parentId ? [id, category.parentId] : [id];
      for (const target of targets) {
        const t = figureFor(target);
        t.total += entry.own;
        t.count += entry.ownCount;
        t.previousTotal += entry.previous;
      }
    }

    const drilldown = (categoryId) => ({
      path: '/api/v1/transactions', query: { type, categoryId, from: period.start, to: period.end },
    });
    const line = (category) => {
      const entry = figures.get(category.id);
      return {
        category: { id: category.id, name: category.name, parentId: category.parentId, isSystem: category.isSystem },
        total: money(entry.total),
        transactionCount: entry.count,
        shareBasisPoints: shareBasisPoints(entry.total, periodTotal),
        previousTotal: money(entry.previousTotal),
        change: { amount: money(entry.total - entry.previousTotal), basisPoints: changeBasisPoints(entry.total, entry.previousTotal) },
        drilldown: drilldown(category.id),
      };
    };
    const active = (category) => {
      const entry = figures.get(category.id);
      return entry && (entry.total !== 0n || entry.previousTotal !== 0n);
    };

    const tops = all.filter((category) => !category.parentId && active(category));
    return tops
      .map((category) => {
        const own = figures.get(category.id);
        const children = all.filter((child) => child.parentId === category.id && active(child)).map(line);
        return {
          ...line(category),
          // Transactions recorded on the parent itself, not on a subcategory.
          ownTotal: children.length > 0 ? money(own.own) : undefined,
          children,
        };
      })
      .sort((a, b) => (BigInt(b.total.amount) > BigInt(a.total.amount) ? 1 : BigInt(b.total.amount) < BigInt(a.total.amount) ? -1 : a.category.name.localeCompare(b.category.name)));
  }

  function figure(current, previous, currency) {
    return {
      amount: moneyJson(current, currency),
      previous: moneyJson(previous, currency),
      change: { amount: moneyJson(current - previous, currency), basisPoints: changeBasisPoints(current, previous) },
    };
  }

  function expenseReportData(companyId, query) {
    const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
    const { currency } = company;
    const current = engine.periodTotals(companyId, period);
    const prior = engine.periodTotals(companyId, previousPeriod);
    const groups = categoryLines(companyId, 'expense', {
      current: engine.categoryTotals(companyId, period),
      previous: engine.categoryTotals(companyId, previousPeriod),
      periodTotal: current.expense,
    }, currency, period);
    const expenseCount = engine.categoryTotals(companyId, period)
      .filter((row) => row.type === 'expense').reduce((count, row) => count + row.count, 0);
    return {
      data: {
        currency,
        period,
        previousPeriod,
        total: figure(current.expense, prior.expense, currency),
        transactionCount: expenseCount,
        groups,
        // No budgets or targets exist in IFRSmart; none are invented.
        targets: null,
        empty: expenseCount === 0,
      },
      meta: { period, notes: ['Every expense transaction in the period appears exactly once, under its category. Uncategorized expenses are listed as their own group.', 'No budget targets are configured, so no target comparison is shown.'] },
    };
  }

  function requireGranularity(period, granularity) {
    if (granularity === 'day' && daysBetween(period.start, period.end) > MAX_DAILY_SERIES_DAYS) {
      throw unprocessable('Use granularity=week or month for periods longer than a year.', [
        { field: 'granularity', issue: `day is limited to ${MAX_DAILY_SERIES_DAYS} days` },
      ]);
    }
  }

  function requireCategories(companyId, categoryIds) {
    for (const id of categoryIds ?? []) {
      if (!categories.findCategory(db, companyId, id)) {
        throw unprocessable('Category not found.', [{ field: 'categoryId', issue: 'not found' }]);
      }
    }
  }

  return {
    index(companyId, query) {
      const { period } = resolveCompanyPeriod(db, companyId, query);
      return {
        data: REPORTS.map((report) => ({ ...report, available: true })),
        meta: { period, notes: [STATEMENT_DISCLAIMER, 'Export is not available yet; every statement is fully readable on screen.'] },
      };
    },

    revenueVsExpenses(companyId, query) {
      const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
      const granularity = query.granularity ?? 'month';
      requireGranularity(period, granularity);
      requireCategories(companyId, query.categoryId);
      const { currency } = company;
      const money = (value) => moneyJson(value, currency);
      const categoryIds = query.categoryId?.length ? query.categoryId : undefined;
      const current = engine.periodTotalsForCategories(companyId, { ...period, categoryIds });
      const prior = engine.periodTotalsForCategories(companyId, { ...previousPeriod, categoryIds });
      const series = engine.periodSeries(companyId, { ...period, granularity, categoryIds });
      const currentByCategory = engine.categoryTotals(companyId, period);
      const previousByCategory = engine.categoryTotals(companyId, previousPeriod);
      return {
        data: {
          currency,
          period,
          previousPeriod,
          granularity,
          filters: { categoryId: categoryIds ?? [] },
          income: figure(current.income, prior.income, currency),
          expenses: figure(current.expense, prior.expense, currency),
          difference: figure(current.net, prior.net, currency),
          transactionCount: current.transactionCount,
          // Buckets with no activity are omitted.
          series: series.map((bucket) => ({
            // A week bucket may begin before the period; it is reported from the period start.
            start: bucket.bucket < period.start ? period.start : bucket.bucket,
            income: money(bucket.income),
            expenses: money(bucket.expense),
            net: money(bucket.net),
            transactionCount: bucket.count,
            drilldown: { path: '/api/v1/transactions', query: { from: bucket.bucket < period.start ? period.start : bucket.bucket, to: bucketEnd(bucket.bucket, granularity, period.end) } },
          })),
          expensesByCategory: categoryLines(companyId, 'expense', { current: currentByCategory, previous: previousByCategory, periodTotal: engine.periodTotals(companyId, period).expense }, currency, period),
          incomeByCategory: categoryLines(companyId, 'income', { current: currentByCategory, previous: previousByCategory, periodTotal: engine.periodTotals(companyId, period).income }, currency, period),
          empty: current.transactionCount === 0,
        },
        meta: { period },
      };
    },

    expenseReport: expenseReportData,

    profitAndLoss(companyId, query) {
      const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
      const { currency } = company;
      const current = engine.periodTotals(companyId, period);
      const prior = engine.periodTotals(companyId, previousPeriod);
      const rows = { current: engine.categoryTotals(companyId, period), previous: engine.categoryTotals(companyId, previousPeriod) };
      return {
        data: {
          company: { id: company.id, name: company.name, isDemo: company.isDemo },
          currency,
          period,
          previousPeriod,
          revenue: { ...figure(current.income, prior.income, currency), lines: categoryLines(companyId, 'income', { ...rows, periodTotal: current.income }, currency, period) },
          expenses: { ...figure(current.expense, prior.expense, currency), lines: categoryLines(companyId, 'expense', { ...rows, periodTotal: current.expense }, currency, period) },
          netResult: { ...figure(current.net, prior.net, currency), result: current.net < 0n ? 'loss' : current.net > 0n ? 'profit' : 'break_even' },
          netMarginBasisPoints: shareBasisPoints(current.net, current.income),
          transactionCount: current.transactionCount,
          empty: current.transactionCount === 0,
          basis: 'cash',
        },
        meta: { period, notes: [STATEMENT_DISCLAIMER, CASH_BASIS_NOTE] },
      };
    },

    balanceSheet(companyId, query) {
      const company = companies.getCompany(db, companyId);
      const asOf = query.asOf ?? todayIso();
      if (!isIsoDate(asOf)) throw badRequest('asOf must be a date.', [{ field: 'asOf', issue: 'must be YYYY-MM-DD' }]);
      const { currency } = company;
      const money = (value) => moneyJson(value, currency);
      const before = addDays(asOf, 1);
      const balances = engine.accountBalances(companyId, { before });
      const list = accounts.listAccounts(db, companyId);

      const section = (types) => {
        let total = 0n;
        const lines = list.filter((account) => types.includes(account.type)).map((account) => {
          const figures = balances.get(account.id);
          const balance = figures ? figures.balance : account.openingBalanceMinor;
          total += balance;
          return { account: { id: account.id, name: account.name, type: account.type }, balance: money(balance) };
        });
        return { lines, total };
      };

      const assets = section(CASH_ACCOUNT_TYPES);
      const liabilities = section(['liability']);
      const equityAccounts = section(['equity']);
      let openingAssets = 0n;
      let accumulated = 0n;
      for (const account of list) {
        const figures = balances.get(account.id);
        if (!CASH_ACCOUNT_TYPES.includes(account.type)) continue;
        openingAssets += account.openingBalanceMinor;
        if (figures) accumulated += figures.income - figures.expense;
      }
      // What the recorded opening balances do not explain. Zero when the
      // opening balances of assets, liabilities and equity agree.
      const unreconciled = openingAssets - liabilities.total - equityAccounts.total;
      const equityTotal = equityAccounts.total + accumulated + unreconciled;
      const unpaid = engine.unpaidInvoicesAt(companyId, { before });

      const issues = [];
      if (list.length === 0) issues.push({ code: 'no_accounts', message: 'No accounts are recorded, so the balance sheet has nothing to show.' });
      if (unreconciled !== 0n) {
        issues.push({ code: 'unreconciled_opening_balances', message: 'The opening balances of assets, liabilities and equity do not agree; the difference is shown in equity as "Unreconciled opening balances".' });
      }
      if (liabilities.lines.length > 0) {
        issues.push({ code: 'liabilities_at_opening_balance', message: 'Liability accounts show their opening balance only; repayments recorded as expenses do not reduce them.' });
      }
      if (unpaid.receivable.count > 0 || unpaid.payable.count > 0) {
        issues.push({ code: 'invoices_not_recognised', message: 'Unpaid invoices are not on the cash-basis balance sheet; they are listed under memo.' });
      }

      return {
        data: {
          company: { id: company.id, name: company.name, isDemo: company.isDemo },
          currency,
          asOf,
          assets: { lines: assets.lines, total: money(assets.total) },
          liabilities: { lines: liabilities.lines, total: money(liabilities.total) },
          equity: {
            lines: [
              ...equityAccounts.lines,
              { label: 'Accumulated net result', amount: money(accumulated), drilldown: { path: '/api/v1/transactions', query: { to: before } } },
              ...(unreconciled !== 0n ? [{ label: 'Unreconciled opening balances', amount: money(unreconciled) }] : []),
            ],
            total: money(equityTotal),
          },
          totalLiabilitiesAndEquity: money(liabilities.total + equityTotal),
          balanced: assets.total === liabilities.total + equityTotal,
          memo: {
            unpaidReceivables: { count: unpaid.receivable.count, total: money(unpaid.receivable.total) },
            unpaidPayables: { count: unpaid.payable.count, total: money(unpaid.payable.total) },
          },
          completeness: { complete: issues.every((issue) => issue.code === 'invoices_not_recognised'), issues },
          basis: 'cash',
        },
        meta: { asOf, notes: [STATEMENT_DISCLAIMER, CASH_BASIS_NOTE] },
      };
    },

    cashFlowStatement(companyId, query) {
      const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, query);
      const { currency } = company;
      const money = (value) => moneyJson(value, currency);
      const flow = engine.cashFlow(companyId, { ...period, granularity: 'month' });
      const rows = { current: engine.categoryTotals(companyId, period), previous: engine.categoryTotals(companyId, previousPeriod) };
      const totals = engine.periodTotals(companyId, period);
      return {
        data: {
          company: { id: company.id, name: company.name, isDemo: company.isDemo },
          currency,
          period,
          openingCash: money(flow.opening),
          activities: {
            operating: {
              cashIn: money(flow.cashIn),
              cashOut: money(flow.cashOut),
              netCash: money(flow.net),
              inflows: categoryLines(companyId, 'income', { ...rows, periodTotal: totals.income }, currency, period),
              outflows: categoryLines(companyId, 'expense', { ...rows, periodTotal: totals.expense }, currency, period),
            },
            // Not classified: no category carries an investing or financing
            // classification, so these are not reported rather than shown as 0.
            investing: null,
            financing: null,
          },
          netChange: money(flow.net),
          closingCash: money(flow.closing),
          mapping: {
            rule: 'all_operating',
            description: 'Every transaction is classified as an operating activity. Categories in IFRSmart carry no investing or financing classification, so no other grouping is applied.',
          },
          reconciles: flow.opening + flow.net === flow.closing,
          basis: 'cash',
        },
        meta: { period, notes: [STATEMENT_DISCLAIMER, 'Opening and closing cash are the same figures as /financials/cash-flow and the balance sheet.'] },
      };
    },
  };
}

/** Exclusive end of a series bucket, capped at the period end. */
function bucketEnd(start, granularity, periodEnd) {
  let end;
  if (granularity === 'day') end = addDays(start, 1);
  else if (granularity === 'week') end = addDays(start, 7);
  else {
    const [year, month] = start.split('-').map(Number);
    end = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  }
  return end < periodEnd ? end : periodEnd;
}
