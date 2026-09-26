/**
 * Phase 3 configuration resources: accounts, categories and category rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import {
  createAccount, createCategory, ledgerOwner, ownerWithCompany, recordTransaction, registerUser, uzs,
} from './helpers/fixtures.js';

const ACCOUNTS = '/api/v1/companies/current/accounts';
const CATEGORIES = '/api/v1/companies/current/categories';
const RULES = '/api/v1/companies/current/category-rules';

function assertRejected(response, status, code, field) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
  if (field) assert.ok(response.error.details?.some((detail) => detail.field === field), `${field}: ${response.raw}`);
}

async function addMember(request, db, company) {
  const member = await registerUser(request, { email: 'member@a.example', name: 'Member' });
  db.run('INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?, ?, ?, ?, ?)', [
    'mem_01M3EFNC4TMGZ36SQ8D1WYJ2TB', member.user.id, company.id, 'member', new Date().toISOString(),
  ]);
  return member;
}

// ---------------------------------------------------------------- accounts

test('an owner creates accounts with an opening balance in the company currency', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });

  const response = await request('POST', ACCOUNTS, { token, body: { name: '  Main bank ', type: 'bank', openingBalance: uzs(125000) } });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  assert.equal(response.headers.get('location'), `/api/v1/accounts/${response.data.id}`);
  assert.match(response.data.id, /^acc_/);
  assert.equal(response.data.name, 'Main bank');
  assert.equal(response.data.currency, 'UZS');
  assert.deepEqual(response.data.openingBalance, uzs(125000));
  assert.deepEqual(response.data.balance.amount, uzs(125000));
  assert.equal(response.data.acceptsTransactions, true);

  const noOpening = await createAccount(request, token, { name: 'Till', type: 'cash' });
  assert.deepEqual(noOpening.openingBalance, uzs(0), 'defaults to zero');
  const overdraft = await createAccount(request, token, { name: 'Overdrawn', type: 'bank', openingBalance: uzs(-5000) });
  assert.deepEqual(overdraft.openingBalance, uzs(-5000), 'an overdrawn opening balance is allowed');
  const loan = await createAccount(request, token, { name: 'Loan', type: 'liability', openingBalance: uzs(40000) });
  assert.equal(loan.acceptsTransactions, false);

  const list = await request('GET', ACCOUNTS, { token });
  assert.deepEqual(list.data.map((account) => account.name), ['Main bank', 'Till', 'Overdrawn', 'Loan']);
});

test('account input is validated', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });

  const cases = [
    [{ type: 'bank' }, 400, 'VALIDATION_ERROR', 'name'],
    [{ name: 'X', type: 'savings' }, 400, 'VALIDATION_ERROR', 'type'],
    [{ name: 'X', type: 'bank', openingBalance: 100 }, 400, 'VALIDATION_ERROR', 'openingBalance'],
    [{ name: 'X', type: 'bank', openingBalance: { amount: '100', currency: 'UZS' } }, 400, 'VALIDATION_ERROR', 'openingBalance.amount'],
    [{ name: 'X', type: 'bank', openingBalance: { amount: 1.5, currency: 'UZS' } }, 400, 'VALIDATION_ERROR', 'openingBalance.amount'],
    [{ name: 'X', type: 'bank', openingBalance: uzs(Number.MAX_SAFE_INTEGER + 1) }, 400, 'VALIDATION_ERROR', 'openingBalance.amount'],
    [{ name: 'X', type: 'bank', openingBalance: { amount: 100, currency: 'USD' } }, 422, 'UNPROCESSABLE', 'openingBalance.currency'],
    [{ name: 'X', type: 'bank', currency: 'USD' }, 400, 'VALIDATION_ERROR', '_root'],
    [{ name: 'X', type: 'bank', companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }, 400, 'VALIDATION_ERROR', '_root'],
  ];
  for (const [body, status, code, field] of cases) {
    assertRejected(await request('POST', ACCOUNTS, { token, body }), status, code, field);
  }
  assert.equal(db.getValue('SELECT count(*) FROM accounts'), 0);

  await createAccount(request, token, { name: 'Main', type: 'bank' });
  assertRejected(await request('POST', ACCOUNTS, { token, body: { name: 'MAIN', type: 'cash' } }), 409, 'CONFLICT', 'name');
});

test('an account can be renamed; its opening balance and type are locked once it has transactions', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 1000 });
  const path = `/api/v1/accounts/${account.id}`;

  const before = await request('PATCH', path, { token, body: { openingBalance: uzs(2000), type: 'cash' } });
  assert.equal(before.status, 200);
  assert.deepEqual(before.data.openingBalance, uzs(2000));
  assert.equal(before.data.type, 'cash');

  await recordTransaction(request, token, { type: 'income', amount: uzs(10), date: '2025-03-01', accountId: account.id, payee: 'x' });
  assertRejected(await request('PATCH', path, { token, body: { openingBalance: uzs(3000) } }), 422, 'UNPROCESSABLE', 'openingBalance');
  assertRejected(await request('PATCH', path, { token, body: { type: 'bank' } }), 422, 'UNPROCESSABLE', 'type');
  assert.equal((await request('PATCH', path, { token, body: { openingBalance: uzs(2000) } })).status, 200, 'unchanged value is fine');

  const renamed = await request('PATCH', path, { token, body: { name: 'Renamed' } });
  assert.equal(renamed.data.name, 'Renamed');
  assert.deepEqual(renamed.data.balance.amount, uzs(2010));

  assertRejected(await request('PATCH', path, { token, body: {} }), 400, 'VALIDATION_ERROR');
  assert.equal((await request('PATCH', '/api/v1/accounts/not-an-id', { token, body: { name: 'x' } })).status, 404);
});

test('transactions can only be recorded on cash and bank accounts', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });
  const loan = await createAccount(request, token, { name: 'Loan', type: 'liability' });

  const response = await request('POST', '/api/v1/transactions', {
    token, body: { type: 'expense', amount: uzs(10), date: '2025-03-01', accountId: loan.id, payee: 'x' },
  });
  assertRejected(response, 422, 'UNPROCESSABLE', 'accountId');
});

test('accounts, categories and rules are configured by owners; members can read them', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const owner = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });
  const member = await addMember(request, db, owner.company);
  const category = await createCategory(request, owner.token, { name: 'Rent', type: 'expense' });

  for (const [method, path, body] of [
    ['POST', ACCOUNTS, { name: 'X', type: 'cash' }],
    ['PATCH', `/api/v1/accounts/${owner.account.id}`, { name: 'X' }],
    ['POST', CATEGORIES, { name: 'X', type: 'income' }],
    ['PATCH', `/api/v1/categories/${category.id}`, { name: 'X' }],
    ['POST', RULES, { matchType: 'exact', pattern: 'x', categoryId: category.id }],
  ]) {
    assertRejected(await request(method, path, { token: member.token, body }), 403, 'FORBIDDEN');
  }
  for (const path of [ACCOUNTS, CATEGORIES, RULES]) {
    assert.equal((await request('GET', path, { token: member.token })).status, 200, path);
  }
  // Members record transactions.
  await recordTransaction(request, member.token, { type: 'expense', amount: uzs(5), date: '2025-03-01', accountId: owner.account.id, payee: 'm' });
});

// ---------------------------------------------------------------- categories

test('every company starts with a system Uncategorized category', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token, company } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });

  const list = await request('GET', CATEGORIES, { token });
  assert.equal(list.data.length, 1);
  assert.deepEqual({ ...list.data[0], id: 'x', createdAt: 'x', updatedAt: 'x' },
    { id: 'x', name: 'Uncategorized', type: null, parentId: null, isSystem: true, createdAt: 'x', updatedAt: 'x' });
  assert.equal(db.getValue('SELECT count(*) FROM categories WHERE company_id = ? AND is_system = 1', [company.id]), 1);

  const uncategorized = list.data[0];
  assertRejected(await request('PATCH', `/api/v1/categories/${uncategorized.id}`, { token, body: { name: 'Misc' } }), 422, 'UNPROCESSABLE');
  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'uncategorized', type: 'expense' } }), 409, 'CONFLICT', 'name');
  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'Sub', type: 'expense', parentId: uncategorized.id } }), 422, 'UNPROCESSABLE', 'parentId');
  assert.throws(
    () => db.run("INSERT INTO categories (id, company_id, name, type, parent_id, is_system, created_at, updated_at) VALUES ('cat_x', ?, 'Other system', NULL, NULL, 1, 'x', 'x')", [company.id]),
    /UNIQUE constraint failed/,
    'the database allows one system category per company',
  );
});

test('categories are typed and form a two-level hierarchy', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });

  const sales = await createCategory(request, token, { name: 'Sales', type: 'income' });
  const rent = await createCategory(request, token, { name: 'Rent', type: 'expense' });
  const office = await createCategory(request, token, { name: 'Office rent', type: 'expense', parentId: rent.id });
  assert.equal(office.parentId, rent.id);

  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'Deep', type: 'expense', parentId: office.id } }), 422, 'UNPROCESSABLE', 'parentId');
  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'Wrong type', type: 'income', parentId: rent.id } }), 422, 'UNPROCESSABLE', 'parentId');
  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'X', type: 'transfer' } }), 400, 'VALIDATION_ERROR', 'type');
  assertRejected(await request('POST', CATEGORIES, { token, body: { name: 'X', type: 'expense', parentId: 'cat_01M3EFNC4TMGZ36SQ8D1WYJ2TK' } }), 422, 'UNPROCESSABLE', 'parentId');

  // Move and rename.
  const moved = await request('PATCH', `/api/v1/categories/${office.id}`, { token, body: { parentId: null, name: 'Office' } });
  assert.deepEqual([moved.data.parentId, moved.data.name], [null, 'Office']);
  const back = await request('PATCH', `/api/v1/categories/${office.id}`, { token, body: { parentId: rent.id } });
  assert.equal(back.data.parentId, rent.id);
  assertRejected(await request('PATCH', `/api/v1/categories/${rent.id}`, { token, body: { parentId: sales.id } }), 422, 'UNPROCESSABLE', 'parentId');
  assertRejected(await request('PATCH', `/api/v1/categories/${rent.id}`, { token, body: { parentId: rent.id } }), 422, 'UNPROCESSABLE', 'parentId');
  assertRejected(await request('PATCH', `/api/v1/categories/${rent.id}`, { token, body: { type: 'income' } }), 400, 'VALIDATION_ERROR');

  const list = (await request('GET', CATEGORIES, { token })).data.map((category) => [category.name, category.type, category.parentId !== null]);
  assert.deepEqual(list, [['Uncategorized', null, false], ['Sales', 'income', false], ['Rent', 'expense', false], ['Office', 'expense', true]]);
});

// ---------------------------------------------------------------- category rules

test('rules are created normalised, listed, and deleted', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });
  const travel = await createCategory(request, token, { name: 'Travel', type: 'expense' });

  const created = await request('POST', RULES, { token, body: { matchType: 'contains', pattern: '  UBER   Trip ', categoryId: travel.id } });
  assert.equal(created.status, 201);
  assert.deepEqual({ ...created.data, id: 'x', createdAt: 'x', updatedAt: 'x' },
    { id: 'x', source: 'user', matchType: 'contains', pattern: 'uber trip', categoryId: travel.id, createdAt: 'x', updatedAt: 'x' });

  assertRejected(await request('POST', RULES, { token, body: { matchType: 'contains', pattern: 'uber trip', categoryId: travel.id } }), 409, 'CONFLICT');
  assertRejected(await request('POST', RULES, { token, body: { matchType: 'regex', pattern: 'x', categoryId: travel.id } }), 400, 'VALIDATION_ERROR', 'matchType');
  const uncategorized = (await request('GET', CATEGORIES, { token })).data[0];
  assertRejected(await request('POST', RULES, { token, body: { matchType: 'exact', pattern: 'x', categoryId: uncategorized.id } }), 422, 'UNPROCESSABLE', 'categoryId');

  assert.equal((await request('GET', RULES, { token })).data.length, 1);
  assert.equal((await request('DELETE', `/api/v1/category-rules/${created.data.id}`, { token })).status, 204);
  assert.equal((await request('DELETE', `/api/v1/category-rules/${created.data.id}`, { token })).status, 404);
  assert.deepEqual((await request('GET', RULES, { token })).data, []);
});

test('categorization precedence: user rules, then learned corrections, then Uncategorized', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });
  const travel = await createCategory(request, token, { name: 'Travel', type: 'expense' });
  const meals = await createCategory(request, token, { name: 'Meals', type: 'expense' });
  const fuel = await createCategory(request, token, { name: 'Fuel', type: 'expense' });
  const expense =(payee, extra = {}) => ({ type: 'expense', amount: uzs(100), date: '2025-03-01', accountId: account.id, payee, ...extra });

  // Nothing matches: Uncategorized, flagged for review.
  const unknown = await recordTransaction(request, token, expense('Uber Eats'));
  assert.deepEqual(unknown.categorization, { method: 'fallback', ruleId: null, reviewStatus: 'needs_review' });

  // The user corrects it: a learned rule for "uber eats".
  await request('PATCH', `/api/v1/transactions/${unknown.id}`, { token, body: { categoryId: meals.id } });
  const learned = await recordTransaction(request, token, expense('  UBER eats ', { date: '2025-03-02' }));
  assert.equal(learned.categoryId, meals.id);
  assert.equal(learned.categorization.method, 'learned');
  assert.equal(learned.categorization.reviewStatus, 'needs_review', 'a suggestion is still a proposal');

  // An owner rule beats the learned correction.
  const rule = (await request('POST', RULES, { token, body: { matchType: 'contains', pattern: 'uber', categoryId: travel.id } })).data;
  const ruled = await recordTransaction(request, token, expense('Uber Eats', { date: '2025-03-03' }));
  assert.deepEqual([ruled.categoryId, ruled.categorization.method, ruled.categorization.ruleId], [travel.id, 'rule', rule.id]);

  // Within user rules: exact beats contains, and the longer contains pattern wins.
  const exact = (await request('POST', RULES, { token, body: { matchType: 'exact', pattern: 'uber eats', categoryId: meals.id } })).data;
  assert.equal((await recordTransaction(request, token, expense('Uber Eats', { date: '2025-03-04' }))).categorization.ruleId, exact.id);
  await request('POST', RULES, { token, body: { matchType: 'contains', pattern: 'shell station', categoryId: fuel.id } });
  await request('POST', RULES, { token, body: { matchType: 'contains', pattern: 'shell', categoryId: meals.id } });
  assert.equal((await recordTransaction(request, token, expense('Shell Station 12'))).categoryId, fuel.id);

  // Rules only apply to their own direction; contains also searches the description.
  const income = await recordTransaction(request, token, { type: 'income', amount: uzs(1), date: '2025-03-05', accountId: account.id, payee: 'Uber' });
  assert.equal(income.categorization.method, 'fallback', 'an expense rule never categorizes income');
  const byDescription = await recordTransaction(request, token, expense(null, { description: 'Taxi via UBER app' }));
  assert.equal(byDescription.categoryId, travel.id);

  // An explicit category is the user's choice, confirmed.
  const chosen = await recordTransaction(request, token, expense('Uber', { date: '2025-03-06', categoryId: fuel.id }));
  assert.deepEqual(chosen.categorization, { method: 'user', ruleId: null, reviewStatus: 'confirmed' });
});

test('the suggestion endpoint discloses its method and never writes', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });
  const travel = await createCategory(request, token, { name: 'Travel', type: 'expense' });
  await request('POST', RULES, { token, body: { matchType: 'contains', pattern: 'uber', categoryId: travel.id } });

  const response = await request('GET', '/api/v1/transactions/categories-suggestion?type=expense&payee=UBER%20BV', { token });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.category, { id: travel.id, name: 'Travel', type: 'expense' });
  assert.equal(response.data.method, 'rule');
  assert.equal(response.meta.capability.method, 'rule');
  assert.equal(response.meta.capability.confidence, null, 'no invented confidence for a deterministic rule');
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0);

  const fallback = await request('GET', '/api/v1/transactions/categories-suggestion?type=income&description=random', { token });
  assert.equal(fallback.data.method, 'fallback');
  assertRejected(await request('GET', '/api/v1/transactions/categories-suggestion?type=expense', { token }), 400, 'VALIDATION_ERROR');
});
