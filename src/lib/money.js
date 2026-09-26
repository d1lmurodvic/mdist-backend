/**
 * Money handling for IFRSmart.
 *
 * Approved model (locked): every monetary value is an INTEGER number of minor
 * units plus an explicit currency. Examples:
 *   { amountMinor: 125000, currency: 'UZS' }  -> 125,000 UZS   (exponent 0)
 *   { amountMinor: 125000, currency: 'USD' }  -> 1,250.00 USD   (exponent 2)
 *
 * Why BigInt: the locked rule is "never use JavaScript Number arithmetic for
 * monetary calculations". Every arithmetic helper here takes and returns
 * BigInt, so integer minor units can never silently become a float.
 *
 * Exact range: ±(2^53 − 1) minor units (MAX_SAFE_MINOR). JSON numbers are exact
 * only up to there, and node:sqlite reads an INTEGER column as a Number and
 * throws ERR_OUT_OF_RANGE beyond it. A value outside this range is therefore
 * refused at the API boundary (validate.js), at persistence (toSqlInteger) and
 * at serialization (toSafeNumber) — never rounded.
 *
 * There is no float parsing anywhere: fromMajor() takes a string, so
 * "100.10" is converted digit-by-digit instead of via parseFloat.
 */

import { badRequest } from './errors.js';

/**
 * Minor-unit exponent per currency. Currencies with no decimal unit use 0,
 * so 125000 UZS is exactly 125,000 UZS rather than 1,250.00.
 * A supported currency (SUPPORTED_CURRENCIES) that is not listed here uses 2
 * decimal places, the ISO 4217 default; unsupported codes are rejected by
 * assertCurrency().
 *
 * LOCKED (ARCHITECTURE.md D9): UZS uses exponent 0 inside IFRSmart, so
 * 125000 UZS is amountMinor 125000. ISO 4217 lists 2 (tiyin); the product
 * deliberately does not use it. Changing this would rescale every stored UZS
 * amount.
 */
const CURRENCY_EXPONENTS = Object.freeze({
  UZS: 0, JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, PYG: 0, RWF: 0, UGX: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

const DEFAULT_EXPONENT = 2;

/** Largest magnitude, in minor units, that is stored and serialized exactly. */
export const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
export const MIN_SAFE_MINOR = -MAX_SAFE_MINOR;

const SUPPORTED_CURRENCIES = Object.freeze(
  new Set([
    'UZS', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'INR', 'KRW', 'TRY',
    'RUB', 'BRL', 'MXN', 'ZAR', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'UAH', 'KZT',
    'AED', 'SAR', 'ILS', 'EGP', 'NGN', 'KES', 'PKR', 'BDT', 'LKR', 'VND', 'THB', 'MYR', 'IDR',
    'PHP', 'GHS', 'MAD', 'DZD', 'AZN', 'GEL', 'AMD',
    // Three-decimal-place currencies.
    'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
  ]),
);

export function isSupportedCurrency(currency) {
  return SUPPORTED_CURRENCIES.has(currency);
}

export function exponentFor(currency) {
  assertCurrency(currency);
  return Object.hasOwn(CURRENCY_EXPONENTS, currency) ? CURRENCY_EXPONENTS[currency] : DEFAULT_EXPONENT;
}

export function assertCurrency(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw badRequest('Currency must be a 3-letter uppercase ISO 4217 code.', [
      { field: 'currency', issue: 'must be a 3-letter uppercase ISO 4217 code' },
    ]);
  }
  if (!isSupportedCurrency(currency)) {
    throw badRequest(`Currency ${currency} is not supported.`, [
      { field: 'currency', issue: 'unsupported currency code' },
    ]);
  }
}

/**
 * Convert a minor-unit value to BigInt. Accepts BigInt, integer Number, or
 * numeric string. Rejects floats, NaN and non-integers outright — a float
 * reaching this function means an upstream bug, and silently rounding it
 * would corrupt a financial figure.
 */
export function toMinor(value, field = 'amountMinor') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw badRequest('Monetary amounts must be whole minor units.', [
        { field, issue: 'must be an integer number of minor units' },
      ]);
    }
    if (!Number.isSafeInteger(value)) {
      throw badRequest('Monetary amount exceeds the supported range.', [
        { field, issue: 'out of range' },
      ]);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw badRequest('Monetary amounts must be an integer number of minor units.', [
    { field, issue: 'must be an integer number of minor units' },
  ]);
}

export function add(a, b) {
  return toMinor(a) + toMinor(b);
}

