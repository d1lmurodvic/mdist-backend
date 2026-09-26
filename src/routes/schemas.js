/**
 * Request schemas for the final backend completion (API_CONTRACT.md §9.2–§9.13).
 * Bodies are strict (unknown keys → 400); query strings ignore unknown keys
 * but reject invalid values (API_CONTRACT.md §7, §8).
 */

import {
  dateRangeQuerySchema,
  emailSchema,
  idSchema,
  isoDateSchema,
  paginationSchema,
  periodPresetSchema,
  currencySchema,
  z,
} from '../lib/validate.js';
import { PASSWORD_MAX_LENGTH } from './auth.js';
import { NOTIFICATION_TYPES } from '../services/notifications.js';
import { ANOMALY_SEVERITIES, ANOMALY_STATUSES } from '../services/anomalies.js';
import { MAX_ACTIVITY_ITEMS } from '../services/dashboard.js';
import { MAX_QUESTION_LENGTH } from '../ai/assistant.js';

const text = (max) => z.string().trim().min(1).max(max);
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const atLeastOne = (schema, keys) => schema.refine(
  (value) => keys.some((key) => value[key] !== undefined),
  { message: 'at least one field is required' },
);

function periodPair(value, ctx) {
  if ((value.periodStart === undefined || value.periodStart === null) !== (value.periodEnd === undefined || value.periodEnd === null)) {
    ctx.addIssue({ code: 'custom', path: ['periodStart'], message: 'periodStart and periodEnd go together' });
  } else if (value.periodStart && value.periodEnd && value.periodStart >= value.periodEnd) {
    ctx.addIssue({ code: 'custom', path: ['periodStart'], message: 'must be earlier than `periodEnd` (`periodEnd` is exclusive)' });
  }
}

export const ACCOUNTANT_TOPICS = Object.freeze(['bookkeeping', 'tax_preparation', 'financial_statements', 'advisory', 'other']);
export const ACCOUNTANT_STATUSES = Object.freeze(['requested', 'in_contact', 'closed']);

export function finalSchemas(config) {
  const accountantFields = {
    contactName: text(200),
    contactEmail: emailSchema,
    contactPhone: text(50).nullable().optional(),
    topic: z.enum(ACCOUNTANT_TOPICS),
    description: text(2000),
    periodStart: isoDateSchema.nullable().optional(),
    periodEnd: isoDateSchema.nullable().optional(),
    shareSummary: z.boolean().optional(),
  };

  return {
    periodQuery: dateRangeQuerySchema,
    periodBody: z.strictObject({
      period: periodPresetSchema.optional(),
      periodStart: isoDateSchema.optional(),
      periodEnd: isoDateSchema.optional(),
    }),
    revenueQuery: dateRangeQuerySchema.extend({
      granularity: z.enum(['day', 'week', 'month']).optional(),
      categoryId: z.array(idSchema).max(50).optional(),
    }),
    balanceSheetQuery: z.object({ asOf: isoDateSchema.optional() }),
    activityQuery: z.object({ limit: z.coerce.number().int().min(1).max(MAX_ACTIVITY_ITEMS).default(20) }),

    forecast: z.strictObject({ horizonDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(30) }),

    insightsQuery: dateRangeQuerySchema.extend({ includeDismissed: booleanQuery.optional() }),
    anomalyListQuery: paginationSchema.extend({
      status: z.array(z.enum(ANOMALY_STATUSES)).optional(),
      severity: z.array(z.enum(ANOMALY_SEVERITIES)).optional(),
      from: isoDateSchema.optional(),
      to: isoDateSchema.optional(),
    }),
    anomalyUpdate: z.strictObject({ status: z.enum(ANOMALY_STATUSES), note: text(1000).nullable().optional() }),
    assistantMessage: z.strictObject({ message: text(MAX_QUESTION_LENGTH) }),
    assistantListQuery: paginationSchema,
    categorize: z.union([
      z.strictObject({ transactionId: idSchema }),
      z.strictObject({ type: z.enum(['income', 'expense']), payee: text(200).optional(), description: text(500).optional() })
        .refine((value) => value.payee || value.description, { message: 'payee or description is required' }),
    ]),

    notificationListQuery: paginationSchema.extend({ unreadOnly: booleanQuery.optional() }),

    accountantCreate: z.strictObject(accountantFields).superRefine(periodPair),
    accountantUpdate: atLeastOne(
      z.strictObject(Object.fromEntries(Object.entries(accountantFields).map(([key, schema]) => [key, schema.optional()]))),
      Object.keys(accountantFields),
    ).superRefine(periodPair),
    accountantListQuery: z.object({ status: z.array(z.enum(ACCOUNTANT_STATUSES)).optional() }),

    profileUpdate: atLeastOne(z.strictObject({ name: text(200).optional(), email: emailSchema.optional() }), ['name', 'email']),
    passwordChange: z.strictObject({
      currentPassword: z.string().min(1, 'is required').max(PASSWORD_MAX_LENGTH),
      newPassword: z.string()
        .min(config.security.passwordMinLength, `must be at least ${config.security.passwordMinLength} characters`)
        .max(PASSWORD_MAX_LENGTH),
    }),
    preferencesUpdate: z.strictObject({
      notifications: z.strictObject(Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, z.boolean().optional()]))),
      acknowledgeCritical: z.boolean().optional(),
    }),
    companyUpdate: atLeastOne(z.strictObject({
      name: text(200).optional(),
      industry: text(100).nullable().optional(),
      size: text(100).nullable().optional(),
      currency: currencySchema.optional(),
      fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
      confirm: z.boolean().optional(),
    }), ['name', 'industry', 'size', 'currency', 'fiscalYearStartMonth']),
    memberUpdate: z.strictObject({ role: z.enum(['owner', 'member']) }),
    empty: z.strictObject({}),
  };
}
