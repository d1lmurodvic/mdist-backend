/**
 * documents and document_extractions: company-scoped (tenantScope.js).
 * Extractions are only read or written through their company's document.
 */

import { assertCompanyScope } from './tenantScope.js';

const COLUMNS = `d.id, d.original_filename, d.storage_key, d.mime_type, d.size_bytes, d.status, d.failure_code,
  d.failure_message, d.confirmed_target, d.transaction_id, d.invoice_id, d.confirmed_at, d.processed_at,
  d.created_at, d.updated_at`;

/** API sort field -> SQL column. */
export const DOCUMENT_SORTABLE_FIELDS = Object.freeze({ createdAt: 'd.created_at', sizeBytes: 'd.size_bytes' });

function toDocument(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    originalFilename: row.original_filename,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    status: row.status,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    confirmedTarget: row.confirmed_target,
    transactionId: row.transaction_id,
    invoiceId: row.invoice_id,
    confirmedAt: row.confirmed_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function findDocument(db, companyId, documentId) {
  assertCompanyScope(companyId);
  return toDocument(db.get(`SELECT ${COLUMNS} FROM documents d WHERE d.company_id = ? AND d.id = ?`, [companyId, documentId]));
}

export function listDocuments(db, companyId, { statuses, sort, page, limit }) {
  assertCompanyScope(companyId);
  const conditions = ['d.company_id = ?'];
  const params = [companyId];
  if (statuses?.length) {
    conditions.push(`d.status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const where = conditions.join(' AND ');
  const column = DOCUMENT_SORTABLE_FIELDS[sort.field];
  const direction = sort.direction === 'asc' ? 'ASC' : 'DESC';
  const total = db.getValue(`SELECT count(*) FROM documents d WHERE ${where}`, params);
  const rows = db.all(
    `SELECT ${COLUMNS} FROM documents d WHERE ${where} ORDER BY ${column} ${direction}, d.id ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  return { items: rows.map(toDocument), total };
}

export function insertDocument(db, companyId, { id, originalFilename, storageKey, mimeType, sizeBytes, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO documents (id, company_id, original_filename, storage_key, mime_type, size_bytes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, ?)`,
    [id, companyId, originalFilename, storageKey, mimeType, sizeBytes, now, now],
  );
}

/** processing -> ready | failed. Only a document still processing is changed. */
export function finishProcessing(db, companyId, documentId, { status, failureCode = null, failureMessage = null, now }) {
  assertCompanyScope(companyId);
  return db.run(
    `UPDATE documents SET status = ?, failure_code = ?, failure_message = ?, processed_at = ?, updated_at = ?
     WHERE company_id = ? AND id = ? AND status = 'processing'`,
    [status, failureCode, failureMessage, now, now, companyId, documentId],
  ).changes > 0;
}

/** ready | failed -> processing, for a re-run. */
export function restartProcessing(db, companyId, documentId, now) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE documents SET status = 'processing', failure_code = NULL, failure_message = NULL, processed_at = NULL, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [now, companyId, documentId],
  );
}

/**
 * Documents left 'processing' by a process that stopped: no extraction can be
 * in flight when the app starts, so they are failed as interrupted.
 */
export function failInterruptedDocuments(db, message, now) {
  return db.run(
    `UPDATE documents SET status = 'failed', failure_code = 'interrupted', failure_message = ?, processed_at = ?, updated_at = ?
     WHERE status = 'processing'`,
    [message, now, now],
  ).changes;
}

export function confirmDocument(db, companyId, documentId, { target, transactionId = null, invoiceId = null, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE documents SET confirmed_target = ?, transaction_id = ?, invoice_id = ?, confirmed_at = ?, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [target, transactionId, invoiceId, now, now, companyId, documentId],
  );
}

export function deleteDocument(db, companyId, documentId) {
  assertCompanyScope(companyId);
  return db.run('DELETE FROM documents WHERE company_id = ? AND id = ?', [companyId, documentId]).changes > 0;
}

/**
 * Mark a transaction created from a document with its provenance. The
 * transactions.source column has allowed 'document' since migration 003.
 */
export function markTransactionFromDocument(db, companyId, transactionId) {
  assertCompanyScope(companyId);
  db.run("UPDATE transactions SET source = 'document' WHERE company_id = ? AND id = ?", [companyId, transactionId]);
}

// ------------------------------------------------------------- extractions

function toExtraction(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    attempt: row.attempt,
    method: row.method,
    provider: row.provider,
    outcome: row.outcome,
    fields: row.fields === null ? null : JSON.parse(row.fields),
    failureCode: row.failure_code,
    createdAt: row.created_at,
  };
}

export function latestExtraction(db, companyId, documentId) {
  assertCompanyScope(companyId);
  return toExtraction(db.get(
    `SELECT id, attempt, method, provider, outcome, fields, failure_code, created_at
     FROM document_extractions WHERE company_id = ? AND document_id = ? ORDER BY attempt DESC LIMIT 1`,
    [companyId, documentId],
  ));
}

export function insertExtraction(db, companyId, { id, documentId, method, provider, outcome, fields, failureCode, now }) {
  assertCompanyScope(companyId);
  const attempt = (db.getValue(
    'SELECT coalesce(max(attempt), 0) FROM document_extractions WHERE company_id = ? AND document_id = ?',
    [companyId, documentId],
  )) + 1;
  db.run(
    `INSERT INTO document_extractions (id, company_id, document_id, attempt, method, provider, outcome, fields, failure_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, documentId, attempt, method, provider, outcome, fields === null ? null : JSON.stringify(fields), failureCode, now],
  );
}
