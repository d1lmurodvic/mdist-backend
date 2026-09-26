/**
 * Error taxonomy for the IFRSmart API.
 *
 * Every error surfaced to a client is an AppError carrying one of the codes
 * defined in API_CONTRACT.md §4. Anything else that reaches the error handler
 * is treated as an unexpected internal error: it is logged in full server-side
 * and reduced to a safe INTERNAL_ERROR response, so stack traces, SQL and
 * configuration never leak (DEVELOPMENT_RULES.md §6.8).
 */

/** code -> { status, defaultMessage } */
export const ERROR_CATALOG = Object.freeze({
  VALIDATION_ERROR: { status: 400, defaultMessage: 'Request failed validation.' },
  INVALID_JSON: { status: 400, defaultMessage: 'Request body is not valid JSON.' },
  UNAUTHENTICATED: { status: 401, defaultMessage: 'Authentication is required.' },
  FORBIDDEN: { status: 403, defaultMessage: 'You do not have access to this resource.' },
  NOT_FOUND: { status: 404, defaultMessage: 'Resource not found.' },
  CONFLICT: { status: 409, defaultMessage: 'Request conflicts with the current state.' },
  UNPROCESSABLE: { status: 422, defaultMessage: 'Request could not be processed.' },
  PAYLOAD_TOO_LARGE: { status: 413, defaultMessage: 'Payload is too large.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, defaultMessage: 'Unsupported media type.' },
  RATE_LIMITED: { status: 429, defaultMessage: 'Too many requests.' },
  AI_UNAVAILABLE: { status: 503, defaultMessage: 'This AI capability is unavailable.' },
  EXTERNAL_SERVICE_ERROR: { status: 502, defaultMessage: 'An upstream service failed.' },
  INTERNAL_ERROR: { status: 500, defaultMessage: 'An unexpected error occurred.' },
});

export class AppError extends Error {
  /**
   * @param {keyof typeof ERROR_CATALOG} code
   * @param {string} [message] safe, human-readable, safe to display to a client
   * @param {Array<{field?: string, issue: string}>|object} [details]
   * @param {Record<string, string>} [headers] protocol headers the response
   *   must carry, e.g. Retry-After on 429 or WWW-Authenticate on 401
   */
  constructor(code, message, details, headers) {
    const entry = ERROR_CATALOG[code];
    if (!entry) {
      throw new Error(`Unknown error code: ${code}`);
    }
    super(message || entry.defaultMessage);
    this.name = 'AppError';
    this.code = code;
    this.status = entry.status;
    this.details = details;
    this.headers = headers;
    this.expected = true;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message, details) => new AppError('VALIDATION_ERROR', message, details);
export const invalidJson = (message) => new AppError('INVALID_JSON', message);
/** 401 always names the scheme the client should use (RFC 9110 §11.6.1). */
export const unauthenticated = (message) =>
  new AppError('UNAUTHENTICATED', message, undefined, { 'WWW-Authenticate': 'Bearer' });
export const forbidden = (message) => new AppError('FORBIDDEN', message);
export const notFound = (message) => new AppError('NOT_FOUND', message);
export const conflict = (message, details) => new AppError('CONFLICT', message, details);
export const unprocessable = (message, details) => new AppError('UNPROCESSABLE', message, details);
export const payloadTooLarge = (message) => new AppError('PAYLOAD_TOO_LARGE', message);
export const unsupportedMediaType = (message) => new AppError('UNSUPPORTED_MEDIA_TYPE', message);
/** 429 carries Retry-After in whole seconds (API_CONTRACT.md §4). */
export const rateLimited = (message, retryAfterSeconds) =>
  new AppError('RATE_LIMITED', message, undefined, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) });
export const aiUnavailable = (message) => new AppError('AI_UNAVAILABLE', message);
export const externalServiceError = (message) => new AppError('EXTERNAL_SERVICE_ERROR', message);
export const internalError = (message) => new AppError('INTERNAL_ERROR', message);

/**
 * True when a value is an AppError we raised deliberately and may expose.
 * Unknown errors are never exposed.
 */
export function isAppError(value) {
  return value instanceof AppError && value.expected === true;
}
