/**
 * Error translation.
 *
 * One place converts any thrown value into the documented error envelope
 * (API_CONTRACT.md §3). Deliberate AppErrors are exposed as-is; anything else
 * is logged in full server-side and reduced to a generic INTERNAL_ERROR, so
 * stack traces, SQL and configuration never reach a client
 * (DEVELOPMENT_RULES.md §6.8).
 */

import { isAppError } from '../lib/errors.js';
import { sendError } from '../lib/http.js';

export function notFoundHandler(req, res) {
  sendError(res, {
    code: 'NOT_FOUND',
    message: `No route matches ${req.method} ${req.pathname}.`,
    requestId: req.id,
  }, req);
}

export function createErrorHandler({ logger } = {}) {
  // Express-style error handler signature: 4 arguments is what identifies it.
  return function errorHandler(error, req, res, _next) {
    const log = req.log ?? logger;

    if (isAppError(error)) {
      const fields = { code: error.code, reason: error.message, details: error.details };
      if (error.status >= 500) {
        log.error('request failed', fields);
      } else {
        log.warn('request rejected', fields);
      }
      sendError(res, {
        code: error.code,
        message: error.message,
        details: error.details,
        requestId: req.id,
        headers: error.headers,
      }, req);
      return;
    }

    // Body parser / stream aborts surface as generic errors with a code.
    if (error && (error.code === 'ECONNRESET' || error.code === 'EPIPE')) {
      log.warn('client disconnected', { code: error.code });
      if (!res.writableEnded) res.destroy();
      return;
    }

    // Name, message, stack and cause are logged (logger.js); none are sent.
    log.error('unhandled error', { error });

    // No environment may widen this: the stack is logged above, never sent.
    sendError(res, {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      requestId: req.id,
    }, req);
  };
}
