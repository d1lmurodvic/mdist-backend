import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { newId } from '../src/lib/ids.js';
import {
  parseOrThrow,
  validate,
  amountMinorSchema,
  positiveAmountMinorSchema,
  isoDateSchema,
  currencySchema,
  idSchema,
  paginationSchema,
  listQuerySchema,
  dateRangeQuerySchema,
  periodPresetSchema,
  emailSchema,
  normalizeEmail,
} from '../src/lib/validate.js';

/**
 * Field-level problems live in `error.details` (API_CONTRACT.md §3); `message`
 * stays generic and safe to display. Tests assert against the details.
 */
function rejection(fn) {
  try {
    fn();
  } catch (error) {
    if (error.code !== 'VALIDATION_ERROR') throw error;
    return (error.details ?? []).map((detail) => `${detail.field}: ${detail.issue}`).join(' | ');
  }
  throw new Error('Expected a VALIDATION_ERROR to be thrown.');
}

test('amountMinorSchema accepts JSON integers and rejects floats', () => {
  assert.equal(validate(amountMinorSchema, 125000), 125000n);
  assert.equal(validate(amountMinorSchema, -500), -500n);
  assert.equal(validate(amountMinorSchema, 0), 0n);

  assert.match(rejection(() => validate(amountMinorSchema, 100.1)), /integer number of minor units/);
  // Every non-number now fails with the same monetary message (the schema is a
  // single z.number(), no longer a number|bigint|string union).
  assert.match(rejection(() => validate(amountMinorSchema, null)), /integer number of minor units/);
  assert.match(rejection(() => validate(amountMinorSchema, { amount: 1 })), /integer number of minor units/);
  assert.match(rejection(() => validate(amountMinorSchema, true)), /integer number of minor units/);
});

// Regression: "125000" used to be accepted and silently converted. API_CONTRACT
// §8 forbids string-to-number conversion, so the old assertion
// `validate(amountMinorSchema, '125000') === 125000n` encoded a contract breach.
test('amountMinorSchema rejects numeric strings instead of converting them', () => {
  for (const value of ['125000', '0', '-500', '100.10', 'abc', '']) {
    assert.match(rejection(() => validate(amountMinorSchema, value)), /integer number of minor units/, JSON.stringify(value));
  }
  assert.match(rejection(() => validate(amountMinorSchema, 125000n)), /integer number of minor units/, 'JSON cannot carry a BigInt');
});

test('amountMinorSchema accepts exactly ±(2^53 − 1)', () => {
  assert.equal(validate(amountMinorSchema, Number.MAX_SAFE_INTEGER), 9007199254740991n);
  assert.equal(validate(amountMinorSchema, -Number.MAX_SAFE_INTEGER), -9007199254740991n);
  assert.match(rejection(() => validate(amountMinorSchema, Number.MAX_SAFE_INTEGER + 1)), /out of the supported range/);
});

test('amountMinorSchema rejects values beyond exact JSON serialization', () => {
  assert.match(rejection(() => validate(amountMinorSchema, 2 ** 60)), /out of the supported range/);
});

test('positiveAmountMinorSchema requires a magnitude above zero', () => {
  assert.equal(validate(positiveAmountMinorSchema, 1), 1n);
  assert.match(rejection(() => validate(positiveAmountMinorSchema, 0)), /greater than zero/);
  assert.match(rejection(() => validate(positiveAmountMinorSchema, -100)), /greater than zero/);
});

test('isoDateSchema rejects impossible calendar dates', () => {
  assert.equal(validate(isoDateSchema, '2026-03-14'), '2026-03-14');
  assert.match(rejection(() => validate(isoDateSchema, '2026-02-30')), /valid YYYY-MM-DD/);
  assert.match(rejection(() => validate(isoDateSchema, '14/03/2026')), /valid YYYY-MM-DD/);
});

test('currencySchema requires a supported uppercase ISO code', () => {
  assert.equal(validate(currencySchema, 'UZS'), 'UZS');
  assert.match(rejection(() => validate(currencySchema, 'usd')), /3-letter uppercase/);
  assert.match(rejection(() => validate(currencySchema, 'ZZZ')), /not a supported currency/);
});

test('idSchema requires the opaque identifier format', () => {
  // 10 characters of timestamp + 16 of randomness, behind a 2-6 letter prefix.
  const valid = `txn_01JQ8Z9K3M00000000000000AB`;
  assert.equal(valid.split('_')[1].length, 26);
  assert.equal(validate(idSchema, valid), valid);
  const generated = newId('txn');
  assert.equal(validate(idSchema, generated), generated);

  assert.match(rejection(() => validate(idSchema, '1')), /opaque identifier/);
  assert.match(rejection(() => validate(idSchema, 'txn_short')), /opaque identifier/);
  assert.match(rejection(() => validate(idSchema, 'transaction-with-a-dash')), /opaque identifier/);
  // 28 characters after the prefix: too long for the 26-character body.
  assert.match(rejection(() => validate(idSchema, 'txn_01JQ8Z9K3M0000000000000000AB')), /opaque identifier/);
});

