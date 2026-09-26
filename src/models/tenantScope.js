/**
 * The tenant-scoping rule for every model that touches company-owned data
 * (ARCHITECTURE.md §5.3, §7.1):
 *
 *   - a tenant-scoped model function takes `companyId` as its first data
 *     argument and puts it in the WHERE clause of every statement;
 *   - that companyId comes only from req.tenant, which the requireCompany
 *     middleware resolves from the caller's server-side membership — never
 *     from a request body, query string or path;
 *   - a row belonging to another company is simply not found, so callers
 *     answer 404 and never reveal that it exists (API_CONTRACT.md §2).
 *
 * assertCompanyScope() makes a missing scope a loud programming error instead
 * of a query that silently spans every tenant.
 */

export function assertCompanyScope(companyId) {
  if (typeof companyId !== 'string' || companyId === '') {
    throw new Error('Tenant-scoped query called without a companyId.');
  }
  return companyId;
}
