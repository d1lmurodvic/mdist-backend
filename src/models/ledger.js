/**
 * Ledger aggregates for the financial engine (services/financialEngine.js).
 *
 * Sums are computed by SQLite over the stored integer minor units
 * (ARCHITECTURE.md §8: aggregate in the data layer, not by loading rows) and
 * read back as BigInt, so no figure ever passes through a float. These are the
 * only queries that total money; nothing else in the codebase sums amounts.
 *
 * Periods are [start, end): date >= start AND date < end.
 */

import { assertCompanyScope } from './tenantScope.js';

/** Income and expense totals and counts in [start, end), per type. */
export function totalsByType(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT type, coalesce(sum(amount_minor), 0) AS total, count(*) AS count
     FROM transactions
     WHERE company_id = ? AND date >= ? AND date < ?
     GROUP BY type`,
    [companyId, start, end],
  );
}

/** Per account: opening balance and income/expense totals for dates before `before`. */
export function accountTotals(db, companyId, { before }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT a.id AS account_id, a.type AS account_type, a.opening_balance_minor AS opening,
            coalesce(sum(CASE WHEN t.type = 'income' THEN t.amount_minor END), 0) AS income,
            coalesce(sum(CASE WHEN t.type = 'expense' THEN t.amount_minor END), 0) AS expense
     FROM accounts a
     LEFT JOIN transactions t ON t.company_id = a.company_id AND t.account_id = a.id AND t.date < ?
     WHERE a.company_id = ?
     GROUP BY a.id, a.type, a.opening_balance_minor`,
    [before, companyId],
  );
}

/** Income/expense per bucket in [start, end), for cash accounts only. */
export function cashTotalsByBucket(db, companyId, { start, end, bucket }) {
  assertCompanyScope(companyId);
  // `bucket` selects one of two fixed expressions, never request text.
  const key = bucket === 'month' ? "substr(t.date, 1, 7) || '-01'" : 't.date';
  return db.allBigInts(
    `SELECT ${key} AS bucket,
            coalesce(sum(CASE WHEN t.type = 'income' THEN t.amount_minor END), 0) AS income,
            coalesce(sum(CASE WHEN t.type = 'expense' THEN t.amount_minor END), 0) AS expense
     FROM transactions t
     JOIN accounts a ON a.company_id = t.company_id AND a.id = t.account_id
     WHERE t.company_id = ? AND a.type IN ('cash', 'bank') AND t.date >= ? AND t.date < ?
     GROUP BY bucket
     ORDER BY bucket`,
    [companyId, start, end],
  );
}

// ---------------------------------------------------------------------------
// Final backend completion: the aggregates behind statements, the dashboard
// and the intelligence features. Same rules: SQLite sums, read as BigInt.
// ---------------------------------------------------------------------------

/** Income/expense totals and counts per category in [start, end). */
export function totalsByCategory(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT t.category_id, t.type, coalesce(sum(t.amount_minor), 0) AS total, count(*) AS count
     FROM transactions t
     WHERE t.company_id = ? AND t.date >= ? AND t.date < ?
     GROUP BY t.category_id, t.type`,
    [companyId, start, end],
  );
}

/** `AND t.category_id IN (...)` for an optional category filter, with its parameters. */
function categoryFilter(categoryIds) {
  if (!categoryIds?.length) return { sql: '', params: [] };
  return { sql: ` AND t.category_id IN (${categoryIds.map(() => '?').join(', ')})`, params: categoryIds };
}

/** Income/expense totals and counts in [start, end), optionally for some categories only. */
export function totalsByTypeForCategories(db, companyId, { start, end, categoryIds }) {
  assertCompanyScope(companyId);
  const filter = categoryFilter(categoryIds);
  return db.allBigInts(
    `SELECT t.type, coalesce(sum(t.amount_minor), 0) AS total, count(*) AS count
     FROM transactions t
     WHERE t.company_id = ? AND t.date >= ? AND t.date < ?${filter.sql}
     GROUP BY t.type`,
    [companyId, start, end, ...filter.params],
  );
}

/** Income/expense per day, ISO week (Monday) or month bucket in [start, end). */
export function totalsByBucket(db, companyId, { start, end, bucket, categoryIds }) {
  assertCompanyScope(companyId);
  const filter = categoryFilter(categoryIds);
  // `bucket` selects one of three fixed expressions, never request text.
  const key = {
    day: 't.date',
    week: "date(t.date, '-6 days', 'weekday 1')",
    month: "substr(t.date, 1, 7) || '-01'",
  }[bucket];
  return db.allBigInts(
    `SELECT ${key} AS bucket,
            coalesce(sum(CASE WHEN t.type = 'income' THEN t.amount_minor END), 0) AS income,
            coalesce(sum(CASE WHEN t.type = 'expense' THEN t.amount_minor END), 0) AS expense,
            count(*) AS count
     FROM transactions t
     WHERE t.company_id = ? AND t.date >= ? AND t.date < ?${filter.sql}
     GROUP BY bucket
     ORDER BY bucket`,
    [companyId, start, end, ...filter.params],
  );
}

/**
 * Unpaid invoices (stored status 'sent') per type, with the part already past
 * its due date as of `today`. Drafts, paid and cancelled invoices owe nothing.
 */
export function outstandingInvoiceTotals(db, companyId, { today }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT type, count(*) AS count, coalesce(sum(total_minor), 0) AS total,
            coalesce(sum(CASE WHEN due_date < ? THEN 1 ELSE 0 END), 0) AS overdue_count,
            coalesce(sum(CASE WHEN due_date < ? THEN total_minor END), 0) AS overdue_total
     FROM invoices
     WHERE company_id = ? AND status = 'sent'
     GROUP BY type`,
    [today, today, companyId],
  );
}

/**
 * Invoices that were issued before `before` and still unpaid at that date:
 * currently sent, or paid by a payment dated on/after `before`. Drafts and
 * cancelled invoices are excluded.
 */
export function unpaidInvoiceTotalsAt(db, companyId, { before }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT i.type, count(*) AS count, coalesce(sum(i.total_minor), 0) AS total
     FROM invoices i
     LEFT JOIN transactions t ON t.company_id = i.company_id AND t.id = i.paid_transaction_id
     WHERE i.company_id = ? AND i.issue_date < ?
       AND (i.status = 'sent' OR (i.status = 'paid' AND t.date >= ?))
     GROUP BY i.type`,
    [companyId, before, before],
  );
}

/** Unpaid (sent) invoices falling due in [start, end), per type. */
export function unpaidDueBetween(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT type, count(*) AS count, coalesce(sum(total_minor), 0) AS total
     FROM invoices WHERE company_id = ? AND status = 'sent' AND due_date >= ? AND due_date < ?
     GROUP BY type`,
    [companyId, start, end],
  );
}

/** Invoices paid by a payment dated in [start, end): count, tax and total per type. */
export function paidInvoiceTaxBetween(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.allBigInts(
    `SELECT i.type, count(*) AS count, coalesce(sum(i.tax_minor), 0) AS tax, coalesce(sum(i.total_minor), 0) AS total
     FROM invoices i JOIN transactions t ON t.company_id = i.company_id AND t.id = i.paid_transaction_id
     WHERE i.company_id = ? AND i.status = 'paid' AND t.date >= ? AND t.date < ?
     GROUP BY i.type`,
    [companyId, start, end],
  );
}