test('pagination coerces query strings and applies bounds', () => {
  assert.deepEqual(validate(paginationSchema, {}), { page: 1, limit: 20 });
  assert.deepEqual(validate(paginationSchema, { page: '3', limit: '50' }), { page: 3, limit: 50 });
  assert.match(rejection(() => validate(paginationSchema, { page: '0' })), /page/);
  assert.match(rejection(() => validate(paginationSchema, { limit: '1000' })), /limit/);
});

test('listQuerySchema parses filters, sorting and the uncategorized flag', () => {
  const parsed = validate(listQuerySchema, {
    page: '2',
    limit: '10',
    type: 'expense',
    q: 'rent',
    sort: 'date:desc',
    includeUncategorized: 'true',
  });
  assert.equal(parsed.page, 2);
  assert.equal(parsed.includeUncategorized, true);

  assert.match(
    rejection(() => validate(listQuerySchema, { includeUncategorized: 'yes' })),
    /includeUncategorized/,
  );
});

test('dateRangeQuerySchema requires from to be earlier than to', () => {
  assert.doesNotThrow(() => validate(dateRangeQuerySchema, { from: '2026-01-01', to: '2026-02-01' }));
  assert.match(
    rejection(() => validate(dateRangeQuerySchema, { from: '2026-02-01', to: '2026-01-01' })),
    /must be earlier than/,
  );
});

test('date ranges are end-exclusive: from <= date < to, likewise periodStart/periodEnd', () => {
  // One day is from=D, to=D+1; from=to would be an empty range.
  assert.doesNotThrow(() => validate(dateRangeQuerySchema, { from: '2026-03-01', to: '2026-03-02' }));
  assert.match(
    rejection(() => validate(dateRangeQuerySchema, { from: '2026-03-01', to: '2026-03-01' })),
    /from: must be earlier than `to` \(`to` is exclusive\)/,
  );
  assert.match(
    rejection(() => validate(dateRangeQuerySchema, { periodStart: '2026-03-01', periodEnd: '2026-03-01' })),
    /periodStart: must be earlier than `periodEnd`/,
  );
  // The list schema applies the same rule.
  assert.match(
    rejection(() => validate(listQuerySchema, { from: '2026-03-05', to: '2026-03-01' })),
    /from: must be earlier than `to`/,
  );
});

test('only the contract period presets are accepted at the API boundary', () => {
  for (const preset of ['this_month', 'last_month', 'this_quarter', 'this_year', 'last_30_days', 'custom']) {
    assert.equal(validate(periodPresetSchema, preset), preset);
  }
  for (const internal of ['last_quarter', 'last_year', 'last_90_days']) {
    assert.throws(() => validate(periodPresetSchema, internal), { code: 'VALIDATION_ERROR' }, internal);
  }
});

// Regression (BUG 6): Owner@Example.com and owner@example.com were two identities.
test('emailSchema canonicalises to trimmed lower case', () => {
  assert.equal(validate(emailSchema, 'Owner@Example.com'), 'owner@example.com');
  assert.equal(validate(emailSchema, '  OWNER@EXAMPLE.COM \t'), 'owner@example.com');
  assert.equal(validate(emailSchema, 'owner@example.com'), 'owner@example.com');
  assert.equal(normalizeEmail(' Owner@Example.com '), 'owner@example.com');

  for (const bad of ['not-an-email', 'a@b', '@example.com', 'owner@', 'o wner@example.com', '']) {
    assert.match(rejection(() => validate(emailSchema, bad)), /valid email address/, JSON.stringify(bad));
  }
  assert.throws(() => validate(emailSchema, `${'a'.repeat(250)}@example.com`), { code: 'VALIDATION_ERROR' });
});

test('parseOrThrow reports field-level details for the API envelope', () => {
  const schema = z.object({ amount: amountMinorSchema, date: isoDateSchema });
  try {
    parseOrThrow(schema, { amount: 1.5, date: 'nope' });
    assert.fail('Expected a validation error');
  } catch (error) {
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.equal(error.status, 400);
    assert.ok(Array.isArray(error.details));
    const fields = error.details.map((detail) => detail.field).sort();
    assert.deepEqual(fields, ['amount', 'date']);
    for (const detail of error.details) {
      assert.equal(typeof detail.issue, 'string');
    }
  }
});

test('unknown keys in a strict object are rejected rather than ignored', () => {
  const schema = z.strictObject({ name: z.string() });
  assert.equal(validate(schema, { name: 'Acme' }).name, 'Acme');
  assert.match(rejection(() => validate(schema, { name: 'Acme', compnayId: 'cmp_x' })), /unrecognized/i);
});
