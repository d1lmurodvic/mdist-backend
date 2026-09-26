/**
 * Phase 3 tenant isolation (DEVELOPMENT_RULES.md §9.5). Two companies, A and
 * B, each with an account, categories, a rule and transactions. Every
 * company-owned Phase 3 resource is probed from the other tenant, in both
 * directions; a foreign id must behave exactly like an id that does not exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createCategory, errorWithoutRequestId, ledgerOwner, recordTransaction, uzs } from './helpers/fixtures.js';

const NOWHERE = {
  transaction: 'txn_01M3EFNC4TMGZ36SQ8D1WYJ2TK',
  account: 'acc_01M3EFNC4TMGZ36SQ8D1WYJ2TK',
  category: 'cat_01M3EFNC4TMGZ36SQ8D1WYJ2TK',
  rule: 'rul_01M3EFNC4TMGZ36SQ8D1WYJ2TK',
};

async function tenant(request, email, companyName, payee) {
  const owner = await ledgerOwner(request, { email, companyName, opening: 1000 });
  const category = await createCategory(request, owner.token, { name: `${companyName} costs`, type: 'expense' });
  const rule = (await request('POST', '/api/v1/companies/current/category-rules', {
    token: owner.token, body: { matchType: 'contains', pattern: payee.toLowerCase(), categoryId: category.id },
  })).data;
  const transaction = await recordTransaction(request, owner.token, {
    type: 'expense', amount: uzs(400), date: '2025-03-10', accountId: owner.account.id, payee,
  });
  return { ...owner, category, rule, transaction };
}

async function twoTenants() {
  const env = await createTestApp();
  const a = await tenant(env.request, 'owner@a.example', 'Company A', 'Shared Vendor');
  const b = await tenant(env.request, 'owner@b.example', 'Company B', 'Shared Vendor');
  return { ...env, a, b };
}

/** A request for another tenant's resource must match the "does not exist" answer. */
async function assertSameAsNowhere(request, token, method, foreignPath, nowherePath, body) {
  const foreign = await request(method, foreignPath, { token, body });
  const nowhere = await request(method, nowherePath, { token, body });
  assert.equal(foreign.status, nowhere.status, `${method} ${foreignPath}: ${foreign.raw}`);
  assert.ok(foreign.status >= 400, `${method} ${foreignPath} must fail`);
  assertErrorEnvelope(foreign, nowhere.error.code);
  assert.deepEqual(errorWithoutRequestId(foreign), errorWithoutRequestId(nowhere), `${method} ${foreignPath} leaks existence`);
  return foreign;
}

test('transactions: another company\'s transaction cannot be read, changed or deleted', async (t) => {
  const { request, db, a, b, close } = await twoTenants();
  t.after(close);

  for (const [self, other] of [[a, b], [b, a]]) {
    const foreign = `/api/v1/transactions/${other.transaction.id}`;
    const nowhere = `/api/v1/transactions/${NOWHERE.transaction}`;
    const read = await assertSameAsNowhere(request, self.token, 'GET', foreign, nowhere);
    assert.equal(read.status, 404);
    await assertSameAsNowhere(request, self.token, 'PATCH', foreign, nowhere, { notes: 'hijack' });
    await assertSameAsNowhere(request, self.token, 'DELETE', foreign, nowhere);

    const list = await request('GET', '/api/v1/transactions?limit=100', { token: self.token });
    assert.deepEqual(list.data.map((row) => row.id), [self.transaction.id]);
    assert.equal(list.meta.total, 1);
  }
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 2, 'both still exist');
  assert.equal(db.getValue('SELECT notes FROM transactions WHERE id = ?', [b.transaction.id]), null, 'untouched');
});

test('transactions cannot reference another company\'s account or category', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);
  const body = (extra) => ({ type: 'expense', amount: uzs(1), date: '2025-03-20', accountId: a.account.id, payee: 'x', ...extra });

  for (const [field, foreign, nowhere] of [
    ['accountId', b.account.id, NOWHERE.account],
    ['categoryId', b.category.id, NOWHERE.category],
  ]) {
    const viaForeign = await request('POST', '/api/v1/transactions', { token: a.token, body: body({ [field]: foreign }) });
    const viaNowhere = await request('POST', '/api/v1/transactions', { token: a.token, body: body({ [field]: nowhere }) });
    assert.equal(viaForeign.status, 422);
    assert.deepEqual(errorWithoutRequestId(viaForeign), errorWithoutRequestId(viaNowhere));

    const patch = await request('PATCH', `/api/v1/transactions/${a.transaction.id}`, { token: a.token, body: { [field]: foreign } });
    assert.equal(patch.status, 422);
  }

  const bulk = await request('POST', '/api/v1/transactions/bulk-categorize', {
    token: a.token, body: { transactionIds: [b.transaction.id, a.transaction.id], categoryId: a.category.id },
  });
  assert.deepEqual(bulk.data.results.map((result) => result.status), ['not_found', 'updated']);
  const bulkForeignCategory = await request('POST', '/api/v1/transactions/bulk-categorize', {
    token: a.token, body: { transactionIds: [a.transaction.id], categoryId: b.category.id },
  });
  assert.equal(bulkForeignCategory.status, 422);
});

