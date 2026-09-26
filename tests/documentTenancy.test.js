/**
 * Phase 5 tenant isolation. Every document endpoint is probed across two
 * companies in both directions; another company's document must be
 * indistinguishable from one that does not exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { assertErrorEnvelope } from './helpers/testApp.js';
import { createAccount, createContact, ownerWithCompany, uzs } from './helpers/fixtures.js';
import { createDocumentsApp, providerResult, settled, storedFiles, uploadFile } from './helpers/documents.js';

const MISSING_ID = 'doc_01M3EFNC4TMGZ36SQ8D1WYJ2TK';

async function twoCompanies() {
  const app = await createDocumentsApp({ adapter: { async readDocument() { return providerResult(); } } });
  const a = await ownerWithCompany(app.request, { email: 'a@a.example', companyName: 'A' });
  const b = await ownerWithCompany(app.request, { email: 'b@b.example', companyName: 'B' });
  for (const side of [a, b]) {
    side.account = await createAccount(app.request, side.token, { name: 'Bank', type: 'bank', openingBalance: uzs(1000) });
    side.vendor = await createContact(app.request, side.token, { name: 'Vendor', type: 'vendor' });
    side.documentId = (await uploadFile(app.request, side.token)).data.id;
    await settled(app.request, side.token, side.documentId);
  }
  return { ...app, a, b };
}

function probes(side, documentId) {
  const confirm = { target: 'transaction', transaction: { type: 'expense', amount: uzs(10), date: '2025-03-14', accountId: side.account.id } };
  return [
    ['GET', `/api/v1/documents/${documentId}`],
    ['GET', `/api/v1/documents/${documentId}/file`],
    ['POST', `/api/v1/documents/${documentId}/extract`],
    ['POST', `/api/v1/documents/${documentId}/confirm`, confirm],
    ['DELETE', `/api/v1/documents/${documentId}`],
  ];
}

async function assertLooksMissing(request, token, method, path, body, missingPath) {
  const foreign = await request(method, path, { token, body });
  const missing = await request(method, missingPath, { token, body });
  assert.equal(foreign.status, 404, `${method} ${path}: ${foreign.raw}`);
  assertErrorEnvelope(foreign, 'NOT_FOUND');
  assert.equal(foreign.error.message, missing.error.message, 'same answer as a document that does not exist');
}

for (const [from, to] of [['a', 'b'], ['b', 'a']]) {
  test(`company ${from.toUpperCase()} cannot reach company ${to.toUpperCase()}'s documents`, async (t) => {
    const app = await twoCompanies();
    t.after(app.close);
    const actor = app[from];
    const victim = app[to];

    for (const [method, path, body] of probes(actor, victim.documentId)) {
      await assertLooksMissing(app.request, actor.token, method, path, body, path.replace(victim.documentId, MISSING_ID));
    }

    const listed = await app.request('GET', '/api/v1/documents', { token: actor.token });
    assert.deepEqual(listed.data.map((d) => d.id), [actor.documentId], 'only the own document is listed');

    // The victim's document is untouched: still there, unconfirmed, one attempt, file intact.
    const intact = await app.request('GET', `/api/v1/documents/${victim.documentId}`, { token: victim.token });
    assert.equal(intact.status, 200);
    assert.deepEqual([intact.data.status, intact.data.confirmation, intact.data.extraction.attempt], ['ready', null, 1]);
    assert.equal((await app.request('GET', `/api/v1/documents/${victim.documentId}/file`, { token: victim.token })).status, 200);
    assert.equal(app.db.getValue('SELECT count(*) FROM transactions'), 0);
    assert.equal(storedFiles(app.uploadDir).length, 2);
  });

  test(`company ${from.toUpperCase()} cannot confirm onto company ${to.toUpperCase()}'s account or contact`, async (t) => {
    const app = await twoCompanies();
    t.after(app.close);
    const actor = app[from];
    const victim = app[to];

    const viaAccount = await app.request('POST', `/api/v1/documents/${actor.documentId}/confirm`, { token: actor.token, body: {
      target: 'transaction', transaction: { type: 'expense', amount: uzs(10), date: '2025-03-14', accountId: victim.account.id },
    } });
    assert.equal(viaAccount.status, 422, viaAccount.raw);
    assertErrorEnvelope(viaAccount, 'UNPROCESSABLE');

    const viaContact = await app.request('POST', `/api/v1/documents/${actor.documentId}/confirm`, { token: actor.token, body: {
      target: 'invoice', invoice: { number: 'X-1', type: 'payable', contactId: victim.vendor.id, issueDate: '2025-03-14', dueDate: '2025-03-14',
        lineItems: [{ description: 'x', quantity: 1, unitPrice: uzs(1) }] },
    } });
    assert.equal(viaContact.status, 422, viaContact.raw);
    assert.equal(app.db.getValue('SELECT count(*) FROM invoices'), 0);
    assert.equal(app.db.getValue('SELECT count(*) FROM documents WHERE confirmed_at IS NOT NULL'), 0);
  });
}

test('the storage layout keeps each company in its own directory', async (t) => {
  const app = await twoCompanies();
  t.after(app.close);
  const files = storedFiles(app.uploadDir);
  const companies = app.db.all('SELECT company_id, storage_key FROM documents');
  for (const row of companies) {
    assert.ok(row.storage_key.startsWith(`${row.company_id}/`), row.storage_key);
    assert.ok(files.includes(row.storage_key));
  }
});

test('the database refuses a document linked to another company\'s transaction or invoice', async (t) => {
  const app = await twoCompanies();
  t.after(app.close);
  const { a, b, db } = app;
  const bTransaction = await app.request('POST', '/api/v1/transactions', { token: b.token, body: {
    type: 'expense', amount: uzs(10), date: '2025-03-14', accountId: b.account.id } });
  const bInvoice = await app.request('POST', '/api/v1/invoices', { token: b.token, body: {
    number: 'B-1', type: 'payable', contactId: b.vendor.id, issueDate: '2025-03-14', dueDate: '2025-03-14',
    lineItems: [{ description: 'x', quantity: 1, unitPrice: uzs(1) }] } });
  const now = new Date().toISOString();

  assert.throws(() => db.run(
    `UPDATE documents SET confirmed_target = 'transaction', transaction_id = ?, confirmed_at = ? WHERE id = ?`,
    [bTransaction.data.id, now, a.documentId],
  ), /within the company/);
  assert.throws(() => db.run(
    `UPDATE documents SET confirmed_target = 'invoice', invoice_id = ?, confirmed_at = ? WHERE id = ?`,
    [bInvoice.data.id, now, a.documentId],
  ), /within the company/);
  assert.equal(db.getValue('SELECT count(*) FROM documents WHERE confirmed_at IS NOT NULL'), 0);
});

test('without a provider, another company\'s document is still a 404 on every endpoint, both ways', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  const sides = [];
  for (const [email, name] of [['a@a.example', 'A'], ['b@b.example', 'B']]) {
    const side = await ownerWithCompany(app.request, { email, companyName: name });
    side.account = await createAccount(app.request, side.token, { name: 'Bank', type: 'bank' });
    side.documentId = (await uploadFile(app.request, side.token)).data.id;
    await settled(app.request, side.token, side.documentId);
    sides.push(side);
  }
  for (const [actor, victim] of [[sides[0], sides[1]], [sides[1], sides[0]]]) {
    for (const [method, path, body] of probes(actor, victim.documentId)) {
      await assertLooksMissing(app.request, actor.token, method, path, body, path.replace(victim.documentId, MISSING_ID));
    }
  }
});
