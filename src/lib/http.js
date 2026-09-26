/**
 * HTTP plumbing shared by routes and controllers.
 *
 * Enforces the response envelope from API_CONTRACT.md §3:
 *   success -> { success: true,  data, meta }
 *   failure -> { success: false, error: { code, message, details, requestId } }
 *
 * No endpoint returns a bare object or a bare array, and no controller builds
 * a response shape by hand.
 */

import { AppError, ERROR_CATALOG, invalidJson, payloadTooLarge } from './errors.js';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Hard ceiling on request body size, independent of upload limits. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB — JSON payloads are small in this product

/**
 * After rejecting an oversized body we stop buffering, but the client is often
 * still uploading. Draining (rather than destroying) lets it finish sending so
 * it can read the error response; this caps how much we are willing to discard.
 */
const MAX_DISCARD_BYTES = 8 * MAX_BODY_BYTES;

export function sendSuccess(res, { data = {}, meta, status = 200, headers = {} } = {}) {
  if (res.writableEnded) return;
  const payload = { success: true, data };
  if (meta !== undefined) payload.meta = meta;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

export function sendNoContent(res, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(204, headers);
  res.end();
}

/**
 * Write the error envelope. Used on failure paths, so it never throws itself:
 * an unknown code is sent as 500, and a response whose headers already went
 * out (a stream that failed mid-way) is cut off instead of re-headed.
 */
export function sendError(res, { code, message, details, requestId, headers: extraHeaders }, req) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const error = { code, message, requestId };
  if (details !== undefined) error.details = details;
  const body = JSON.stringify({ success: false, error });
  const headers = {
    ...extraHeaders,
    'Content-Type': JSON_CONTENT_TYPE,
    'Content-Length': Buffer.byteLength(body),
  };
  // When the request body was abandoned part-way (oversized upload) the rest of
  // it is still arriving, so the connection cannot be reused.
  const abandoned = Boolean(req?.bodyAbandoned);
  if (abandoned) headers.Connection = 'close';

  res.writeHead(ERROR_CATALOG[code]?.status ?? 500, headers);
  // No manual socket teardown: readJsonBody() drains the remainder so the
  // client can read this response, and `Connection: close` ends it afterwards.
  res.end(body);
}

/**
 * Read and parse a JSON request body.
 * Enforces a size ceiling while reading, so an oversized body is rejected
 * without being buffered in full.
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType && !contentType.includes('application/json')) {
      reject(new AppError('UNSUPPORTED_MEDIA_TYPE', 'Request body must be application/json.'));
      return;
    }

    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      // Drop what has been buffered and drain the rest without keeping it, so
      // the client can finish sending and still receive the error response.
      // The socket is NOT destroyed here — that would reset the connection
      // before the client could read the response, hanging the request.
      chunks.length = 0;
      req.bodyAbandoned = true;
      req.resume();
      reject(error);
    };

    req.on('data', (chunk) => {
      if (settled) {
        // Body already rejected: discard, but give up on absurd uploads.
        size += chunk.length;
        if (size > MAX_DISCARD_BYTES) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(payloadTooLarge('Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => fail(new AppError('INVALID_JSON', 'Could not read request body.')));

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(invalidJson('Request body must be a JSON object.'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(invalidJson('Request body is not valid JSON.'));
      }
    });
  });
}

/** Parse a repeatable or single query-string parameter into a string array. */
export function queryList(searchParams, key) {
  const all = searchParams.getAll(key);
  return all.length > 1 ? all : all.length === 1 ? [all[0]] : [];
}

export function queryString(searchParams, key) {
  const value = searchParams.get(key);
  return value === null ? undefined : value;
}

/** Build a `?a=1&b=2` string, skipping undefined values. */
export function buildQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, String(item)));
    else search.append(key, String(value));
  }
  const result = search.toString();
  return result ? `?${result}` : '';
}
