/**
 * Auth controllers: HTTP only. Validated input in, one service call, response
 * descriptor out. Rate limiting lives here because it keys on the client IP.
 */

import { rateLimited } from '../lib/errors.js';
import { clientIp, readBearerToken } from '../middleware/auth.js';

const MINUTE_MS = 60 * 1000;

/**
 * Basic brute-force protection (PRODUCT_REQUIREMENTS.md #2). Failed logins
 * are counted per email and per client IP; registrations per client IP.
 */
export const AUTH_RATE_LIMITS = Object.freeze({
  loginFailuresPerEmail: { limit: 5, windowMs: 15 * MINUTE_MS },
  loginFailuresPerIp: { limit: 20, windowMs: 15 * MINUTE_MS },
  registrationsPerIp: { limit: 10, windowMs: 60 * MINUTE_MS },
});

const TOO_MANY_ATTEMPTS = 'Too many attempts. Try again later.';

export function createAuthController({ services, rateLimiter }) {
  function enforce(keys) {
    const wait = Math.max(...keys.map(([key, rule]) => rateLimiter.retryAfterSeconds(key, rule.limit)));
    if (wait > 0) throw rateLimited(TOO_MANY_ATTEMPTS, wait);
  }

  return {
    async register(req) {
      const ip = clientIp(req);
      const ipKey = ['register:ip:' + ip, AUTH_RATE_LIMITS.registrationsPerIp];
      enforce([ipKey]);
      rateLimiter.hit(ipKey[0], ipKey[1].windowMs);

      const { user, session } = await services.auth.register({ ...req.validBody, ip });
      return {
        status: 201,
        headers: { Location: '/api/v1/auth/me' },
        data: { user, session },
      };
    },

    async login(req) {
      const ip = clientIp(req);
      const { email, password } = req.validBody;
      const emailKey = ['login:email:' + email, AUTH_RATE_LIMITS.loginFailuresPerEmail];
      const ipKey = ['login:ip:' + ip, AUTH_RATE_LIMITS.loginFailuresPerIp];
      enforce([emailKey, ipKey]);

      try {
        const { user, session } = await services.auth.login({ email, password, ip });
        rateLimiter.clear(emailKey[0]);
        return { data: { user, session } };
      } catch (error) {
        if (error?.code === 'UNAUTHENTICATED') {
          rateLimiter.hit(emailKey[0], emailKey[1].windowMs);
          rateLimiter.hit(ipKey[0], ipKey[1].windowMs);
        }
        throw error;
      }
    },

    /** 401 without a well-formed token; otherwise 204 whether or not it was still active. */
    logout(req) {
      services.auth.logout(readBearerToken(req));
      return { status: 204 };
    },

    me(req) {
      const memberships = services.companies.membershipsOf(req.auth.userId);
      const tenant = services.companies.resolveTenant(req.auth.userId);
      const current = memberships.find((membership) => membership.company.id === tenant?.companyId) ?? null;
      return {
        data: {
          user: req.auth.user,
          session: { expiresAt: req.auth.expiresAt },
          memberships,
          currentCompanyId: current?.company.id ?? null,
          onboarding: {
            companyCreated: current !== null,
            completed: current?.company.onboarded ?? false,
          },
        },
      };
    },
  };
}
