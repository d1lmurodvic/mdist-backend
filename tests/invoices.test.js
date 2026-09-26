/**
 * Phase 4 invoices: contacts, CRUD, line items and derived totals,
 * validation, statuses and dates.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import { createContact, createInvoice, ownerWithCompany, sendInvoice, uzs } from './helpers/fixtures.js';
import { addDays, todayIso } from '../src/lib/dates.js';
import { applyBasisPoints } from '../src/lib/money.js';

const INVOICES = '/api/v1/invoices';
const CONTACTS = '/api/v1/companies/current/contacts';

function assertRejected(response, status, code, field) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
  if (field) assert.ok(response.error.details?.some((detail) => detail.field === field), `${field}: ${response.raw}`);
}

async function setup() {
  const env = await createTestApp();
  const owner = await ownerWithCompany(env.request, { email: 'o@a.example', companyName: 'A' });
  const customer = await createContact(env.request, owner.token, { name: 'Acme LLC', type: 'customer' });
  const vendor = await createContact(env.request, owner.token, { name: 'Paper Supplies', type: 'vendor' });
  return { ...env, ...owner, customer, vendor };
}

// ---------------------------------------------------------------- contacts

test('contacts are created, listed, filtered and updated', async (t) => {
  const { request, token, customer, vendor, close } = await setup();
  t.after(close);

  const created = await request('POST', CONTACTS, {
    token, body: { name: '  Zeta Trade ', type: 'customer', email: ' Sales@Zeta.UZ ', phone: '+998 90 000 00 00', address: 'Tashkent' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('location'), `/api/v1/contacts/${created.data.id}`);
  assert.deepEqual(
    { ...created.data, id: 'x', createdAt: 'x', updatedAt: 'x' },
    { id: 'x', name: 'Zeta Trade', type: 'customer', email: 'sales@zeta.uz', phone: '+998 90 000 00 00', address: 'Tashkent', createdAt: 'x', updatedAt: 'x' },
  );

  const names = async (query = '') => (await request('GET', `${CONTACTS}${query}`, { token })).data.map((contact) => contact.name);
  assert.deepEqual(await names(), ['Acme LLC', 'Paper Supplies', 'Zeta Trade']);
  assert.deepEqual(await names('?type=vendor'), ['Paper Supplies']);
  assert.deepEqual(await names('?q=TRADE'), ['Zeta Trade']);

  const renamed = await request('PATCH', `/api/v1/contacts/${customer.id}`, { token, body: { name: 'Acme Group', email: null } });
  assert.equal(renamed.data.name, 'Acme Group');
  for (const [body, field] of [[{ type: 'partner' }, 'type'], [{ name: '' }, 'name'], [{ email: 'nope' }, 'email'], [{}, undefined]]) {
    assertRejected(await request('PATCH', `/api/v1/contacts/${vendor.id}`, { token, body }), 400, 'VALIDATION_ERROR', field);
  }
  assertRejected(await request('POST', CONTACTS, { token, body: { name: 'X' } }), 400, 'VALIDATION_ERROR', 'type');
  assertRejected(await request('PATCH', '/api/v1/contacts/con_01M3EFNC4TMGZ36SQ8D1WYJ2TK', { token, body: { name: 'x' } }), 404, 'NOT_FOUND');
});

test('a contact used by invoices cannot change type', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);
  await createInvoice(request, token, customer);
  assertRejected(await request('PATCH', `/api/v1/contacts/${customer.id}`, { token, body: { type: 'vendor' } }), 422, 'UNPROCESSABLE', 'type');
});

// ---------------------------------------------------------------- create / read

test('an invoice is created as a draft with server-derived totals', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);

  const response = await request('POST', INVOICES, {
    token,
    body: {
      number: 'INV-2025-001',
      type: 'receivable',
      contactId: customer.id,
      issueDate: '2025-03-01',
      dueDate: '2025-03-31',
      notes: 'Thank you for your business',
      lineItems: [
        { description: 'Consulting hours', quantity: 3, unitPrice: uzs(10000), taxRate: 1200 },
        { description: 'Setup fee', quantity: 1, unitPrice: uzs(5001), taxRate: 1200 },
        { description: 'Tax-exempt item', quantity: 2, unitPrice: uzs(250) },
      ],
    },
  });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  const invoice = response.data;
  assert.equal(response.headers.get('location'), `${INVOICES}/${invoice.id}`);
  assert.match(invoice.id, /^inv_/);
  assert.equal(invoice.status, 'draft');
  assert.deepEqual(invoice.contact, { id: customer.id, name: 'Acme LLC', type: 'customer' });
  assert.equal(invoice.currency, 'UZS');
  // 30,000 + 5,001 + 500 = 35,501; tax 3,600 + 600.12→600 + 0 = 4,200.
  assert.deepEqual([invoice.subtotal, invoice.tax, invoice.total], [uzs(35501), uzs(4200), uzs(39701)]);
  assert.deepEqual(invoice.lineItems.map((line) => [line.description, line.quantity, line.unitPrice.amount, line.taxRate, line.lineTotal.amount, line.tax.amount]), [
    ['Consulting hours', 3, 10000, 1200, 30000, 3600],
    ['Setup fee', 1, 5001, 1200, 5001, 600],
    ['Tax-exempt item', 2, 250, 0, 500, 0],
  ]);
  assert.equal(invoice.payment, null);

  const read = await request('GET', `${INVOICES}/${invoice.id}`, { token });
  assert.deepEqual(read.data, invoice);
});

test('client-supplied totals are never accepted', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);
  const base = { number: 'X', type: 'receivable', contactId: customer.id, issueDate: '2025-03-01', dueDate: '2025-03-02', lineItems: [{ description: 'a', quantity: 1, unitPrice: uzs(1) }] };
  for (const extra of [{ total: uzs(999) }, { subtotal: uzs(1) }, { tax: uzs(0) }, { status: 'paid' }, { currency: 'UZS' }]) {
    assertRejected(await request('POST', INVOICES, { token, body: { ...base, ...extra } }), 400, 'VALIDATION_ERROR', '_root');
  }
  const lineWithTotal = { ...base, lineItems: [{ description: 'a', quantity: 1, unitPrice: uzs(1), lineTotal: uzs(100) }] };
  assertRejected(await request('POST', INVOICES, { token, body: lineWithTotal }), 400, 'VALIDATION_ERROR');
});

test('line-item tax rounds half away from zero in exact arithmetic', () => {
  assert.equal(applyBasisPoints(5001n, 1200), 600n, '600.12 -> 600');
  assert.equal(applyBasisPoints(5005n, 1000), 501n, '500.5 -> 501');
  assert.equal(applyBasisPoints(1n, 4999), 0n, '0.4999 -> 0');
  assert.equal(applyBasisPoints(1n, 5000), 1n, '0.5 -> 1');
  assert.equal(applyBasisPoints(123456789n, 10000), 123456789n, '100%');
  assert.equal(applyBasisPoints(9007199254740991n, 1200), 1080863910568919n, 'exact near 2^53');
});

test('large invoices stay exact, and totals beyond the safe range are refused', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);
  const big = await createInvoice(request, token, customer, {
    number: 'BIG', lineItems: [{ description: 'Big', quantity: 1, unitPrice: uzs(4_000_000_000_000_000), taxRate: 10000 }],
  });
  assert.deepEqual([big.subtotal, big.tax, big.total], [uzs(4_000_000_000_000_000), uzs(4_000_000_000_000_000), uzs(8_000_000_000_000_000)]);

  const tooBig = await request('POST', INVOICES, {
    token,
    body: { number: 'TOO-BIG', type: 'receivable', contactId: customer.id, issueDate: '2025-03-01', dueDate: '2025-03-01',
      lineItems: [{ description: 'x', quantity: 1_000_000, unitPrice: uzs(9_007_199_254_741) }] },
  });
  assertRejected(tooBig, 422, 'UNPROCESSABLE');
});

test('invoice input is validated', async (t) => {
  const { request, db, token, customer, vendor, close } = await setup();
  t.after(close);
  const line = { description: 'Item', quantity: 1, unitPrice: uzs(100) };
  const base = (extra) => ({ number: 'INV-1', type: 'receivable', contactId: customer.id, issueDate: '2025-03-01', dueDate: '2025-03-31', lineItems: [line], ...extra });

  const cases = [
    [base({ lineItems: [] }), 400, 'VALIDATION_ERROR', 'lineItems'],
    [base({ lineItems: undefined }), 400, 'VALIDATION_ERROR', 'lineItems'],
    [base({ lineItems: Array.from({ length: 201 }, () => line) }), 400, 'VALIDATION_ERROR', 'lineItems'],
    [base({ lineItems: [{ ...line, quantity: 0 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.quantity'],
    [base({ lineItems: [{ ...line, quantity: 1.5 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.quantity'],
    [base({ lineItems: [{ ...line, quantity: -1 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.quantity'],
    [base({ lineItems: [{ ...line, unitPrice: uzs(0) }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.unitPrice.amount'],
    [base({ lineItems: [{ ...line, unitPrice: uzs(10.5) }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.unitPrice.amount'],
    [base({ lineItems: [{ ...line, unitPrice: { amount: '100', currency: 'UZS' } }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.unitPrice.amount'],
    [base({ lineItems: [{ ...line, unitPrice: { amount: 100, currency: 'USD' } }] }), 422, 'UNPROCESSABLE', 'lineItems.0.unitPrice.currency'],
    [base({ lineItems: [{ ...line, taxRate: 10001 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.taxRate'],
    [base({ lineItems: [{ ...line, taxRate: 12.5 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.taxRate'],
    [base({ lineItems: [{ ...line, taxRate: -1 }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.taxRate'],
    [base({ lineItems: [{ ...line, description: '' }] }), 400, 'VALIDATION_ERROR', 'lineItems.0.description'],
    [base({ issueDate: '2025-02-30' }), 400, 'VALIDATION_ERROR', 'issueDate'],
    [base({ dueDate: '31/03/2025' }), 400, 'VALIDATION_ERROR', 'dueDate'],
    [base({ dueDate: '2025-02-28' }), 400, 'VALIDATION_ERROR', 'dueDate'],
    [base({ type: 'credit_note' }), 400, 'VALIDATION_ERROR', 'type'],
    [base({ number: '' }), 400, 'VALIDATION_ERROR', 'number'],
    [base({ number: 'x'.repeat(51) }), 400, 'VALIDATION_ERROR', 'number'],
    [base({ contactId: 'not-an-id' }), 400, 'VALIDATION_ERROR', 'contactId'],
    [base({ contactId: 'con_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 422, 'UNPROCESSABLE', 'contactId'],
    [base({ contactId: vendor.id }), 422, 'UNPROCESSABLE', 'contactId'],
    [base({ type: 'payable' }), 422, 'UNPROCESSABLE', 'contactId'],
    [base({ companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 400, 'VALIDATION_ERROR', '_root'],
  ];
  for (const [body, status, code, field] of cases) {
    assertRejected(await request('POST', INVOICES, { token, body }), status, code, field);
  }
  assert.equal(db.getValue('SELECT count(*) FROM invoices'), 0);

  assertRejected(await request('POST', INVOICES, { token, raw: '{ "number": ' }), 400, 'INVALID_JSON');
  await createInvoice(request, token, customer, { number: 'INV-1' });
  assertRejected(await request('POST', INVOICES, { token, body: base({ number: 'inv-1' }) }), 409, 'CONFLICT', 'number');
  assert.equal((await request('POST', INVOICES, { token, body: base({ number: 'P-1', type: 'payable', contactId: vendor.id }) })).status, 201);
});

// ---------------------------------------------------------------- update / delete

test('draft and sent invoices can be edited; line items are replaced and totals recomputed', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);
  const other = await createContact(request, token, { name: 'Beta', type: 'customer' });
  const invoice = await createInvoice(request, token, customer);

  const updated = await request('PATCH', `${INVOICES}/${invoice.id}`, {
    token,
    body: { notes: 'Updated', contactId: other.id, dueDate: '2025-04-15', lineItems: [{ description: 'New', quantity: 2, unitPrice: uzs(750), taxRate: 1000 }] },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual([updated.data.notes, updated.data.contact.id, updated.data.dueDate], ['Updated', other.id, '2025-04-15']);
  assert.deepEqual([updated.data.subtotal, updated.data.tax, updated.data.total], [uzs(1500), uzs(150), uzs(1650)]);
  assert.equal(updated.data.lineItems.length, 1);

  await sendInvoice(request, token, invoice);
  const sentEdit = await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: { notes: null } });
  assert.equal(sentEdit.status, 200);
  assert.equal(sentEdit.data.notes, null);

  assertRejected(await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: {} }), 400, 'VALIDATION_ERROR');
  assertRejected(await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: { dueDate: '2025-02-01' } }), 400, 'VALIDATION_ERROR', 'dueDate');
  assertRejected(await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: { total: uzs(1) } }), 400, 'VALIDATION_ERROR');
  assertRejected(await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: { status: 'paid' } }), 400, 'VALIDATION_ERROR');

  await request('POST', `${INVOICES}/${invoice.id}/status`, { token, body: { status: 'cancelled' } });
  assertRejected(await request('PATCH', `${INVOICES}/${invoice.id}`, { token, body: { notes: 'x' } }), 422, 'UNPROCESSABLE', 'status');
});

test('only a draft invoice can be deleted', async (t) => {
  const { request, db, token, customer, close } = await setup();
  t.after(close);
  const draft = await createInvoice(request, token, customer, { number: 'D-1' });
  const sent = await createInvoice(request, token, customer, { number: 'S-1' });
  await sendInvoice(request, token, sent);

  const deleted = await request('DELETE', `${INVOICES}/${draft.id}`, { token });
  assert.equal(deleted.status, 204);
  assert.equal(db.getValue('SELECT count(*) FROM invoice_line_items WHERE invoice_id = ?', [draft.id]), 0, 'line items go with it');
  assertRejected(await request('GET', `${INVOICES}/${draft.id}`, { token }), 404, 'NOT_FOUND');
  assertRejected(await request('DELETE', `${INVOICES}/${sent.id}`, { token }), 422, 'UNPROCESSABLE', 'status');
  assertRejected(await request('DELETE', `${INVOICES}/garbage`, { token }), 404, 'NOT_FOUND');
});

// ---------------------------------------------------------------- statuses and dates

test('status transitions: draft → sent → cancelled; invalid transitions are refused', async (t) => {
  const { request, token, customer, close } = await setup();
  t.after(close);
  const invoice = await createInvoice(request, token, customer, { issueDate: todayIso(), dueDate: addDays(todayIso(), 30) });
  const transition = (status) => request('POST', `${INVOICES}/${invoice.id}/status`, { token, body: { status } });

  for (const status of ['paid', 'overdue', 'draft']) {
    assertRejected(await transition(status), 422, 'UNPROCESSABLE', 'status');
  }
  const sent = await transition('sent');
  assert.equal(sent.data.status, 'sent');
  assert.ok(sent.data.sentAt);
  for (const status of ['sent', 'draft', 'overdue', 'paid']) {
    assertRejected(await transition(status), 422, 'UNPROCESSABLE', 'status');
  }
  assertRejected(await transition('void'), 400, 'VALIDATION_ERROR', 'status');

  const cancelled = await transition('cancelled');
  assert.equal(cancelled.data.status, 'cancelled');
  assert.ok(cancelled.data.cancelledAt);
  for (const status of ['sent', 'cancelled', 'draft']) {
    assertRejected(await transition(status), 422, 'UNPROCESSABLE', 'status');
  }

  const draft = await createInvoice(request, token, customer, { number: 'D-2' });
  assert.equal((await request('POST', `${INVOICES}/${draft.id}/status`, { token, body: { status: 'cancelled' } })).data.status, 'cancelled', 'a draft can be cancelled');
});

test('overdue is derived: a sent invoice becomes overdue the day after its due date (UTC)', async (t) => {
  const { request, db, token, customer, close } = await setup();
  t.after(close);
  const today = todayIso();
  const dueToday = await createInvoice(request, token, customer, { number: 'DUE-TODAY', issueDate: addDays(today, -10), dueDate: today });
  const dueYesterday = await createInvoice(request, token, customer, { number: 'DUE-YESTERDAY', issueDate: addDays(today, -10), dueDate: addDays(today, -1) });
  const draftPastDue = await createInvoice(request, token, customer, { number: 'DRAFT-OLD', issueDate: '2025-01-01', dueDate: '2025-01-02' });

  assert.equal((await sendInvoice(request, token, dueToday)).status, 'sent', 'still payable on its due date');
  assert.equal((await sendInvoice(request, token, dueYesterday)).status, 'overdue');
  assert.equal((await request('GET', `${INVOICES}/${draftPastDue.id}`, { token })).data.status, 'draft', 'a draft is never overdue');
  assert.equal(db.getValue('SELECT status FROM invoices WHERE id = ?', [dueYesterday.id]), 'sent', 'overdue is never stored');

  const statuses = async (query) => (await request('GET', `${INVOICES}?${query}&sort=number:asc`, { token })).data.map((row) => row.number);
  assert.deepEqual(await statuses('status=overdue'), ['DUE-YESTERDAY']);
  assert.deepEqual(await statuses('status=sent'), ['DUE-TODAY']);
  assert.deepEqual(await statuses('status=sent&status=overdue'), ['DUE-TODAY', 'DUE-YESTERDAY']);
  assert.deepEqual(await statuses('status=draft'), ['DRAFT-OLD']);

  // Moving the due date forward takes it out of overdue.
  const extended = await request('PATCH', `${INVOICES}/${dueYesterday.id}`, { token, body: { dueDate: addDays(today, 7) } });
  assert.equal(extended.data.status, 'sent');
});

test('the list is paginated, filtered, searched and sorted', async (t) => {
  const { request, token, customer, vendor, close } = await setup();
  t.after(close);
  for (let i = 1; i <= 5; i += 1) {
    await createInvoice(request, token, customer, { number: `R-${i}`, issueDate: `2025-03-0${i}`, dueDate: '2025-04-30',
      lineItems: [{ description: 'x', quantity: i, unitPrice: uzs(100) }] });
  }
  await createInvoice(request, token, vendor, { number: 'P-1', type: 'payable', issueDate: '2025-02-15', dueDate: '2025-03-15' });

  const first = await request('GET', `${INVOICES}?limit=2`, { token });
  assert.deepEqual(first.meta, { page: 1, limit: 2, total: 6, totalPages: 3, hasNext: true, hasPrevious: false, sort: 'issueDate:desc' });
  assert.deepEqual(first.data.map((row) => row.number), ['R-5', 'R-4']);
  assert.equal('lineItems' in first.data[0], false, 'the list omits line items');

  const numbers = async (query) => (await request('GET', `${INVOICES}?${query}`, { token })).data.map((row) => row.number);
  assert.deepEqual(await numbers('type=payable'), ['P-1']);
  assert.deepEqual(await numbers(`contactId=${vendor.id}`), ['P-1']);
  assert.deepEqual(await numbers('from=2025-03-02&to=2025-03-04&sort=issueDate:asc'), ['R-2', 'R-3']);
  assert.deepEqual(await numbers('period=custom&periodStart=2025-02-01&periodEnd=2025-03-01'), ['P-1']);
  assert.deepEqual(await numbers('q=r-&sort=total:desc'), ['R-5', 'R-4', 'R-3', 'R-2', 'R-1']);
  assert.deepEqual(await numbers('q=%25'), [], 'a literal % is not a wildcard');

  for (const bad of ['status=unknown', 'type=credit', 'sort=contact', 'limit=0', 'from=2025-03-05&to=2025-03-01', 'contactId=nope']) {
    assertRejected(await request('GET', `${INVOICES}?${bad}`, { token }), 400, 'VALIDATION_ERROR');
  }
});
