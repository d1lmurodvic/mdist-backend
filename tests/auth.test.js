/**
 * Phase 2 authentication: registration, login, sessions, logout and the
 * authentication middleware, through the real HTTP pipeline.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import { PASSWORD, errorWithoutRequestId, registerUser } from './helpers/fixtures.js';
import { createLogger } from '../src/lib/logger.js';

const register = (request, body) => request('POST', '/api/v1/auth/register', { body });
const login = (request, body) => request('POST', '/api/v1/auth/login', { body });
const me = (request, token, headers) => request('GET', '/api/v1/auth/me', { token, headers });

/** Nothing secret or internal may appear in a response body. */
function assertNoSecrets(response, ...secrets) {
  for (const secret of ['scrypt$', 'passwordHash', 'password_hash', 'tokenHash', 'token_hash', ...secrets]) {
    assert.ok(!response.raw.includes(secret), `response leaked "${secret}": ${response.raw}`);
  }
}

// ---------------------------------------------------------------- registration

test('registration creates a user and a session, and nothing else', async (t) => {
  const { request, db, config, close } = await createTestApp();
  t.after(close);

  const before = Date.now();
  const response = await register(request, { email: 'owner@example.com', password: PASSWORD, name: 'Owner' });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  assert.equal(response.headers.get('location'), '/api/v1/auth/me');

  const { user, session } = response.data;
  assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'id', 'name']);
  assert.match(user.id, /^usr_/);
  assert.equal(user.email, 'owner@example.com');
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  const ttlMs = Date.parse(session.expiresAt) - before;
  assert.ok(Math.abs(ttlMs - config.session.ttlSeconds * 1000) < 5000, 'expires after the configured TTL');
  assertNoSecrets(response, PASSWORD);

  // Onboarding, not registration, creates the company (PRODUCT_REQUIREMENTS #2, #3).
  assert.equal(db.getValue('SELECT count(*) FROM companies'), 0);
  assert.equal(db.getValue('SELECT count(*) FROM memberships'), 0);
});

test('the password is stored only as a salted scrypt hash', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  await registerUser(request, { email: 'a@example.com' });
  await registerUser(request, { email: 'b@example.com' });
  const hashes = db.all('SELECT password_hash FROM users ORDER BY email').map((row) => row.password_hash);
  for (const hash of hashes) {
    assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{86}$/);
    assert.ok(!hash.includes(PASSWORD));
  }
  assert.notEqual(hashes[0], hashes[1], 'same password, different salt, different hash');
});

test('emails are trimmed and lower-cased before storage', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  const { user } = await registerUser(request, { email: '  Owner@Example.COM ' });
  assert.equal(user.email, 'owner@example.com');
  assert.equal(db.getValue('SELECT email FROM users'), 'owner@example.com');
});

test('a duplicate email is refused, including case and whitespace variants', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  await registerUser(request, { email: 'owner@example.com' });
  for (const variant of ['owner@example.com', 'Owner@Example.com', 'OWNER@EXAMPLE.COM', ' owner@example.com ']) {
    const response = await register(request, { email: variant, password: PASSWORD, name: 'Other' });
    assert.equal(response.status, 409, variant);
    assertErrorEnvelope(response, 'CONFLICT');
  }
  assert.equal(db.getValue('SELECT count(*) FROM users'), 1);
});

test('registration input is validated at the boundary', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  const valid = { email: 'new@example.com', password: PASSWORD, name: 'New' };
  const cases = [
    [{ ...valid, email: 'not-an-email' }, 'email'],
    [{ ...valid, email: '' }, 'email'],
    [{ ...valid, password: 'short77' }, 'password'],
    [{ ...valid, password: 'x'.repeat(129) }, 'password'],
    [{ ...valid, password: 12345678 }, 'password'],
    [{ ...valid, name: '   ' }, 'name'],
    [{ email: valid.email, password: valid.password }, 'name'],
    [{ ...valid, companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }, '_root'],
  ];
  for (const [body, field] of cases) {
    const response = await register(request, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assertErrorEnvelope(response, 'VALIDATION_ERROR');
    assert.ok(response.error.details.some((detail) => detail.field === field), `${field}: ${response.raw}`);
    assertNoSecrets(response, PASSWORD);
  }
  assert.equal(db.getValue('SELECT count(*) FROM users'), 0);
});

test('registration is atomic: if the session cannot be created, no user is left behind', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  db.exec("CREATE TRIGGER fail_sessions BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  const response = await register(request, { email: 'owner@example.com', password: PASSWORD, name: 'Owner' });
  assert.equal(response.status, 500);
  assertErrorEnvelope(response, 'INTERNAL_ERROR');
  assert.ok(!response.raw.includes('forced failure'));
  assert.equal(db.getValue('SELECT count(*) FROM users'), 0);

  db.exec('DROP TRIGGER fail_sessions');
  assert.equal((await register(request, { email: 'owner@example.com', password: PASSWORD, name: 'Owner' })).status, 201);
});

