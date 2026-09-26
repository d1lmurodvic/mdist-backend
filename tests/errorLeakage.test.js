/**
 * Regression guard: internal diagnostics must never reach a client.
 *
 * DEVELOPMENT_RULES.md §6.8 and API_CONTRACT.md §3 require that a failure
 * response carries only { code, message, details?, requestId }. Stack traces,
 * SQL, absolute paths and configuration are logged server-side and reduced to a
 * generic INTERNAL_ERROR on the wire.
 *
 * These tests deliberately throw real internal errors so the "no leak" rule is
 * proven against the code that actually produces the response, rather than
 * asserted by inspection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createErrorHandler } from '../src/middleware/errorHandler.js';
import { createLogger } from '../src/lib/logger.js';
import { AppError } from '../src/lib/errors.js';

/** A secret planted in the internal error, to prove it is not echoed back. */
const SECRET = 'super-secret-database-password-9f2b';

/**
 * Signatures that must never appear in a client-visible error body.
 * Each is a class of internal information, not a specific message.
 */
const LEAK_PATTERNS = [
  ['stack frame', /(^|\n)\s*at\s+[^\s(]/],
  ['error class name', /\b(TypeError|ReferenceError|RangeError|SyntaxError|AppError|Error):/],
  ['node internals', /node:internal/],
  ['source location', /[A-Za-z0-9_./-]+\.(js|mjs|cjs):\d+(:\d+)?/],
  ['absolute filesystem path', /([A-Za-z]:\\|\/home\/|\/Users\/|\/root\/|\/tmp\/)/],
  ['sqlite internals', /SQLITE_|SQLITE_ERROR|no such (table|column)/i],
  ['errno', /\berrno\b|\bEACCES\b|\bEPIPE\b/],
  ['stack key', /"?stack"?\s*[:}]/i],
  ['cause chain', /"?cause"?\s*[:}]/i],
  ['planted secret', new RegExp(SECRET)],
  ['secret-bearing key', /"(password|token|apiKey|api_key|secret|authorization|cookie)"\s*:/i],
];

/** Assert a raw response body carries no internal diagnostics. */
function assertNoLeak(raw, label) {
  for (const [name, pattern] of LEAK_PATTERNS) {
    assert.ok(
      !pattern.test(raw),
      `${label}: response leaked a ${name}.\n--- body ---\n${raw}\n---------------`,
    );
  }
}

/** Deep-check that no key anywhere in the envelope looks internal. */
function assertNoInternalKeys(value, label, path = 'error') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInternalKeys(item, label, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert.ok(
      !/^(stack|cause|errno|code_|sql|query|path|file|line|column|original)$/i.test(key),
      `${label}: envelope key "${key}" at ${path} exposes internal detail.`,
    );
    assertNoInternalKeys(item, label, `${path}.${key}`);
  }
}

