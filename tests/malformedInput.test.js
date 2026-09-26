/**
 * Malformed client input is a 4xx, never a 500 (BUG 7).
 *
 * Before the fix, the request URL was parsed against the Host header, so
 * `Host: a b` threw "Invalid URL" and produced 500 INTERNAL_ERROR plus an
 * error-level log with a stack; a malformed %-escape in a path parameter did
 * the same through decodeURIComponent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';

const get = (target, host) =>
  `GET ${target} HTTP/1.1\r\n${host === undefined ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`;

function assertSafe400(response, field) {
  assert.equal(response.status, 400);
  assertErrorEnvelope(response, 'VALIDATION_ERROR');
  assert.equal(response.error.details[0].field, field);
  assert.equal(response.headers['x-request-id'], response.error.requestId);
  assert.ok(!/\bat\s+\S+\s+\(|node:internal|Invalid URL|URIError/.test(response.raw), response.raw);
}

test('a malformed Host header is a 400 VALIDATION_ERROR with the documented envelope', async (t) => {
  const { rawRequest, close } = await createTestApp();
  t.after(close);

  for (const host of ['a b', 'evil.example/path', 'user@host', 'host?x', 'host#frag', 'a\\b']) {
    assertSafe400(await rawRequest(get('/api/v1/health', host)), 'host');
  }
});

test('valid Host header forms are accepted', async (t) => {
  const { rawRequest, close } = await createTestApp();
  t.after(close);

  for (const host of ['localhost', 'localhost:4000', '127.0.0.1:4000', '[::1]:4000', 'api.ifrsmart.test', '']) {
    const response = await rawRequest(get('/api/v1/health', host));
    assert.equal(response.status, 200, `Host: "${host}"`);
    assert.equal(response.body.data.status, 'ok');
  }
});

test('an unparseable absolute-form request target is a 400', async (t) => {
  const { rawRequest, close } = await createTestApp();
  t.after(close);
  assertSafe400(await rawRequest(get('http://[bad/api/v1/health', 'localhost')), 'url');
});

test('a path starting with // is a path, never a host', async (t) => {
  const { rawRequest, close } = await createTestApp();
  t.after(close);

  // Resolved against a base, '//[/' would be an invalid host; it is a path.
  const odd = await rawRequest(get('//[/', 'localhost'));
  assert.equal(odd.status, 404);
  assertErrorEnvelope(odd, 'NOT_FOUND');

  const doubled = await rawRequest(get('//api/v1/health', 'localhost'));
  assert.equal(doubled.status, 200, 'empty segments are ignored, as for any other path');
});

test('a malformed percent-escape in a path parameter is a 400 through the real pipeline', async (t) => {
  const { app, request, close } = await createTestApp();
  t.after(close);
  app.apiRouter.get('/__test/items/:itemId', (req) => ({ data: { itemId: req.params.itemId } }));

  const ok = await request('GET', '/api/v1/__test/items/inv%20001');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.itemId, 'inv 001');

  const bad = await request('GET', '/api/v1/__test/items/%E0%A4%A');
  assert.equal(bad.status, 400);
  assertErrorEnvelope(bad, 'VALIDATION_ERROR');
  assert.deepEqual(bad.error.details, [{ field: 'itemId', issue: 'contains malformed percent-encoding' }]);
  assert.ok(!/URIError|at\s+\S+\s+\(/.test(bad.raw));
});
