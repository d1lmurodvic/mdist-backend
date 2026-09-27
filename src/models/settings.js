/**
 * Settings writes (PRODUCT_REQUIREMENTS.md #25): user profile and password,
 * other sessions of a user, company configuration and member roles.
 */

import { assertCompanyScope } from './tenantScope.js';

export function updateUserProfile(db, userId, { name, email, now }) {
  db.run('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?', [name, email, now, userId]);
}

export function updatePasswordHash(db, userId, { passwordHash, now }) {
  db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [passwordHash, now, userId]);
}

/** End every other active session of the user (after a password change). */
export function revokeOtherSessions(db, userId, keepSessionId, now) {
  return db.run(
    'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
    [now, userId, keepSessionId],
  ).changes;
}

export function updateCompanyConfiguration(db, companyId, { name, industry, size, currency, fiscalYearStartMonth, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE companies SET name = ?, industry = ?, size = ?, currency = ?, fiscal_year_start_month = ?, updated_at = ?
     WHERE id = ?`,
    [name, industry, size, currency, fiscalYearStartMonth, now, companyId],
  );
}

export function setDemoFlag(db, companyId, isDemo, now) {
  assertCompanyScope(companyId);
  db.run('UPDATE companies SET is_demo = ?, updated_at = ? WHERE id = ?', [isDemo ? 1 : 0, now, companyId]);
}

export function countOwners(db, companyId) {
  assertCompanyScope(companyId);
  return db.getValue("SELECT count(*) FROM memberships WHERE company_id = ? AND role = 'owner'", [companyId]);
}

export function updateMemberRole(db, companyId, membershipId, role) {
  assertCompanyScope(companyId);
  db.run('UPDATE memberships SET role = ? WHERE company_id = ? AND id = ?', [role, companyId, membershipId]);
}

/**
 * Remove every business record of a company, keeping the company, its
 * members and its system Uncategorized category (demo data removal). Order
 * respects foreign keys. Returns the storage keys of removed documents.
 *
 * Assistant messages and accountant requests are kept: the demo seed never
 * writes them and the load guard does not count them, so they are the user's
 * own records even in a demo company.
 */
export function clearCompanyData(db, companyId) {
  assertCompanyScope(companyId);
  const storageKeys = db.all('SELECT storage_key FROM documents WHERE company_id = ?', [companyId]).map((row) => row.storage_key);
  const tables = [
    'notifications', 'insights', 'anomalies', 'forecasts',
    'document_extractions', 'documents', 'idempotency_keys',
  ];
  for (const table of tables) db.run(`DELETE FROM ${table} WHERE company_id = ?`, [companyId]);
  // Invoices point at payment transactions; line items go with their invoice.
  db.run('DELETE FROM invoice_line_items WHERE company_id = ?', [companyId]);
  db.run('DELETE FROM invoices WHERE company_id = ?', [companyId]);
  db.run('DELETE FROM contacts WHERE company_id = ?', [companyId]);
  db.run('DELETE FROM transactions WHERE company_id = ?', [companyId]);
  db.run('DELETE FROM category_rules WHERE company_id = ?', [companyId]);
  db.run('DELETE FROM categories WHERE company_id = ? AND is_system = 0 AND parent_id IS NOT NULL', [companyId]);
  db.run('DELETE FROM categories WHERE company_id = ? AND is_system = 0', [companyId]);
  db.run('DELETE FROM accounts WHERE company_id = ?', [companyId]);
  return storageKeys;
}
