/**
 * Document reader adapter: Google Cloud Document AI (AI_CONTEXT.md §4.1,
 * phase D). Uses the pretrained Invoice parser and Expense (receipt) parser
 * over the REST API — no SDK.
 *
 *   PDF   -> invoice parser first, expense parser if no total was found
 *   image -> expense parser first, invoice parser if no total was found
 *
 * (Only configured processors are used, so one of them is enough.) One read
 * is at most two processor calls.
 *
 * Mapping rules — nothing is invented:
 * - A value is taken from Google's normalised value where one exists; a
 *   field Google did not find stays { value: null, confidence: null }.
 * - Confidence is Google's per-entity confidence. An entity without one is
 *   given 0, so it is always flagged for review rather than trusted.
 * - Money is converted to integer minor units exactly; an amount that does
 *   not fit the currency's minor unit, has no identifiable currency or is
 *   negative is left missing, never rounded.
 * - documentType is only stated with evidence: 'invoice' when the invoice
 *   parser found an invoice number, 'receipt' when the expense parser found
 *   a total. Each carries the confidence of that evidence.
 * - A line's unit price is derived only by exact arithmetic (amount ÷ whole
 *   quantity), and quantity 1 only when unit price equals the line amount.
 *   Per-line tax rates are not given by either parser, so they stay null.
 * - Document text is never logged; only the processor, status and latency.
 */

import { exponentFor, isSupportedCurrency, MAX_SAFE_MINOR } from '../../lib/money.js';
import { isIsoDate } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { ExtractionFailure } from '../extractionFailure.js';
import { createGoogleTokenProvider, loadGoogleCredentials } from './auth.js';

export const GOOGLE_DOCUMENT_AI = 'google_document_ai';

/** File types the Document AI parsers accept (HEIC is not one of them). */
export const READABLE_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MAX_LINES = 200;
const MISSING = Object.freeze({ value: null, confidence: null });

/** Printed currency marks -> ISO codes. Ambiguous marks (¥, kr) are left out. */
const CURRENCY_MARKS = new Map([
  ['$', 'USD'], ['us$', 'USD'], ['€', 'EUR'], ['£', 'GBP'], ['₹', 'INR'], ['₺', 'TRY'], ['₸', 'KZT'], ['₴', 'UAH'],
  ['₽', 'RUB'], ['руб', 'RUB'], ['руб.', 'RUB'], ['₩', 'KRW'], ['₫', 'VND'], ['zł', 'PLN'],
  ['сум', 'UZS'], ['сўм', 'UZS'], ["so'm", 'UZS'], ['soʻm', 'UZS'], ['som', 'UZS'], ['sum', 'UZS'], ['soum', 'UZS'],
]);

const clean = (text) => (typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '');
const score = (entity) => (Number.isFinite(entity?.confidence) ? Math.min(1, Math.max(0, entity.confidence)) : 0);
const found = (value, entity) => (value === null ? MISSING : { value, confidence: score(entity) });

/** The most confident entity of a type, or null. */
function best(entities, type) {
  let winner = null;
  for (const entity of entities) {
    if (entity?.type === type && (!winner || score(entity) > score(winner))) winner = entity;
  }
  return winner;
}

export function currencyCode(text) {
  const raw = clean(text);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (/^[A-Z]{3}$/.test(upper)) return isSupportedCurrency(upper) ? upper : null;
  return CURRENCY_MARKS.get(raw.toLowerCase()) ?? null;
}

function textOf(entity, max) {
  const text = clean(entity?.normalizedValue?.text) || clean(entity?.mentionText);
  return text ? text.slice(0, max).trim() : null;
}

