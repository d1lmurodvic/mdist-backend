/** idempotency_keys: the stored outcome of a successful keyed request, per company. */

import { assertCompanyScope } from './tenantScope.js';

export function findIdempotencyRecord(db, companyId, key) {
  assertCompanyScope(companyId);
  const row = db.get(
    'SELECT scope, request_hash, response_status, response_body FROM idempotency_keys WHERE company_id = ? AND key = ?',
    [companyId, key],
  );
  if (!row) return undefined;
  return { scope: row.scope, requestHash: row.request_hash, status: row.response_status, body: JSON.parse(row.response_body) };
}

export function insertIdempotencyRecord(db, companyId, { key, scope, requestHash, status, body, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO idempotency_keys (company_id, key, scope, request_hash, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [companyId, key, scope, requestHash, status, JSON.stringify(body), now],
  );
}
