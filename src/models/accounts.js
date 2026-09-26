/** accounts: company-scoped (tenantScope.js). */

import { assertCompanyScope } from './tenantScope.js';

const COLUMNS = 'id, company_id, name, type, currency, opening_balance_minor, created_at, updated_at';

function toAccount(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    openingBalanceMinor: BigInt(row.opening_balance_minor),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(db, companyId) {
  assertCompanyScope(companyId);
  return db.all(`SELECT ${COLUMNS} FROM accounts WHERE company_id = ? ORDER BY created_at, id`, [companyId]).map(toAccount);
}

export function findAccount(db, companyId, accountId) {
  assertCompanyScope(companyId);
  return toAccount(db.get(`SELECT ${COLUMNS} FROM accounts WHERE company_id = ? AND id = ?`, [companyId, accountId]));
}

export function findAccountByName(db, companyId, name) {
  assertCompanyScope(companyId);
  return toAccount(db.get(`SELECT ${COLUMNS} FROM accounts WHERE company_id = ? AND name = ? COLLATE NOCASE`, [companyId, name]));
}

export function insertAccount(db, companyId, { id, name, type, currency, openingBalanceMinor, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO accounts (id, company_id, name, type, currency, opening_balance_minor, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, name, type, currency, openingBalanceMinor, now, now],
  );
  return findAccount(db, companyId, id);
}

/** Update the given fields only; `changes` keys are fixed by the service. */
export function updateAccount(db, companyId, accountId, { name, type, openingBalanceMinor, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE accounts SET
       name = coalesce(?, name),
       type = coalesce(?, type),
       opening_balance_minor = coalesce(?, opening_balance_minor),
       updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [name ?? null, type ?? null, openingBalanceMinor ?? null, now, companyId, accountId],
  );
  return findAccount(db, companyId, accountId);
}

export function countAccountTransactions(db, companyId, accountId) {
  assertCompanyScope(companyId);
  return db.getValue('SELECT count(*) FROM transactions WHERE company_id = ? AND account_id = ?', [companyId, accountId]);
}
