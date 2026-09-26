import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_SAFE_MINOR,
  MIN_SAFE_MINOR,
  add,
  subtract,
  sum,
  compare,
  negate,
  abs,
  max,
  min,
  toMinor,
  toSafeNumber,
  fromMajor,
  formatMajor,
  toSqlInteger,
  exponentFor,
  assertCurrency,
  isSupportedCurrency,
} from '../src/lib/money.js';

test('exponentFor distinguishes zero-decimal and two-decimal currencies', () => {
  assert.equal(exponentFor('UZS'), 0, 'UZS has no minor unit');
  assert.equal(exponentFor('JPY'), 0, 'JPY has no minor unit');
  assert.equal(exponentFor('USD'), 2);
  assert.equal(exponentFor('EUR'), 2);
  assert.equal(exponentFor('KWD'), 3, 'KWD has three decimal places');
});

test('assertCurrency rejects malformed and unsupported codes', () => {
  assert.doesNotThrow(() => assertCurrency('USD'));
  assert.throws(() => assertCurrency('usd'), /3-letter uppercase/);
  assert.throws(() => assertCurrency('US'), /3-letter uppercase/);
  assert.throws(() => assertCurrency('ZZZ'), /not supported/);
  assert.equal(isSupportedCurrency('UZS'), true);
  assert.equal(isSupportedCurrency('XYZ'), false);
});

test('toMinor refuses floats so a decimal can never enter as a float', () => {
  assert.equal(toMinor(125000), 125000n);
  assert.equal(toMinor('125000'), 125000n);
  assert.equal(toMinor(125000n), 125000n);
  assert.throws(() => toMinor(100.1), /minor units/);
  assert.throws(() => toMinor('100.10'), /minor units/);
  assert.throws(() => toMinor(Number.NaN), /minor units/);
  assert.throws(() => toMinor(null), /minor units/);
});

test('a rejected monetary value reports the offending field in details', () => {
  try {
    toMinor(1.5, 'amountMinor');
    assert.fail('Expected toMinor to throw');
  } catch (error) {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(error.details, [
      { field: 'amountMinor', issue: 'must be an integer number of minor units' },
    ]);
  }
});

test('arithmetic is exact where float arithmetic would drift', () => {
  // 0.1 + 0.2 !== 0.3 in floating point; in minor units this is exact.
  assert.equal(add(10n, 20n), 30n);
  assert.equal(subtract(30n, 10n), 20n);
  assert.equal(sum([100n, 200n, 300n]), 600n);
  assert.equal(sum([]), 0n);
  assert.equal(negate(500n), -500n);
  assert.equal(abs(-500n), 500n);
  assert.equal(compare(200n, 100n), 1);
  assert.equal(compare(100n, 100n), 0);
  assert.equal(compare(50n, 100n), -1);
  assert.equal(max(10n, 20n), 20n);
  assert.equal(min(10n, 20n), 10n);

  // A float sum of many cent amounts drifts; the BigInt sum does not.
  const cents = Array.from({ length: 10 }, () => 10n);
  assert.equal(sum(cents), 100n);
});

test('fromMajor converts decimal strings without floating point', () => {
  assert.equal(fromMajor('1250.00', 'USD'), 125000n);
  assert.equal(fromMajor('0.01', 'USD'), 1n);
  assert.equal(fromMajor('100.1', 'USD'), 10010n);
  assert.equal(fromMajor('-5.05', 'USD'), -505n);
  assert.equal(fromMajor('125000', 'UZS'), 125000n, 'zero-decimal currency keeps the whole amount');
});

test('fromMajor rejects precision the currency cannot represent', () => {
  assert.throws(() => fromMajor('1.005', 'USD'), /more decimal places/);
  assert.throws(() => fromMajor('1.5', 'UZS'), /more decimal places/);
  assert.throws(() => fromMajor('abc', 'USD'), /decimal number/);
  assert.throws(() => fromMajor('1.2.3', 'USD'), /decimal number/);
});

test('toSafeNumber refuses to lose precision silently', () => {
  assert.equal(toSafeNumber(125000n), 125000);
  assert.equal(toSafeNumber(-125000n), -125000);
  assert.throws(() => toSafeNumber(2n ** 60n), /cannot be serialized exactly/);
});

test('toSqlInteger converts ordinary amounts exactly', () => {
  assert.equal(toSqlInteger(125000n), 125000);
  assert.equal(toSqlInteger(-125000n), -125000);
  assert.equal(toSqlInteger(0n), 0);
});

// Regression: toSqlInteger(2^60 + 1) used to return 1152921504606847000 —
// Number() had silently rounded it. The old test only checked 2^64 against the
// 64-bit limit ("does not fit"); the range is now the exact round-trip range.
test('toSqlInteger is exact up to ±(2^53 − 1) and refuses anything larger', () => {
  const max = 2n ** 53n - 1n;
  assert.equal(MAX_SAFE_MINOR, max);
  assert.equal(MIN_SAFE_MINOR, -max);

  for (const value of [max, max - 1n, -max, -(max - 1n)]) {
    const stored = toSqlInteger(value);
    assert.equal(typeof stored, 'number');
    assert.equal(BigInt(stored), value, `${value} must be stored exactly`);
  }

  for (const value of [max + 1n, -(max + 1n), 2n ** 60n, 2n ** 60n + 1n, 2n ** 63n - 1n, 2n ** 64n]) {
    assert.throws(() => toSqlInteger(value), (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.details[0].field, 'amountMinor');
      assert.match(error.details[0].issue, /must be between -9007199254740991 and 9007199254740991/);
      return true;
    }, `${value} must be refused, not rounded`);
  }

  assert.throws(() => toSqlInteger(2n ** 60n, 'totalMinor'), (error) => error.details[0].field === 'totalMinor');
});

test('amounts at the boundary round-trip through SQLite exactly; beyond it node:sqlite cannot read them', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE amounts (amount_minor INTEGER NOT NULL)');
    const max = 2n ** 53n - 1n;
    db.prepare('INSERT INTO amounts VALUES (?)').run(toSqlInteger(max));
    db.prepare('INSERT INTO amounts VALUES (?)').run(toSqlInteger(-max));
    const rows = db.prepare('SELECT amount_minor FROM amounts ORDER BY amount_minor').all();
    assert.deepEqual(rows.map((row) => BigInt(row.amount_minor)), [-max, max]);

    // Why the limit sits at 2^53 − 1 rather than 2^63 − 1: a larger value can
    // be written, but reading it back as a number fails.
    db.prepare('INSERT INTO amounts VALUES (?)').run(2n ** 60n + 1n);
    assert.throws(
      () => db.prepare('SELECT amount_minor FROM amounts WHERE amount_minor > ?').get(toSqlInteger(max)),
      { code: 'ERR_OUT_OF_RANGE' },
    );
  } finally {
    db.close();
  }
});

test('formatMajor is presentation-only and correct for both exponents', () => {
  assert.equal(formatMajor(125000n, 'USD'), '1250.00');
  assert.equal(formatMajor(1n, 'USD'), '0.01');
  assert.equal(formatMajor(125000n, 'UZS'), '125000');
  assert.equal(formatMajor(-505n, 'USD'), '-5.05');
});
