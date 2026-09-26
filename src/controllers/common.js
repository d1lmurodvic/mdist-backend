/**
 * Shared controller helpers for the final backend completion: query parsing
 * (repeatable keys as arrays), path ids, and pagination metadata.
 */

import { notFound } from '../lib/errors.js';
import { idSchema, parseOrThrow } from '../lib/validate.js';

export function queryObject(searchParams, repeatable = []) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    query[key] = repeatable.includes(key) ? searchParams.getAll(key) : searchParams.get(key);
  }
  return query;
}

export function parseQuery(req, schema, repeatable = []) {
  return parseOrThrow(schema, queryObject(req.searchParams, repeatable));
}

/** A path id that is not well-formed cannot exist: the same 404 as any other. */
export function pathId(req, name, message) {
  const result = idSchema.safeParse(req.params[name]);
  if (!result.success) throw notFound(message);
  return result.data;
}

export function paginationMeta({ page, limit }, total, extra = {}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { page, limit, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1, ...extra };
}
