/**
 * memberships: user <-> company access with a role ('owner' | 'member').
 * This table is the tenant boundary: a caller's company is whatever their
 * membership says, resolved server-side on every request.
 */

import { assertCompanyScope } from './tenantScope.js';

export function insertMembership(db, { id, userId, companyId, role, now }) {
  db.run(
    'INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, userId, companyId, role, now],
  );
}

/** Every membership of a user, oldest first, with the company's name. */
export function findMembershipsForUser(db, userId) {
  return db
    .all(
      `SELECT m.id, m.company_id, m.role, m.created_at, c.name AS company_name, c.onboarded_at
       FROM memberships m
       JOIN companies c ON c.id = m.company_id
       WHERE m.user_id = ?
       ORDER BY m.created_at, m.id`,
      [userId],
    )
    .map((row) => ({
      id: row.id,
      companyId: row.company_id,
      role: row.role,
      createdAt: row.created_at,
      companyName: row.company_name,
      companyOnboardedAt: row.onboarded_at,
    }));
}

function toMember(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    role: row.role,
    createdAt: row.created_at,
    user: { id: row.user_id, name: row.user_name, email: row.user_email },
  };
}

const MEMBER_SELECT = `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.name AS user_name, u.email AS user_email
  FROM memberships m JOIN users u ON u.id = m.user_id`;

export function listMembersOfCompany(db, companyId) {
  assertCompanyScope(companyId);
  return db.all(`${MEMBER_SELECT} WHERE m.company_id = ? ORDER BY m.created_at, m.id`, [companyId]).map(toMember);
}

/** One member of the caller's company; another company's member is not found. */
export function findMemberInCompany(db, companyId, membershipId) {
  assertCompanyScope(companyId);
  return toMember(db.get(`${MEMBER_SELECT} WHERE m.company_id = ? AND m.id = ?`, [companyId, membershipId]));
}
