/**
 * Google Document AI adapter: response mapping, processor order, failures,
 * credentials and tokens. No network: `fetch` is a stand-in that answers
 * with Document AI's documented response shapes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createDocumentReader, providerResultSchema } from '../src/ai/documentReader.js';
import { ExtractionFailure } from '../src/ai/extractionFailure.js';
import { createGoogleDocumentAiAdapter, mapDocument, moneyOf } from '../src/ai/google/documentAi.js';
import { createGoogleTokenProvider, loadGoogleCredentials } from '../src/ai/google/auth.js';

// ------------------------------------------------------------ fixtures

const money = (units, nanos = 0, currencyCode = 'USD') => ({ moneyValue: { currencyCode, units: String(units), nanos } });
const entity = (type, mentionText, confidence, normalizedValue) => ({ type, mentionText, confidence, ...(normalizedValue ? { normalizedValue } : {}) });

const INVOICE_DOCUMENT = {
  entities: [
    entity('invoice_id', 'INV-0042', 0.97),
    entity('invoice_date', 'Mar 14, 2025', 0.95, { dateValue: { year: 2025, month: 3, day: 14 }, text: '2025-03-14' }),
    entity('due_date', 'Apr 13, 2025', 0.9, { dateValue: { year: 2025, month: 4, day: 13 }, text: '2025-04-13' }),
    entity('supplier_name', 'Paper  Supplies\nLLC', 0.92),
    entity('receiver_name', 'Accora Demo', 0.88),
    entity('currency', '$', 0.8, { text: 'USD' }),
    entity('net_amount', '$350.00', 0.91, money(350)),
    entity('total_tax_amount', '$42.00', 0.9, money(42)),
    entity('total_amount', '$392.00', 0.96, money(392)),
    {
      type: 'line_item', mentionText: 'Coffee beans 2 175.00 350.00', confidence: 0.86,
      properties: [
        entity('line_item/description', 'Coffee beans', 0.9),
        entity('line_item/quantity', '2', 0.9),
        entity('line_item/unit_price', '175.00', 0.9, money(175)),
        entity('line_item/amount', '350.00', 0.9, money(350)),
      ],
    },
    {
      type: 'line_item', mentionText: 'Delivery 25.50', confidence: 0.7,
      properties: [
        entity('line_item/description', 'Delivery', 0.8),
        entity('line_item/amount', '25.50', 0.8, money(25, 500000000)),
      ],
    },
  ],
};

const RECEIPT_DOCUMENT = {
  entities: [
    entity('supplier_name', 'Korzinka', 0.9),
    entity('receipt_date', '14.03.2025', 0.85, { dateValue: { year: 2025, month: 3, day: 14 } }),
    entity('currency', "so'm", 0.7),
    entity('total_amount', '39 200', 0.93, money(39200, 0, '')),
    entity('total_tax_amount', '4 200', 0.8, money(4200, 0, '')),
  ],
};

function fakeFetch(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    const { status = 200, body = {} } = await handler(url, init, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fetch.calls = calls;
  return fetch;
}

const SETTINGS = { projectId: 'demo-project', location: 'us', invoiceProcessorId: 'inv123', expenseProcessorId: 'exp456' };
const staticTokens = { isUserCredential: false, accessToken: async () => 'test-token' };

function adapterWith(handler, settings = SETTINGS, tokenProvider = staticTokens) {
  const fetch = fakeFetch(handler);
  return { fetch, adapter: createGoogleDocumentAiAdapter({ settings, fetch, tokenProvider }) };
}

// ------------------------------------------------------------ mapping

test('an invoice maps to validated fields with Google’s own confidence', () => {
  const result = mapDocument(INVOICE_DOCUMENT, 'invoice');
  assert.ok(providerResultSchema.safeParse(result).success, 'the mapping always satisfies the reader schema');
  assert.deepEqual(result.documentType, { value: 'invoice', confidence: 0.97 });
  assert.deepEqual(result.invoiceNumber, { value: 'INV-0042', confidence: 0.97 });
  assert.deepEqual(result.date, { value: '2025-03-14', confidence: 0.95 });
  assert.deepEqual(result.dueDate, { value: '2025-04-13', confidence: 0.9 });
  assert.deepEqual(result.vendor, { value: 'Paper Supplies LLC', confidence: 0.92 }, 'whitespace is normalised');
  assert.deepEqual(result.customer, { value: 'Accora Demo', confidence: 0.88 });
  assert.deepEqual(result.currency, { value: 'USD', confidence: 0.8 });
  assert.deepEqual(result.subtotal.value, { amount: 35000, currency: 'USD' }, 'USD is in cents');
  assert.deepEqual(result.tax.value, { amount: 4200, currency: 'USD' });
  assert.deepEqual(result.total.value, { amount: 39200, currency: 'USD' });
  assert.deepEqual(result.lineItems, {
    value: [
      { description: 'Coffee beans', quantity: 2, unitPrice: { amount: 17500, currency: 'USD' }, taxRate: null },
      { description: 'Delivery', quantity: null, unitPrice: null, taxRate: null },
    ],
    confidence: 0.7,
  }, 'a line without quantity or unit price is kept incomplete, not guessed');
});

test('a receipt maps with the printed currency mark and UZS whole units', () => {
  const result = mapDocument(RECEIPT_DOCUMENT, 'expense');
  assert.ok(providerResultSchema.safeParse(result).success);
  assert.deepEqual(result.documentType, { value: 'receipt', confidence: 0.93 });
  assert.deepEqual(result.currency, { value: 'UZS', confidence: 0.7 });
  assert.deepEqual(result.total.value, { amount: 39200, currency: 'UZS' });
  assert.deepEqual(result.date.value, '2025-03-14');
  for (const name of ['invoiceNumber', 'dueDate', 'customer', 'subtotal', 'lineItems']) {
    assert.deepEqual(result[name], { value: null, confidence: null }, name);
  }
});

test('evidence is required: no invoice number means no invoice type', () => {
  const entities = INVOICE_DOCUMENT.entities.filter((e) => e.type !== 'invoice_id');
  const result = mapDocument({ entities }, 'invoice');
  assert.deepEqual(result.documentType, { value: null, confidence: null });
});

test('money is converted exactly or left missing, never rounded or relabelled', () => {
  assert.deepEqual(moneyOf({ normalizedValue: money(12, 340000000) }, null), { amount: 1234, currency: 'USD' });
  assert.equal(moneyOf({ normalizedValue: money(12, 345000000) }, null), null, 'a fraction of a cent');
  assert.equal(moneyOf({ normalizedValue: money(100, 500000000, 'UZS') }, null), null, 'UZS has no minor unit (D9)');
  assert.deepEqual(moneyOf({ normalizedValue: money(5, 0, 'KWD') }, null), { amount: 5000, currency: 'KWD' }, 'three-decimal currency');
  assert.equal(moneyOf({ normalizedValue: money(-5) }, null), null, 'negative');
  assert.equal(moneyOf({ normalizedValue: money(5, 0, 'XYZ') }, 'UZS'), null, 'an unsupported stated currency is not replaced');
  assert.equal(moneyOf({ normalizedValue: money(5, 0, '') }, null), null, 'no currency anywhere');
  assert.deepEqual(moneyOf({ normalizedValue: money(5, 0, '') }, 'EUR'), { amount: 500, currency: 'EUR' }, 'the document currency fills in');
  assert.equal(moneyOf({ normalizedValue: money('9007199254740992') }, null), null, 'beyond the exact range');
  assert.equal(moneyOf({ mentionText: '$5' }, 'USD'), null, 'no normalised value');
});

test('missing confidence is treated as zero so the value is always reviewed', () => {
  const result = mapDocument({ entities: [{ type: 'supplier_name', mentionText: 'Shop' }] }, 'expense');
  assert.deepEqual(result.vendor, { value: 'Shop', confidence: 0 });
});

test('line details are derived only by exact arithmetic', () => {
  const line = (properties) => mapDocument({ entities: [{ type: 'line_item', confidence: 0.9, properties }] }, 'invoice').lineItems.value[0];
  assert.deepEqual(line([
    entity('line_item/quantity', '3', 0.9), entity('line_item/amount', '30.00', 0.9, money(30)),
  ]).unitPrice, { amount: 1000, currency: 'USD' }, 'amount ÷ whole quantity');
  assert.equal(line([
    entity('line_item/quantity', '3', 0.9), entity('line_item/amount', '10.00', 0.9, money(10)),
  ]).unitPrice, null, 'not divisible exactly');
  assert.equal(line([
    entity('line_item/unit_price', '7.00', 0.9, money(7)), entity('line_item/amount', '7.00', 0.9, money(7)),
  ]).quantity, 1, 'unit price equal to the amount means one');
  assert.equal(line([entity('line_item/description', 'Milk', 0.9), entity('line_item/quantity', '1,5', 0.9)]).quantity, 1.5);
  assert.equal(line([entity('line_item/description', 'Milk', 0.9), entity('line_item/quantity', 'two', 0.9)]).quantity, null);
});

test('a document with nothing recognisable is unreadable', () => {
  assert.deepEqual(mapDocument({ entities: [] }, 'invoice'), { readable: false });
  assert.deepEqual(mapDocument(undefined, 'expense'), { readable: false });
  assert.deepEqual(mapDocument({ entities: [{ type: 'supplier_address', mentionText: 'x', confidence: 0.9 }] }, 'expense'), { readable: false });
});

// ------------------------------------------------------------ adapter

test('a PDF goes to the invoice processor with the file as base64 and a bearer token', async () => {
  const { fetch, adapter } = adapterWith(() => ({ body: { document: INVOICE_DOCUMENT } }));
  const bytes = Buffer.from('%PDF-1.4 test');
  const result = await adapter.readDocument({ bytes, mimeType: 'application/pdf' });
  assert.equal(result.invoiceNumber.value, 'INV-0042');
  assert.equal(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.equal(call.url, 'https://us-documentai.googleapis.com/v1/projects/demo-project/locations/us/processors/inv123:process');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer test-token');
  assert.equal(call.init.headers['x-goog-user-project'], undefined);
  assert.deepEqual(call.body, { rawDocument: { content: bytes.toString('base64'), mimeType: 'application/pdf' } });
});

test('a photo goes to the expense processor first', async () => {
  const { fetch, adapter } = adapterWith(() => ({ body: { document: RECEIPT_DOCUMENT } }));
  const result = await adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'image/jpeg' });
  assert.equal(result.documentType.value, 'receipt');
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/').pop()), ['exp456:process']);
});

test('without a total the other processor is tried once, and the better answer wins', async () => {
  const { fetch, adapter } = adapterWith((url) => ({
    body: { document: url.includes('exp456') ? { entities: [entity('supplier_name', 'Shop', 0.9)] } : INVOICE_DOCUMENT },
  }));
  const result = await adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'image/png' });
  assert.equal(result.total.value.amount, 39200);
  assert.equal(fetch.calls.length, 2);

  const nothing = adapterWith(() => ({ body: { document: { entities: [entity('supplier_name', 'Shop', 0.9)] } } }));
  const partial = await nothing.adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'application/pdf' });
  assert.equal(partial.vendor.value, 'Shop', 'a partial read is still returned for review');
  assert.equal(nothing.fetch.calls.length, 2);
});

test('only configured processors are called', async () => {
  const { fetch, adapter } = adapterWith(() => ({ body: { document: { entities: [] } } }), { ...SETTINGS, invoiceProcessorId: '' });
  assert.deepEqual(await adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'application/pdf' }), { readable: false });
  assert.deepEqual(fetch.calls.map((c) => c.url.split('/').pop()), ['exp456:process']);
});

test('HEIC is refused before any call; a refused file is unreadable; other errors are provider errors', async () => {
  const heic = adapterWith(() => assert.fail('no call expected'));
  await assert.rejects(heic.adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'image/heic' }),
    (error) => error instanceof ExtractionFailure && error.code === 'unreadable' && /HEIC/.test(error.message));

  const refused = adapterWith(() => ({ status: 400, body: { error: { message: 'Unsupported input file format.' } } }));
  await assert.rejects(refused.adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'application/pdf' }),
    (error) => error instanceof ExtractionFailure && error.code === 'unreadable');

  const down = adapterWith(() => ({ status: 503 }));
  await assert.rejects(down.adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'application/pdf' }),
    (error) => !(error instanceof ExtractionFailure) && /503/.test(error.message));
});

test('through the reader: provider errors become safe failures and results are validated', async () => {
  const config = loadConfig({
    NODE_ENV: 'test', AI_PROVIDER: 'google_document_ai', GOOGLE_CLOUD_PROJECT: 'demo-project',
    DOCUMENT_AI_INVOICE_PROCESSOR_ID: 'inv123', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{}',
  });
  const read = (handler) => createDocumentReader({ config, adapters: { google_document_ai: adapterWith(handler).adapter } })
    .read({ bytes: Buffer.from('x'), mimeType: 'application/pdf' });

  const ok = await read(() => ({ body: { document: INVOICE_DOCUMENT } }));
  assert.equal(ok.provider, 'google_document_ai');
  assert.equal(ok.fields.total.value.amount, 39200);

  await assert.rejects(read(() => ({ status: 403, body: { error: { message: 'Permission denied on project demo-project' } } })),
    (error) => error.code === 'provider_error' && !error.message.includes('demo-project'));
  await assert.rejects(read(() => ({ body: { document: { entities: [] } } })), (error) => error.code === 'unreadable');
});

test('the reader states Google as the method when configured', () => {
  const reader = createDocumentReader({
    config: { ai: { enabled: true, provider: 'google_document_ai' } },
    adapters: { google_document_ai: adapterWith(() => ({})).adapter },
  });
  const capability = reader.capability();
  assert.deepEqual([capability.available, capability.method, capability.provider], [true, 'ai', 'google_document_ai']);
  assert.match(capability.note, /Google Document AI/);
});

// ------------------------------------------------------------ credentials and tokens

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE_ACCOUNT = {
  type: 'service_account', client_email: 'reader@demo-project.iam.gserviceaccount.com', private_key_id: 'kid-1',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token',
};

test('a service account signs an RS256 JWT for the cloud-platform scope, and the token is cached', async () => {
  let clock = 1_700_000_000_000;
  const fetch = fakeFetch(() => ({ body: { access_token: `token-${fetch.calls.length}`, expires_in: 3600 } }));
  const tokens = createGoogleTokenProvider({ credentials: SERVICE_ACCOUNT, fetch, now: () => clock });

  assert.equal(await tokens.accessToken(), 'token-1');
  const form = new URLSearchParams(fetch.calls[0].init.body.toString());
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [header, claims, signature] = form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: SERVICE_ACCOUNT.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token', iat: 1_700_000_000, exp: 1_700_003_600,
  });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')));

  clock += 30 * 60_000;
  assert.equal(await tokens.accessToken(), 'token-1', 'cached while valid');
  clock += 29.5 * 60_000;
  assert.equal(await tokens.accessToken(), 'token-2', 'refreshed a minute before expiry');
});

test('concurrent callers share one token request; a refused request surfaces only its status', async () => {
  const fetch = fakeFetch(async () => { await new Promise((r) => setTimeout(r, 10)); return { body: { access_token: 'shared', expires_in: 3600 } }; });
  const tokens = createGoogleTokenProvider({ credentials: SERVICE_ACCOUNT, fetch });
  assert.deepEqual(await Promise.all([tokens.accessToken(), tokens.accessToken(), tokens.accessToken()]), ['shared', 'shared', 'shared']);
  assert.equal(fetch.calls.length, 1);

  const refused = createGoogleTokenProvider({ credentials: SERVICE_ACCOUNT, fetch: fakeFetch(() => ({ status: 401, body: { error: 'invalid_grant' } })) });
  await assert.rejects(refused.accessToken(), (error) => error.status === 401 && !/invalid_grant/.test(error.message));
});

test('authorized_user credentials use the refresh token and name the quota project', async () => {
  const credentials = { type: 'authorized_user', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' };
  const tokenFetch = fakeFetch(() => ({ body: { access_token: 'user-token', expires_in: 3599 } }));
  const tokens = createGoogleTokenProvider({ credentials, fetch: tokenFetch });
  assert.equal(await tokens.accessToken(), 'user-token');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenFetch.calls[0].init.body.toString())),
    { grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csecret', refresh_token: 'rtoken' });

  const { fetch, adapter } = adapterWith(() => ({ body: { document: INVOICE_DOCUMENT } }), SETTINGS, tokens);
  await adapter.readDocument({ bytes: Buffer.from('x'), mimeType: 'application/pdf' });
  assert.equal(fetch.calls[0].init.headers['x-goog-user-project'], 'demo-project');
});

test('credentials load from a file or inline JSON, and bad credentials stop startup without echoing them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ifrsmart-gcp-'));
  try {
    const file = path.join(dir, 'key.json');
    fs.writeFileSync(file, JSON.stringify(SERVICE_ACCOUNT));
    assert.equal(loadGoogleCredentials({ file }).client_email, SERVICE_ACCOUNT.client_email);
    assert.equal(loadGoogleCredentials({ json: JSON.stringify(SERVICE_ACCOUNT) }).type, 'service_account');

    const secret = 'super-secret-value';
    for (const [input, pattern] of [
      [{ file: path.join(dir, 'missing.json') }, /cannot be read/],
      [{ json: `not json ${secret}` }, /not valid JSON/],
      [{ json: JSON.stringify({ type: 'external_account', secret }) }, /service_account or authorized_user/],
      [{ json: JSON.stringify({ ...SERVICE_ACCOUNT, private_key: secret }) }, /private_key cannot be parsed/],
      [{ json: JSON.stringify({ type: 'authorized_user', client_id: 'x', client_secret: secret }) }, /refresh_token/],
    ]) {
      assert.throws(() => loadGoogleCredentials(input), (error) => pattern.test(error.message) && !error.message.includes(secret));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('configuring google_document_ai with unreadable credentials fails at startup', () => {
  const config = loadConfig({
    NODE_ENV: 'test', AI_PROVIDER: 'google_document_ai', GOOGLE_CLOUD_PROJECT: 'demo-project',
    DOCUMENT_AI_EXPENSE_PROCESSOR_ID: 'exp456', GOOGLE_APPLICATION_CREDENTIALS_JSON: '{"type":"service_account"}',
  });
  assert.throws(() => createDocumentReader({ config }), /Invalid configuration[\s\S]*client_email/);
});

test('a real reader is built from configuration with inline service account JSON', () => {
  const config = loadConfig({
    NODE_ENV: 'test', AI_PROVIDER: 'google_document_ai', GOOGLE_CLOUD_PROJECT: 'demo-project',
    DOCUMENT_AI_EXPENSE_PROCESSOR_ID: 'exp456', GOOGLE_APPLICATION_CREDENTIALS_JSON: JSON.stringify(SERVICE_ACCOUNT),
  });
  assert.equal(createDocumentReader({ config }).capability().available, true);
});
