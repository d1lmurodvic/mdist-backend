/**
 * The authentication and tenancy boundary.
 *
 *   authenticate   -> req.auth   { userId, sessionId, user, expiresAt }
 *   requireCompany -> req.tenant { companyId, role, membershipId }
 *   requireRole    -> 403 unless req.tenant.role is allowed
 *
 * Controllers never parse tokens or look up memberships themselves. 401 means
 * "not authenticated"; 403 means "authenticated but not permitted"; a
 * resource in another company is a 404 decided by the scoped model query.
 */

import { forbidden, unauthenticated } from '../lib/errors.js';

/** 32 random bytes in base64url: exactly 43 characters. */
const BEARER_TOKEN = /^Bearer ([A-Za-z0-9_-]{43})$/;

/** The session token from `Authorization: Bearer <token>`, or 401. */
export function readBearerToken(req) {
  const match = BEARER_TOKEN.exec(req.headers.authorization ?? '');
  if (!match) throw unauthenticated('Authentication is required.');
  return match[1];
}

/** The peer address. Proxy headers are not trusted: no proxy is configured. */
export function clientIp(req) {
  return req.socket?.remoteAddress ?? null;
}

export function authenticate({ authService }) {
  return function authenticateMiddleware(req) {
    req.auth = authService.resolveSession(readBearerToken(req), { ip: clientIp(req) });
    return undefined;
  };
}

export function requireCompany({ companyService }) {
  return function requireCompanyMiddleware(req) {
    const tenant = companyService.resolveTenant(req.auth.userId);
    if (!tenant) throw forbidden('Create your company workspace to continue.');
    req.tenant = tenant;
    return undefined;
  };
}

export function requireRole(...roles) {
  return function requireRoleMiddleware(req) {
    if (!roles.includes(req.tenant?.role)) throw forbidden('Your role does not permit this action.');
    return undefined;
  };
}
