/**
 * Router matching and mounting (BUG 3, and the path half of BUG 7).
 *
 * Before the fix, use('/auth', subRouter) never matched '/auth/login' (the
 * prefix was compared exactly), a mounted router saw the unstripped path, and
 * a malformed %-escape in a path parameter threw URIError (HTTP 500).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../src/lib/router.js';

/** A response double that records what the router sent. */
function fakeResponse() {
  return {
    writableEnded: false,
    statusCode: null,
    body: null,
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      this.body = body === undefined ? null : JSON.parse(body);
      this.writableEnded = true;
    },
  };
}

async function dispatch(router, method, path) {
  const req = { method, pathname: path };
  const res = fakeResponse();
  const handled = await router.handle(req, res);
  return { handled, req, res, data: res.body?.data };
}

function authRouter() {
  const auth = createRouter();
  auth.get('/', () => ({ data: { route: 'auth-root' } }));
  auth.post('/login', () => ({ data: { route: 'login' } }));
  auth.get('/sessions/:sessionId', (req) => ({ data: { route: 'session', params: req.params } }));
  return auth;
}

test('exact routes match whole paths only, with methods respected', async () => {
  const router = createRouter();
  router.get('/health', () => ({ data: { ok: true } }));

  assert.equal((await dispatch(router, 'GET', '/health')).data.ok, true);
  assert.equal((await dispatch(router, 'GET', '/health/extra')).handled, false);
  assert.equal((await dispatch(router, 'GET', '/healthz')).handled, false);
  assert.equal((await dispatch(router, 'POST', '/health')).handled, false, 'method must match');
});

test('a mounted router sees paths relative to its prefix', async () => {
  const api = createRouter().use('/auth', authRouter());

  assert.equal((await dispatch(api, 'POST', '/auth/login')).data.route, 'login');
  assert.equal((await dispatch(api, 'GET', '/auth')).data.route, 'auth-root');
  assert.equal((await dispatch(api, 'GET', '/auth/')).data.route, 'auth-root');
  assert.equal((await dispatch(api, 'GET', '/auth/login')).handled, false, 'GET is not registered for /login');
});

test('prefixes match by whole segments, never by string prefix', async () => {
  const api = createRouter().use('/auth', authRouter());
  for (const path of ['/authors', '/auth-x/login', '/authlogin', '/xauth/login', '/', '/login']) {
    assert.equal((await dispatch(api, 'POST', path)).handled, false, path);
    assert.equal((await dispatch(api, 'GET', path)).handled, false, path);
  }
});

test('nested mounts strip each prefix (/api/v1 -> /auth -> /login)', async () => {
  const v1 = createRouter().use('/auth', authRouter());
  const root = createRouter().use('/api/v1', v1);

  assert.equal((await dispatch(root, 'POST', '/api/v1/auth/login')).data.route, 'login');
  assert.equal((await dispatch(root, 'POST', '/api/v1/login')).handled, false);
  assert.equal((await dispatch(root, 'POST', '/api/v2/auth/login')).handled, false);
  assert.equal((await dispatch(root, 'POST', '/api/v1auth/login')).handled, false);
});

test('route parameters survive mounting and are percent-decoded', async () => {
  const root = createRouter().use('/api/v1', createRouter().use('/auth', authRouter()));
  const result = await dispatch(root, 'GET', '/api/v1/auth/sessions/ses%20abc');
  assert.deepEqual(result.data.params, { sessionId: 'ses abc' });
});

test('parameters captured by a mount prefix are merged into req.params', async () => {
  const payments = createRouter();
  payments.get('/payments/:paymentId', (req) => ({ data: { params: req.params } }));
  const api = createRouter().use('/invoices/:invoiceId', payments);

  const result = await dispatch(api, 'GET', '/invoices/inv_1/payments/pay_2');
  assert.deepEqual(result.data.params, { invoiceId: 'inv_1', paymentId: 'pay_2' });
});

test('an unmatched mount falls through to later layers', async () => {
  const api = createRouter()
    .use('/auth', authRouter())
    .get('/auth/legacy', () => ({ data: { route: 'legacy' } }));
  assert.equal((await dispatch(api, 'GET', '/auth/legacy')).data.route, 'legacy');
});

test('middleware mounted at a prefix runs only below that prefix', async () => {
  const seen = [];
  const api = createRouter()
    .use('/admin', (req) => {
      seen.push(req.pathname);
      return undefined;
    })
    .get('/admin/users', () => ({ data: {} }))
    .get('/administrators', () => ({ data: {} }));

  await dispatch(api, 'GET', '/admin/users');
  await dispatch(api, 'GET', '/administrators');
  assert.deepEqual(seen, ['/admin/users']);
});

test('a malformed percent-escape in a parameter is a 400 VALIDATION_ERROR, not a URIError', async () => {
  const api = createRouter().get('/items/:itemId', (req) => ({ data: req.params }));
  await assert.rejects(dispatch(api, 'GET', '/items/%E0%A4%A'), (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.deepEqual(error.details, [{ field: 'itemId', issue: 'contains malformed percent-encoding' }]);
    return true;
  });
});

test('a malformed segment in a path that does not match is not an error', async () => {
  const api = createRouter()
    .get('/items/:itemId/edit', () => ({ data: { route: 'edit' } }))
    .get('/other', () => ({ data: { route: 'other' } }));
  assert.equal((await dispatch(api, 'GET', '/items/%E0/view')).handled, false);
});

test('use() rejects handlers that are neither functions nor routers', () => {
  assert.throws(() => createRouter().use('/x', {}), TypeError);
  assert.throws(() => createRouter().use('/x'), TypeError);
  assert.throws(() => createRouter().use('/files/*', () => undefined), TypeError);
  assert.throws(() => createRouter().get('/x', 'not a function'), TypeError);
});
