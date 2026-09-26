import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertSuccessEnvelope, assertErrorEnvelope } from './helpers/testApp.js';

test('GET /api/v1/health returns the success envelope', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.equal(response.status, 200);
  assertSuccessEnvelope(response);
  assert.equal(response.data.status, 'ok');
  assert.equal(response.data.service, 'ifrsmart-backend');
  assert.equal(response.data.database, 'connected');
});

test('health reports the AI provider truthfully as disabled when unconfigured', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.equal(response.data.aiProvider, 'disabled', 'must not imply an AI model is in use');
});

test('health reports the configured provider name when one is set', async (t) => {
  const { request, close } = await createTestApp({
    env: { AI_PROVIDER: 'test-provider', AI_API_KEY: 'key', AI_MODEL: 'model' },
  });
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.equal(response.data.aiProvider, 'test-provider');
});

test('health never exposes secrets or database internals', async (t) => {
  const { request, close } = await createTestApp({
    env: { AI_PROVIDER: 'test-provider', AI_API_KEY: 'super-secret-key', AI_MODEL: 'model' },
  });
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.ok(!response.raw.includes('super-secret-key'), 'API key must never appear in a response');
});

test('an unknown route returns the documented 404 error envelope', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/does-not-exist');
  assert.equal(response.status, 404);
  assertErrorEnvelope(response, 'NOT_FOUND');
  assert.equal(response.error.requestId.startsWith('req_'), true);
});

test('a path outside /api/v1 returns 404', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/not-the-api');
  assert.equal(response.status, 404);
  assertErrorEnvelope(response, 'NOT_FOUND');
});

test('a wrong method on a known path returns 404, not 405-with-impl-detail', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('DELETE', '/api/v1/health');
  assert.equal(response.status, 404);
  assertErrorEnvelope(response, 'NOT_FOUND');
});

test('malformed JSON returns INVALID_JSON with a safe message', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('POST', '/api/v1/anything', {
    raw: '{ "broken": ',
    headers: { 'Content-Type': 'application/json' },
  });
  assertErrorEnvelope(response, 'INVALID_JSON');
  assert.ok(!response.raw.includes('at '), 'must not leak a stack trace');
});

test('a non-JSON content type is rejected', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('POST', '/api/v1/anything', {
    raw: 'plain text',
    headers: { 'Content-Type': 'text/plain' },
  });
  assertErrorEnvelope(response, 'UNSUPPORTED_MEDIA_TYPE');
});

test('a JSON array body is rejected — the contract requires an object', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('POST', '/api/v1/anything', { body: [1, 2, 3] });
  assertErrorEnvelope(response, 'INVALID_JSON');
});

test('an oversized body returns PAYLOAD_TOO_LARGE', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const oversized = JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) });
  const response = await request('POST', '/api/v1/anything', {
    raw: oversized,
    headers: { 'Content-Type': 'application/json' },
  });
  assertErrorEnvelope(response, 'PAYLOAD_TOO_LARGE');
});

test('every response carries a request id, echoed from the header when supplied', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const generated = await request('GET', '/api/v1/does-not-exist');
  assert.match(generated.error.requestId, /^req_/);
  assert.equal(generated.headers.get('x-request-id'), generated.error.requestId);

  const supplied = await request('GET', '/api/v1/does-not-exist', {
    headers: { 'X-Request-Id': 'req_client-supplied-123' },
  });
  assert.equal(supplied.error.requestId, 'req_client-supplied-123');
});

// Replaces a test of the same intent that could never fail: it sent a bad
// Content-Length, asserted nothing when the request errored, and never checked
// the error code. This one throws a real error inside a real route.
test('an internal error is reported as INTERNAL_ERROR without leaking internals', async (t) => {
  const { app, request, close } = await createTestApp();
  t.after(close);
  app.apiRouter.get('/__test/crash', () => {
    throw new Error('database file is locked (SQLITE_BUSY) at /srv/data/ifrsmart.sqlite');
  });

  const response = await request('GET', '/api/v1/__test/crash');
  assert.equal(response.status, 500);
  assertErrorEnvelope(response, 'INTERNAL_ERROR');
  assert.equal(response.error.message, 'An unexpected error occurred.');
  assert.ok(!/SQLITE|ifrsmart\.sqlite|\bat\s/.test(response.raw), response.raw);
});

test('the health probe lives only under the versioned prefix', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  assert.equal((await request('GET', '/api/v1/health')).status, 200);
  const unversioned = await request('GET', '/health');
  assert.equal(unversioned.status, 404);
  assertErrorEnvelope(unversioned, 'NOT_FOUND');
});

test('a 404 names the full requested path', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const response = await request('GET', '/api/v1/does-not-exist');
  assert.equal(response.error.message, 'No route matches GET /api/v1/does-not-exist.');
});

test('CORS preflight is answered for an allowed origin', async (t) => {
  const { request, close } = await createTestApp({
    env: { CORS_ALLOWED_ORIGINS: 'http://localhost:5173' },
  });
  t.after(close);

  const preflight = await request('OPTIONS', '/api/v1/health', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('CORS does not echo a disallowed origin', async (t) => {
  const { request, close } = await createTestApp({
    env: { CORS_ALLOWED_ORIGINS: 'http://localhost:5173' },
  });
  t.after(close);

  const preflight = await request('OPTIONS', '/api/v1/health', {
    headers: { Origin: 'https://evil.example.com' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('trailing slashes resolve to the same route', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health/');
  assert.equal(response.status, 200);
  assertSuccessEnvelope(response);
});
