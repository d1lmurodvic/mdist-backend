/**
 * Opaque identifier generation.
 *
 * API_CONTRACT.md §2: identifiers are opaque strings and clients must not infer
 * meaning from their format. These are prefixed ULID-style values: a
 * millisecond timestamp prefix (keeps SQLite indexes insertion-ordered) plus
 * randomness, with a short entity prefix for debuggability only.
 */

import { randomBytes, randomUUID } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I/L/O/U

function randomSuffix(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function encodeTime(ms) {
  let out = '';
  let value = ms;
  for (let i = 0; i < 10; i += 1) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/**
 * @param {string} prefix short entity tag, e.g. 'txn', 'cmp', 'usr'
 * @returns {string} e.g. 'txn_01JQ8Z9K3M00000000000000AB' (10 time + 16 random characters)
 */
export function newId(prefix) {
  if (typeof prefix !== 'string' || !/^[a-z]{2,6}$/.test(prefix)) {
    throw new Error('newId(prefix) requires a 2-6 character lowercase prefix.');
  }
  return `${prefix}_${encodeTime(Date.now())}${randomSuffix(16)}`;
}

/**
 * High-entropy opaque token for sessions. 32 random bytes -> 43 base64url
 * characters. Only the SHA-256 hash of this is stored server-side.
 */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function newRequestId() {
  return `req_${randomUUID()}`;
}

export function newIdempotencyKey() {
  return randomUUID();
}
