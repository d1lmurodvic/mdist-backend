/**
 * Environment configuration.
 *
 * Validated once at startup and frozen. The process refuses to start on
 * invalid configuration (ARCHITECTURE.md §5.2) rather than failing later at
 * an arbitrary call site.
 *
 * `.env` is loaded if present, but every value can equally come from the real
 * environment. No secret is ever defaulted to a working value: if a required
 * secret-like setting is missing, startup fails.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { z } from 'zod';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Load a .env file if one exists. Absence is not an error. */
export function loadEnvFile(file = path.join(backendRoot, '.env')) {
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 'true' | 'false' | '1' | '0' -> boolean; absent -> `fallback`.
 *
 * The fallback is applied inside the transform on purpose: in Zod 4,
 * `.default()` after a transform short-circuits and returns the default as-is,
 * so `.default('false')` produced the truthy STRING 'false'.
 */
const envBoolean = (fallback) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((value) => (value === undefined ? fallback : value === 'true' || value === '1'));

/**
 * Comma-separated exact origins, or a lone '*'. An entry that is not an exact
 * origin (scheme://host[:port], lower-case, no path or trailing slash) could
 * never equal a browser's Origin header, so it is rejected at startup instead
 * of silently disabling CORS.
 */
const corsOrigins = z
  .string()
  .default('http://localhost:5173')
  .transform((raw, ctx) => {
    const origins = raw.split(',').map((origin) => origin.trim()).filter(Boolean);
    if (origins.includes('*') && origins.length > 1) {
      ctx.addIssue({ code: 'custom', message: '"*" cannot be combined with explicit origins' });
    }
    for (const origin of origins) {
      if (origin === '*') continue;
      let parsed = null;
      try {
        parsed = new URL(origin);
      } catch {
        // Reported below.
      }
      const isExactOrigin = parsed !== null
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.origin === origin;
      if (!isExactOrigin) {
        ctx.addIssue({
          code: 'custom',
          message: `"${origin}" is not an exact origin such as https://app.example.com (scheme, host and optional port; no path or trailing slash)`,
        });
      }
    }
    return origins;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(4000),
  HOST: z.string().min(1).default('127.0.0.1'),
  // Behind one reverse proxy (e.g. Render): take the client address from the
  // last X-Forwarded-For entry, the one the proxy itself appended.
  TRUST_PROXY: envBoolean(false),
  CORS_ALLOWED_ORIGINS: corsOrigins,

  DATABASE_PATH: z.string().min(1).default('data/ifrsmart.sqlite'),
  DATABASE_ALLOW_MEMORY: envBoolean(false),

  SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(60 * 60 * 24 * 30).default(86400),
  SESSION_BIND_IP: envBoolean(false),

  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(8),
  // Defaults follow the OWASP password-storage minimum for scrypt:
  // N = 2^17, r = 8, p = 1 (128 MiB per hash). The test suite lowers N.
  SCRYPT_COST: z.coerce
    .number()
    .int()
    .min(16384)
    .max(1048576)
    .refine((value) => Number.isInteger(Math.log2(value)), { message: 'must be a power of two' })
    .default(131072),
  SCRYPT_BLOCK_SIZE: z.coerce.number().int().min(1).max(1024).default(8),
  SCRYPT_PARALLELIZATION: z.coerce.number().int().min(1).max(16).default(1),
  SCRYPT_MAXMEM: z.coerce.number().int().min(33554432).default(268435456),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  UPLOAD_DIR: z.string().min(1).default('uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),

  AI_PROVIDER: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default(''),
  AI_BASE_URL: z.string().default(''),
  AI_DAILY_CALL_CAP_PER_COMPANY: z.coerce.number().int().min(0).default(50),

  // Google Document AI (AI_PROVIDER=google_document_ai). Credentials come from
  // the same sources Google's own libraries read: a key file path or its JSON.
  GOOGLE_CLOUD_PROJECT: z.string().default(''),
  DOCUMENT_AI_LOCATION: z.string().default('us'),
  DOCUMENT_AI_INVOICE_PROCESSOR_ID: z.string().default(''),
  DOCUMENT_AI_EXPENSE_PROCESSOR_ID: z.string().default(''),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().default(''),
  GOOGLE_APPLICATION_CREDENTIALS_JSON: z.string().default(''),
});

export const GOOGLE_DOCUMENT_AI_PROVIDER = 'google_document_ai';

/**
 * Build a frozen config object from an environment map.
 * Throws with every problem listed at once.
 */
export function loadConfig(source = process.env) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  const env = result.data;

  // AI is entirely optional (AI_CONTEXT.md). Configured but incomplete is a
  // startup error, because a half-configured provider produces confusing
  // runtime failures instead of a truthful "unavailable".
  const aiProvider = env.AI_PROVIDER.trim();
  const aiConfigured = aiProvider !== '';
  const google = Object.freeze({
    projectId: env.GOOGLE_CLOUD_PROJECT.trim(),
    location: env.DOCUMENT_AI_LOCATION.trim() || 'us',
    invoiceProcessorId: env.DOCUMENT_AI_INVOICE_PROCESSOR_ID.trim(),
    expenseProcessorId: env.DOCUMENT_AI_EXPENSE_PROCESSOR_ID.trim(),
    credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS.trim(),
    credentialsJson: env.GOOGLE_APPLICATION_CREDENTIALS_JSON.trim(),
  });
  if (aiProvider === GOOGLE_DOCUMENT_AI_PROVIDER) {
    // Google Document AI does not use AI_API_KEY/AI_MODEL: it needs a project,
    // at least one processor and Google credentials.
    const missing = [];
    if (!google.projectId) missing.push('GOOGLE_CLOUD_PROJECT');
    if (!google.invoiceProcessorId && !google.expenseProcessorId) {
      missing.push('DOCUMENT_AI_INVOICE_PROCESSOR_ID or DOCUMENT_AI_EXPENSE_PROCESSOR_ID');
    }
    if (!google.credentialsFile && !google.credentialsJson) {
      missing.push('GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS_JSON');
    }
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration:\n${missing.map((name) => `  - AI_PROVIDER is set to "${aiProvider}" but ${name} is missing`).join('\n')}`,
      );
    }
  } else if (aiConfigured) {
    const missing = [];
    if (!env.AI_API_KEY.trim()) missing.push('AI_API_KEY');
    if (!env.AI_MODEL.trim()) missing.push('AI_MODEL');
    if (missing.length > 0) {
      throw new Error(
        `Invalid configuration:\n  - AI_PROVIDER is set to "${aiProvider}" but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. Either configure all AI settings or leave AI_PROVIDER empty.`,
      );
    }
  }

  // scrypt needs about 128 * N * r bytes; with too little maxmem every
  // registration and login would fail at runtime instead of at startup.
  const scryptBytes = 128 * env.SCRYPT_COST * env.SCRYPT_BLOCK_SIZE;
  if (env.SCRYPT_MAXMEM <= scryptBytes) {
    throw new Error(
      `Invalid configuration:\n  - SCRYPT_MAXMEM must exceed 128 * SCRYPT_COST * SCRYPT_BLOCK_SIZE (${scryptBytes} bytes)`,
    );
  }

  // A wildcard can never be paired with credentials, so production requires
  // explicit origins.
  if (env.NODE_ENV === 'production' && env.CORS_ALLOWED_ORIGINS.includes('*')) {
    throw new Error('Invalid configuration:\n  - CORS_ALLOWED_ORIGINS must not be "*" in production');
  }

  const resolveFromRoot = (value) => (path.isAbsolute(value) ? value : path.join(backendRoot, value));

  return Object.freeze({
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    backendRoot,

    server: Object.freeze({
      port: env.PORT,
      host: env.HOST,
      trustProxy: env.TRUST_PROXY,
      corsAllowedOrigins: Object.freeze(env.CORS_ALLOWED_ORIGINS),
    }),

    database: Object.freeze({
      path: env.DATABASE_PATH === ':memory:' ? ':memory:' : resolveFromRoot(env.DATABASE_PATH),
      allowMemory: env.DATABASE_ALLOW_MEMORY,
      isMemory: env.DATABASE_PATH === ':memory:',
    }),

    session: Object.freeze({
      ttlSeconds: env.SESSION_TTL_SECONDS,
      bindIp: env.SESSION_BIND_IP,
    }),

    security: Object.freeze({
      passwordMinLength: env.PASSWORD_MIN_LENGTH,
      scrypt: Object.freeze({
        cost: env.SCRYPT_COST,
        blockSize: env.SCRYPT_BLOCK_SIZE,
        parallelization: env.SCRYPT_PARALLELIZATION,
        maxmem: env.SCRYPT_MAXMEM,
      }),
    }),

    storage: Object.freeze({
      driver: env.STORAGE_DRIVER,
      uploadDir: resolveFromRoot(env.UPLOAD_DIR),
      maxBytes: env.UPLOAD_MAX_BYTES,
      allowedMimeTypes: Object.freeze([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/heic',
        'application/pdf',
      ]),
    }),

    logLevel: env.LOG_LEVEL,

    ai: Object.freeze({
      enabled: aiConfigured,
      provider: aiProvider,
      apiKey: env.AI_API_KEY,
      model: env.AI_MODEL,
      baseUrl: env.AI_BASE_URL,
      dailyCallCapPerCompany: env.AI_DAILY_CALL_CAP_PER_COMPANY,
      google: Object.freeze({
        ...google,
        credentialsFile: google.credentialsFile ? resolveFromRoot(google.credentialsFile) : '',
      }),
    }),
  });
}

export { backendRoot };
