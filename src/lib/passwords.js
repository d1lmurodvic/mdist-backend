/**
 * Password hashing with scrypt from node:crypto — a slow, memory-hard,
 * adaptive algorithm (DEVELOPMENT_RULES.md §6.2) that needs no dependency.
 *
 * Stored format: scrypt$N$r$p$<salt base64url>$<hash base64url>
 * Each hash carries its own cost parameters, so the configured cost can be
 * raised later without invalidating existing passwords.
 *
 * Plaintext passwords are never logged, stored or returned by this module.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;

function derive(password, salt, { N, r, p }, maxmem) {
  return new Promise((resolve, reject) => {
    // scrypt needs ~128 * N * r bytes; allow for the stored parameters even
    // if the configured cost has since changed.
    const memory = Math.max(maxmem, 256 * N * r);
    scryptCallback(Buffer.from(password, 'utf8'), salt, KEY_BYTES, { N, r, p, maxmem: memory }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** @param {{cost: number, blockSize: number, parallelization: number, maxmem: number}} params */
export async function hashPassword(password, params) {
  const cost = { N: params.cost, r: params.blockSize, p: params.parallelization };
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost, params.maxmem);
  return [ALGORITHM, cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Constant-time comparison against a stored hash. A malformed stored value
 * verifies as false rather than throwing, so it can never surface as a 500.
 */
export async function verifyPassword(password, stored, { maxmem }) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;

  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return false;

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;

  const actual = await derive(password, salt, { N, r, p }, maxmem);
  return timingSafeEqual(actual, expected);
}