// ---------------------------------------------------------------- login

test('login with valid credentials opens a new session', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  const registered = await registerUser(request, { email: 'owner@example.com' });
  const response = await login(request, { email: 'owner@example.com', password: PASSWORD });
  assert.equal(response.status, 200);
  assertSuccessEnvelope(response);
  assert.equal(response.data.user.id, registered.user.id);
  assert.notEqual(response.data.session.token, registered.token);
  assertNoSecrets(response, PASSWORD);

  // Stored as a hash only; the token itself is nowhere in the database.
  assert.equal(db.getValue('SELECT count(*) FROM sessions WHERE user_id = ?', [registered.user.id]), 2);
  const stored = db.all('SELECT token_hash FROM sessions').map((row) => row.token_hash);
  assert.ok(stored.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  assert.ok(!stored.includes(response.data.session.token));

  assert.equal((await me(request, response.data.session.token)).status, 200);
});

test('login normalises the email before lookup', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  await registerUser(request, { email: 'owner@example.com' });
  const response = await login(request, { email: '  OWNER@Example.com ', password: PASSWORD });
  assert.equal(response.status, 200);
});

test('wrong password, unknown email and disabled account fail identically', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);

  await registerUser(request, { email: 'owner@example.com' });
  await registerUser(request, { email: 'disabled@example.com' });
  db.run("UPDATE users SET status = 'disabled' WHERE email = ?", ['disabled@example.com']);

  const failures = [
    await login(request, { email: 'owner@example.com', password: 'wrong password' }),
    await login(request, { email: 'nobody@example.com', password: PASSWORD }),
    await login(request, { email: 'disabled@example.com', password: PASSWORD }),
  ];
  for (const response of failures) {
    assert.equal(response.status, 401);
    assertErrorEnvelope(response, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assertNoSecrets(response, PASSWORD);
  }
  const [first, ...rest] = failures.map(errorWithoutRequestId);
  for (const other of rest) assert.deepEqual(other, first, 'no difference reveals whether the account exists');
  assert.equal(first.message, 'Email or password is incorrect.');
});

test('login input is validated, and the password is never trimmed', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  await registerUser(request, { email: 'owner@example.com', password: ' padded password ' });
  assert.equal((await login(request, { email: 'owner@example.com', password: 'padded password' })).status, 401);
  assert.equal((await login(request, { email: 'owner@example.com', password: ' padded password ' })).status, 200);

  for (const body of [{}, { email: 'owner@example.com' }, { email: 'bad', password: 'x' }, { email: 'owner@example.com', password: '' }]) {
    const response = await login(request, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assertErrorEnvelope(response, 'VALIDATION_ERROR');
  }
});

// ---------------------------------------------------------------- middleware & sessions

test('public routes need no session', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  assert.equal((await request('GET', '/api/v1/health')).status, 200);
  assert.equal((await register(request, { email: 'p@example.com', password: PASSWORD, name: 'P' })).status, 201);
  assert.equal((await login(request, { email: 'p@example.com', password: PASSWORD })).status, 200);
});

test('protected routes reject a missing or malformed credential with 401', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  const attempts = [
    await me(request, undefined),
    await me(request, undefined, { Authorization: token }),
    await me(request, undefined, { Authorization: `Basic ${token}` }),
    await me(request, undefined, { Authorization: 'Bearer short' }),
    await me(request, undefined, { Authorization: `Bearer ${token}x` }),
    await me(request, undefined, { Cookie: `session=${token}` }),
    await request('GET', `/api/v1/auth/me?token=${token}`),
  ];
  for (const response of attempts) {
    assert.equal(response.status, 401);
    assertErrorEnvelope(response, 'UNAUTHENTICATED');
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  }
});

test('unknown, expired and revoked sessions are 401, never 500', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });
  assert.equal((await me(request, token)).status, 200, 'valid session');

  const unknown = await me(request, 'A'.repeat(43));
  assert.equal(unknown.status, 401);
  assertErrorEnvelope(unknown, 'UNAUTHENTICATED');

  db.run('UPDATE sessions SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()]);
  const expired = await me(request, token);
  assert.equal(expired.status, 401);
  assertErrorEnvelope(expired, 'UNAUTHENTICATED');
  assert.deepEqual(errorWithoutRequestId(expired), errorWithoutRequestId(unknown), 'expired looks like unknown');

  const { token: second } = await registerUser(request, { email: 'second@example.com' });
  db.run('UPDATE sessions SET revoked_at = ? WHERE expires_at > ?', [new Date().toISOString(), new Date().toISOString()]);
  assert.equal((await me(request, second)).status, 401);
});

