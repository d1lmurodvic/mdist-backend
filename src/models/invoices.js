/**
 * invoices and invoice_line_items: company-scoped (tenantScope.js). Line items
 * are only ever read or written through their invoice, with company_id in
 * every statement.
 *
 * "overdue" is not stored: it is status 'sent' with due_date before today.
 * List filters express it in SQL so filtering and pagination stay exact.
 */

import { assertCompanyScope } from './tenantScope.js';
import { likePattern } from './sql.js';

const COLUMNS = `i.id, i.number, i.type, i.contact_id, c.name AS contact_name, c.type AS contact_type, i.status,
  i.currency, i.issue_date, i.due_date, i.subtotal_minor, i.tax_minor, i.total_minor, i.notes,
  i.paid_transaction_id, t.date AS paid_date, t.account_id AS paid_account_id,
  i.sent_at, i.cancelled_at, i.created_at, i.updated_at`;

const FROM = `invoices i
  JOIN contacts c ON c.company_id = i.company_id AND c.id = i.contact_id
  LEFT JOIN transactions t ON t.company_id = i.company_id AND t.id = i.paid_transaction_id`;

/** API sort field -> SQL column. */
export const INVOICE_SORTABLE_FIELDS = Object.freeze({
  issueDate: 'i.issue_date',
  dueDate: 'i.due_date',
  total: 'i.total_minor',
  number: 'i.number',
  createdAt: 'i.created_at',
});

function toInvoice(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    number: row.number,
    type: row.type,
    contact: { id: row.contact_id, name: row.contact_name, type: row.contact_type },
    status: row.status,
    currency: row.currency,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    subtotalMinor: BigInt(row.subtotal_minor),
    taxMinor: BigInt(row.tax_minor),
    totalMinor: BigInt(row.total_minor),
    notes: row.notes,
    paidTransactionId: row.paid_transaction_id,
    paidDate: row.paid_date,
    paidAccountId: row.paid_account_id,
    sentAt: row.sent_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toLineItem(row) {
  return {
    id: row.id,
    position: row.position,
    description: row.description,
    quantity: row.quantity,
    unitPriceMinor: BigInt(row.unit_price_minor),
    taxRate: row.tax_rate_bp,
    lineTotalMinor: BigInt(row.line_total_minor),
    taxMinor: BigInt(row.tax_minor),
  };
}

export function findInvoice(db, companyId, invoiceId) {
  assertCompanyScope(companyId);
  return toInvoice(db.get(`SELECT ${COLUMNS} FROM ${FROM} WHERE i.company_id = ? AND i.id = ?`, [companyId, invoiceId]));
}

export function findInvoiceByNumber(db, companyId, number) {
  assertCompanyScope(companyId);
  return db.get('SELECT id FROM invoices WHERE company_id = ? AND number = ? COLLATE NOCASE', [companyId, number]);
}

/** The invoice a payment transaction belongs to, or undefined. */
export function findInvoiceIdByTransaction(db, companyId, transactionId) {
  assertCompanyScope(companyId);
  return db.getValue('SELECT id FROM invoices WHERE company_id = ? AND paid_transaction_id = ?', [companyId, transactionId]);
}

export function listLineItems(db, companyId, invoiceId) {
  assertCompanyScope(companyId);
  return db
    .all(
      `SELECT id, position, description, quantity, unit_price_minor, tax_rate_bp, line_total_minor, tax_minor
       FROM invoice_line_items WHERE company_id = ? AND invoice_id = ? ORDER BY position`,
      [companyId, invoiceId],
    )
    .map(toLineItem);
}

/** Stored-status condition for one effective status, relative to `today`. */
function statusCondition(status) {
  switch (status) {
    case 'overdue': return "(i.status = 'sent' AND i.due_date < ?)";
    case 'sent': return "(i.status = 'sent' AND i.due_date >= ?)";
    default: return '(i.status = ?)';
  }
}

export function listInvoices(db, companyId, { filters, sort, page, limit, today }) {
  assertCompanyScope(companyId);
  const conditions = ['i.company_id = ?'];
  const params = [companyId];
  if (filters.statuses?.length) {
    conditions.push(`(${filters.statuses.map(statusCondition).join(' OR ')})`);
    for (const status of filters.statuses) params.push(status === 'overdue' || status === 'sent' ? today : status);
  }
  if (filters.type) { conditions.push('i.type = ?'); params.push(filters.type); }
  if (filters.contactId) { conditions.push('i.contact_id = ?'); params.push(filters.contactId); }
  if (filters.from) { conditions.push('i.issue_date >= ?'); params.push(filters.from); }
  if (filters.to) { conditions.push('i.issue_date < ?'); params.push(filters.to); }
  if (filters.q) { conditions.push("i.number LIKE ? ESCAPE '\\'"); params.push(likePattern(filters.q)); }

  const where = conditions.join(' AND ');
  const column = INVOICE_SORTABLE_FIELDS[sort.field];
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const total = db.getValue(`SELECT count(*) FROM invoices i WHERE ${where}`, params);
  const rows = db.all(
    `SELECT ${COLUMNS} FROM ${FROM} WHERE ${where} ORDER BY ${column} ${direction}, i.id ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  return { items: rows.map(toInvoice), total };
}

export function insertInvoice(db, companyId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO invoices (id, company_id, number, type, contact_id, status, currency, issue_date, due_date,
       subtotal_minor, tax_minor, total_minor, notes, paid_transaction_id, sent_at, cancelled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    [
      fields.id, companyId, fields.number, fields.type, fields.contactId, fields.currency, fields.issueDate, fields.dueDate,
      fields.subtotalMinor, fields.taxMinor, fields.totalMinor, fields.notes, fields.now, fields.now,
    ],
  );
}

/** Replace the editable header fields and totals. */
export function updateInvoiceDetails(db, companyId, invoiceId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE invoices SET number = ?, contact_id = ?, issue_date = ?, due_date = ?, notes = ?,
       subtotal_minor = ?, tax_minor = ?, total_minor = ?, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [
      fields.number, fields.contactId, fields.issueDate, fields.dueDate, fields.notes,
      fields.subtotalMinor, fields.taxMinor, fields.totalMinor, fields.now, companyId, invoiceId,
    ],
  );
}

export function replaceLineItems(db, companyId, invoiceId, lines, newLineId) {
  assertCompanyScope(companyId);
  db.run('DELETE FROM invoice_line_items WHERE company_id = ? AND invoice_id = ?', [companyId, invoiceId]);
  lines.forEach((line, index) => {
    db.run(
      `INSERT INTO invoice_line_items (id, company_id, invoice_id, position, description, quantity, unit_price_minor,
         tax_rate_bp, line_total_minor, tax_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newLineId(), companyId, invoiceId, index + 1, line.description, line.quantity, line.unitPriceMinor,
        line.taxRate, line.lineTotalMinor, line.taxMinor],
    );
  });
}

/** Set the stored status (and its timestamp / payment link) in one statement. */
export function setInvoiceStatus(db, companyId, invoiceId, { status, paidTransactionId = null, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE invoices SET status = ?, paid_transaction_id = ?,
       sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
       cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
       updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [status, paidTransactionId, status, now, status, now, now, companyId, invoiceId],
  );
}

export function deleteInvoice(db, companyId, invoiceId) {
  assertCompanyScope(companyId);
  return db.run('DELETE FROM invoices WHERE company_id = ? AND id = ?', [companyId, invoiceId]).changes > 0;
}
