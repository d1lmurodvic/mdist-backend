/**
 * CORS behaviour.
 *
 * The browser frontend is served separately (Vite dev server on :5173), so the
 * API must opt specific origins in. Credentials and a wildcard origin are
 * mutually exclusive per the Fetch specification: a browser rejects
 * `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true`, so the pairing must never occur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTestApp } from './helpers/testApp.js';

const FRONTEND_ORIGIN = 'http://localhost:5173';

test('the configured frontend origin is echoed and credentials are allowed', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health', {
    headers: { Origin: FRONTEND_ORIGIN },
  });

  assert.equal(response.status, 200);
  // An explicit origin, never a wildcard, so credentials remain usable.
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.match(response.headers.get('vary') ?? '', /Origin/);
});

test('a credentialed request from the configured origin succeeds', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  // The shape a browser sends for a cookie-authenticated call.
  const response = await request('GET', '/api/v1/health', {
    headers: { Origin: FRONTEND_ORIGIN, Cookie: 'sid=opaque-session-token' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  // Both halves a browser requires before it will expose the response.
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});

test('an unlisted origin receives no CORS grant', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health', {
    headers: { Origin: 'https://evil.example' },
  });

  // The request still executes server-side; the browser is what blocks it.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('a same-origin request without an Origin header gets no CORS headers', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('a preflight from the configured origin is answered with the allowed methods', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('OPTIONS', '/api/v1/health', {
    headers: {
      Origin: FRONTEND_ORIGIN,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type, authorization',
    },
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);

  const allowedHeaders = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert.match(allowedHeaders, /content-type/);
  assert.match(allowedHeaders, /authorization/);
});

test('a wildcard configuration never pairs with credentials', async (t) => {
  const { request, close } = await createTestApp({ env: { CORS_ALLOWED_ORIGINS: '*' } });
  t.after(close);

  const response = await request('GET', '/api/v1/health', {
    headers: { Origin: 'https://any.example' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  // The invalid combination is the thing being guarded against.
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
});

test('multiple explicit origins are all honoured, each echoed exactly', async (t) => {
  const { request, close } = await createTestApp({
    env: { CORS_ALLOWED_ORIGINS: 'http://localhost:5173, https://app.ifrsmart.test' },
  });
  t.after(close);

  for (const origin of ['http://localhost:5173', 'https://app.ifrsmart.test']) {
    const response = await request('GET', '/api/v1/health', { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  }

  const rejected = await request('GET', '/api/v1/health', {
    headers: { Origin: 'https://app.ifrsmart.test.evil' },
  });
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});

test('with explicit origins every response varies by Origin, granted or not', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  // A shared cache must not hand a no-grant response to the allowed origin.
  for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: FRONTEND_ORIGIN }]) {
    const response = await request('GET', '/api/v1/health', { headers });
    assert.match(response.headers.get('vary') ?? '', /Origin/, JSON.stringify(headers));
  }
  const notFound = await request('GET', '/api/v1/nope', { headers: { Origin: FRONTEND_ORIGIN } });
  assert.equal(notFound.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN, 'errors are readable by the frontend');
});

test('a disallowed preflight is answered without any grant', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const response = await request('OPTIONS', '/api/v1/health', {
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('access-control-allow-methods'), null);
});

test('the default configuration allows the local demo frontend', async (t) => {
  const { config, request, close } = await createTestApp();
  t.after(close);

  assert.deepEqual([...config.server.corsAllowedOrigins], [FRONTEND_ORIGIN]);
  // No default may ever be a wildcard.
  assert.equal(config.server.corsAllowedOrigins.includes('*'), false);

  const response = await request('GET', '/api/v1/health', {
    headers: { Origin: FRONTEND_ORIGIN },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), FRONTEND_ORIGIN);
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
});
