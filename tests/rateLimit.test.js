/**
 * Phase 2 rate limiting on authentication endpoints.
 * Limits: 5 failed logins per email and 20 per client IP per 15 minutes;
 * 10 registrations per client IP per hour (controllers/auth.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { PASSWORD, registerUser } from './helpers/fixtures.js';
import { createRateLimiter } from '../src/lib/rateLimiter.js';
import { AUTH_RATE_LIMITS } from '../src/controllers/auth.js';

const login = (request, email, password) => request('POST', '/api/v1/auth/login', { body: { email, password } });

function assertRateLimited(response, rule = AUTH_RATE_LIMITS.loginFailuresPerEmail) {
  assert.equal(response.status, 429);
  assertErrorEnvelope(response, 'RATE_LIMITED');
  const retryAfter = Number(response.headers.get('retry-after'));
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= rule.windowMs / 1000,
    `Retry-After: ${retryAfter}`,
  );
}

test('repeated failed logins for one email end in RATE_LIMITED, even with the right password', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });

  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerEmail.limit; i += 1) {
    assert.equal((await login(request, 'owner@example.com', `wrong ${i}`)).status, 401, `attempt ${i + 1}`);
  }
  assertRateLimited(await login(request, 'owner@example.com', 'wrong again'));
  assertRateLimited(await login(request, 'OWNER@example.com', PASSWORD));
});

test('the email limit is per account: another account can still log in', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });
  await registerUser(request, { email: 'other@example.com' });

  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerEmail.limit; i += 1) await login(request, 'owner@example.com', 'wrong');
  assert.equal((await login(request, 'other@example.com', PASSWORD)).status, 200);
});

test('a successful login clears the failure count for that email', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });

  const almost = AUTH_RATE_LIMITS.loginFailuresPerEmail.limit - 1;
  for (let i = 0; i < almost; i += 1) await login(request, 'owner@example.com', 'wrong');
  assert.equal((await login(request, 'owner@example.com', PASSWORD)).status, 200);
  for (let i = 0; i < almost; i += 1) {
    assert.equal((await login(request, 'owner@example.com', 'wrong')).status, 401, 'counting restarted');
  }
  assert.equal((await login(request, 'owner@example.com', PASSWORD)).status, 200);
});

test('parallel login attempts cannot get past the email limit', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });

  const attempts = 40;
  const responses = await Promise.all(
    Array.from({ length: attempts }, (_, i) => login(request, 'owner@example.com', i === attempts - 1 ? PASSWORD : `wrong ${i}`)),
  );
  const statuses = responses.map((response) => response.status);
  const passed = statuses.filter((status) => status !== 429).length;
  assert.ok(passed <= AUTH_RATE_LIMITS.loginFailuresPerEmail.limit, `${passed} attempts reached the password check`);
  responses.filter((response) => response.status === 429).forEach((response) => assertRateLimited(response));
});

test('a successful login does not count against the per-IP failure limit', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });

  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerIp.limit + 5; i += 1) {
    assert.equal((await login(request, 'owner@example.com', PASSWORD)).status, 200, `login ${i + 1}`);
  }
  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerIp.limit - 1; i += 1) {
    assert.equal((await login(request, `user${i}@example.com`, 'wrong')).status, 401, `failure ${i + 1}`);
  }
});

test('failures across many emails from one IP hit the per-IP limit', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerIp.limit; i += 1) {
    assert.equal((await login(request, `user${i}@example.com`, 'wrong')).status, 401);
  }
  assertRateLimited(await login(request, 'fresh@example.com', 'wrong'));
});

test('malformed login requests are rejected without consuming the budget', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });

  for (let i = 0; i < 10; i += 1) {
    assert.equal((await request('POST', '/api/v1/auth/login', { body: { email: 'owner@example.com' } })).status, 400);
  }
  assert.equal((await login(request, 'owner@example.com', PASSWORD)).status, 200);
});

test('registrations are limited per client IP', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  for (let i = 0; i < AUTH_RATE_LIMITS.registrationsPerIp.limit; i += 1) {
    await registerUser(request, { email: `user${i}@example.com` });
  }
  const blocked = await request('POST', '/api/v1/auth/register', {
    body: { email: 'one-more@example.com', password: PASSWORD, name: 'One More' },
  });
  assertRateLimited(blocked, AUTH_RATE_LIMITS.registrationsPerIp);
});

test('limiter state can be reset, and every app instance starts clean', async (t) => {
  const first = await createTestApp();
  t.after(first.close);
  await registerUser(first.request, { email: 'owner@example.com' });
  for (let i = 0; i < AUTH_RATE_LIMITS.loginFailuresPerEmail.limit; i += 1) await login(first.request, 'owner@example.com', 'wrong');
  assertRateLimited(await login(first.request, 'owner@example.com', PASSWORD));

  first.app.rateLimiter.reset();
  assert.equal((await login(first.request, 'owner@example.com', PASSWORD)).status, 200);

  const second = await createTestApp();
  t.after(second.close);
  await registerUser(second.request, { email: 'owner@example.com' });
  assert.equal((await login(second.request, 'owner@example.com', PASSWORD)).status, 200, 'no state shared between apps');
});

test('the limiter window expires on its own', () => {
  let time = 1_000_000;
  const limiter = createRateLimiter({ now: () => time });
  const windowMs = 60_000;

  limiter.hit('k', windowMs);
  limiter.hit('k', windowMs);
  assert.equal(limiter.retryAfterSeconds('k', 3), 0, 'under the limit');
  limiter.hit('k', windowMs);
  assert.equal(limiter.retryAfterSeconds('k', 3), 60);

  time += 30_000;
  assert.equal(limiter.retryAfterSeconds('k', 3), 30, 'counts down');
  time += 30_000;
  assert.equal(limiter.retryAfterSeconds('k', 3), 0, 'window over');
  limiter.hit('k', windowMs);
  assert.equal(limiter.retryAfterSeconds('k', 2), 0, 'a fresh window started');

  limiter.clear('k');
  assert.equal(limiter.retryAfterSeconds('k', 1), 0);
});

test('TRUST_PROXY: registrations are limited per forwarded client address, not per proxy', async (t) => {
  const { request, close } = await createTestApp({ env: { TRUST_PROXY: 'true' } });
  t.after(close);
  const register = (i, ip) => request('POST', '/api/v1/auth/register', {
    body: { email: `proxy${ip}-${i}@example.com`, password: PASSWORD, name: 'Proxy' },
    headers: { 'X-Forwarded-For': `203.0.113.99, ${ip}` },
  });
  for (let i = 0; i < AUTH_RATE_LIMITS.registrationsPerIp.limit; i += 1) {
    assert.equal((await register(i, '198.51.100.1')).status, 201, `attempt ${i + 1}`);
  }
  assertRateLimited(await register(99, '198.51.100.1'), AUTH_RATE_LIMITS.registrationsPerIp);
  // Another client behind the same proxy is not affected.
  assert.equal((await register(0, '198.51.100.2')).status, 201);
});

test('without TRUST_PROXY, X-Forwarded-For is ignored', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  for (let i = 0; i < AUTH_RATE_LIMITS.registrationsPerIp.limit; i += 1) {
    await request('POST', '/api/v1/auth/register', {
      body: { email: `direct${i}@example.com`, password: PASSWORD, name: 'Direct' },
      headers: { 'X-Forwarded-For': `198.51.100.${i}` },
    });
  }
  const response = await request('POST', '/api/v1/auth/register', { body: { email: 'direct99@example.com', password: PASSWORD, name: 'Direct' } });
  assertRateLimited(response, AUTH_RATE_LIMITS.registrationsPerIp);
});
