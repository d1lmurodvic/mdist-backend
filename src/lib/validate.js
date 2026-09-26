/**
 * Validation infrastructure.
 *
 * Locked decision: a schema validation library (zod). One schema definition
 * per resource, applied at the HTTP boundary, so the shape of every endpoint
 * is declared in exactly one place and the backend stays authoritative
 * (API_CONTRACT.md §8, DEVELOPMENT_RULES.md §5.6).
 *
 * ZodError is translated into the documented VALIDATION_ERROR envelope with
 * field-level details the frontend can attach to inputs.
 */

import { z } from 'zod';
import { badRequest } from './errors.js';
import { isIsoDate, PERIOD_PRESETS } from './dates.js';
import { isSupportedCurrency } from './money.js';

/** Translate a ZodError into error.details: [{ field, issue }]. */
function toDetails(error) {
  return error.issues.map((issue) => {
    const field = issue.path.length > 0 ? issue.path.join('.') : '_root';
    return { field, issue: issue.message };
  });
}

/**
 * Run a schema, returning parsed (and coerced) data or throwing a
 * VALIDATION_ERROR AppError with field details.
 */
export function parseOrThrow(schema, value, { message } = {}) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(message || 'Request failed validation.', toDetails(result.error));
  }
  return result.data;
}

export function validate(schema, value, options) {
  return parseOrThrow(schema, value, options);
}

/** Route middleware: validate the JSON body and expose it as req.validBody. */
export function validateBody(schema) {
  return function validateBodyMiddleware(req) {
    req.validBody = parseOrThrow(schema, req.body ?? {});
    return undefined;
  };
}

/* ------------------------------------------------------------------ *
 * Reusable field schemas
 * ------------------------------------------------------------------ */

export const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z]{2,6}_[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a valid opaque identifier');

/** 'YYYY-MM-DD', validated for real calendar existence. */
export const isoDateSchema = z
  .string()
  .refine(isIsoDate, { message: 'must be a valid YYYY-MM-DD date' });

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter uppercase ISO 4217 code')
  .refine(isSupportedCurrency, { message: 'is not a supported currency' });

const MINOR_UNITS_ISSUE = 'must be an integer number of minor units';

/**
 * Monetary amount in integer minor units, as a JSON integer (API_CONTRACT.md
 * §2, §8). Strings such as "125000" are rejected — no silent string-to-number
 * conversion — as are floats and values beyond ±(2^53 − 1), the range money.js
 * can store and serialize exactly. Output is a BigInt (money.js works in BigInt).
 */
export const amountMinorSchema = z
  .number({ message: MINOR_UNITS_ISSUE })
  .transform((value, ctx) => {
    if (!Number.isInteger(value)) {
      ctx.addIssue({ code: 'custom', message: MINOR_UNITS_ISSUE });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({ code: 'custom', message: 'is out of the supported range' });
      return z.NEVER;
    }
    return BigInt(value);
  });

/** Positive amount — used for transaction/invoice magnitudes. */
export const positiveAmountMinorSchema = amountMinorSchema.refine(
  (value) => value > 0n,
  { message: 'must be greater than zero' },
);

/** Money on the wire: { amount, currency } (API_CONTRACT.md §2). */
export const moneySchema = z.strictObject({ amount: amountMinorSchema, currency: currencySchema });
export const positiveMoneySchema = z.strictObject({ amount: positiveAmountMinorSchema, currency: currencySchema });

/**
 * Canonical email: trimmed and lower-cased. An email identifies one person
 * regardless of letter case, so this is the only form ever stored or looked up.
 * The database refuses any other form (migration 002).
 */
export function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

/**
 * Email at the API boundary: normalised, then validated. Zod's email format is
 * ASCII-only, which keeps it consistent with SQLite's ASCII lower()/trim()
 * used by the database guard.
 */
export const emailSchema = z
  .string()
  .transform(normalizeEmail)
  .pipe(z.email({ message: 'must be a valid email address' }).max(254));

/** Presets a client may send (API_CONTRACT.md §7); internal presets are rejected. */
export const periodPresetSchema = z.enum(PERIOD_PRESETS);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Date ranges are start-inclusive, end-exclusive: `from <= date < to`, and
 * likewise `periodStart <= date < periodEnd` (API_CONTRACT.md §7). The end
 * must therefore be strictly later than the start; one day is from=D, to=D+1.
 */
function checkDateRangeOrder(value, ctx) {
  const pairs = [['from', 'to'], ['periodStart', 'periodEnd']];
  for (const [startKey, endKey] of pairs) {
    const start = value[startKey];
    const end = value[endKey];
    if (start && end && start >= end) {
      ctx.addIssue({
        code: 'custom',
        path: [startKey],
        message: `must be earlier than \`${endKey}\` (\`${endKey}\` is exclusive)`,
      });
    }
  }
}

const dateRangeShape = {
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  period: periodPresetSchema.optional(),
  periodStart: isoDateSchema.optional(),
  periodEnd: isoDateSchema.optional(),
};

/** Common list query parameters, with strict handling of unknown values. */
export const listQuerySchema = paginationSchema
  .extend({
    sort: z.string().optional(),
    q: z.string().max(200).optional(),
    ...dateRangeShape,
    includeUncategorized: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .superRefine(checkDateRangeOrder);

export const dateRangeQuerySchema = z.object(dateRangeShape).superRefine(checkDateRangeOrder);

/** Reject unexpected top-level keys so typos surface instead of being ignored. */
export function strictObject(shape) {
  return z.strictObject(shape);
}

export { z };
