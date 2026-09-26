/**
 * Tenancy: companies and memberships.
 *
 * - Onboarding (POST /companies) creates the company, the caller's owner
 *   membership and the Uncategorized category in one transaction
 *   (API_CONTRACT.md §9.3).
 * - One company per user in the MVP (ARCHITECTURE.md §7.1): a user who already
 *   has a membership cannot create another company. The schema still allows
 *   more memberships later; no company switching is built.
 * - The tenant for a request is resolved from the caller's membership only.
 */

import { conflict } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIsoTimestamp } from '../lib/dates.js';
import * as companies from '../models/companies.js';
import * as memberships from '../models/memberships.js';
import * as categories from '../models/categories.js';

export const ROLES = Object.freeze({ OWNER: 'owner', MEMBER: 'member' });

export function createCompanyService({ db }) {
  return {
    /**
     * The caller's tenant context, or null before onboarding. With more than
     * one membership (not creatable through the API), the oldest is used.
     */
    resolveTenant(userId) {
      const [membership] = memberships.findMembershipsForUser(db, userId);
      if (!membership) return null;
      return { companyId: membership.companyId, role: membership.role, membershipId: membership.id };
    },

    membershipsOf(userId) {
      return memberships.findMembershipsForUser(db, userId).map((membership) => ({
        id: membership.id,
        role: membership.role,
        company: {
          id: membership.companyId,
          name: membership.companyName,
          onboarded: membership.companyOnboardedAt !== null,
        },
      }));
    },

    /** @param {object} input validated onboarding fields */
    createCompanyForUser(userId, input) {
      return db.transaction(() => {
        if (memberships.findMembershipsForUser(db, userId).length > 0) {
          throw conflict('You already belong to a company workspace.');
        }
        const now = nowIsoTimestamp();
        const company = companies.insertCompany(db, { id: newId('cmp'), ...input, now });
        memberships.insertMembership(db, {
          id: newId('mem'),
          userId,
          companyId: company.id,
          role: ROLES.OWNER,
          now,
        });
        // Every company has its Uncategorized fallback from the start.
        categories.insertCategory(db, company.id, {
          id: newId('cat'), name: categories.UNCATEGORIZED_NAME, type: null, parentId: null, isSystem: true, now,
        });
        return company;
      });
    },

    getCompany(companyId) {
      return companies.getCompany(db, companyId);
    },

    completeOnboarding(companyId) {
      return companies.markCompanyOnboarded(db, companyId, nowIsoTimestamp());
    },

    listMembers(companyId) {
      return memberships.listMembersOfCompany(db, companyId);
    },

    findMember(companyId, membershipId) {
      return memberships.findMemberInCompany(db, companyId, membershipId);
    },
  };
}
