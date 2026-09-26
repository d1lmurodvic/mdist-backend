/**
 * Phase 4 tenant isolation (DEVELOPMENT_RULES.md §9.5): two companies, each
 * with a contact and a sent invoice, probed from the other side in both
 * directions. A foreign id must behave exactly like an id that exists nowhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createContact, createInvoice, errorWithoutRequestId, ledgerOwner, sendInvoice } from './helpers/fixtures.js';

const NOWHERE = { invoice: 'inv_01M3EFNC4TMGZ36SQ8D1WYJ2TK', contact: 'con_01M3EFNC4TMGZ36SQ8D1WYJ2TK' };
const APRIL = 'period=custom&periodStart=2025-04-01&periodEnd=2025-05-01';

async function tenant(request, email, companyName) {
  const owner = await ledgerOwner(request, { email, companyName, opening: 1000 });
  const contact = await createContact(request, owner.token, { name: `${companyName} client`, type: 'customer' });
  const invoice = await createInvoice(request, owner.token, contact, { number: 'INV-001' });
  await sendInvoice(request, owner.token, invoice);
  return { ...owner, contact, invoice };
}

async function twoTenants() {
  const env = await createTestApp();
  return { ...env, a: await tenant(env.request, 'owner@a.example', 'Company A'), b: await tenant(env.request, 'owner@b.example', 'Company B') };
}

async function assertSameAsNowhere(request, token, method, foreignPath, nowherePath, options = {}) {
  const foreign = await request(method, foreignPath, { token, ...options });
  const nowhere = await request(method, nowherePath, { token, ...options });
  assert.equal(foreign.status, nowhere.status, `${method} ${foreignPath}: ${foreign.raw}`);
  assert.ok(foreign.status >= 400);
  assertErrorEnvelope(foreign, nowhere.error.code);
  assert.deepEqual(errorWithoutRequestId(foreign), errorWithoutRequestId(nowhere), `${method} ${foreignPath} leaks existence`);
  return foreign;
}

test('another company\'s invoice cannot be read, edited, sent, cancelled, deleted or paid', async (t) => {
  const { request, db, a, b, close } = await twoTenants();
  t.after(close);

  for (const [self, other] of [[a, b], [b, a]]) {
    const foreign = `/api/v1/invoices/${other.invoice.id}`;
    const nowhere = `/api/v1/invoices/${NOWHERE.invoice}`;
    const read = await assertSameAsNowhere(request, self.token, 'GET', foreign, nowhere);
    assert.equal(read.status, 404);
    await assertSameAsNowhere(request, self.token, 'PATCH', foreign, nowhere, { body: { notes: 'hijack' } });
    await assertSameAsNowhere(request, self.token, 'POST', `${foreign}/status`, `${nowhere}/status`, { body: { status: 'cancelled' } });
    await assertSameAsNowhere(request, self.token, 'DELETE', foreign, nowhere);
    await assertSameAsNowhere(request, self.token, 'POST', `${foreign}/payment`, `${nowhere}/payment`, {
      body: { accountId: self.account.id, date: '2025-04-05' }, headers: { 'Idempotency-Key': `probe-${self.company.id}` },
    });

    const list = await request('GET', '/api/v1/invoices', { token: self.token });
    assert.deepEqual(list.data.map((invoice) => invoice.id), [self.invoice.id]);
  }
  for (const side of [a, b]) {
    assert.equal(db.getValue('SELECT status FROM invoices WHERE id = ?', [side.invoice.id]), 'sent', 'untouched');
    assert.equal(db.getValue('SELECT notes FROM invoices WHERE id = ?', [side.invoice.id]), null);
  }
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0, 'no payment was recorded');
  assert.equal(db.getValue('SELECT count(*) FROM idempotency_keys'), 0);
});

test('another company\'s contact cannot be listed, edited or used on an invoice', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);

  for (const [self, other] of [[a, b], [b, a]]) {
    const contacts = await request('GET', '/api/v1/companies/current/contacts', { token: self.token });
    assert.deepEqual(contacts.data.map((contact) => contact.id), [self.contact.id]);
    await assertSameAsNowhere(request, self.token, 'PATCH', `/api/v1/contacts/${other.contact.id}`, `/api/v1/contacts/${NOWHERE.contact}`, { body: { name: 'x' } });

    const body = (contactId) => ({
      number: 'X-1', type: 'receivable', contactId, issueDate: '2025-03-01', dueDate: '2025-03-02',
      lineItems: [{ description: 'x', quantity: 1, unitPrice: { amount: 1, currency: 'UZS' } }],
    });
    const viaForeign = await request('POST', '/api/v1/invoices', { token: self.token, body: body(other.contact.id) });
    const viaNowhere = await request('POST', '/api/v1/invoices', { token: self.token, body: body(NOWHERE.contact) });
    assert.equal(viaForeign.status, 422);
    assert.deepEqual(errorWithoutRequestId(viaForeign), errorWithoutRequestId(viaNowhere));

    const moveToForeign = await request('PATCH', `/api/v1/invoices/${self.invoice.id}`, { token: self.token, body: { contactId: other.contact.id } });
    assert.equal(moveToForeign.status, 422);
  }
});

test('line items are only reachable through their own company\'s invoice', async (t) => {
  const { request, db, a, b, close } = await twoTenants();
  t.after(close);

  const own = await request('GET', `/api/v1/invoices/${a.invoice.id}`, { token: a.token });
  assert.equal(own.data.lineItems.length, 1);
  assert.equal((await request('GET', `/api/v1/invoices/${a.invoice.id}`, { token: b.token })).status, 404);
  // The database refuses a line item under another company's invoice.
  assert.throws(() => db.run(
    `INSERT INTO invoice_line_items (id, company_id, invoice_id, position, description, quantity, unit_price_minor, tax_rate_bp, line_total_minor, tax_minor)
     VALUES ('inl_x', ?, ?, 9, 'smuggled', 1, 1, 0, 1, 0)`,
    [b.company.id, a.invoice.id],
  ), /FOREIGN KEY constraint failed/);
});

test('a payment cannot use another company\'s account, and totals stay per company', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);

  const foreignAccount = await request('POST', `/api/v1/invoices/${a.invoice.id}/payment`, {
    token: a.token, body: { accountId: b.account.id, date: '2025-04-05' },
  });
  assert.equal(foreignAccount.status, 422);

  const paid = await request('POST', `/api/v1/invoices/${a.invoice.id}/payment`, { token: a.token, body: { accountId: a.account.id, date: '2025-04-05' } });
  assert.equal(paid.status, 201);
  const overviewA = await request('GET', `/api/v1/financials/overview?${APRIL}`, { token: a.token });
  const overviewB = await request('GET', `/api/v1/financials/overview?${APRIL}`, { token: b.token });
  assert.deepEqual(overviewA.data.income, { amount: 10000, currency: 'UZS' });
  assert.deepEqual(overviewB.data.income, { amount: 0, currency: 'UZS' }, 'A\'s paid invoice does not touch B');
  assert.equal((await request('GET', `/api/v1/transactions/${paid.data.transaction.id}`, { token: b.token })).status, 404);
});

test('a client-supplied companyId never selects another tenant', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);
  const viaQuery = await request('GET', `/api/v1/invoices?companyId=${b.company.id}`, { token: a.token });
  assert.deepEqual(viaQuery.data.map((invoice) => invoice.id), [a.invoice.id]);
  const viaFilter = await request('GET', `/api/v1/invoices?contactId=${b.contact.id}`, { token: a.token });
  assert.deepEqual(viaFilter.data, []);
  const viaBody = await request('POST', '/api/v1/companies/current/contacts', { token: a.token, body: { name: 'X', type: 'vendor', companyId: b.company.id } });
  assert.equal(viaBody.status, 400);
});

test('invoice and contact routes require a session and a company', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  for (const [method, path] of [
    ['GET', '/api/v1/invoices'], ['POST', '/api/v1/invoices'], ['GET', `/api/v1/invoices/${NOWHERE.invoice}`],
    ['POST', `/api/v1/invoices/${NOWHERE.invoice}/payment`], ['GET', '/api/v1/companies/current/contacts'],
    ['PATCH', `/api/v1/contacts/${NOWHERE.contact}`],
  ]) {
    const response = await request(method, path, { body: method === 'GET' ? undefined : {} });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});
