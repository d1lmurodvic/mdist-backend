/**
 * Phase 4 payments: linked transaction, financial-engine integration,
 * idempotency, cancellation of paid invoices and the locked payment link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createAccount, createCategory, createContact, createInvoice, ledgerOwner, recordTransaction, sendInvoice, uzs } from './helpers/fixtures.js';

const APRIL = 'period=custom&periodStart=2025-04-01&periodEnd=2025-05-01';

function assertRejected(response, status, code, field) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
  if (field) assert.ok(response.error.details?.some((detail) => detail.field === field), `${field}: ${response.raw}`);
}

async function setup() {
  const env = await createTestApp();
  const owner = await ledgerOwner(env.request, { email: 'o@a.example', companyName: 'A', opening: 100000 });
  const customer = await createContact(env.request, owner.token, { name: 'Acme LLC', type: 'customer' });
  const vendor = await createContact(env.request, owner.token, { name: 'Paper Supplies', type: 'vendor' });
  const pay = (invoice, { key, body } = {}) => env.request('POST', `/api/v1/invoices/${invoice.id}/payment`, {
    token: owner.token,
    headers: key === undefined ? {} : { 'Idempotency-Key': key },
    body: body ?? { accountId: owner.account.id, date: '2025-04-05' },
  });
  const overview = async () => (await env.request('GET', `/api/v1/financials/overview?${APRIL}`, { token: owner.token })).data;
  const txCount = () => env.db.getValue('SELECT count(*) FROM transactions');
  return { ...env, ...owner, customer, vendor, pay, overview, txCount };
}

test('an unpaid invoice changes no financial figure', async (t) => {
  const { request, token, customer, overview, txCount, close } = await setup();
  t.after(close);
  const before = await overview();
  const invoice = await createInvoice(request, token, customer, { issueDate: '2025-04-01', dueDate: '2025-04-30' });
  await sendInvoice(request, token, invoice);

  assert.equal(txCount(), 0, 'no transaction until payment');
  assert.deepEqual(await overview(), before);
});

test('paying a receivable creates one linked income transaction the engine counts', async (t) => {
  const { request, token, account, customer, pay, overview, txCount, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer, {
    number: 'INV-7', lineItems: [{ description: 'Work', quantity: 2, unitPrice: uzs(25000), taxRate: 1200 }],
  });
  await sendInvoice(request, token, invoice);

  const response = await pay(invoice);
  assert.equal(response.status, 201);
  const { invoice: paid, transaction } = response.data;
  assert.equal(paid.status, 'paid');
  assert.deepEqual(paid.payment, { transactionId: transaction.id, date: '2025-04-05', accountId: account.id });
  assert.deepEqual(
    [transaction.type, transaction.amount, transaction.date, transaction.accountId, transaction.payee, transaction.description, transaction.invoiceId],
    ['income', uzs(56000), '2025-04-05', account.id, 'Acme LLC', 'Invoice INV-7', invoice.id],
  );
  assert.equal(txCount(), 1);

  const figures = await overview();
  assert.deepEqual([figures.income, figures.netResult, figures.cash.closing], [uzs(56000), uzs(56000), uzs(156000)]);
  const balance = (await request('GET', '/api/v1/companies/current/accounts', { token })).data[0].balance.amount;
  assert.deepEqual(balance, uzs(156000));
  assert.equal((await request('GET', `/api/v1/transactions/${transaction.id}`, { token })).data.invoiceId, invoice.id);
});

test('paying a payable creates a linked expense transaction', async (t) => {
  const { request, token, vendor, pay, overview, close } = await setup();
  t.after(close);
  const office = await createCategory(request, token, { name: 'Office', type: 'expense' });
  const invoice = await createInvoice(request, token, vendor, { number: 'BILL-1', type: 'payable' });
  await sendInvoice(request, token, invoice);

  const response = await pay(invoice, { body: { accountId: (await request('GET', '/api/v1/companies/current/accounts', { token })).data[0].id, date: '2025-04-10', categoryId: office.id } });
  assert.equal(response.status, 201);
  assert.deepEqual([response.data.transaction.type, response.data.transaction.categoryId], ['expense', office.id]);
  const figures = await overview();
  assert.deepEqual([figures.expenses, figures.cash.closing], [uzs(10000), uzs(90000)]);
});

test('an overdue invoice can be paid', async (t) => {
  const { request, token, customer, pay, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer, { dueDate: '2025-03-02' });
  assert.equal((await sendInvoice(request, token, invoice)).status, 'overdue');
  assert.equal((await pay(invoice)).data.invoice.status, 'paid');
});

test('payment is refused for drafts, paid and cancelled invoices, and for invalid input', async (t) => {
  const { request, token, customer, pay, txCount, close } = await setup();
  t.after(close);
  const loan = await createAccount(request, token, { name: 'Loan', type: 'liability' });
  const income = await createCategory(request, token, { name: 'Sales', type: 'income' });
  const expenseCategory = await createCategory(request, token, { name: 'Rent', type: 'expense' });
  const draft = await createInvoice(request, token, customer, { number: 'DRAFT' });
  assertRejected(await pay(draft), 422, 'UNPROCESSABLE', 'status');

  const invoice = await createInvoice(request, token, customer, { number: 'SENT' });
  await sendInvoice(request, token, invoice);
  const accountId = (await request('GET', '/api/v1/companies/current/accounts', { token })).data[0].id;
  const cases = [
    [{ accountId, date: '2025-02-28' }, 422, 'UNPROCESSABLE', 'date'],
    [{ accountId, date: '2025-02-30' }, 400, 'VALIDATION_ERROR', 'date'],
    [{ accountId: loan.id, date: '2025-04-05' }, 422, 'UNPROCESSABLE', 'accountId'],
    [{ accountId: 'acc_01M3EFNC4TMGZ36SQ8D1WYJ2TK', date: '2025-04-05' }, 422, 'UNPROCESSABLE', 'accountId'],
    [{ accountId, date: '2025-04-05', categoryId: expenseCategory.id }, 422, 'UNPROCESSABLE', 'categoryId'],
    [{ accountId, date: '2025-04-05', amount: uzs(1) }, 400, 'VALIDATION_ERROR', '_root'],
    [{ date: '2025-04-05' }, 400, 'VALIDATION_ERROR', 'accountId'],
  ];
  for (const [body, status, code, field] of cases) assertRejected(await pay(invoice, { body }), status, code, field);
  assert.equal(txCount(), 0, 'nothing written by a failed payment');

  assert.equal((await pay(invoice, { body: { accountId, date: '2025-04-05', categoryId: income.id } })).status, 201);
  const again = await pay(invoice);
  assertRejected(again, 409, 'CONFLICT', 'status');
  assert.equal(txCount(), 1, 'already paid: no second transaction');

  const cancelled = await createInvoice(request, token, customer, { number: 'CANCELLED' });
  await request('POST', `/api/v1/invoices/${cancelled.id}/status`, { token, body: { status: 'cancelled' } });
  assertRejected(await pay(cancelled), 422, 'UNPROCESSABLE', 'status');
  assertRejected(await pay({ id: 'inv_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 404, 'NOT_FOUND');
});

test('idempotency: the same key replays the first result without a second transaction', async (t) => {
  const { request, token, customer, pay, txCount, overview, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);

  const first = await pay(invoice, { key: 'pay-inv-001-attempt' });
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('idempotent-replayed'), null);

  const retry = await pay(invoice, { key: 'pay-inv-001-attempt' });
  assert.equal(retry.status, 201);
  assert.equal(retry.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(retry.body, first.body, 'the same logical result');
  assert.equal(txCount(), 1, 'no duplicate payment transaction');
  assert.deepEqual((await overview()).income, uzs(10000), 'counted once');

  // A different key is a new request: normal validation applies.
  assertRejected(await pay(invoice, { key: 'another-key' }), 409, 'CONFLICT');
  // The same key with a different request is refused.
  const other = await createInvoice(request, token, customer, { number: 'INV-2' });
  await sendInvoice(request, token, other);
  assertRejected(await pay(other, { key: 'pay-inv-001-attempt' }), 422, 'UNPROCESSABLE', 'Idempotency-Key');
  const accountId = (await request('GET', '/api/v1/companies/current/accounts', { token })).data[0].id;
  assertRejected(await pay(invoice, { key: 'pay-inv-001-attempt', body: { accountId, date: '2025-04-06' } }), 422, 'UNPROCESSABLE', 'Idempotency-Key');
  assert.equal(txCount(), 1);
});

test('a failed keyed request stores nothing, so a corrected retry with the same key succeeds', async (t) => {
  const { request, token, customer, pay, txCount, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  const accountId = (await request('GET', '/api/v1/companies/current/accounts', { token })).data[0].id;

  assertRejected(await pay(invoice, { key: 'k-1', body: { accountId, date: '2025-02-01' } }), 422, 'UNPROCESSABLE', 'date');
  const retry = await pay(invoice, { key: 'k-1', body: { accountId, date: '2025-04-05' } });
  assert.equal(retry.status, 201);
  assert.equal(txCount(), 1);
});

test('malformed Idempotency-Key headers are rejected', async (t) => {
  const { request, token, customer, pay, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  for (const key of ['has space', 'x'.repeat(256), 'ünïcode']) {
    assertRejected(await pay(invoice, { key }), 400, 'VALIDATION_ERROR', 'Idempotency-Key');
  }
});

test('idempotency keys are scoped to the company', async (t) => {
  const { request, token, customer, pay, db, close } = await setup();
  t.after(close);
  const b = await ledgerOwner(request, { email: 'b@b.example', companyName: 'B' });
  const bCustomer = await createContact(request, b.token, { name: 'B customer', type: 'customer' });
  const bInvoice = await createInvoice(request, b.token, bCustomer);
  await sendInvoice(request, b.token, bInvoice);

  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  assert.equal((await pay(invoice, { key: 'shared-key' })).status, 201);
  const bPay = await request('POST', `/api/v1/invoices/${bInvoice.id}/payment`, {
    token: b.token, headers: { 'Idempotency-Key': 'shared-key' }, body: { accountId: b.account.id, date: '2025-04-05' },
  });
  assert.equal(bPay.status, 201, 'the same key in another company is independent');
  assert.equal(bPay.headers.get('idempotent-replayed'), null);
  assert.equal(db.getValue('SELECT count(*) FROM idempotency_keys'), 2);
});

test('cancelling a paid invoice removes its payment from every figure, atomically', async (t) => {
  const { request, db, token, customer, pay, overview, txCount, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  const { transaction } = (await pay(invoice)).data;
  assert.deepEqual((await overview()).income, uzs(10000));

  const cancelled = await request('POST', `/api/v1/invoices/${invoice.id}/status`, { token, body: { status: 'cancelled' } });
  assert.equal(cancelled.status, 200);
  assert.deepEqual([cancelled.data.status, cancelled.data.payment], ['cancelled', null]);
  assert.equal(txCount(), 0, 'the payment transaction is removed');
  assertRejected(await request('GET', `/api/v1/transactions/${transaction.id}`, { token }), 404, 'NOT_FOUND');
  assert.deepEqual((await overview()).income, uzs(0));
  assert.equal(db.getValue('SELECT paid_transaction_id FROM invoices WHERE id = ?', [invoice.id]), null);
});

test('a payment transaction follows its invoice: amount, type and deletion are locked', async (t) => {
  const { request, token, customer, pay, txCount, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  const { transaction } = (await pay(invoice)).data;
  const path = `/api/v1/transactions/${transaction.id}`;

  assertRejected(await request('PATCH', path, { token, body: { amount: uzs(1) } }), 422, 'UNPROCESSABLE', 'amount');
  assertRejected(await request('PATCH', path, { token, body: { type: 'expense' } }), 422, 'UNPROCESSABLE');
  assertRejected(await request('DELETE', path, { token }), 422, 'UNPROCESSABLE', 'transactionId');
  assert.equal(txCount(), 1);

  // Other fields remain editable.
  const edited = await request('PATCH', path, { token, body: { notes: 'Paid by bank transfer', date: '2025-04-06' } });
  assert.equal(edited.status, 200);
  assert.equal((await request('GET', `/api/v1/invoices/${invoice.id}`, { token })).data.payment.date, '2025-04-06');

  // A paid invoice cannot be edited.
  assertRejected(await request('PATCH', `/api/v1/invoices/${invoice.id}`, { token, body: { notes: 'x' } }), 422, 'UNPROCESSABLE', 'status');
});

test('the database refuses to delete a transaction that pays an invoice', async (t) => {
  const { request, db, token, customer, pay, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  const { transaction } = (await pay(invoice)).data;
  assert.throws(() => db.run('DELETE FROM transactions WHERE id = ?', [transaction.id]), /FOREIGN KEY constraint failed/);
  assert.throws(() => db.run("UPDATE invoices SET status = 'sent' WHERE id = ?", [invoice.id]), /CHECK constraint failed/,
    'paid ⇔ linked payment is enforced by the schema');
});

test('a manually recorded copy of the payment is reported, not blocking', async (t) => {
  const { request, token, account, customer, pay, close } = await setup();
  t.after(close);
  const manual = await recordTransaction(request, token, {
    type: 'income', amount: uzs(10000), date: '2025-04-05', accountId: account.id, payee: 'Acme LLC',
  });
  const invoice = await createInvoice(request, token, customer);
  await sendInvoice(request, token, invoice);
  const response = await pay(invoice);
  assert.equal(response.status, 201);
  assert.deepEqual(response.meta, { possibleDuplicateOf: [manual.id] });
});
