/**
 * Minimal HTTP router built on node:http.
 *
 * Express is not used: the product needs path parameters, a middleware chain,
 * mounted sub-routers and async handlers, all of which fit in this file.
 * Avoiding the dependency also keeps the request pipeline explicit, which
 * matters when the only thing between the internet and the financial engine is
 * this code.
 *
 * Controllers return a response descriptor ({ status, data, meta, headers })
 * or throw an AppError. Serialization is centralised in the route dispatcher
 * so no endpoint can invent its own response shape (API_CONTRACT.md §3).
 *
 * Matching rules:
 *   - Routes (get/post/...) match the whole path, segment by segment. A
 *     trailing '*' segment captures the rest of the path.
 *   - use('/prefix', ...) matches by whole segments: '/auth' matches '/auth'
 *     and '/auth/login', never '/authors'. A mounted router matches against
 *     the remainder of the path (the prefix is stripped), and parameters
 *     captured by the prefix are merged into req.params.
 *   - Path parameters are percent-decoded; malformed encoding is a 400
 *     VALIDATION_ERROR, never a 500.
 */

import { badRequest } from './errors.js';
import { sendNoContent, sendSuccess } from './http.js';

function splitPath(path) {
  return path.split('/').filter((segment) => segment !== '');
}

function isRouter(value) {
  return value !== null && typeof value === 'object' && typeof value.handle === 'function';
}

function decodeParams(rawParams) {
  const params = {};
  for (const [name, value] of Object.entries(rawParams)) {
    if (name === '*') {
      params[name] = value;
      continue;
    }
    try {
      params[name] = decodeURIComponent(value);
    } catch {
      throw badRequest('Request path is malformed.', [
        { field: name, issue: 'contains malformed percent-encoding' },
      ]);
    }
  }
  return params;
}

/**
 * Compare pattern segments with path segments. The structure is matched
 * first and parameters decoded only afterwards, so a malformed segment in a
 * path that does not match this pattern cannot fail the request.
 * Returns { params, consumed } or null.
 */
function matchSegments(segments, parts, { prefix }) {
  const raw = {};
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === '*') {
      if (i >= parts.length) return null;
      raw['*'] = parts.slice(i).join('/');
      return { params: decodeParams(raw), consumed: parts.length };
    }
    if (i >= parts.length) return null;
    if (segment.startsWith(':')) raw[segment.slice(1)] = parts[i];
    else if (segment !== parts[i]) return null;
  }
  if (!prefix && parts.length !== segments.length) return null;
  return { params: decodeParams(raw), consumed: segments.length };
}

export function createRouter() {
  /** @type {Array<{kind: 'route'|'mount', method?: string, segments: string[]|null, handlers: Array}>} */
  const layers = [];

  function add(method, path, handlers) {
    for (const handler of handlers) {
      if (typeof handler !== 'function') {
        throw new TypeError(`Route handler for ${method} ${path} must be a function.`);
      }
    }
    layers.push({ kind: 'route', method, segments: splitPath(path), handlers });
  }

  const router = {
    /** use(fn | router, ...) or use('/prefix', fn | router, ...) */
    use(pathOrHandler, ...rest) {
      const prefix = typeof pathOrHandler === 'string' ? pathOrHandler : null;
      const handlers = prefix === null ? [pathOrHandler, ...rest] : rest;
      if (handlers.length === 0) {
        throw new TypeError(`use(${prefix ?? ''}) requires at least one handler.`);
      }
      for (const handler of handlers) {
        if (typeof handler !== 'function' && !isRouter(handler)) {
          throw new TypeError(`Handlers mounted with use(${prefix ?? ''}) must be functions or routers.`);
        }
      }
      const segments = prefix === null ? null : splitPath(prefix);
      if (segments?.includes('*')) {
        throw new TypeError('A mount prefix already matches everything below it; it cannot contain "*".');
      }
      layers.push({ kind: 'mount', segments, handlers });
      return router;
    },

    get: (path, ...handlers) => (add('GET', path, handlers), router),
    post: (path, ...handlers) => (add('POST', path, handlers), router),
    put: (path, ...handlers) => (add('PUT', path, handlers), router),
    patch: (path, ...handlers) => (add('PATCH', path, handlers), router),
    delete: (path, ...handlers) => (add('DELETE', path, handlers), router),

    /**
     * Walk the layers in registration order. Returns true once the request has
     * been answered, false when nothing here handled it (the caller then tries
     * its next layer, or answers 404). Handler errors propagate to the caller
     * so a single error handler covers all.
     *
     * @param {string} [path] path relative to this router's mount point
     * @param {object} [inheritedParams] parameters captured by parent mounts
     */
    async handle(req, res, path = req.pathname, inheritedParams = {}) {
      const parts = splitPath(path);

      for (const layer of layers) {
        if (layer.kind === 'mount') {
          const match = layer.segments === null
            ? { params: {}, consumed: 0 }
            : matchSegments(layer.segments, parts, { prefix: true });
          if (match === null) continue;
          const remainder = `/${parts.slice(match.consumed).join('/')}`;
          const outcome = await runHandlers(layer.handlers, req, res, { ...inheritedParams, ...match.params }, remainder);
          if (outcome === 'stop') return true;
          continue;
        }

        if (layer.method !== req.method) continue;
        const match = matchSegments(layer.segments, parts, { prefix: false });
        if (match === null) continue;

        // The first matching route owns the request.
        const outcome = await runHandlers(layer.handlers, req, res, { ...inheritedParams, ...match.params }, path);
        return outcome === 'stop' || res.writableEnded;
      }

      return res.writableEnded;
    },
  };

  return router;
}

/**
 * Run handlers in order. A handler signals completion by writing to `res`
 * (auto-detected) or by returning a response descriptor; a mounted router
 * signals it by returning true from handle().
 */
async function runHandlers(handlers, req, res, params, subPath) {
  for (const handler of handlers) {
    // Reset on every step: a sub-router that did not match may have changed it.
    req.params = params;

    if (isRouter(handler)) {
      if (await handler.handle(req, res, subPath, params)) return 'stop';
      continue;
    }

    const result = await handler(req, res);

    if (res.writableEnded) return 'stop';

    if (result === undefined || result === null) continue;

    if (result === 'next') continue;

    // Response descriptor from a controller.
    const { status = 200, data = {}, meta, headers } = result;
    if (status === 204) {
      sendNoContent(res, headers);
    } else {
      sendSuccess(res, { data, meta, status, headers });
    }
    return 'stop';
  }
  return 'next';
}