test('the documented error envelope is still produced, with no stack or internals', async (t) => {
  const { request, rawRequest, close } = await createTestApp();
  t.after(close);

  const cases = [
    ['unknown route', () => request('GET', '/api/v1/does-not-exist'), 'NOT_FOUND', 404],
    ['outside the versioned prefix', () => request('GET', '/nope'), 'NOT_FOUND', 404],
    ['malformed JSON', () => request('POST', '/api/v1/x', { raw: '{ "a": ' }), 'INVALID_JSON', 400],
    ['non-JSON content type', () => request('POST', '/api/v1/x', { raw: 'a=1', headers: { 'Content-Type': 'text/plain' } }), 'UNSUPPORTED_MEDIA_TYPE', 415],
    ['JSON array body', () => request('POST', '/api/v1/x', { raw: '[1,2]' }), 'INVALID_JSON', 400],
    ['oversized body', () => request('POST', '/api/v1/x', { raw: 'x'.repeat(2 * 1024 * 1024) }), 'PAYLOAD_TOO_LARGE', 413],
    ['malformed Host header', () => rawRequest('GET /api/v1/health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n'), 'VALIDATION_ERROR', 400],
    ['malformed request target', () => rawRequest('GET http://[bad/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 'VALIDATION_ERROR', 400],
  ];

  for (const [label, send, code, status] of cases) {
    const response = await send();
    assert.equal(response.status, status, `${label}: unexpected status`);
    // Contract compliance is preserved...
    assertErrorEnvelope(response, code);
    assertNoInternalKeys(response.body, label);
    // ...and nothing internal rides along with it.
    assertNoLeak(response.raw, label);
  }
});

test('an unexpected internal error is reduced to a generic INTERNAL_ERROR', async (t) => {
  const logs = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    logs.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = originalWrite;
  });

  const logger = createLogger({ level: 'error' });
  const errorHandler = createErrorHandler({ logger });

  // Real HTTP server, real response, real error handler: the genuine
  // unhandled-error path, with a secret planted in the thrown error.
  const boom = new Error(`connection to postgres failed: ${SECRET}`);
  boom.code = 'ECONNREFUSED';

  const server = http.createServer((req, res) => {
    req.id = 'req_leaktest0000000000000001';
    errorHandler(boom, req, res, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/anything`);
  const raw = await response.text();

  assert.equal(response.status, 500);
  const body = JSON.parse(raw);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'An unexpected error occurred.');
  assert.equal(body.error.requestId, 'req_leaktest0000000000000001');
  // No details key at all: there is nothing safe to add.
  assert.equal('details' in body.error, false);

  assertNoLeak(raw, 'internal error');
  assertNoInternalKeys(body, 'internal error');

  // Diagnostics are preserved server-side; only the delivery is forbidden.
  // The stack is written to the log, so the failure is still diagnosable.
  const logged = logs.join('');
  assert.match(logged, /"level":"error"/);
  assert.ok(logged.includes(boom.stack.split('\n')[0]), 'the stack must still be logged');
  assert.match(logged, /node:internal/, 'the logged stack should be the real one');
});

test('a thrown non-Error value cannot leak its representation', async (t) => {
  const logger = createLogger({ level: 'silent' });
  const errorHandler = createErrorHandler({ logger });

  const server = http.createServer((req, res) => {
    req.id = 'req_leaktest0000000000000002';
    // A string carrying a stack and a secret: a careless handler would echo it.
    errorHandler(`boom ${SECRET}\n    at deep (/srv/app/src/db.js:10:5)`, req, res, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const raw = await (await fetch(`http://127.0.0.1:${port}/api/v1/anything`)).text();

  assert.equal(JSON.parse(raw).error.code, 'INTERNAL_ERROR');
  assertNoLeak(raw, 'non-Error throw');
});

test('a deliberate AppError keeps its field details but never gains a stack', async (t) => {
  const logger = createLogger({ level: 'silent' });
  const errorHandler = createErrorHandler({ logger });

  const server = http.createServer((req, res) => {
    req.id = 'req_leaktest0000000000000003';
    const error = new AppError('VALIDATION_ERROR', 'Request failed validation.', [
      { field: 'amountMinor', issue: 'must be an integer number of minor units' },
    ]);
    // Even if something upstream attaches a stack, it must not be serialised.
    error.stack = `Error: leaked\n    at handler (${SECRET})`;
    errorHandler(error, req, res, () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const raw = await (await fetch(`http://127.0.0.1:${port}/api/v1/anything`)).text();
  const body = JSON.parse(raw);

  // Contract compliance: field-level detail is still delivered to the client.
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.deepEqual(body.error.details, [
    { field: 'amountMinor', issue: 'must be an integer number of minor units' },
  ]);
  assertNoLeak(raw, 'AppError with stack');
  assertNoInternalKeys(body, 'AppError with stack');
});

/** Capture stderr (where error-level logs go) for the duration of a test. */
function captureStderr(t) {
  const logs = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    logs.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return logs;
}

test('an internal error thrown inside a real route is reduced to INTERNAL_ERROR end to end', async (t) => {
  const { app, request, close } = await createTestApp();
  t.after(close);

  // A genuine exception through the full pipeline: request context, CORS,
  // JSON body parsing, the /api/v1 mount, the router and the error handler.
  app.apiRouter.get('/__test/boom', () => {
    const error = new TypeError(`Cannot read properties of undefined (reading 'x') ${SECRET}`);
    error.cause = new Error(`SQLITE_ERROR: no such table: ledger ${SECRET}`);
    throw error;
  });
  app.apiRouter.post('/__test/boom-string', () => {
    throw `raw string ${SECRET}\n    at handler (/srv/app/src/x.js:1:1)`;
  });

  for (const [method, path] of [['GET', '/api/v1/__test/boom'], ['POST', '/api/v1/__test/boom-string']]) {
    const response = await request(method, path, method === 'POST' ? { body: {} } : {});
    assert.equal(response.status, 500);
    assertErrorEnvelope(response, 'INTERNAL_ERROR');
    assert.equal(response.error.message, 'An unexpected error occurred.');
    assert.equal('details' in response.error, false);
    assert.equal(response.headers.get('x-request-id'), response.error.requestId);
    assertNoLeak(response.raw, `${method} ${path}`);
    assertNoInternalKeys(response.body, `${method} ${path}`);
  }
});

test('the internal error is diagnosable server-side under its event name', async (t) => {
  const logs = captureStderr(t);
  const { app, request, close } = await createTestApp({ logger: createLogger({ level: 'error' }) });
  t.after(close);

  app.apiRouter.get('/__test/boom', () => {
    throw new Error(`boom ${SECRET}`);
  });
  const response = await request('GET', '/api/v1/__test/boom');
  assert.equal(response.status, 500);
  assertNoLeak(response.raw, 'diagnosable');

  const records = logs.join('').trim().split('\n').map((line) => JSON.parse(line));
  const record = records.find((entry) => entry.message === 'unhandled error');
  assert.ok(record, `expected an "unhandled error" record, got: ${logs.join('')}`);
  assert.equal(record.logger, `ifrsmart:${response.error.requestId}`, 'correlates with the client-visible requestId');
  assert.match(record.error.message, /boom/);
  assert.match(record.error.stack, /errorLeakage\.test\.js/, 'the real stack is kept in the log');
});

test('if the error path itself fails, nothing leaks and the server keeps serving', async (t) => {
  const { app, request, baseUrl, close } = await createTestApp();
  t.after(close);

  // Sabotage the response so writing the error envelope throws inside the
  // error handler; the last-resort path in app.js must cope.
  app.apiRouter.get('/__test/broken-response', (req, res) => {
    res.writeHead = () => {
      throw new Error(`writeHead failed ${SECRET}`);
    };
    throw new Error('original failure');
  });

  const outcome = await fetch(`${baseUrl}/api/v1/__test/broken-response`)
    .then(async (response) => ({ status: response.status, text: await response.text() }))
    .catch((error) => ({ networkError: error.cause?.code ?? error.message }));
  if ('text' in outcome) assertNoLeak(outcome.text, 'broken response');
  else assert.ok(outcome.networkError, 'the connection is closed instead of answered with internals');

  const health = await request('GET', '/api/v1/health');
  assert.equal(health.status, 200, 'the server is still up');
});

test('the success envelope is unaffected by the no-leak rule', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const response = await request('GET', '/api/v1/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.data.status, 'ok');
  // A health payload must not become a dumping ground for internals either.
  assert.equal('stack' in response.body.data, false);
  assertNoLeak(response.raw, 'health');
});