function dateOf(entity) {
  const date = entity?.normalizedValue?.dateValue;
  if (date?.year && date.month && date.day) {
    const iso = `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
    if (isIsoDate(iso)) return iso;
  }
  const text = clean(entity?.normalizedValue?.text);
  return isIsoDate(text) ? text : null;
}

/** Google's Money { currencyCode, units, nanos } -> { amount (minor units), currency } exactly, else null. */
export function moneyOf(entity, fallbackCurrency) {
  const money = entity?.normalizedValue?.moneyValue;
  if (!money) return null;
  // A code Google stated but IFRSmart does not support is not replaced by a guess.
  const currency = clean(money.currencyCode) ? currencyCode(money.currencyCode) : fallbackCurrency;
  if (!currency) return null;
  let units;
  let nanos;
  try {
    units = BigInt(money.units ?? 0);
    nanos = BigInt(money.nanos ?? 0);
  } catch {
    return null;
  }
  if (units < 0n || nanos < 0n) return null;
  const exponent = exponentFor(currency);
  const nanosPerMinor = 10n ** BigInt(9 - exponent);
  if (nanos % nanosPerMinor !== 0n) return null;
  const amount = units * 10n ** BigInt(exponent) + nanos / nanosPerMinor;
  if (amount > MAX_SAFE_MINOR) return null;
  return { amount: Number(amount), currency };
}

function quantityOf(entity) {
  if (!entity) return null;
  const float = entity.normalizedValue?.floatValue;
  const text = clean(entity.normalizedValue?.text) || clean(entity.mentionText);
  let value = Number.isFinite(float) ? float : null;
  if (value === null) {
    const compact = text.replace(/\s/g, '').replace(',', '.');
    if (!/^\d+(\.\d+)?$/.test(compact)) return null;
    value = Number(compact);
  }
  const thousandths = Math.round(value * 1000);
  if (Math.abs(value * 1000 - thousandths) > 1e-6 || value <= 0 || value > 1_000_000) return null;
  return thousandths / 1000;
}

/** The document's currency: its own currency entity, else the currency Google gave the total. */
function documentCurrency(entities) {
  const entity = best(entities, 'currency');
  const stated = currencyCode(entity?.normalizedValue?.text) ?? currencyCode(entity?.mentionText);
  if (stated) return found(stated, entity);
  for (const type of ['total_amount', 'net_amount', 'total_tax_amount']) {
    const money = best(entities, type);
    const code = currencyCode(money?.normalizedValue?.moneyValue?.currencyCode);
    if (code) return found(code, money);
  }
  return MISSING;
}

function lineItemsOf(entities, currency) {
  const rows = entities.filter((entity) => entity?.type === 'line_item').slice(0, MAX_LINES);
  const lines = [];
  let confidence = 1;
  for (const row of rows) {
    const properties = Array.isArray(row.properties) ? row.properties : [];
    const part = (name) => best(properties, `line_item/${name}`);
    const description = textOf(part('description'), 500);
    let quantity = quantityOf(part('quantity'));
    let unitPrice = moneyOf(part('unit_price'), currency);
    const amount = moneyOf(part('amount'), currency);

    if (!unitPrice && amount && quantity !== null && Number.isInteger(quantity) && amount.amount % quantity === 0) {
      unitPrice = { amount: amount.amount / quantity, currency: amount.currency };
    }
    if (quantity === null && unitPrice && amount && unitPrice.currency === amount.currency && unitPrice.amount === amount.amount) {
      quantity = 1;
    }
    if (description === null && quantity === null && unitPrice === null) continue;
    lines.push({ description, quantity, unitPrice, taxRate: null });
    confidence = Math.min(confidence, score(row));
  }
  return lines.length > 0 ? { value: lines, confidence } : MISSING;
}

/**
 * A Document AI `document` -> the reader's ProviderResult.
 * `kind` is the processor that produced it: 'invoice' | 'expense'.
 */
export function mapDocument(document, kind) {
  const entities = Array.isArray(document?.entities) ? document.entities : [];
  if (entities.length === 0) return { readable: false };

  const invoice = kind === 'invoice';
  const currency = documentCurrency(entities);
  const text = (type, max) => { const entity = best(entities, type); return found(textOf(entity, max), entity); };
  const money = (type) => { const entity = best(entities, type); return found(moneyOf(entity, currency.value), entity); };
  const date = (...types) => {
    for (const type of types) {
      const entity = best(entities, type);
      const value = dateOf(entity);
      if (value) return found(value, entity);
    }
    return MISSING;
  };

  const invoiceNumber = invoice ? text('invoice_id', 100) : MISSING;
  const total = money('total_amount');
  const fields = {
    documentType: invoice
      ? (invoiceNumber.value ? { value: 'invoice', confidence: invoiceNumber.confidence } : MISSING)
      : (total.value ? { value: 'receipt', confidence: total.confidence } : MISSING),
    invoiceNumber,
    date: invoice ? date('invoice_date') : date('receipt_date', 'purchase_date', 'invoice_date'),
    dueDate: invoice ? date('due_date') : MISSING,
    currency,
    subtotal: money('net_amount'),
    tax: money('total_tax_amount'),
    total,
    vendor: text('supplier_name', 200),
    customer: invoice ? text('receiver_name', 200) : MISSING,
    lineItems: lineItemsOf(entities, currency.value),
  };
  if (Object.values(fields).every((field) => field.value === null)) return { readable: false };
  return { readable: true, ...fields };
}

/**
 * @param {{ settings: { projectId, location, invoiceProcessorId, expenseProcessorId, credentialsFile, credentialsJson } }} options
 * `fetch` and `tokenProvider` are injectable for tests.
 */
export function createGoogleDocumentAiAdapter({ settings, fetch = globalThis.fetch, tokenProvider }) {
  const tokens = tokenProvider ?? createGoogleTokenProvider({
    credentials: loadGoogleCredentials({ file: settings.credentialsFile, json: settings.credentialsJson }),
    fetch,
  });
  const processors = { invoice: settings.invoiceProcessorId, expense: settings.expenseProcessorId };
  const endpoint = (processorId) =>
    `https://${settings.location}-documentai.googleapis.com/v1/projects/${settings.projectId}/locations/${settings.location}/processors/${processorId}:process`;

  async function run(kind, { bytes, mimeType, signal }) {
    const headers = { Authorization: `Bearer ${await tokens.accessToken(signal)}`, 'Content-Type': 'application/json; charset=utf-8' };
    if (tokens.isUserCredential) headers['x-goog-user-project'] = settings.projectId;
    const started = Date.now();
    const response = await fetch(endpoint(processors[kind]), {
      method: 'POST',
      headers,
      body: JSON.stringify({ rawDocument: { content: Buffer.from(bytes).toString('base64'), mimeType } }),
      signal,
    });
    const meta = { provider: GOOGLE_DOCUMENT_AI, processor: kind, status: response.status, latencyMs: Date.now() - started };
    if (!response.ok) logger.warn('document ai call failed', meta);
    else logger.debug('document ai call', meta);

    // INVALID_ARGUMENT: the file itself was refused (damaged, encrypted, too many pages).
    if (response.status === 400) {
      throw new ExtractionFailure('unreadable', 'The reader could not process this file (it may be damaged, password-protected or too long). Enter the details manually.');
    }
    if (!response.ok) throw new Error(`Document AI responded ${response.status}`);
    const body = await response.json();
    return mapDocument(body?.document, kind);
  }

  return {
    description: 'Google Document AI invoice and receipt parsers. Every value comes with Google’s confidence and is checked by you before anything is recorded.',

    async readDocument({ bytes, mimeType, signal }) {
      if (!READABLE_TYPES.includes(mimeType)) {
        throw new ExtractionFailure('unreadable', 'HEIC photos cannot be read automatically. Upload a JPEG, PNG or PDF, or enter the details manually.');
      }
      const order = (mimeType === 'application/pdf' ? ['invoice', 'expense'] : ['expense', 'invoice']).filter((kind) => processors[kind]);
      let fallback = null;
      for (const kind of order) {
        const result = await run(kind, { bytes, mimeType, signal });
        if (result.readable && result.total.value !== null) return result;
        if (!fallback || (!fallback.readable && result.readable)) fallback = result;
      }
      return fallback;
    },
  };
}
