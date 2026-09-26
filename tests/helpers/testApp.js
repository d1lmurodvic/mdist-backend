/**
 * Test harness.
 *
 * Every test gets its own in-memory SQLite database with migrations applied
 * and its own ephemeral HTTP server, so tests are isolated, order-independent
 * and exercise the real middleware/router/envelope path rather than mocks.
 */

import net from 'node:net';
import { loadConfig } from '../../src/config/index.js';
import { Database } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { createLogger } from '../../src/lib/logger.js';
import { createApp } from '../../src/app.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_PATH: ':memory:',
  DATABASE_ALLOW_MEMORY: 'true',
  SESSION_TTL_SECONDS: '3600',
  // Lower scrypt cost keeps the suite fast; production uses the .env values.
  SCRYPT_COST: '16384',
};

export async function createTestApp({ env = {}, services = {}, logger = createLogger({ level: 'silent' }) } = {}) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const db = Database.open({ path: ':memory:', allowMemory: true });
  migrate(db);

  const app = createApp({ config, db, logger, services });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  /**
   * Perform a request against the app and parse the response envelope.
   * Never throws on a non-2xx status: tests assert on the status.
   */
  async function request(method, path, { body, token, headers = {}, raw } = {}) {
    // Defaults first, so a caller can deliberately send a different
    // Content-Type (used to prove non-JSON bodies are rejected).
    const requestHeaders = { Accept: 'application/json' };
    if (raw !== undefined || body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    Object.assign(requestHeaders, headers);

    // `raw` is sent verbatim (used to send deliberately malformed payloads);
    // otherwise `body` is JSON-encoded.
    const payload = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: payload,
    });

    const text = await response.text();
    let parsed = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { __unparsed: text };
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      body: parsed,
      data: parsed?.data,
      meta: parsed?.meta,
      error: parsed?.error,
      raw: text,
    };
  }

  /**
   * Send raw HTTP/1.1 text over a socket — for input fetch() refuses to
   * produce (a malformed Host header or request target). Returns the parsed
   * status, headers and envelope.
   */
  function rawRequest(text) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
      let received = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        received += chunk;
      });
      socket.on('error', reject);
      socket.on('end', () => {
        const split = received.indexOf('\r\n\r\n');
        const head = received.slice(0, split).split('\r\n');
        const raw = received.slice(split + 4);
        const headers = Object.fromEntries(head.slice(1).map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }));
        let body = null;
        try {
          body = raw === '' ? null : JSON.parse(raw);
        } catch {
          body = { __unparsed: raw };
        }
        resolve({ status: Number(head[0].split(' ')[1]), headers, body, error: body?.error, raw });
      });
    });
  }

  async function close() {
    await new Promise((resolve) => app.server.close(resolve));
    db.close();
  }

  return { app, db, config, logger, baseUrl, request, rawRequest, close };
}

/** Assert the response uses the documented success envelope. */
export function assertSuccessEnvelope(response) {
  if (response.body?.success !== true) {
    throw new Error(`Expected success envelope, received: ${response.raw}`);
  }
  if (!('data' in response.body)) {
    throw new Error('Success envelope must contain a data field.');
  }
}

/** Assert the response uses the documented error envelope. */
export function assertErrorEnvelope(response, expectedCode) {
  if (response.body?.success !== false) {
    throw new Error(`Expected error envelope, received: ${response.raw}`);
  }
  const error = response.body.error;
  if (!error || typeof error.code !== 'string') {
    throw new Error(`Error envelope must contain error.code, received: ${response.raw}`);
  }
  if (typeof error.message !== 'string' || error.message === '') {
    throw new Error('Error envelope must contain a human-readable message.');
  }
  if (typeof error.requestId !== 'string' || !error.requestId.startsWith('req_')) {
    throw new Error(`Error envelope must contain a requestId, received: ${response.raw}`);
  }
  if (expectedCode && error.code !== expectedCode) {
    throw new Error(`Expected error code ${expectedCode}, received ${error.code}: ${error.message}`);
  }
}
