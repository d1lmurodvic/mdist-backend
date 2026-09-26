/**
 * /api/v1/auth (API_CONTRACT.md §9.1). register and login are public;
 * logout and me require a session.
 */

import { createRouter } from '../lib/router.js';
import { emailSchema, validateBody, z } from '../lib/validate.js';
import { authenticate } from '../middleware/auth.js';
import { createAuthController } from '../controllers/auth.js';

/** Upper bound on password length: bounded input, bounded hashing cost. */
export const PASSWORD_MAX_LENGTH = 128;

export function authSchemas(config) {
  return {
    register: z.strictObject({
      email: emailSchema,
      password: z
        .string()
        .min(config.security.passwordMinLength, `must be at least ${config.security.passwordMinLength} characters`)
        .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`),
      name: z.string().trim().min(1, 'is required').max(200),
    }),
    // No minimum length at login: a policy change must not lock anyone out,
    // and any mismatch is the same generic failure anyway.
    login: z.strictObject({
      email: emailSchema,
      password: z.string().min(1, 'is required').max(PASSWORD_MAX_LENGTH),
    }),
  };
}

export function createAuthRouter({ services, config, rateLimiter }) {
  const router = createRouter();
  const controller = createAuthController({ services, rateLimiter });
  const schemas = authSchemas(config);
  const requireAuth = authenticate({ authService: services.auth });

  router.post('/register', validateBody(schemas.register), controller.register);
  router.post('/login', validateBody(schemas.login), controller.login);
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth, controller.me);

  return router;
}
