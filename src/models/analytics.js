/**
 * Row-level reads for the intelligence features, the tax center and the
 * dashboard feed. Company-scoped (tenantScope.js). These queries return
 * records, never money totals: every total comes from models/ledger.js
 * through the financial engine.
 */

import { assertCompanyScope } from './tenantScope.js';

function toRow(row) {
  return {
    id: row.id,
    type: row.type,
    amountMinor: BigInt(row.amount_minor),
    date: row.date,
    categoryId: row.category_id,
    counterpartyKey: row.counterparty_key,
    payee: row.payee,
    description: row.description,
    createdAt: row.created_at,
  };
}

/** Transactions dated in [start, end), oldest first. */
export function transactionsBetween(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT id, type, amount_minor, date, category_id, counterparty_key, payee, description, created_at
     FROM transactions WHERE company_id = ? AND date >= ? AND date < ?
     ORDER BY date, created_at, id`,
    [companyId, start, end],
  ).map(toRow);
}

export function firstTransactionDate(db, companyId) {
  assertCompanyScope(companyId);
  return db.getValue('SELECT min(date) FROM transactions WHERE company_id = ?', [companyId]) ?? null;
}

export function countTransactionsBefore(db, companyId, before) {
  assertCompanyScope(companyId);
  return db.getValue('SELECT count(*) FROM transactions WHERE company_id = ? AND date < ?', [companyId, before]);
}

/** Largest transactions of a type (and category) in [start, end). */
export function largestTransactions(db, companyId, { start, end, type, categoryId, limit }) {
  assertCompanyScope(companyId);
  const params = [companyId, start, end, type];
  let filter = '';
  if (categoryId) { filter = ' AND category_id = ?'; params.push(categoryId); }
  return db.all(
    `SELECT id, type, amount_minor, date, category_id, counterparty_key, payee, description, created_at
     FROM transactions WHERE company_id = ? AND date >= ? AND date < ? AND type = ?${filter}
     ORDER BY amount_minor DESC, date DESC, id LIMIT ?`,
    [...params, limit],
  ).map(toRow);
}

/** Unpaid (sent) invoices with their contact, soonest due first. */
export function unpaidInvoices(db, companyId) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT i.id, i.number, i.type, i.total_minor, i.issue_date, i.due_date, c.name AS contact_name
     FROM invoices i JOIN contacts c ON c.company_id = i.company_id AND c.id = i.contact_id
     WHERE i.company_id = ? AND i.status = 'sent'
     ORDER BY i.due_date, i.number, i.id`,
    [companyId],
  ).map((row) => ({
    id: row.id, number: row.number, type: row.type, totalMinor: BigInt(row.total_minor),
    issueDate: row.issue_date, dueDate: row.due_date, contactName: row.contact_name,
  }));
}

/** Invoices paid recently: the payment transaction was recorded on/after `since`. */
export function recentlyPaidInvoices(db, companyId, { since }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT i.id, i.number, i.type, t.id AS transaction_id, t.created_at AS paid_at
     FROM invoices i JOIN transactions t ON t.company_id = i.company_id AND t.id = i.paid_transaction_id
     WHERE i.company_id = ? AND i.status = 'paid' AND t.created_at >= ?`,
    [companyId, since],
  ).map((row) => ({ id: row.id, number: row.number, type: row.type, transactionId: row.transaction_id, paidAt: row.paid_at }));
}

/** Documents that finished processing on/after `since`. */
export function recentlyProcessedDocuments(db, companyId, { since }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT id, status, original_filename, failure_code, processed_at FROM documents
     WHERE company_id = ? AND status IN ('ready', 'failed') AND processed_at >= ?`,
    [companyId, since],
  ).map((row) => ({ id: row.id, status: row.status, originalFilename: row.original_filename, failureCode: row.failure_code, processedAt: row.processed_at }));
}

// ------------------------------------------------------------ tax completeness

