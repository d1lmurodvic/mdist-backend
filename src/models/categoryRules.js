/** category_rules: company-scoped deterministic categorization rules (tenantScope.js). */

import { assertCompanyScope } from './tenantScope.js';

const COLUMNS = 'r.id, r.source, r.match_type, r.pattern, r.category_id, r.created_at, r.updated_at';

function toRule(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    source: row.source,
    matchType: row.match_type,
    pattern: row.pattern,
    categoryId: row.category_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listRules(db, companyId) {
  assertCompanyScope(companyId);
  return db
    .all(`SELECT ${COLUMNS} FROM category_rules r WHERE r.company_id = ? ORDER BY r.source DESC, r.created_at, r.id`, [companyId])
    .map(toRule);
}

export function findRule(db, companyId, ruleId) {
  assertCompanyScope(companyId);
  return toRule(db.get(`SELECT ${COLUMNS} FROM category_rules r WHERE r.company_id = ? AND r.id = ?`, [companyId, ruleId]));
}

export function findRuleByPattern(db, companyId, { source, matchType, pattern }) {
  assertCompanyScope(companyId);
  return toRule(db.get(
    `SELECT ${COLUMNS} FROM category_rules r WHERE r.company_id = ? AND r.source = ? AND r.match_type = ? AND r.pattern = ?`,
    [companyId, source, matchType, pattern],
  ));
}

export function insertRule(db, companyId, { id, source, matchType, pattern, categoryId, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO category_rules (id, company_id, source, match_type, pattern, category_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, source, matchType, pattern, categoryId, now, now],
  );
  return findRule(db, companyId, id);
}

export function updateRuleCategory(db, companyId, ruleId, categoryId, now) {
  assertCompanyScope(companyId);
  db.run('UPDATE category_rules SET category_id = ?, updated_at = ? WHERE company_id = ? AND id = ?', [categoryId, now, companyId, ruleId]);
}

export function deleteRule(db, companyId, ruleId) {
  assertCompanyScope(companyId);
  return db.run('DELETE FROM category_rules WHERE company_id = ? AND id = ?', [companyId, ruleId]).changes > 0;
}

/**
 * The first matching rule of one layer for a transaction, or undefined.
 * Only rules whose category has the transaction's type are eligible.
 * Order: exact before contains, longer patterns first, then oldest (stable).
 *
 * @param {'user'|'learned'} source
 * @param {string|null} key normalised counterparty (exact match target)
 * @param {string} text normalised payee + description (contains match target)
 */
export function findMatchingRule(db, companyId, { source, type, key, text }) {
  assertCompanyScope(companyId);
  return toRule(db.get(
    `SELECT ${COLUMNS}
     FROM category_rules r
     JOIN categories c ON c.company_id = r.company_id AND c.id = r.category_id
     WHERE r.company_id = ? AND r.source = ? AND c.type = ?
       AND ((r.match_type = 'exact' AND r.pattern = ?)
         OR (r.match_type = 'contains' AND instr(?, r.pattern) > 0))
     ORDER BY r.match_type = 'exact' DESC, length(r.pattern) DESC, r.created_at, r.id
     LIMIT 1`,
    [companyId, source, type, key, text],
  ));
}