test('accounts, categories and rules: each company sees and changes only its own', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);

  for (const [self, other] of [[a, b], [b, a]]) {
    const accounts = await request('GET', '/api/v1/companies/current/accounts', { token: self.token });
    assert.deepEqual(accounts.data.map((account) => account.id), [self.account.id]);
    const categories = await request('GET', '/api/v1/companies/current/categories', { token: self.token });
    assert.ok(categories.data.every((category) => category.id !== other.category.id));
    assert.equal(categories.data.filter((category) => category.isSystem).length, 1, 'own Uncategorized only');
    const rules = await request('GET', '/api/v1/companies/current/category-rules', { token: self.token });
    assert.deepEqual(rules.data.map((rule) => rule.id), [self.rule.id]);

    await assertSameAsNowhere(request, self.token, 'PATCH', `/api/v1/accounts/${other.account.id}`, `/api/v1/accounts/${NOWHERE.account}`, { name: 'x' });
    await assertSameAsNowhere(request, self.token, 'PATCH', `/api/v1/categories/${other.category.id}`, `/api/v1/categories/${NOWHERE.category}`, { name: 'x' });
    await assertSameAsNowhere(request, self.token, 'DELETE', `/api/v1/category-rules/${other.rule.id}`, `/api/v1/category-rules/${NOWHERE.rule}`);

    const foreignRule = await request('POST', '/api/v1/companies/current/category-rules', {
      token: self.token, body: { matchType: 'exact', pattern: 'x', categoryId: other.category.id },
    });
    assert.equal(foreignRule.status, 422);
    const foreignParent = await request('POST', '/api/v1/companies/current/categories', {
      token: self.token, body: { name: 'Child', type: 'expense', parentId: other.category.id },
    });
    assert.equal(foreignParent.status, 422);
  }
});

test('a client-supplied companyId never selects another tenant', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);

  const viaQuery = await request('GET', `/api/v1/transactions?companyId=${b.company.id}`, { token: a.token });
  assert.deepEqual(viaQuery.data.map((row) => row.id), [a.transaction.id]);
  const accountsViaQuery = await request('GET', `/api/v1/companies/current/accounts?companyId=${b.company.id}`, { token: a.token });
  assert.deepEqual(accountsViaQuery.data.map((row) => row.id), [a.account.id]);
  const filterByForeignAccount = await request('GET', `/api/v1/transactions?accountId=${b.account.id}`, { token: a.token });
  assert.deepEqual(filterByForeignAccount.data, []);

  for (const [path, body] of [
    ['/api/v1/transactions', { type: 'expense', amount: uzs(1), date: '2025-03-01', accountId: a.account.id, companyId: b.company.id }],
    ['/api/v1/companies/current/accounts', { name: 'X', type: 'cash', companyId: b.company.id }],
    ['/api/v1/companies/current/categories', { name: 'X', type: 'income', companyId: b.company.id }],
  ]) {
    const response = await request('POST', path, { token: a.token, body });
    assert.equal(response.status, 400, path);
  }
});

test('categorization and duplicate detection never cross tenants', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);

  // Identical type, amount, date and payee in the other company is not a duplicate.
  const same = await request('POST', '/api/v1/transactions', {
    token: a.token, body: { type: 'expense', amount: uzs(400), date: '2025-03-10', accountId: a.account.id, payee: 'Other vendor' },
  });
  assert.equal(same.status, 201);
  const bCopy = await request('POST', '/api/v1/transactions', {
    token: b.token, body: { type: 'expense', amount: uzs(400), date: '2025-03-10', accountId: b.account.id, payee: 'Other vendor' },
  });
  assert.equal(bCopy.status, 201, 'A\'s transaction does not make B\'s a duplicate');
  assert.deepEqual((await request('GET', '/api/v1/transactions/duplicates', { token: a.token })).data, []);

  // Each company's rule categorizes only its own transactions.
  assert.equal(a.transaction.categoryId, a.category.id);
  assert.equal(b.transaction.categoryId, b.category.id);

  // A learned correction in B does not affect A.
  const bExtra = await recordTransaction(request, b.token, { type: 'expense', amount: uzs(9), date: '2025-03-11', accountId: b.account.id, payee: 'Taxi Co' });
  await request('PATCH', `/api/v1/transactions/${bExtra.id}`, { token: b.token, body: { categoryId: b.category.id } });
  const aTaxi = await recordTransaction(request, a.token, { type: 'expense', amount: uzs(9), date: '2025-03-11', accountId: a.account.id, payee: 'Taxi Co' });
  assert.equal(aTaxi.categorization.method, 'fallback');
});

test('financial figures include only the caller\'s company', async (t) => {
  const { request, a, b, close } = await twoTenants();
  t.after(close);
  await recordTransaction(request, b.token, { type: 'income', amount: uzs(1_000_000), date: '2025-03-15', accountId: b.account.id, payee: 'Big client' });

  const query = 'period=custom&periodStart=2025-03-01&periodEnd=2025-04-01';
  const overviewA = await request('GET', `/api/v1/financials/overview?${query}`, { token: a.token });
  assert.deepEqual([overviewA.data.income, overviewA.data.expenses], [uzs(0), uzs(400)]);
  assert.deepEqual(overviewA.data.cash.closing, uzs(600));
  const overviewB = await request('GET', `/api/v1/financials/overview?${query}`, { token: b.token });
  assert.deepEqual(overviewB.data.income, uzs(1_000_000));
  const flowA = await request('GET', `/api/v1/financials/cash-flow?${query}`, { token: a.token });
  assert.deepEqual(flowA.data.cashIn, uzs(0));
});

test('Phase 3 routes require a session and a company', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  for (const [method, path] of [
    ['GET', '/api/v1/transactions'], ['POST', '/api/v1/transactions'], ['GET', '/api/v1/companies/current/accounts'],
    ['GET', '/api/v1/financials/overview'], ['GET', '/api/v1/financials/cash-flow'], ['GET', '/api/v1/transactions/duplicates'],
  ]) {
    const response = await request(method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
});
