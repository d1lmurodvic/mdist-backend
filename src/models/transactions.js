/**
 * transactions: the ledger, company-scoped (tenantScope.js).
 *
 * List queries are assembled from fixed SQL fragments only; every value from
 * a request travels as a bound parameter, and sort columns come from a
 * whitelist, never from the request text.
 */

import { assertCompanyScope } from './tenantScope.js';
import { likePattern } from './sql.js';

// invoice_id: the invoice this transaction pays, if any (invoices.paid_transaction_id).
const COLUMNS = `id, type, amount_minor, currency, date, account_id, category_id, description, payee,
  payment_method, notes, source, category_source, category_rule_id, review_status, created_at, updated_at,
  (SELECT inv.id FROM invoices inv WHERE inv.company_id = transactions.company_id
     AND inv.paid_transaction_id = transactions.id) AS invoice_id`;

/** API sort field -> SQL column. */
export const SORTABLE_FIELDS = Object.freeze({ date: 'date', amount: 'amount_minor', createdAt: 'created_at' });

function toTransaction(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    date: row.date,
    accountId: row.account_id,
    categoryId: row.category_id,
    description: row.description,
    payee: row.payee,
    paymentMethod: row.payment_method,
    notes: row.notes,
    source: row.source,
    categorySource: row.category_source,
    categoryRuleId: row.category_rule_id,
    reviewStatus: row.review_status,
    invoiceId: row.invoice_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findTransaction(db, companyId, transactionId) {
  assertCompanyScope(companyId);
  return toTransaction(db.get(`SELECT ${COLUMNS} FROM transactions WHERE company_id = ? AND id = ?`, [companyId, transactionId]));
}

function whereClause(companyId, filters) {
  const conditions = ['company_id = ?'];
  const params = [companyId];
  if (filters.from) { conditions.push('date >= ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('date < ?'); params.push(filters.to); }
  if (filters.type) { conditions.push('type = ?'); params.push(filters.type); }
  if (filters.accountId) { conditions.push('account_id = ?'); params.push(filters.accountId); }
  if (filters.categoryIds?.length) {
    conditions.push(`category_id IN (${filters.categoryIds.map(() => '?').join(', ')})`);
    params.push(...filters.categoryIds);
  }
  if (filters.reviewStatus) { conditions.push('review_status = ?'); params.push(filters.reviewStatus); }
  if (filters.q) {
    conditions.push("(description LIKE ? ESCAPE '\\' OR payee LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
    const pattern = likePattern(filters.q);
    params.push(pattern, pattern, pattern);
  }
  return { sql: conditions.join(' AND '), params };
}

/**
 * One page of transactions plus the total count. Ordering is stable: ties
 * are broken by id, so pages never repeat or skip a row (API_CONTRACT.md §6).
 */
export function listTransactions(db, companyId, { filters, sort, page, limit }) {
  assertCompanyScope(companyId);
  const where = whereClause(companyId, filters);
  const column = SORTABLE_FIELDS[sort.field];
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const total = db.getValue(`SELECT count(*) FROM transactions WHERE ${where.sql}`, where.params);
  const rows = db.all(
    `SELECT ${COLUMNS} FROM transactions WHERE ${where.sql}
     ORDER BY ${column} ${direction}, id ${direction} LIMIT ? OFFSET ?`,
    [...where.params, limit, (page - 1) * limit],
  );
  return { items: rows.map(toTransaction), total };
}

export function insertTransaction(db, companyId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id,
       description, payee, counterparty_key, payment_method, notes, source, category_source, category_rule_id,
       review_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
    [
      fields.id, companyId, fields.type, fields.amountMinor, fields.currency, fields.date, fields.accountId,
      fields.categoryId, fields.description, fields.payee, fields.counterpartyKey, fields.paymentMethod, fields.notes,
      fields.categorySource, fields.categoryRuleId, fields.reviewStatus, fields.now, fields.now,
    ],
  );
  return findTransaction(db, companyId, fields.id);
}

/** Replace every editable column with the merged state computed by the service. */
export function updateTransaction(db, companyId, transactionId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE transactions SET type = ?, amount_minor = ?, date = ?, account_id = ?, category_id = ?,
       description = ?, payee = ?, counterparty_key = ?, payment_method = ?, notes = ?,
       category_source = ?, category_rule_id = ?, review_status = ?, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [
      fields.type, fields.amountMinor, fields.date, fields.accountId, fields.categoryId, fields.description,
      fields.payee, fields.counterpartyKey, fields.paymentMethod, fields.notes, fields.categorySource,
      fields.categoryRuleId, fields.reviewStatus, fields.now, companyId, transactionId,
    ],
  );
  return findTransaction(db, companyId, transactionId);
}

export function deleteTransaction(db, companyId, transactionId) {
  assertCompanyScope(companyId);
  return db.run('DELETE FROM transactions WHERE company_id = ? AND id = ?', [companyId, transactionId]).changes > 0;
}

/**
 * Possible duplicates of a prospective transaction: same direction, amount,
 * date and counterparty. Nothing is merged or deleted — callers only report.
 */
export function findDuplicatesOf(db, companyId, { type, amountMinor, date, counterpartyKey }) {
  assertCompanyScope(companyId);
  if (!counterpartyKey) return [];
  return db
    .all(
      `SELECT ${COLUMNS} FROM transactions
       WHERE company_id = ? AND counterparty_key = ? AND amount_minor = ? AND date = ? AND type = ?
       ORDER BY created_at, id`,
      [companyId, counterpartyKey, amountMinor, date, type],
    )
    .map(toTransaction);
}

/** Every group of 2+ transactions that are possible duplicates of each other. */
export function findDuplicateGroups(db, companyId, { limit }) {
  assertCompanyScope(companyId);
  const groups = db.all(
    `SELECT type, amount_minor, date, counterparty_key, count(*) AS size
     FROM transactions
     WHERE company_id = ? AND counterparty_key IS NOT NULL
     GROUP BY type, amount_minor, date, counterparty_key
     HAVING count(*) > 1
     ORDER BY date DESC, amount_minor DESC, counterparty_key, type
     LIMIT ?`,
    [companyId, limit + 1],
  );
  return {
    truncated: groups.length > limit,
    groups: groups.slice(0, limit).map((group) => ({
      transactions: findDuplicatesOf(db, companyId, {
        type: group.type,
        amountMinor: group.amount_minor,
        date: group.date,
        counterpartyKey: group.counterparty_key,
      }),
    })),
  };
}
