/**
 * Settings controllers: /users/me (API_CONTRACT.md §9.2), company
 * configuration, member roles and demo data (§9.3).
 */

import { pathId } from './common.js';

export function createSettingsController({ services }) {
  const user = (req) => req.auth.userId;
  return {
    profile: (req) => ({ data: services.settings.profile(user(req)) }),
    updateProfile: (req) => ({ data: services.settings.updateProfile(user(req), req.validBody) }),
    async changePassword(req) {
      await services.settings.changePassword(user(req), req.auth.sessionId, req.validBody);
      return { status: 204 };
    },
    preferences: (req) => ({ data: services.settings.preferences(user(req)) }),
    updatePreferences: (req) => ({ data: services.settings.updatePreferences(user(req), req.validBody) }),

    updateCompany: (req) => ({ data: services.settings.updateCompany(req.tenant.companyId, req.validBody) }),
    updateMember: (req) => ({ data: services.settings.changeMemberRole(req.tenant.companyId, pathId(req, 'memberId', 'Member not found.'), req.validBody.role) }),

    async loadDemo(req) {
      return services.demoData.load(req.tenant.companyId);
    },
    async removeDemo(req) {
      await services.demoData.remove(req.tenant.companyId);
      return { status: 204 };
    },
  };
}
