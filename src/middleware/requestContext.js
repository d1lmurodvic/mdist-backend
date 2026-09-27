/**
 * Per-request context: request id, parsed URL, timing, and access logging.
 *
 * The request id is generated here (or taken from an inbound header) and is
 * attached to every error response so a client-visible failure can be traced
 * to a server log line (API_CONTRACT.md §3).
 *
 * Malformed client input (an invalid Host header or an unparseable request
 * target) is rejected here with 400 VALIDATION_ERROR. The Host header is never
 * used to build URLs: routing depends on the path alone.
 */

import { newRequestId } from '../lib/ids.js';
import { badRequest } from '../lib/errors.js';

const SAFE_HEADER = 'x-request-id';

/** Fixed base for parsing request targets; the path is all routing needs. */
const URL_BASE = 'http://localhost';

/**
 * Host header syntax, RFC 9110 §7.2: uri-host [ ":" port ], where uri-host is
 * an IP-literal in brackets or a reg-name (RFC 3986 §3.2.2). Whitespace, '/',
 * '@', '?', '#' and other delimiters are not allowed.
 */
const HOST_HEADER = /^(?:\[[0-9A-Za-z:.%_~-]+\]|[A-Za-z0-9\-._~!$&'()*+,;=%]+)(?::\d{0,5})?$/;

function parseRequestTarget(url) {
  // Origin-form ('/path?query') is appended to the base rather than resolved
  // against it, so a path starting with '//' is never read as a host.
  const text = url || '/';
  try {
    return text.startsWith('/') ? new URL(`${URL_BASE}${text}`) : new URL(text, URL_BASE);
  } catch {
    throw badRequest('Request URL is malformed.', [
      { field: 'url', issue: 'must be a valid request target' },
    ]);
  }
}

export function requestContext({ logger }) {
  return function requestContextMiddleware(req, res) {
    const inbound = req.headers[SAFE_HEADER];
    const requestId = typeof inbound === 'string' && /^[\w-]{1,64}$/.test(inbound) ? inbound : newRequestId();

    req.id = requestId;
    req.startedAt = process.hrtime.bigint();
    req.log = logger.child({ requestId });
    res.setHeader('X-Request-Id', requestId);
    // Known only once the target has been parsed; stays null if it cannot be.
    req.pathname = null;

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]('request', {
        method: req.method,
        // Path only — query strings can carry search terms and are not logged.
        path: req.pathname,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    const host = req.headers.host;
    if (typeof host === 'string' && host !== '' && !HOST_HEADER.test(host)) {
      throw badRequest('Host header is malformed.', [
        { field: 'host', issue: 'must be a valid host[:port]' },
      ]);
    }

    req.parsedUrl = parseRequestTarget(req.url);
    req.pathname = req.parsedUrl.pathname.replace(/\/+$/, '') || '/';
    req.searchParams = req.parsedUrl.searchParams;
  };
}

/**
 * Minimal CORS support for the separate React frontend.
 *
 * A wildcard origin and `Access-Control-Allow-Credentials: true` are mutually
 * exclusive — browsers reject that pairing outright (Fetch standard, CORS
 * protocol). So credentials are only advertised when a concrete configured
 * origin is echoed; a wildcard configuration is honoured without credentials
 * and is refused in production by config/index.js.
 */
export function cors({ allowedOrigins }) {
  const allowAll = allowedOrigins.includes('*');
  return function corsMiddleware(req, res) {
    // Unless every origin is allowed, whether the grant is present depends on
    // the request's Origin, so shared caches must key every response on it.
    if (!allowAll) res.setHeader('Vary', 'Origin');

    const origin = req.headers.origin;
    if (origin && (allowAll || allowedOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : origin);
      // Wildcard + credentials is an invalid combination, so it is omitted.
      if (!allowAll) res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, Idempotency-Key');
      res.setHeader('Access-Control-Max-Age', '600');
      // Response headers the frontend reads (429 wait time, request id for
      // support, register Location, download filename).
      res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id, Location, Content-Disposition');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return 'stop';
    }
    return undefined;
  };
}