export function subtract(a, b) {
  return toMinor(a) - toMinor(b);
}

export function negate(a) {
  return -toMinor(a);
}

export function sum(values) {
  let total = 0n;
  for (const value of values) total += toMinor(value);
  return total;
}

export function compare(a, b) {
  const left = toMinor(a);
  const right = toMinor(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function isNegative(a) {
  return toMinor(a) < 0n;
}

export function abs(a) {
  const value = toMinor(a);
  return value < 0n ? -value : value;
}

export function max(a, b) {
  return compare(a, b) >= 0 ? toMinor(a) : toMinor(b);
}

export function min(a, b) {
  return compare(a, b) <= 0 ? toMinor(a) : toMinor(b);
}

/**
 * BigInt -> Number for JSON serialization only. Throws rather than silently
 * losing precision if the value cannot be represented exactly, so an
 * unrepresentable figure becomes a visible error instead of wrong data.
 */
export function toSafeNumber(value) {
  const big = toMinor(value);
  if (big > MAX_SAFE_MINOR || big < MIN_SAFE_MINOR) {
    throw new Error('Monetary value cannot be serialized exactly as a JSON number.');
  }
  return Number(big);
}

/**
 * The wire form of money (API_CONTRACT.md §2): { amount, currency }, amount in
 * integer minor units. Every monetary value in a response goes through here.
 */
export function moneyJson(value, currency) {
  assertCurrency(currency);
  return { amount: toSafeNumber(value), currency };
}

/**
 * Change from `previous` to `current` in basis points (1% = 100), rounded half
 * away from zero, computed in BigInt. null when there is no base to compare
 * with (previous is zero).
 */
export function changeBasisPoints(current, previous) {
  const base = abs(previous);
  if (base === 0n) return null;
  return toSafeNumber(divideRoundHalfAway((toMinor(current) - toMinor(previous)) * 10000n, base));
}

/** numerator / denominator (denominator > 0), rounded half away from zero. */
function divideRoundHalfAway(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const roundAway = abs(remainder) * 2n >= denominator ? (numerator < 0n ? -1n : 1n) : 0n;
  return quotient + roundAway;
}

/**
 * `amount` × `basisPoints` / 10000 in minor units (1200 bp = 12%), rounded
 * half away from zero, in exact BigInt arithmetic. Used for a line's tax.
 */
export function applyBasisPoints(amount, basisPoints) {
  return divideRoundHalfAway(toMinor(amount) * BigInt(basisPoints), 10000n);
}

/**
 * Major-unit decimal string -> minor-unit BigInt, without floating point.
 * Accepts "100", "100.1", "100.10", "-5.05". Used for import/manual entry
 * where a human reads a decimal amount.
 */
export function fromMajor(decimalString, currency, field = 'amount') {
  assertCurrency(currency);
  const text = String(decimalString).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw badRequest('Amount must be a decimal number.', [{ field, issue: 'must be a decimal number' }]);
  }
  const exponent = exponentFor(currency);
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');

  if (fraction.length > exponent) {
    throw badRequest(`Amount has more decimal places than ${currency} supports.`, [
      { field, issue: `supports at most ${exponent} decimal place(s)` },
    ]);
  }
  const padded = fraction.padEnd(exponent, '0');
  const combined = BigInt(`${whole}${padded || ''}`);
  return negative ? -combined : combined;
}

/**
 * Minor units -> a human-readable major-unit string, e.g. 125000 USD -> "1250.00".
 * Presentation only: never feed the result back into arithmetic.
 */
export function formatMajor(value, currency) {
  const exponent = exponentFor(currency);
  const big = toMinor(value);
  const negative = big < 0n;
  const digits = (negative ? -big : big).toString().padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/**
 * Integer minor units -> a value to bind to a SQLite INTEGER column.
 *
 * The range check happens BEFORE any Number conversion, and the range is the
 * exact round-trip range (see the file header): a value SQLite could store as
 * a 64-bit integer but node:sqlite could not read back is refused here rather
 * than written. Inside the range, Number(big) is exact.
 */
export function toSqlInteger(value, field = 'amountMinor') {
  const big = toMinor(value, field);
  if (big > MAX_SAFE_MINOR || big < MIN_SAFE_MINOR) {
    throw badRequest('Monetary amount exceeds the supported range.', [
      { field, issue: `must be between ${MIN_SAFE_MINOR} and ${MAX_SAFE_MINOR} minor units` },
    ]);
  }
  return Number(big);
}