test('a session expires exactly at expires_at', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  db.run('UPDATE sessions SET expires_at = ?', [new Date(Date.now() + 60_000).toISOString()]);
  assert.equal((await me(request, token)).status, 200, 'one minute left');
  db.run('UPDATE sessions SET expires_at = ?', [new Date(Date.now() - 1).toISOString()]);
  assert.equal((await me(request, token)).status, 401, 'just expired');
});

test('a disabled user loses access with existing sessions', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });
  db.run("UPDATE users SET status = 'disabled'");
  assert.equal((await me(request, token)).status, 401);
});

test('GET /auth/me describes the user, the session and onboarding state only', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { user, token } = await registerUser(request, { email: 'owner@example.com' });

  const response = await me(request, token);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.user, user);
  assert.deepEqual(Object.keys(response.data.session), ['expiresAt']);
  assert.deepEqual(response.data.memberships, []);
  assert.equal(response.data.currentCompanyId, null);
  assert.deepEqual(response.data.onboarding, { companyCreated: false, completed: false });
  assertNoSecrets(response, token, PASSWORD);
});

test('IP binding, when enabled, rejects a session used from another address', async (t) => {
  const { request, app, close } = await createTestApp({ env: { SESSION_BIND_IP: 'true' } });
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  assert.equal((await me(request, token)).status, 200, 'same client address');
  const loopback = app.db.getValue('SELECT bound_ip FROM sessions');
  assert.ok(loopback, 'the login address is recorded');
  assert.throws(() => app.services.auth.resolveSession(token, { ip: '203.0.113.9' }), { code: 'UNAUTHENTICATED' });
  assert.doesNotThrow(() => app.services.auth.resolveSession(token, { ip: loopback }));
});

test('without IP binding (the default) no address is stored', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  await registerUser(request, { email: 'owner@example.com' });
  assert.equal(db.getValue('SELECT bound_ip FROM sessions'), null);
});

// ---------------------------------------------------------------- logout

test('logout revokes the session; protected routes then reject it', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });
  const other = (await login(request, { email: 'owner@example.com', password: PASSWORD })).data.session.token;

  const response = await request('POST', '/api/v1/auth/logout', { token });
  assert.equal(response.status, 204);
  assert.equal(response.raw, '');
  assert.equal(db.getValue('SELECT count(*) FROM sessions WHERE revoked_at IS NOT NULL'), 1);

  assert.equal((await me(request, token)).status, 401, 'logged-out session is rejected');
  assert.equal((await me(request, other)).status, 200, 'other sessions of the same user are untouched');
});

test('logout is idempotent for a well-formed token and 401 without one', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  assert.equal((await request('POST', '/api/v1/auth/logout', { token })).status, 204);
  assert.equal((await request('POST', '/api/v1/auth/logout', { token })).status, 204, 'repeat is safe');
  assert.equal((await request('POST', '/api/v1/auth/logout', { token: 'B'.repeat(43) })).status, 204, 'unknown token: nothing to revoke, nothing revealed');

  const missing = await request('POST', '/api/v1/auth/logout');
  assert.equal(missing.status, 401);
  assertErrorEnvelope(missing, 'UNAUTHENTICATED');
});

// ---------------------------------------------------------------- secrets in logs

test('passwords, tokens and hashes never reach the logs', async (t) => {
  const lines = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  t.after(() => {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  });

  const { request, db, close } = await createTestApp({ logger: createLogger({ level: 'debug' }) });
  t.after(close);

  const { token } = await registerUser(request, { email: 'owner@example.com' });
  const loginResponse = await login(request, { email: 'owner@example.com', password: PASSWORD });
  await login(request, { email: 'owner@example.com', password: 'wrong password 1' });
  await me(request, token);
  await request('POST', '/api/v1/auth/logout', { token });
  await request('POST', '/api/v1/auth/register', { body: { email: 'x@example.com', password: 'short', name: 'X' } });

  const logged = lines.join('');
  assert.ok(logged.includes('"message":"request"'), 'requests were logged');
  const hash = db.getValue('SELECT password_hash FROM users');
  for (const secret of [PASSWORD, 'wrong password 1', token, loginResponse.data.session.token, hash]) {
    assert.ok(!logged.includes(secret), `log leaked a secret: ${secret}`);
  }
  assert.doesNotMatch(logged, /"password":"(?!\[redacted\])/, 'a password field is only ever logged redacted');
});
