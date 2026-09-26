/** contacts: company-scoped customers and vendors (tenantScope.js). */

import { assertCompanyScope } from './tenantScope.js';
import { likePattern } from './sql.js';

const COLUMNS = 'id, name, type, email, phone, address, created_at, updated_at';

function toContact(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    email: row.email,
    phone: row.phone,
    address: row.address,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** All contacts (a bounded collection, API_CONTRACT.md §6), optionally filtered. */
export function listContacts(db, companyId, { type, q } = {}) {
  assertCompanyScope(companyId);
  const conditions = ['company_id = ?'];
  const params = [companyId];
  if (type) { conditions.push('type = ?'); params.push(type); }
  if (q) { conditions.push("name LIKE ? ESCAPE '\\'"); params.push(likePattern(q)); }
  return db
    .all(`SELECT ${COLUMNS} FROM contacts WHERE ${conditions.join(' AND ')} ORDER BY name COLLATE NOCASE, id`, params)
    .map(toContact);
}

export function findContact(db, companyId, contactId) {
  assertCompanyScope(companyId);
  return toContact(db.get(`SELECT ${COLUMNS} FROM contacts WHERE company_id = ? AND id = ?`, [companyId, contactId]));
}

export function insertContact(db, companyId, { id, name, type, email, phone, address, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO contacts (id, company_id, name, type, email, phone, address, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, name, type, email, phone, address, now, now],
  );
  return findContact(db, companyId, id);
}

/** Replace every editable column with the merged state computed by the service. */
export function updateContact(db, companyId, contactId, { name, type, email, phone, address, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE contacts SET name = ?, type = ?, email = ?, phone = ?, address = ?, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [name, type, email, phone, address, now, companyId, contactId],
  );
  return findContact(db, companyId, contactId);
}

/** Invoice types that reference this contact. */
export function invoiceTypesForContact(db, companyId, contactId) {
  assertCompanyScope(companyId);
  return db.all('SELECT DISTINCT type FROM invoices WHERE company_id = ? AND contact_id = ?', [companyId, contactId]).map((row) => row.type);
}
