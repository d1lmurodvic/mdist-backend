/**
 * Auth/tenancy fixtures built through the real API, so every test exercises
 * the same path a client does.
 */

import assert from 'node:assert/strict';

export const PASSWORD = 'correct horse battery';

export async function registerUser(request, { email, password = PASSWORD, name = 'Test User' } = {}) {
  const response = await request('POST', '/api/v1/auth/register', { body: { email, password, name } });
  assert.equal(response.status, 201, `registration of ${email} failed: ${response.raw}`);
  return { user: response.data.user, token: response.data.session.token };
}

export async function createCompany(request, token, body = { name: 'Acme', currency: 'UZS' }) {
  const response = await request('POST', '/api/v1/companies', { token, body });
  assert.equal(response.status, 201, `company creation failed: ${response.raw}`);
  return response.data;
}

/** A registered owner with an onboarded company. */
export async function ownerWithCompany(request, { email, companyName }) {
  const { user, token } = await registerUser(request, { email, name: `${companyName} Owner` });
  const company = await createCompany(request, token, { name: companyName, currency: 'UZS' });
  return { user, token, company };
}

/** Money in the company currency used by the fixtures. */
export const uzs = (amount) => ({ amount, currency: 'UZS' });

export async function createAccount(request, token, body) {
  const response = await request('POST', '/api/v1/companies/current/accounts', { token, body });
  assert.equal(response.status, 201, `account creation failed: ${response.raw}`);
  return response.data;
}

export async function createCategory(request, token, body) {
  const response = await request('POST', '/api/v1/companies/current/categories', { token, body });
  assert.equal(response.status, 201, `category creation failed: ${response.raw}`);
  return response.data;
}

export async function recordTransaction(request, token, body) {
  const response = await request('POST', '/api/v1/transactions', { token, body });
  assert.equal(response.status, 201, `transaction failed: ${response.raw}`);
  return response.data;
}

/** An owner with a company (UZS) and one bank account holding `opening`. */
export async function ledgerOwner(request, { email, companyName, opening = 0 }) {
  const owner = await ownerWithCompany(request, { email, companyName });
  const account = await createAccount(request, owner.token, { name: 'Main bank', type: 'bank', openingBalance: uzs(opening) });
  return { ...owner, account };
}

export async function createContact(request, token, body = { name: 'Acme LLC', type: 'customer' }) {
  const response = await request('POST', '/api/v1/companies/current/contacts', { token, body });
  assert.equal(response.status, 201, `contact creation failed: ${response.raw}`);
  return response.data;
}

/** A draft invoice; `overrides` replace fields of a one-line 10,000 UZS receivable. */
export async function createInvoice(request, token, contact, overrides = {}) {
  const body = {
    number: 'INV-001',
    type: 'receivable',
    contactId: contact.id,
    issueDate: '2025-03-01',
    dueDate: '2025-03-31',
    lineItems: [{ description: 'Consulting', quantity: 1, unitPrice: uzs(10000) }],
    ...overrides,
  };
  const response = await request('POST', '/api/v1/invoices', { token, body });
  assert.equal(response.status, 201, `invoice creation failed: ${response.raw}`);
  return response.data;
}

export async function sendInvoice(request, token, invoice) {
  const response = await request('POST', `/api/v1/invoices/${invoice.id}/status`, { token, body: { status: 'sent' } });
  assert.equal(response.status, 200, `send failed: ${response.raw}`);
  return response.data;
}

/** The error envelope without its per-request id, for comparing two failures. */
export function errorWithoutRequestId(response) {
  const { requestId, ...rest } = response.error;
  assert.match(requestId, /^req_/);
  return rest;
}
