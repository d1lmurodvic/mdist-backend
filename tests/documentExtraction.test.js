/**
 * Phase 5 extraction and confirmation with a configured provider. The
 * provider is a stand-in adapter behind the real document reader, so the
 * lifecycle, validation, review flags and provenance are all exercised.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertErrorEnvelope } from './helpers/testApp.js';
import { createAccount, createContact, ownerWithCompany, uzs } from './helpers/fixtures.js';
import { SAMPLES, createDocumentsApp, providerResult, settled, storedFiles, uploadFile } from './helpers/documents.js';

const APRIL = 'period=custom&periodStart=2025-03-01&periodEnd=2025-04-01';

function assertRejected(response, status, code, field) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
  if (field) assert.ok(response.error.details?.some((detail) => detail.field === field), `${field}: ${response.raw}`);
}

async function setup(adapter, options = {}) {
  const app = await createDocumentsApp({ adapter, ...options });
  const owner = await ownerWithCompany(app.request, { email: 'o@a.example', companyName: 'A' });
  const account = await createAccount(app.request, owner.token, { name: 'Bank', type: 'bank', openingBalance: uzs(100000) });
  return { ...app, ...owner, account };
}

const staticAdapter = (result) => ({ calls: [], async readDocument(input) { this.calls.push(input); return result; } });

// ---------------------------------------------------------------- extraction

test('a readable document becomes ready with validated fields, per-field confidence and review flags', async (t) => {
  const adapter = staticAdapter(providerResult({
    vendor: { value: 'Korzinka', confidence: 0.55 },
    total: { value: { amount: 39200, currency: 'USD' }, confidence: 0.96 },
  }));
  const { request, token, close } = await setup(adapter);
  t.after(close);

  const uploaded = await uploadFile(request, token);
  assert.equal(uploaded.data.status, 'processing');
  const response = await settled(request, token, uploaded.data.id);
  const document = response.data;
  assert.equal(document.status, 'ready');
  assert.equal(document.failure, null);
  assert.ok(document.processedAt);
  assert.deepEqual([document.extraction.attempt, document.extraction.method, document.extraction.provider, document.extraction.outcome],
    [1, 'ai', 'stand-in', 'succeeded']);
  assert.deepEqual(document.extraction.fields.date, { value: '2025-03-14', confidence: 0.93 });
  assert.deepEqual(document.extraction.fields.customer, { value: null, confidence: null }, 'missing stays missing');
  assert.deepEqual(document.extraction.fields.lineItems.value[0], { description: 'Coffee beans', quantity: 2, unitPrice: uzs(17500), taxRate: 1200 });
  assert.deepEqual(document.extraction.needsReview, [
    { field: 'total', reason: 'currency_mismatch' },
    { field: 'vendor', reason: 'low_confidence' },
    { field: 'customer', reason: 'missing' },
  ]);
  assert.deepEqual(response.meta.capability, { method: 'ai', confidence: null, degraded: false, note: null });

  // The adapter received exactly the stored bytes and the verified type.
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(Buffer.from(adapter.calls[0].bytes), SAMPLES.pdf);
  assert.equal(adapter.calls[0].mimeType, 'application/pdf');
});

test('an uncertain document type is left missing, never defaulted to invoice', async (t) => {
  const { request, token, close } = await setup(staticAdapter(providerResult({ documentType: { value: null, confidence: null } })));
  t.after(close);
  const document = (await settled(request, token, (await uploadFile(request, token)).data.id)).data;
  assert.deepEqual(document.extraction.fields.documentType, { value: null, confidence: null });
  assert.ok(document.extraction.needsReview.some((flag) => flag.field === 'documentType' && flag.reason === 'missing'));
});

test('processing is visible until the provider answers', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const adapter = { async readDocument() { await gate; return providerResult(); } };
  const { request, token, close } = await setup(adapter);
  t.after(close);

  const uploaded = await uploadFile(request, token);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await request('GET', `/api/v1/documents/${uploaded.data.id}`, { token })).data.status, 'processing');
  assertRejected(await request('POST', `/api/v1/documents/${uploaded.data.id}/extract`, { token }), 409, 'CONFLICT');
  assertRejected(await request('POST', `/api/v1/documents/${uploaded.data.id}/confirm`, {
    token, body: { target: 'invoice', invoice: {} },
  }), 400, 'VALIDATION_ERROR');
  release();
  assert.equal((await settled(request, token, uploaded.data.id)).data.status, 'ready');
});

test('provider failures end in failed, with a safe message and no stored fields', async (t) => {
  const secret = 'sk-live-provider-secret-123';
  const cases = [
    ['provider_error', { async readDocument() { throw new Error(`upstream 500 at https://api.vendor.example?key=${secret}`); } }],
    ['unreadable', staticAdapter({ readable: false })],
    ['invalid_provider_response', staticAdapter(providerResult({ total: { value: { amount: 392.5, currency: 'UZS' }, confidence: 0.9 } }))],
    ['invalid_provider_response', staticAdapter(providerResult({ total: { value: { amount: '39200', currency: 'UZS' }, confidence: 0.9 } }))],
    ['invalid_provider_response', staticAdapter(providerResult({ vendor: { value: null, confidence: 0.4 } }))],
    ['invalid_provider_response', staticAdapter(providerResult({ tax: { value: { amount: 10, currency: 'UZS' }, confidence: null } }))],
    ['invalid_provider_response', staticAdapter({ ...providerResult(), inventedField: 'x' })],
    ['invalid_provider_response', staticAdapter(providerResult({ lineItems: { value: [{ description: 'x', quantity: 1.5, unitPrice: uzs(1), taxRate: 0 }], confidence: 0.9 } }))],
    ['invalid_provider_response', staticAdapter('not an object')],
  ];
  for (const [code, adapter] of cases) {
    const { request, token, close } = await setup(adapter);
    try {
      const response = await settled(request, token, (await uploadFile(request, token)).data.id);
      const document = response.data;
      assert.equal(document.status, 'failed', code);
      assert.equal(document.failure.code, code);
      assert.equal(document.extraction.outcome, 'failed');
      assert.equal(document.extraction.fields, null, 'nothing is stored from a failed read');
      assert.ok(!response.raw.includes(secret) && !response.raw.includes('vendor.example'), 'provider internals never leak');
    } finally {
      await close();
    }
  }
});

test('a provider that never answers times out instead of leaving the document processing', async (t) => {
  const { request, token, close } = await setup({ readDocument: () => new Promise(() => {}) }, { timeoutMs: 50 });
  t.after(close);
  const document = (await settled(request, token, (await uploadFile(request, token)).data.id)).data;
  assert.equal(document.status, 'failed');
  assert.equal(document.failure.code, 'timeout');
});

test('re-running extraction records a new attempt and keeps the history', async (t) => {
  let answer = { readable: false };
  const { request, token, db, close } = await setup({ async readDocument() { return answer; } });
  t.after(close);
  const id = (await uploadFile(request, token)).data.id;
  assert.equal((await settled(request, token, id)).data.failure.code, 'unreadable');

  answer = providerResult();
  const rerun = await request('POST', `/api/v1/documents/${id}/extract`, { token });
  assert.equal(rerun.status, 200);
  assert.equal(rerun.data.status, 'processing');
  assert.equal(rerun.data.failure, null);
  const document = (await settled(request, token, id)).data;
  assert.equal(document.status, 'ready');
  assert.equal(document.extraction.attempt, 2);
  assert.deepEqual(db.all('SELECT attempt, outcome FROM document_extractions ORDER BY attempt').map((r) => [r.attempt, r.outcome]),
    [[1, 'failed'], [2, 'succeeded']]);
});

// ---------------------------------------------------------------- confirmation

function transactionBody(account, extra = {}) {
  return { target: 'transaction', transaction: { type: 'expense', amount: uzs(39200), date: '2025-03-14', accountId: account.id, payee: 'Korzinka', ...extra } };
}

test('confirming creates the reviewed transaction with document provenance, and nothing before that', async (t) => {
  const { request, token, account, db, close } = await setup(staticAdapter(providerResult()));
  t.after(close);
  const id = (await uploadFile(request, token)).data.id;
  await settled(request, token, id);
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0, 'extraction alone records nothing');

  const confirmed = await request('POST', `/api/v1/documents/${id}/confirm`, { token, body: transactionBody(account, { description: 'Groceries' }) });
  assert.equal(confirmed.status, 201);
  const { document, transaction } = confirmed.data;
  assert.equal(transaction.source, 'document', 'provenance on the transaction');
  assert.deepEqual([transaction.type, transaction.amount, transaction.payee], ['expense', uzs(39200), 'Korzinka']);
  assert.deepEqual({ ...document.confirmation, confirmedAt: 'x' }, { target: 'transaction', transactionId: transaction.id, invoiceId: null, confirmedAt: 'x' });
  assert.equal(document.extraction.method, 'ai', 'the extraction and its confidence stay with the document');

  const overview = await request('GET', `/api/v1/financials/overview?${APRIL}`, { token });
  assert.deepEqual([overview.data.expenses, overview.data.cash.closing], [uzs(39200), uzs(60800)], 'the engine counts it like any transaction');

  assertRejected(await request('POST', `/api/v1/documents/${id}/confirm`, { token, body: transactionBody(account) }), 409, 'CONFLICT');
  assertRejected(await request('DELETE', `/api/v1/documents/${id}`, { token }), 422, 'UNPROCESSABLE');
  assertRejected(await request('POST', `/api/v1/documents/${id}/extract`, { token }), 422, 'UNPROCESSABLE');
});

test('confirming as an invoice creates a draft only — never sent, never paid, no transaction', async (t) => {
  const { request, token, db, close } = await setup(staticAdapter(providerResult({ documentType: { value: 'invoice', confidence: 0.99 } })));
  t.after(close);
  const vendor = await createContact(request, token, { name: 'Paper Supplies', type: 'vendor' });
  const id = (await uploadFile(request, token)).data.id;
  await settled(request, token, id);

  const confirmed = await request('POST', `/api/v1/documents/${id}/confirm`, {
    token,
    body: { target: 'invoice', invoice: {
      number: 'BILL-77', type: 'payable', contactId: vendor.id, issueDate: '2025-03-14', dueDate: '2025-04-13',
      lineItems: [{ description: 'Coffee beans', quantity: 2, unitPrice: uzs(17500), taxRate: 1200 }],
    } },
  });
  assert.equal(confirmed.status, 201);
  const { invoice, document } = confirmed.data;
  assert.equal(invoice.status, 'draft');
  assert.deepEqual(invoice.total, uzs(39200), 'totals come from the invoice rules, not the extraction');
  assert.equal(document.confirmation.invoiceId, invoice.id);
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0);
});

test('a document without a provider can still be confirmed from manually entered values', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  const { token } = await ownerWithCompany(app.request, { email: 'o@a.example', companyName: 'A' });
  const account = await createAccount(app.request, token, { name: 'Bank', type: 'bank' });
  const id = (await uploadFile(app.request, token)).data.id;
  assert.equal((await settled(app.request, token, id)).data.failure.code, 'ai_unavailable');

  const confirmed = await app.request('POST', `/api/v1/documents/${id}/confirm`, { token, body: transactionBody(account) });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.data.transaction.source, 'document');
});

test('confirmation input is validated exactly like the ledger and invoice endpoints', async (t) => {
  const { request, token, account, db, close } = await setup(staticAdapter(providerResult()));
  t.after(close);
  const loan = await createAccount(request, token, { name: 'Loan', type: 'liability' });
  const id = (await uploadFile(request, token)).data.id;
  await settled(request, token, id);

  const cases = [
    [{}, 400, 'VALIDATION_ERROR'],
    [{ target: 'receipt' }, 400, 'VALIDATION_ERROR'],
    [{ target: 'transaction' }, 400, 'VALIDATION_ERROR'],
    [transactionBody(account, { amount: uzs(10.5) }), 400, 'VALIDATION_ERROR'],
    [transactionBody(account, { amount: { amount: 100, currency: 'USD' } }), 422, 'UNPROCESSABLE'],
    [transactionBody(loan), 422, 'UNPROCESSABLE'],
    [{ ...transactionBody(account), companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }, 400, 'VALIDATION_ERROR'],
    [{ target: 'invoice', invoice: { number: 'X' } }, 400, 'VALIDATION_ERROR'],
  ];
  for (const [body, status, code] of cases) {
    assertRejected(await request('POST', `/api/v1/documents/${id}/confirm`, { token, body }), status, code);
  }
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0);
  assert.equal(db.getValue('SELECT confirmed_at FROM documents'), null, 'a failed confirmation changes nothing');
});

test('a duplicate of an existing transaction is flagged and needs an explicit allowDuplicate', async (t) => {
  const { request, token, account, close } = await setup(staticAdapter(providerResult()));
  t.after(close);
  const manual = await request('POST', '/api/v1/transactions', { token, body: transactionBody(account).transaction });
  const id = (await uploadFile(request, token)).data.id;
  await settled(request, token, id);

  const refused = await request('POST', `/api/v1/documents/${id}/confirm`, { token, body: transactionBody(account) });
  assertRejected(refused, 409, 'CONFLICT');
  assert.equal(refused.error.details[0].transactionId, manual.data.id);
  const allowed = await request('POST', `/api/v1/documents/${id}/confirm`, { token, body: transactionBody(account, { allowDuplicate: true }) });
  assert.equal(allowed.status, 201);
  assert.deepEqual(allowed.meta, { possibleDuplicateOf: [manual.data.id] });
});

test('deleting the created transaction or draft invoice is not blocked by the document', async (t) => {
  const { request, token, account, close } = await setup(staticAdapter(providerResult()));
  t.after(close);
  const vendor = await createContact(request, token, { name: 'V', type: 'vendor' });
  const first = (await uploadFile(request, token)).data.id;
  const second = (await uploadFile(request, token)).data.id;
  await settled(request, token, first);
  await settled(request, token, second);

  const { transaction } = (await request('POST', `/api/v1/documents/${first}/confirm`, { token, body: transactionBody(account) })).data;
  assert.equal((await request('DELETE', `/api/v1/transactions/${transaction.id}`, { token })).status, 204);
  const afterTransaction = (await request('GET', `/api/v1/documents/${first}`, { token })).data;
  assert.deepEqual([afterTransaction.confirmation.target, afterTransaction.confirmation.transactionId], ['transaction', null]);

  const { invoice } = (await request('POST', `/api/v1/documents/${second}/confirm`, { token, body: { target: 'invoice', invoice: {
    number: 'B-1', type: 'payable', contactId: vendor.id, issueDate: '2025-03-14', dueDate: '2025-03-14',
    lineItems: [{ description: 'x', quantity: 1, unitPrice: uzs(1) }] } } })).data;
  assert.equal((await request('DELETE', `/api/v1/invoices/${invoice.id}`, { token })).status, 204);
  assert.equal((await request('GET', `/api/v1/documents/${second}`, { token })).data.confirmation.invoiceId, null);
});

test('a document deleted while processing is gone for good; the late provider answer is discarded', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { request, token, db, uploadDir, close } = await setup({ async readDocument() { await gate; return providerResult(); } });
  t.after(close);
  const id = (await uploadFile(request, token)).data.id;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await request('DELETE', `/api/v1/documents/${id}`, { token })).status, 204);
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await request('GET', `/api/v1/documents/${id}`, { token })).status, 404);
  assert.equal(db.getValue('SELECT count(*) FROM documents'), 0);
  assert.equal(db.getValue('SELECT count(*) FROM document_extractions'), 0);
  assert.deepEqual(storedFiles(uploadDir), []);
});
