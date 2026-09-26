/**
 * Phase 3 transactions: CRUD, validation, filters, pagination, duplicates,
 * relations and bulk categorization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import { createAccount, createCategory, ledgerOwner, recordTransaction, uzs } from './helpers/fixtures.js';

const TX = '/api/v1/transactions';

function assertRejected(response, status, code, field) {
  assert.equal(response.status, status, response.raw);
  assertErrorEnvelope(response, code);
  if (field) assert.ok(response.error.details?.some((detail) => detail.field === field), `${field}: ${response.raw}`);
}

async function setup() {
  const env = await createTestApp();
  const owner = await ledgerOwner(env.request, { email: 'o@a.example', companyName: 'A', opening: 1000 });
  const base = (extra = {}) => ({ type: 'expense', amount: uzs(500), date: '2025-03-10', accountId: owner.account.id, payee: 'Supplier', ...extra });
  return { ...env, ...owner, base };
}

test('create and read a transaction', async (t) => {
  const { request, token, account, base, close } = await setup();
  t.after(close);

  const response = await request('POST', TX, {
    token,
    body: base({ description: 'Paper', paymentMethod: 'card', notes: 'Quarterly order' }),
  });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  assert.equal(response.headers.get('location'), `${TX}/${response.data.id}`);
  assert.equal(response.meta, undefined, 'no duplicate warning');

  const created = response.data;
  assert.match(created.id, /^txn_/);
  assert.deepEqual(
    { ...created, id: 'x', categoryId: 'x', createdAt: 'x', updatedAt: 'x' },
    {
      id: 'x', type: 'expense', amount: uzs(500), date: '2025-03-10', accountId: account.id, categoryId: 'x',
      description: 'Paper', payee: 'Supplier', paymentMethod: 'card', notes: 'Quarterly order', source: 'manual',
      // invoiceId was added in Phase 4 (the invoice a payment transaction belongs to).
      categorization: { method: 'fallback', ruleId: null, reviewStatus: 'needs_review' }, invoiceId: null, createdAt: 'x', updatedAt: 'x',
    },
  );

  const read = await request('GET', `${TX}/${created.id}`, { token });
  assert.deepEqual(read.data, created);
});

test('transaction input is validated', async (t) => {
  const { request, db, token, base, close } = await setup();
  t.after(close);
  const income = await createCategory(request, token, { name: 'Sales', type: 'income' });

  const cases = [
    [base({ amount: uzs(0) }), 400, 'VALIDATION_ERROR', 'amount.amount'],
    [base({ amount: uzs(-5) }), 400, 'VALIDATION_ERROR', 'amount.amount'],
    [base({ amount: uzs(10.5) }), 400, 'VALIDATION_ERROR', 'amount.amount'],
    [base({ amount: { amount: '500', currency: 'UZS' } }), 400, 'VALIDATION_ERROR', 'amount.amount'],
    [base({ amount: 500 }), 400, 'VALIDATION_ERROR', 'amount'],
    [base({ amount: { amount: 500, currency: 'USD' } }), 422, 'UNPROCESSABLE', 'amount.currency'],
    [base({ type: 'transfer' }), 400, 'VALIDATION_ERROR', 'type'],
    [base({ type: undefined }), 400, 'VALIDATION_ERROR', 'type'],
    [base({ date: '2025-02-30' }), 400, 'VALIDATION_ERROR', 'date'],
    [base({ date: '10/03/2025' }), 400, 'VALIDATION_ERROR', 'date'],
    [base({ accountId: undefined }), 400, 'VALIDATION_ERROR', 'accountId'],
    [base({ accountId: 'acc_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 422, 'UNPROCESSABLE', 'accountId'],
    [base({ categoryId: 'cat_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 422, 'UNPROCESSABLE', 'categoryId'],
    [base({ categoryId: income.id }), 422, 'UNPROCESSABLE', 'categoryId'],
    [base({ payee: '' }), 400, 'VALIDATION_ERROR', 'payee'],
    [base({ payee: 'x'.repeat(201) }), 400, 'VALIDATION_ERROR', 'payee'],
    [base({ notes: 'x'.repeat(2001) }), 400, 'VALIDATION_ERROR', 'notes'],
    [base({ companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 400, 'VALIDATION_ERROR', '_root'],
    [base({ source: 'ai' }), 400, 'VALIDATION_ERROR', '_root'],
    [base({ invoiceId: 'inv_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 400, 'VALIDATION_ERROR', '_root'],
  ];
  for (const [body, status, code, field] of cases) {
    assertRejected(await request('POST', TX, { token, body }), status, code, field);
  }
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 0);
});

test('update edits fields; changing the category is a confirmed correction', async (t) => {
  const { request, token, base, close } = await setup();
  t.after(close);
  const office = await createCategory(request, token, { name: 'Office', type: 'expense' });
  const created = await recordTransaction(request, token, base());

  const updated = await request('PATCH', `${TX}/${created.id}`, {
    token, body: { categoryId: office.id, description: 'Toner', payee: null, date: '2025-03-11', amount: uzs(650) },
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(
    [updated.data.categoryId, updated.data.description, updated.data.payee, updated.data.date, updated.data.amount],
    [office.id, 'Toner', null, '2025-03-11', uzs(650)],
  );
  assert.deepEqual(updated.data.categorization, { method: 'user', ruleId: null, reviewStatus: 'confirmed' });
  assert.ok(updated.data.updatedAt >= created.updatedAt);

  const confirm = await recordTransaction(request, token, base({ payee: 'Other', date: '2025-03-12' }));
  const accepted = await request('PATCH', `${TX}/${confirm.id}`, { token, body: { reviewStatus: 'confirmed' } });
  assert.deepEqual(accepted.data.categorization, { method: 'fallback', ruleId: null, reviewStatus: 'confirmed' }, 'accepting keeps the method');

  assertRejected(await request('PATCH', `${TX}/${created.id}`, { token, body: {} }), 400, 'VALIDATION_ERROR');
  assertRejected(await request('PATCH', `${TX}/${created.id}`, { token, body: { type: 'income' } }), 422, 'UNPROCESSABLE', 'categoryId');
  assertRejected(await request('PATCH', `${TX}/${created.id}`, { token, body: { reviewStatus: 'needs_review' } }), 400, 'VALIDATION_ERROR');
  assertRejected(await request('PATCH', `${TX}/${created.id}`, { token, body: { amount: uzs(0) } }), 400, 'VALIDATION_ERROR');
});

test('delete removes the transaction; unknown ids are 404', async (t) => {
  const { request, token, base, close } = await setup();
  t.after(close);
  const created = await recordTransaction(request, token, base());

  const deleted = await request('DELETE', `${TX}/${created.id}`, { token });
  assert.equal(deleted.status, 204);
  assert.equal(deleted.raw, '');
  for (const [method, path] of [['GET', `${TX}/${created.id}`], ['DELETE', `${TX}/${created.id}`], ['PATCH', `${TX}/${created.id}`], ['GET', `${TX}/garbage`]]) {
    const response = await request(method, path, { token, body: method === 'PATCH' ? { notes: 'x' } : undefined });
    assertRejected(response, 404, 'NOT_FOUND');
  }
});

test('the list is paginated with a stable order and complete metadata', async (t) => {
  const { request, token, base, close } = await setup();
  t.after(close);
  for (let day = 1; day <= 5; day += 1) {
    await recordTransaction(request, token, base({ date: `2025-03-0${day}`, payee: `P${day}` }));
    await recordTransaction(request, token, base({ date: `2025-03-0${day}`, payee: `Q${day}` }));
  }

  const first = await request('GET', `${TX}?limit=4`, { token });
  assert.deepEqual(first.meta, { page: 1, limit: 4, total: 10, totalPages: 3, hasNext: true, hasPrevious: false, sort: 'date:desc' });
  const pages = [first.data];
  for (const page of [2, 3]) pages.push((await request('GET', `${TX}?limit=4&page=${page}`, { token })).data);
  const ids = pages.flat().map((transaction) => transaction.id);
  assert.equal(ids.length, 10);
  assert.equal(new Set(ids).size, 10, 'no row repeated or skipped');
  assert.deepEqual(pages.flat().map((transaction) => transaction.date), [...pages.flat().map((transaction) => transaction.date)].sort().reverse());

  const ascending = await request('GET', `${TX}?sort=date:asc&limit=100`, { token });
  assert.equal(ascending.data[0].date, '2025-03-01');
  assert.equal(ascending.meta.sort, 'date:asc');

  const beyond = await request('GET', `${TX}?page=9`, { token });
  assert.deepEqual([beyond.data, beyond.meta.hasNext], [[], false]);

  for (const bad of ['limit=0', 'limit=101', 'page=0', 'sort=payee', 'sort=date:sideways', 'from=2025-13-01', 'type=transfer', 'from=2025-03-05&to=2025-03-05']) {
    assertRejected(await request('GET', `${TX}?${bad}`, { token }), 400, 'VALIDATION_ERROR');
  }
});

test('filters: date range (end-exclusive), type, account, category, review status and search', async (t) => {
  const { request, token, account, base, close } = await setup();
  t.after(close);
  const till = await createAccount(request, token, { name: 'Till', type: 'cash' });
  const office = await createCategory(request, token, { name: 'Office', type: 'expense' });

  await recordTransaction(request, token, base({ date: '2025-02-28', payee: 'Feb' }));
  await recordTransaction(request, token, base({ date: '2025-03-01', payee: 'Mar first', categoryId: office.id }));
  await recordTransaction(request, token, base({ date: '2025-03-31', payee: '50% off store', accountId: till.id }));
  await recordTransaction(request, token, base({ date: '2025-04-01', payee: 'Apr', type: 'income' }));

  const payees = async (query) => (await request('GET', `${TX}?sort=date:asc&${query}`, { token })).data.map((row) => row.payee);
  assert.deepEqual(await payees('from=2025-03-01&to=2025-04-01'), ['Mar first', '50% off store']);
  assert.deepEqual(await payees('period=custom&periodStart=2025-03-01&periodEnd=2025-04-01'), ['Mar first', '50% off store']);
  assert.deepEqual(await payees('type=income'), ['Apr']);
  assert.deepEqual(await payees(`accountId=${till.id}`), ['50% off store']);
  assert.deepEqual(await payees(`accountId=${account.id}&type=expense`), ['Feb', 'Mar first']);
  assert.deepEqual(await payees(`categoryId=${office.id}`), ['Mar first']);
  assert.deepEqual(await payees(`categoryId=${office.id}&includeUncategorized=true`), ['Feb', 'Mar first', '50% off store', 'Apr']);
  assert.deepEqual(await payees('reviewStatus=confirmed'), ['Mar first']);
  assert.deepEqual(await payees('q=50%25'), ['50% off store'], 'a literal % is not a wildcard');
  assert.deepEqual(await payees('q=STORE'), ['50% off store'], 'search is case-insensitive');
  assert.deepEqual(await payees('q=_'), [], 'a literal _ is not a wildcard');
  assert.deepEqual(await payees('unknownParam=1&from=2025-04-01'), ['Apr'], 'unknown parameters are ignored');
});

test('a possible duplicate is refused with an explanation until the user confirms it', async (t) => {
  const { request, db, token, base, close } = await setup();
  t.after(close);
  const original = await recordTransaction(request, token, base({ payee: 'Acme Supplies' }));

  const duplicate = await request('POST', TX, { token, body: base({ payee: '  ACME   supplies ' }) });
  assertRejected(duplicate, 409, 'CONFLICT');
  assert.match(duplicate.error.message, /duplicate/);
  assert.deepEqual(duplicate.error.details, [{ field: 'transaction', transactionId: original.id, issue: 'same type, amount, date and payee' }]);
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 1, 'nothing recorded, nothing merged');

  // Differences in any of type, amount, date or payee mean no warning.
  for (const change of [{ amount: uzs(501) }, { date: '2025-03-11' }, { type: 'income' }, { payee: 'Acme Supplies Ltd' }]) {
    assert.equal((await request('POST', TX, { token, body: base({ payee: 'Acme Supplies', ...change }) })).status, 201, JSON.stringify(change));
  }

  const confirmed = await request('POST', TX, { token, body: base({ payee: 'Acme Supplies', allowDuplicate: true }) });
  assert.equal(confirmed.status, 201);
  assert.deepEqual(confirmed.meta, { possibleDuplicateOf: [original.id] });

  const groups = await request('GET', `${TX}/duplicates`, { token });
  assert.equal(groups.status, 200);
  assert.equal(groups.data.length, 1);
  assert.deepEqual(groups.data[0].transactions.map((row) => row.id), [original.id, confirmed.data.id]);
  assert.equal(groups.meta.truncated, false);
  assert.equal(db.getValue('SELECT count(*) FROM transactions'), 6, 'both kept; the user decides');
});

test('bulk categorization reports a result per transaction', async (t) => {
  const { request, db, token, base, close } = await setup();
  t.after(close);
  const office = await createCategory(request, token, { name: 'Office', type: 'expense' });
  const a = await recordTransaction(request, token, base({ payee: 'A' }));
  const b = await recordTransaction(request, token, base({ payee: 'B' }));
  const income = await recordTransaction(request, token, base({ payee: 'C', type: 'income' }));
  const missing = 'txn_01M3EFNC4TMGZ36SQ8D1WYJ2TK';

  const response = await request('POST', `${TX}/bulk-categorize`, {
    token, body: { transactionIds: [a.id, b.id, income.id, missing, a.id], categoryId: office.id },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.results, [
    { transactionId: a.id, status: 'updated' },
    { transactionId: b.id, status: 'updated' },
    { transactionId: income.id, status: 'type_mismatch' },
    { transactionId: missing, status: 'not_found' },
  ]);
  assert.equal(response.data.updated, 2);
  assert.equal(db.getValue('SELECT count(*) FROM transactions WHERE category_id = ? AND review_status = ?', [office.id, 'confirmed']), 2);
  assert.equal(db.getValue("SELECT count(*) FROM category_rules WHERE source = 'learned'"), 2, 'corrections are learned');

  assertRejected(await request('POST', `${TX}/bulk-categorize`, { token, body: { transactionIds: [], categoryId: office.id } }), 400, 'VALIDATION_ERROR');
  const tooMany = Array.from({ length: 101 }, () => a.id);
  assertRejected(await request('POST', `${TX}/bulk-categorize`, { token, body: { transactionIds: tooMany, categoryId: office.id } }), 400, 'VALIDATION_ERROR');
});

test('the database itself refuses a transaction pointing at another company\'s account or category', async (t) => {
  const { request, db, company, close } = await setup();
  t.after(close);
  const other = await ledgerOwner(request, { email: 'b@b.example', companyName: 'B' });
  const otherCategory = db.getValue('SELECT id FROM categories WHERE company_id = ?', [other.company.id]);
  const ownCategory = db.getValue('SELECT id FROM categories WHERE company_id = ?', [company.id]);
  const insert = (accountId, categoryId) => db.run(
    `INSERT INTO transactions (id, company_id, type, amount_minor, currency, date, account_id, category_id,
       category_source, review_status, created_at, updated_at)
     VALUES (?, ?, 'expense', 1, 'UZS', '2025-03-01', ?, ?, 'user', 'confirmed', 'x', 'x')`,
    [`txn_${Math.random()}`, company.id, accountId, categoryId],
  );
  assert.throws(() => insert(other.account.id, ownCategory), /FOREIGN KEY constraint failed/);
  const ownAccount = db.getValue('SELECT id FROM accounts WHERE company_id = ?', [company.id]);
  assert.throws(() => insert(ownAccount, otherCategory), /FOREIGN KEY constraint failed/);
});
