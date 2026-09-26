/** categories: company-scoped two-level hierarchy (tenantScope.js). */

import { assertCompanyScope } from './tenantScope.js';

export const UNCATEGORIZED_NAME = 'Uncategorized';

const COLUMNS = 'id, name, type, parent_id, is_system, created_at, updated_at';

function toCategory(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    isSystem: row.is_system === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** System category first, then income before expense, parents before children, by name. */
export function listCategories(db, companyId) {
  assertCompanyScope(companyId);
  return db
    .all(
      `SELECT c.id, c.name, c.type, c.parent_id, c.is_system, c.created_at, c.updated_at
       FROM categories c
       LEFT JOIN categories p ON p.company_id = c.company_id AND p.id = c.parent_id
       WHERE c.company_id = ?
       ORDER BY c.is_system DESC, c.type = 'expense', coalesce(p.name, c.name) COLLATE NOCASE,
                c.parent_id IS NOT NULL, c.name COLLATE NOCASE, c.id`,
      [companyId],
    )
    .map(toCategory);
}

export function findCategory(db, companyId, categoryId) {
  assertCompanyScope(companyId);
  return toCategory(db.get(`SELECT ${COLUMNS} FROM categories WHERE company_id = ? AND id = ?`, [companyId, categoryId]));
}

export function findCategoryByName(db, companyId, name) {
  assertCompanyScope(companyId);
  return toCategory(db.get(`SELECT ${COLUMNS} FROM categories WHERE company_id = ? AND name = ? COLLATE NOCASE`, [companyId, name]));
}

export function findUncategorized(db, companyId) {
  assertCompanyScope(companyId);
  return toCategory(db.get(`SELECT ${COLUMNS} FROM categories WHERE company_id = ? AND is_system = 1`, [companyId]));
}

export function countChildren(db, companyId, categoryId) {
  assertCompanyScope(companyId);
  return db.getValue('SELECT count(*) FROM categories WHERE company_id = ? AND parent_id = ?', [companyId, categoryId]);
}

export function insertCategory(db, companyId, { id, name, type, parentId, isSystem = false, now }) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO categories (id, company_id, name, type, parent_id, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, companyId, name, type, parentId, isSystem, now, now],
  );
  return findCategory(db, companyId, id);
}

/** `parentId` undefined leaves the parent unchanged; null moves to top level. */
export function updateCategory(db, companyId, categoryId, { name, parentId, now }) {
  assertCompanyScope(companyId);
  if (name !== undefined) {
    db.run('UPDATE categories SET name = ?, updated_at = ? WHERE company_id = ? AND id = ?', [name, now, companyId, categoryId]);
  }
  if (parentId !== undefined) {
    db.run('UPDATE categories SET parent_id = ?, updated_at = ? WHERE company_id = ? AND id = ?', [parentId, now, companyId, categoryId]);
  }
  return findCategory(db, companyId, categoryId);
}
