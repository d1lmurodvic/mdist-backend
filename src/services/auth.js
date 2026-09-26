/**
 * Authentication: accounts, passwords and opaque server-side sessions.
 *
 * - Registration creates the user and a first session. It does not create a
 *   company: onboarding does (PRODUCT_REQUIREMENTS.md #2, #3; API_CONTRACT.md
 *   §9.1, §9.3).
 * - A session token is 32 random bytes (base64url). Only its SHA-256 hash is
 *   stored, so a database leak yields no usable token.
 * - Every login failure — unknown email, wrong password, disabled account —
 *   is the same UNAUTHENTICATED error, and an unknown email still costs one
 *   scrypt verification, so neither the answer nor its timing reveals whether
 *   an account exists.
 *
 * Rate limiting is applied by the auth controller, which sees the client IP.
 */

import { createHash } from 'node:crypto';
import { conflict, unauthenticated } from '../lib/errors.js';
import { newId, newSessionToken } from '../lib/ids.js';
import { nowIsoTimestamp } from '../lib/dates.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';
import * as users from '../models/users.js';
import * as sessions from '../models/sessions.js';

const INVALID_CREDENTIALS = 'Email or password is incorrect.';
const INVALID_SESSION = 'Authentication is required.';
/** A session's last_used_at is refreshed at most this often, to spare writes. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashSessionToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The only user fields that ever leave the service. */
export function toPublicUser(user) {
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

function isUniqueEmailViolation(error) {
  return typeof error?.message === 'string' && error.message.includes('UNIQUE constraint failed: users.email');
}

export function createAuthService({ db, config, now = () => new Date() }) {
  const scrypt = config.security.scrypt;
  let dummyHash = null;

  /** Created once, lazily: verified against when the email is unknown. */
  async function timingDummyHash() {
    dummyHash ??= await hashPassword(newSessionToken(), scrypt);
    return dummyHash;
  }

  function openSession(userId, ip) {
    const issuedAt = now();
    const token = newSessionToken();
    const expiresAt = new Date(issuedAt.getTime() + config.session.ttlSeconds * 1000).toISOString();
    sessions.insertSession(db, {
      id: newId('ses'),
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      boundIp: config.session.bindIp ? ip : null,
      now: issuedAt.toISOString(),
    });
    return { token, expiresAt };
  }

  return {
    /** @param {{email: string, password: string, name: string, ip: string|null}} input (validated, email canonical) */
    async register({ email, password, name, ip }) {
      // Hash before touching the database: the slow step never holds a
      // transaction open, and duplicate and new emails cost the same time.
      const passwordHash = await hashPassword(password, scrypt);

      try {
        return db.transaction(() => {
          if (users.findUserByEmail(db, email)) throw conflict('This email cannot be used to register.');
          const user = users.insertUser(db, { id: newId('usr'), email, passwordHash, name, now: nowIsoTimestamp() });
          const session = openSession(user.id, ip);
          return { user: toPublicUser(user), session };
        });
      } catch (error) {
        if (isUniqueEmailViolation(error)) throw conflict('This email cannot be used to register.');
        throw error;
      }
    },

    /** @param {{email: string, password: string, ip: string|null}} input (validated, email canonical) */
    async login({ email, password, ip }) {
      const user = users.findUserByEmail(db, email);
      const matches = await verifyPassword(password, user?.passwordHash ?? (await timingDummyHash()), scrypt);
      if (!user || !matches || user.status !== 'active') throw unauthenticated(INVALID_CREDENTIALS);

      sessions.deleteExpiredSessions(db, now().toISOString());
      return { user: toPublicUser(user), session: openSession(user.id, ip) };
    },

    /**
     * Resolve a bearer token to an identity, or throw UNAUTHENTICATED.
     * Unknown, revoked, expired, IP-mismatched and disabled-user sessions are
     * all rejected the same way.
     */
    resolveSession(token, { ip }) {
      const time = now();
      const session = sessions.findActiveSessionByTokenHash(db, hashSessionToken(token), time.toISOString());
      if (!session) throw unauthenticated(INVALID_SESSION);
      if (session.boundIp !== null && session.boundIp !== ip) throw unauthenticated(INVALID_SESSION);

      const user = users.findUserById(db, session.userId);
      if (!user || user.status !== 'active') throw unauthenticated(INVALID_SESSION);

      if (time.getTime() - Date.parse(session.lastUsedAt) >= TOUCH_INTERVAL_MS) {
        sessions.touchSession(db, session.id, time.toISOString());
      }
      return { userId: user.id, sessionId: session.id, user: toPublicUser(user), expiresAt: session.expiresAt };
    },

    /** Revoke the token's session. Idempotent: an unknown or ended session is a no-op. */
    logout(token) {
      sessions.revokeSessionByTokenHash(db, hashSessionToken(token), now().toISOString());
    },
  };
}
