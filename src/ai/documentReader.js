/**
 * AI capability: invoice/receipt document reading (AI_CONTEXT.md §4.1).
 *
 * The capability boundary between the document service and any provider:
 *
 *   documents service ──▶ documentReader ──▶ provider adapter (optional)
 *
 * - Adapters are looked up by the configured AI_PROVIDER name. None ships
 *   yet: no OCR/vision vendor is approved (AI_CONTEXT.md §7, phase D), so the
 *   reader reports itself unavailable and the product falls back to manual
 *   entry. It never invents a value, a confidence or a document type.
 * - An adapter's output is external input: it is validated here (strict
 *   schema, money as integer minor units, confidence only alongside a value)
 *   and anything else is treated as a provider failure.
 * - This module reads documents; it computes no financial figure.
 *
 * Adapter interface:
 *   readDocument({ bytes, mimeType, signal }) -> Promise<ProviderResult>
 * where ProviderResult is `providerResultSchema` below. Amounts are integer
 * minor units in the stated currency (UZS exponent 0, D9); tax rates are
 * integer basis points (1250 = 12.5%).
 */

import { z } from 'zod';
import { currencySchema, isoDateSchema } from '../lib/validate.js';
import { MAX_SAFE_MINOR } from '../lib/money.js';

/** Vendor adapters by AI_PROVIDER name. None is implemented or approved yet. */
export const DOCUMENT_READER_ADAPTERS = Object.freeze({});

/** How long one provider call may take before the document fails. */
export const EXTRACTION_TIMEOUT_MS = 60_000;
/** Below this confidence a field is flagged for review (PRD #10). */
export const REVIEW_CONFIDENCE_THRESHOLD = 0.8;

/** A failure the document records; `code` is the documents.failure_code value. */
export class ExtractionFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const confidence = z.number().min(0).max(1);
const minorUnits = z.number().int().min(0).max(Number(MAX_SAFE_MINOR));
const money = z.strictObject({ amount: minorUnits, currency: currencySchema });

/** { value, confidence }: a missing value has no confidence. */
const field = (valueSchema) =>
  z
    .strictObject({ value: valueSchema.nullable(), confidence: confidence.nullable() })
    .refine((f) => (f.value === null) === (f.confidence === null), {
      message: 'confidence must be given exactly when a value is',
    });

const lineItem = z.strictObject({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPrice: money,
  taxRate: z.number().int().min(0).max(10000).nullable(),
});

export const providerResultSchema = z.discriminatedUnion('readable', [
  z.strictObject({ readable: z.literal(false) }),
  z.strictObject({
    readable: z.literal(true),
    documentType: field(z.enum(['invoice', 'receipt'])),
    date: field(isoDateSchema),
    subtotal: field(money),
    tax: field(money),
    total: field(money),
    vendor: field(z.string().trim().min(1).max(200)),
    customer: field(z.string().trim().min(1).max(200)),
    lineItems: field(z.array(lineItem).max(200)),
  }),
]);

export const EXTRACTED_FIELDS = Object.freeze(['documentType', 'date', 'subtotal', 'tax', 'total', 'vendor', 'customer', 'lineItems']);

/**
 * Fields a person must look at: missing, below the confidence threshold, or
 * in a currency other than the company's (which could not be recorded as is).
 */
export function fieldsNeedingReview(fields, companyCurrency) {
  const review = [];
  for (const name of EXTRACTED_FIELDS) {
    const { value, confidence: score } = fields[name];
    if (value === null) review.push({ field: name, reason: 'missing' });
    else if (score < REVIEW_CONFIDENCE_THRESHOLD) review.push({ field: name, reason: 'low_confidence' });
    else if (value?.currency && value.currency !== companyCurrency) review.push({ field: name, reason: 'currency_mismatch' });
  }
  return review;
}

function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExtractionFailure('timeout', 'Automated extraction took too long and was stopped.'));
    }, timeoutMs);
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

export function createDocumentReader({ config, adapters = DOCUMENT_READER_ADAPTERS, timeoutMs = EXTRACTION_TIMEOUT_MS }) {
  const provider = config.ai.enabled ? config.ai.provider : null;
  const adapter = provider ? adapters[provider] ?? null : null;

  const unavailableNote = provider
    ? `Automated extraction is unavailable: no document reader exists for AI provider "${provider}". Enter the details manually.`
    : 'Automated extraction is unavailable: no AI provider is configured. Enter the details manually.';

  return {
    /** What the capability can do right now, for capability disclosure. */
    capability() {
      return adapter
        ? { available: true, method: 'ai', provider, note: null }
        : { available: false, method: 'unavailable', provider, note: unavailableNote };
    },

    /**
     * Read one document. Resolves with validated fields, or rejects with an
     * ExtractionFailure (never with invented data).
     */
    async read({ bytes, mimeType }) {
      if (!adapter) throw new ExtractionFailure('ai_unavailable', unavailableNote);

      let raw;
      try {
        raw = await withTimeout((signal) => adapter.readDocument({ bytes, mimeType, signal }), timeoutMs);
      } catch (error) {
        if (error instanceof ExtractionFailure) throw error;
        // The provider's own message may contain internals; it is not surfaced.
        throw new ExtractionFailure('provider_error', 'The document reader failed. Try again later or enter the details manually.');
      }

      const parsed = providerResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ExtractionFailure('invalid_provider_response', 'The document reader returned an unusable result. Enter the details manually.');
      }
      if (!parsed.data.readable) {
        throw new ExtractionFailure('unreadable', 'The document could not be read. Check the file or enter the details manually.');
      }
      const { readable, ...fields } = parsed.data;
      return { provider, fields };
    },
  };
}
