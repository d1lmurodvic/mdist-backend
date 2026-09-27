/**
 * Application bootstrap.
 *
 * createApp() returns a plain node:http request handler plus the collaborators
 * it was built with, so tests can construct an isolated app against an
 * in-memory database instead of booting a server.
 *
 * Layering (ARCHITECTURE.md §5.2):
 *   request -> middleware (context, cors, auth, validation) -> router
 *           -> controller -> service -> model -> database
 * This file owns only cross-cutting HTTP concerns: it contains no business
 * logic and no financial calculation.
 */

import http from 'node:http';
import { createApiV1Router } from './routes/index.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { cors, requestContext } from './middleware/requestContext.js';
import { ERROR_CATALOG } from './lib/errors.js';
import { newRequestId } from './lib/ids.js';
import { readJsonBody, sendError } from './lib/http.js';
import { createLogger } from './lib/logger.js';
import { createRateLimiter } from './lib/rateLimiter.js';
import { createRouter } from './lib/router.js';
import { createServices } from './services/index.js';

const API_PREFIX = '/api/v1';

/** Attach a parsed JSON body to the request. */
function jsonBody() {
  return async function jsonBodyMiddleware(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return undefined;
    if (req.pathname === `${API_PREFIX}/health`) return undefined;
    // The document upload is multipart; its controller reads the body itself.
    if (req.method === 'POST' && req.pathname === `${API_PREFIX}/documents`) return undefined;
    req.body = await readJsonBody(req);
    return undefined;
  };
}

export function createApp({ config, db, logger: providedLogger, services: serviceOverrides = {} } = {}) {
  if (!config) throw new Error('createApp requires a config object.');
  if (!db) throw new Error('createApp requires an open Database.');

  const logger = providedLogger ?? createLogger({ level: config.logLevel });
  const errorHandler = createErrorHandler({ logger });
  const contextMiddleware = requestContext({ logger });
  const corsMiddleware = cors({ allowedOrigins: config.server.corsAllowedOrigins });
  const services = createServices({ db, config, overrides: serviceOverrides });
  // One limiter per app: state is per process, and each test app is isolated.
  const rateLimiter = createRateLimiter();

  // Everything outside /api/v1 falls through to 404; the body is only read
  // for API requests (API_CONTRACT.md §1).
  const apiRouter = createApiV1Router({ db, config, services, rateLimiter });
  const rootRouter = createRouter().use(API_PREFIX, jsonBody(), apiRouter);

  const handler = async (req, res) => {
    try {
      contextMiddleware(req, res);
      if (config.server.trustProxy) {
        const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
        if (forwarded.length) req.forwardedIp = forwarded.at(-1);
      }

      const corsOutcome = corsMiddleware(req, res);
      if (corsOutcome === 'stop' || res.writableEnded) return;

      const handled = await rootRouter.handle(req, res);
      if (!handled && !res.writableEnded) notFoundHandler(req, res);
    } catch (error) {
      errorHandler(error, req, res, () => {});
    }
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error) => {
      // Last resort: the error handler itself failed. Answer first, with the
      // same safe envelope, then try to record what happened.
      try {
        sendError(res, {
          code: 'INTERNAL_ERROR',
          message: ERROR_CATALOG.INTERNAL_ERROR.defaultMessage,
          requestId: req.id ?? newRequestId(),
        }, req);
      } catch {
        if (!res.destroyed) res.destroy();
      }
      logger.error('fatal handler failure', { error });
    });
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  return { server, handler, db, config, logger, services, rateLimiter, apiRouter };
}

/** Boot a real HTTP server. Used by src/server.js, not by tests. */
export function startServer({ config, db, logger, services }) {
  const app = createApp({ config, db, logger, services });

  return new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.server.port, config.server.host, () => {
      const address = app.server.address();
      logger.info('server listening', {
        host: config.server.host,
        port: typeof address === 'object' && address ? address.port : config.server.port,
        env: config.env,
        aiProvider: config.ai.enabled ? config.ai.provider : 'disabled (deterministic capabilities only)',
      });
      resolve(app);
    });
  });
}

export { API_PREFIX };
