/**
 * companies: the tenant root. Reads take the companyId resolved from the
 * caller's membership (tenantScope.js), never an id supplied by a client.
 */

import { assertCompanyScope } from './tenantScope.js';

const COLUMNS = `id, name, industry, size, currency, fiscal_year_start_month, timezone, is_demo,
  onboarded_at, created_at, updated_at`;

function toCompany(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    industry: row.industry,
    size: row.size,
    currency: row.currency,
    fiscalYearStartMonth: row.fiscal_year_start_month,
    timezone: row.timezone,
    isDemo: row.is_demo === 1,
    onboardedAt: row.onboarded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertCompany(db, { id, name, industry, size, currency, fiscalYearStartMonth, now }) {
  db.run(
    `INSERT INTO companies
       (id, name, industry, size, currency, fiscal_year_start_month, timezone, is_demo, onboarded_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'UTC', 0, NULL, ?, ?)`,
    [id, name, industry, size, currency, fiscalYearStartMonth, now, now],
  );
  return getCompany(db, id);
}

export function getCompany(db, companyId) {
  assertCompanyScope(companyId);
  return toCompany(db.get(`SELECT ${COLUMNS} FROM companies WHERE id = ?`, [companyId]));
}

/** Idempotent: an already-onboarded company keeps its original timestamp. */
export function markCompanyOnboarded(db, companyId, now) {
  assertCompanyScope(companyId);
  db.run(
    'UPDATE companies SET onboarded_at = ?, updated_at = ? WHERE id = ? AND onboarded_at IS NULL',
    [now, now, companyId],
  );
  return getCompany(db, companyId);
}
