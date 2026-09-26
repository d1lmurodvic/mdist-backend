import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/lib/passwords.js';
import { loadConfig } from '../src/config/index.js';

const FAST = { cost: 16384, blockSize: 8, parallelization: 1, maxmem: 268435456 };

test('hashPassword produces a self-describing salted scrypt hash', async () => {
  const hash = await hashPassword('correct horse', FAST);
  const [algorithm, N, r, p, salt, key] = hash.split('$');
  assert.deepEqual([algorithm, N, r, p], ['scrypt', '16384', '8', '1']);
  assert.equal(Buffer.from(salt, 'base64url').length, 16);
  assert.equal(Buffer.from(key, 'base64url').length, 64);
  assert.notEqual(await hashPassword('correct horse', FAST), hash, 'a fresh salt every time');
});

test('verifyPassword accepts only the exact password', async () => {
  const hash = await hashPassword('correct horse', FAST);
  assert.equal(await verifyPassword('correct horse', hash, FAST), true);
  for (const wrong of ['correct horse ', 'Correct horse', 'correct', '']) {
    assert.equal(await verifyPassword(wrong, hash, FAST), false, JSON.stringify(wrong));
  }
});

test('a hash made with other cost parameters still verifies', async () => {
  const stronger = await hashPassword('pw-123456', { ...FAST, cost: 32768 });
  assert.equal(await verifyPassword('pw-123456', stronger, FAST), true);
});

test('a malformed stored hash verifies as false instead of throwing', async () => {
  for (const stored of [undefined, null, '', 'plaintext', 'bcrypt$1$2$3$4$5', 'scrypt$x$8$1$AAAA$BBBB', 'scrypt$16384$8$1$$']) {
    assert.equal(await verifyPassword('anything', stored, FAST), false, String(stored));
  }
});

test('password hashing defaults to the OWASP scrypt minimum', () => {
  const { scrypt } = loadConfig({ NODE_ENV: 'test' }).security;
  assert.deepEqual({ ...scrypt }, { cost: 131072, blockSize: 8, parallelization: 1, maxmem: 268435456 });
});

test('scrypt configuration that cannot work is refused at startup', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SCRYPT_COST: '131072', SCRYPT_MAXMEM: '67108864' }), /SCRYPT_MAXMEM must exceed/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SCRYPT_COST: '20000' }), /power of two/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', SCRYPT_COST: '1024' }), /SCRYPT_COST/);
});