/** Ids of transactions in [start, end) on the Uncategorized category. */
export function uncategorizedTransactionIds(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT t.id FROM transactions t JOIN categories c ON c.company_id = t.company_id AND c.id = t.category_id
     WHERE t.company_id = ? AND t.date >= ? AND t.date < ? AND c.is_system = 1
     ORDER BY t.date, t.id`,
    [companyId, start, end],
  ).map((row) => row.id);
}

/** Ids of expenses in [start, end) with no document confirmed into them. */
export function expensesWithoutDocumentIds(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT t.id FROM transactions t
     WHERE t.company_id = ? AND t.type = 'expense' AND t.date >= ? AND t.date < ?
       AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.company_id = t.company_id AND d.transaction_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.company_id = t.company_id AND i.paid_transaction_id = t.id)
     ORDER BY t.date, t.id`,
    [companyId, start, end],
  ).map((row) => row.id);
}

/** Sent (unpaid) invoices issued in [start, end). */
export function unpaidInvoiceIdsIssuedBetween(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT id FROM invoices WHERE company_id = ? AND status = 'sent' AND issue_date >= ? AND issue_date < ?
     ORDER BY issue_date, id`,
    [companyId, start, end],
  ).map((row) => row.id);
}

/** Transactions in [start, end) for an export, with category name. */
export function transactionsForExport(db, companyId, { start, end, limit }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT t.id, t.date, t.type, t.amount_minor, t.currency, c.name AS category, t.payee, t.description,
            t.payment_method, t.source,
            (SELECT d.id FROM documents d WHERE d.company_id = t.company_id AND d.transaction_id = t.id) AS document_id,
            (SELECT i.id FROM invoices i WHERE i.company_id = t.company_id AND i.paid_transaction_id = t.id) AS invoice_id
     FROM transactions t JOIN categories c ON c.company_id = t.company_id AND c.id = t.category_id
     WHERE t.company_id = ? AND t.date >= ? AND t.date < ?
     ORDER BY t.date, t.id LIMIT ?`,
    [companyId, start, end, limit],
  );
}

/** Invoices issued in [start, end) for an export. */
export function invoicesForExport(db, companyId, { start, end }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT i.id, i.number, i.type, i.status, i.issue_date, i.due_date, i.subtotal_minor, i.tax_minor, i.total_minor,
            i.currency, c.name AS contact
     FROM invoices i JOIN contacts c ON c.company_id = i.company_id AND c.id = i.contact_id
     WHERE i.company_id = ? AND i.issue_date >= ? AND i.issue_date < ?
     ORDER BY i.issue_date, i.id`,
    [companyId, start, end],
  );
}

// ------------------------------------------------------------ dashboard feed

/** Recent events across the ledger, invoices and documents, newest first. */
export function recentActivity(db, companyId, { limit }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT * FROM (
       SELECT 'transaction_recorded' AS kind, id AS entity_id, 'transaction' AS entity_type, created_at AS at,
              coalesce(payee, description) AS label, type AS detail, amount_minor AS amount_minor
       FROM transactions WHERE company_id = ?
       UNION ALL
       SELECT 'invoice_created', id, 'invoice', created_at, number, type, total_minor FROM invoices WHERE company_id = ?
       UNION ALL
       SELECT 'invoice_sent', id, 'invoice', sent_at, number, type, total_minor FROM invoices WHERE company_id = ? AND sent_at IS NOT NULL
       UNION ALL
       SELECT 'invoice_cancelled', id, 'invoice', cancelled_at, number, type, total_minor FROM invoices WHERE company_id = ? AND cancelled_at IS NOT NULL
       UNION ALL
       SELECT 'document_uploaded', id, 'document', created_at, original_filename, status, NULL FROM documents WHERE company_id = ?
     )
     ORDER BY at DESC, entity_id DESC LIMIT ?`,
    [companyId, companyId, companyId, companyId, companyId, limit],
  );
}

/** How many business records a company holds (demo-data guard). */
export function companyRecordCounts(db, companyId) {
  assertCompanyScope(companyId);
  const count = (table) => db.getValue(`SELECT count(*) FROM ${table} WHERE company_id = ?`, [companyId]);
  return {
    accounts: count('accounts'),
    transactions: count('transactions'),
    invoices: count('invoices'),
    contacts: count('contacts'),
    documents: count('documents'),
    customCategories: db.getValue('SELECT count(*) FROM categories WHERE company_id = ? AND is_system = 0', [companyId]),
  };
}
