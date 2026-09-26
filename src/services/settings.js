/**
 * Settings (PRODUCT_REQUIREMENTS.md #25; API_CONTRACT.md §9.2, §9.3): the
 * user's profile, password and notification preferences; the company's
 * configuration; member roles.
 *
 * - The company currency cannot change once financial records exist: every
 *   stored amount is in that currency and IFRSmart does no conversion.
 * - Changing the fiscal year start after transactions exist moves every
 *   fiscal period boundary, so it needs `confirm: true`.
 * - A company always keeps at least one owner.
 */

import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { nowIsoTimestamp } from '../lib/dates.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import * as users from '../models/users.js';
import * as companies from '../models/companies.js';
import * as memberships from '../models/memberships.js';
import * as analytics from '../models/analytics.js';
import * as settings from '../models/settings.js';
import { toPublicUser } from './auth.js';

function isUniqueEmailViolation(error) {
  return typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed: users.email');
}

export function createSettingsService({ db, config, notifications }) {
  const scrypt = config.security.scrypt;

  return {
    profile(userId) {
      return toPublicUser(users.findUserById(db, userId));
    },

    updateProfile(userId, changes) {
      const current = users.findUserById(db, userId);
      const next = { name: changes.name ?? current.name, email: changes.email ?? current.email };
      try {
        db.transaction(() => {
          const owner = users.findUserByEmail(db, next.email);
          if (owner && owner.id !== userId) throw conflict('This email cannot be used.');
          settings.updateUserProfile(db, userId, { ...next, now: nowIsoTimestamp() });
        });
      } catch (error) {
        if (isUniqueEmailViolation(error)) throw conflict('This email cannot be used.');
        throw error;
      }
      return toPublicUser(users.findUserById(db, userId));
    },

    /** Verify the current password, store the new hash, end the user's other sessions. */
    async changePassword(userId, sessionId, { currentPassword, newPassword }) {
      const user = users.findUserById(db, userId);
      if (!(await verifyPassword(currentPassword, user.passwordHash, scrypt))) {
        throw unprocessable('The current password is incorrect.', [{ field: 'currentPassword', issue: 'does not match' }]);
      }
      const passwordHash = await hashPassword(newPassword, scrypt);
      const now = nowIsoTimestamp();
      db.transaction(() => {
        settings.updatePasswordHash(db, userId, { passwordHash, now });
        settings.revokeOtherSessions(db, userId, sessionId, now);
      });
    },

    preferences(userId) {
      return { notifications: notifications.preferencesOf(userId) };
    },

    updatePreferences(userId, changes) {
      return { notifications: notifications.updatePreferences(userId, changes) };
    },

    updateCompany(companyId, changes) {
      return db.transaction(() => {
        const current = companies.getCompany(db, companyId);
        const counts = analytics.companyRecordCounts(db, companyId);
        if (changes.currency !== undefined && changes.currency !== current.currency
          && (counts.accounts > 0 || counts.transactions > 0 || counts.invoices > 0)) {
          throw unprocessable('The currency cannot change once accounts, transactions or invoices exist: every amount is stored in the company currency and IFRSmart does not convert.', [
            { field: 'currency', issue: 'financial records already use the current currency' },
          ]);
        }
        if (changes.fiscalYearStartMonth !== undefined && changes.fiscalYearStartMonth !== current.fiscalYearStartMonth
          && counts.transactions > 0 && changes.confirm !== true) {
          throw unprocessable('Changing the fiscal year start moves every quarter and year boundary in reports. Send confirm: true to proceed.', [
            { field: 'fiscalYearStartMonth', issue: 'requires confirm: true because transactions exist' },
          ]);
        }
        settings.updateCompanyConfiguration(db, companyId, {
          name: changes.name ?? current.name,
          industry: changes.industry === undefined ? current.industry : changes.industry,
          size: changes.size === undefined ? current.size : changes.size,
          currency: changes.currency ?? current.currency,
          fiscalYearStartMonth: changes.fiscalYearStartMonth ?? current.fiscalYearStartMonth,
          now: nowIsoTimestamp(),
        });
        return companies.getCompany(db, companyId);
      });
    },

    changeMemberRole(companyId, membershipId, role) {
      return db.transaction(() => {
        const member = memberships.findMemberInCompany(db, companyId, membershipId);
        if (!member) throw notFound('Member not found.');
        if (member.role === 'owner' && role !== 'owner' && settings.countOwners(db, companyId) <= 1) {
          throw unprocessable('A company must keep at least one owner.', [{ field: 'role', issue: 'this is the only owner' }]);
        }
        settings.updateMemberRole(db, companyId, membershipId, role);
        return memberships.findMemberInCompany(db, companyId, membershipId);
      });
    },
  };
}
