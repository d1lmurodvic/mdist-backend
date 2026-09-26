/**
 * The financial calculation engine, tested with known inputs and known
 * expected outputs (DEVELOPMENT_RULES.md §9.2), through the real API.
 *
 * Periods are explicit (period=custom) so results never depend on today.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from './helpers/testApp.js';
import { createAccount, createCategory, ledgerOwner, ownerWithCompany, recordTransaction, uzs } from './helpers/fixtures.js';
import { changeBasisPoints } from '../src/lib/money.js';

const MARCH = 'period=custom&periodStart=2025-03-01&periodEnd=2025-04-01';

async function overview(request, token, query = MARCH) {
  const response = await request('GET', `/api/v1/financials/overview?${query}`, { token });
  assert.equal(response.status, 200, response.raw);
  return response.data;
}

async function cashFlow(request, token, query = MARCH) {
  const response = await request('GET', `/api/v1/financials/cash-flow?${query}`, { token });
  assert.equal(response.status, 200, response.raw);
  return response.data;
}

async function balanceOf(request, token, accountId) {
  const response = await request('GET', '/api/v1/companies/current/accounts', { token });
  return response.data.find((account) => account.id === accountId).balance.amount.amount;
}

const tx = (account, type, amount, date, extra = {}) => ({ type, amount: uzs(amount), date, accountId: account.id, ...extra });

test('opening 100,000 + income 50,000 − expense 20,000 = 130,000; net result 30,000', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 100000 });

  await recordTransaction(request, token, tx(account, 'income', 50000, '2025-03-10', { payee: 'Client' }));
  await recordTransaction(request, token, tx(account, 'expense', 20000, '2025-03-12', { payee: 'Landlord' }));

  assert.equal(await balanceOf(request, token, account.id), 130000);
  const result = await overview(request, token);
  assert.deepEqual(result.income, uzs(50000));
  assert.deepEqual(result.expenses, uzs(20000));
  assert.deepEqual(result.netResult, uzs(30000));
  assert.deepEqual(result.cash, { opening: uzs(100000), closing: uzs(130000), netMovement: uzs(30000) });
  assert.equal(result.transactionCount, 2);

  const flow = await cashFlow(request, token);
  assert.deepEqual([flow.openingCash, flow.cashIn, flow.cashOut, flow.netMovement, flow.closingCash],
    [uzs(100000), uzs(50000), uzs(20000), uzs(30000), uzs(130000)]);
});

test('zero transactions and no accounts: every figure is an explicit zero', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await ownerWithCompany(request, { email: 'o@a.example', companyName: 'A' });

  const result = await overview(request, token);
  for (const figure of [result.income, result.expenses, result.netResult, result.cash.opening, result.cash.closing]) {
    assert.deepEqual(figure, uzs(0));
  }
  assert.equal(result.transactionCount, 0);
  assert.equal(result.change.income.basisPoints, null, 'no base to compare with');
  assert.deepEqual((await cashFlow(request, token)).series, []);
});

test('an opening balance alone is cash, not income', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 75000 });

  assert.equal(await balanceOf(request, token, account.id), 75000);
  const result = await overview(request, token);
  assert.deepEqual(result.income, uzs(0), 'opening balances are not transactions');
  assert.deepEqual(result.cash, { opening: uzs(75000), closing: uzs(75000), netMovement: uzs(0) });
});

test('income only and expense only', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const a = await ledgerOwner(request, { email: 'a@a.example', companyName: 'A' });
  const b = await ledgerOwner(request, { email: 'b@b.example', companyName: 'B', opening: 10000 });

  await recordTransaction(request, a.token, tx(a.account, 'income', 999, '2025-03-01', { payee: 'X' }));
  const incomeOnly = await overview(request, a.token);
  assert.deepEqual([incomeOnly.income, incomeOnly.expenses, incomeOnly.netResult], [uzs(999), uzs(0), uzs(999)]);

  await recordTransaction(request, b.token, tx(b.account, 'expense', 25000, '2025-03-31', { payee: 'Y' }));
  const expenseOnly = await overview(request, b.token);
  assert.deepEqual([expenseOnly.income, expenseOnly.expenses, expenseOnly.netResult], [uzs(0), uzs(25000), uzs(-25000)]);
  assert.deepEqual(expenseOnly.cash.closing, uzs(-15000), 'a loss can take cash below zero, shown as a negative amount');
});

test('multiple accounts: each balance and the cash total agree; liabilities are not cash', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account: bank } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 100000 });
  const till = await createAccount(request, token, { name: 'Till', type: 'cash', openingBalance: uzs(5000) });
  const loan = await createAccount(request, token, { name: 'Bank loan', type: 'liability', openingBalance: uzs(40000) });
  const capital = await createAccount(request, token, { name: 'Owner capital', type: 'equity', openingBalance: uzs(65000) });

  await recordTransaction(request, token, tx(bank, 'income', 30000, '2025-03-05', { payee: 'Client' }));
  await recordTransaction(request, token, tx(till, 'income', 2000, '2025-03-05', { payee: 'Walk-in' }));
  await recordTransaction(request, token, tx(till, 'expense', 1500, '2025-03-06', { payee: 'Shop' }));

  assert.equal(await balanceOf(request, token, bank.id), 130000);
  assert.equal(await balanceOf(request, token, till.id), 5500);
  assert.equal(await balanceOf(request, token, loan.id), 40000);
  assert.equal(await balanceOf(request, token, capital.id), 65000);

  const result = await overview(request, token);
  assert.deepEqual(result.cash.opening, uzs(105000), 'cash = bank + till only');
  assert.deepEqual(result.cash.closing, uzs(135500));
  assert.deepEqual(result.netResult, uzs(30500));
});

test('multiple categories all count toward the same totals, Uncategorized included', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });
  const rent = await createCategory(request, token, { name: 'Rent', type: 'expense' });
  const salaries = await createCategory(request, token, { name: 'Salaries', type: 'expense' });
  const office = await createCategory(request, token, { name: 'Office rent', type: 'expense', parentId: rent.id });

  await recordTransaction(request, token, tx(account, 'expense', 1000, '2025-03-02', { payee: 'A', categoryId: rent.id }));
  await recordTransaction(request, token, tx(account, 'expense', 2000, '2025-03-02', { payee: 'B', categoryId: salaries.id }));
  await recordTransaction(request, token, tx(account, 'expense', 4000, '2025-03-02', { payee: 'C', categoryId: office.id }));
  await recordTransaction(request, token, tx(account, 'expense', 8000, '2025-03-02', { payee: 'D' })); // Uncategorized

  assert.deepEqual((await overview(request, token)).expenses, uzs(15000), 'nothing is dropped');
});

test('periods are start-inclusive and end-exclusive', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });

  await recordTransaction(request, token, tx(account, 'income', 1, '2025-02-28', { payee: 'before' }));
  await recordTransaction(request, token, tx(account, 'income', 10, '2025-03-01', { payee: 'first day' }));
  await recordTransaction(request, token, tx(account, 'income', 100, '2025-03-31', { payee: 'last day' }));
  await recordTransaction(request, token, tx(account, 'income', 1000, '2025-04-01', { payee: 'next period' }));

  const march = await overview(request, token);
  assert.deepEqual(march.income, uzs(110), '1 March and 31 March in; 28 Feb and 1 April out');
  assert.deepEqual(march.cash.opening, uzs(1), 'opening cash = everything before 1 March');
  assert.deepEqual(march.cash.closing, uzs(111), 'closing cash = everything before 1 April');

  const oneDay = await overview(request, token, 'period=custom&periodStart=2025-03-31&periodEnd=2025-04-01');
  assert.deepEqual(oneDay.income, uzs(100));
});

test('same-day transactions all count, and the daily series sums them', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 1000 });

  for (const [type, amount, payee] of [['income', 300, 'a'], ['income', 200, 'b'], ['expense', 50, 'c'], ['expense', 25, 'd']]) {
    await recordTransaction(request, token, tx(account, type, amount, '2025-03-15', { payee }));
  }
  const flow = await cashFlow(request, token);
  assert.equal(flow.series.length, 1);
  assert.deepEqual(flow.series[0], {
    start: '2025-03-15', cashIn: uzs(500), cashOut: uzs(75), netMovement: uzs(425), closingBalance: uzs(1425),
  });
});

test('the cash-flow series is a running balance that ties to opening and closing cash', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 500 });

  await recordTransaction(request, token, tx(account, 'income', 100, '2025-01-20', { payee: 'january' }));
  await recordTransaction(request, token, tx(account, 'expense', 40, '2025-03-03', { payee: 'x' }));
  await recordTransaction(request, token, tx(account, 'income', 70, '2025-03-09', { payee: 'y' }));
  await recordTransaction(request, token, tx(account, 'expense', 900, '2025-03-20', { payee: 'z' }));

  const flow = await cashFlow(request, token);
  assert.deepEqual(flow.openingCash, uzs(600), 'opening + January income');
  assert.deepEqual(flow.series.map((bucket) => [bucket.start, bucket.closingBalance.amount]),
    [['2025-03-03', 560], ['2025-03-09', 630], ['2025-03-20', -270]]);
  assert.equal(flow.closingCash.amount, flow.openingCash.amount + flow.cashIn.amount - flow.cashOut.amount);
  assert.deepEqual(flow.closingCash, flow.series.at(-1).closingBalance);

  const byMonth = await cashFlow(request, token, 'period=custom&periodStart=2025-01-01&periodEnd=2025-04-01&granularity=month');
  assert.deepEqual(byMonth.series.map((bucket) => [bucket.start, bucket.netMovement.amount, bucket.closingBalance.amount]),
    [['2025-01-01', 100, 600], ['2025-03-01', -870, -270]]);
});

test('previous period is the preceding calendar month, with exact change figures', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });

  await recordTransaction(request, token, tx(account, 'income', 10000, '2025-02-01', { payee: 'feb first' }));
  await recordTransaction(request, token, tx(account, 'expense', 3000, '2025-02-28', { payee: 'feb last' }));
  await recordTransaction(request, token, tx(account, 'income', 5000, '2025-01-31', { payee: 'january (out)' }));
  await recordTransaction(request, token, tx(account, 'income', 11800, '2025-03-15', { payee: 'march' }));
  await recordTransaction(request, token, tx(account, 'expense', 2000, '2025-03-16', { payee: 'march' }));

  const result = await overview(request, token);
  assert.deepEqual(result.previousPeriod, { start: '2025-02-01', end: '2025-03-01', basis: 'calendar' });
  assert.deepEqual(result.previous.income, uzs(10000));
  assert.deepEqual(result.previous.expenses, uzs(3000));
  assert.deepEqual(result.change.income, { amount: uzs(1800), basisPoints: 1800 }, '+18.00%');
  assert.deepEqual(result.change.expenses, { amount: uzs(-1000), basisPoints: -3333 }, '−33.33%');
  assert.deepEqual(result.change.netResult, { amount: uzs(2800), basisPoints: 4000 }, '7000 -> 9800 = +40%');
});

test('an updated transaction is reflected in every figure immediately', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 1000 });
  const second = await createAccount(request, token, { name: 'Second', type: 'cash' });
  const txn = await recordTransaction(request, token, tx(account, 'expense', 400, '2025-03-10', { payee: 'x' }));

  await request('PATCH', `/api/v1/transactions/${txn.id}`, { token, body: { amount: uzs(250) } });
  assert.deepEqual((await overview(request, token)).expenses, uzs(250));
  assert.equal(await balanceOf(request, token, account.id), 750);

  await request('PATCH', `/api/v1/transactions/${txn.id}`, { token, body: { type: 'income' } });
  assert.deepEqual((await overview(request, token)).netResult, uzs(250), 'direction change flips the sign');
  assert.equal(await balanceOf(request, token, account.id), 1250);

  await request('PATCH', `/api/v1/transactions/${txn.id}`, { token, body: { accountId: second.id } });
  assert.equal(await balanceOf(request, token, account.id), 1000);
  assert.equal(await balanceOf(request, token, second.id), 250);

  await request('PATCH', `/api/v1/transactions/${txn.id}`, { token, body: { date: '2025-04-02' } });
  assert.deepEqual((await overview(request, token)).income, uzs(0), 'moved out of March');
});

test('a deleted transaction disappears from every figure', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token, account } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A', opening: 1000 });
  await recordTransaction(request, token, tx(account, 'income', 300, '2025-03-10', { payee: 'kept' }));
  const removed = await recordTransaction(request, token, tx(account, 'income', 700, '2025-03-11', { payee: 'removed' }));

  assert.equal((await request('DELETE', `/api/v1/transactions/${removed.id}`, { token })).status, 204);
  const result = await overview(request, token);
  assert.deepEqual(result.income, uzs(300));
  assert.equal(result.transactionCount, 1);
  assert.equal(await balanceOf(request, token, account.id), 1300);
});

test('large amounts stay exact: totals beyond 2^53 are summed in BigInt, never rounded', async (t) => {
  const { request, app, close } = await createTestApp();
  t.after(close);
  const { token, account, company } = await ledgerOwner(request, { email: 'o@a.example', companyName: 'A' });
  const max = Number.MAX_SAFE_INTEGER;

  await recordTransaction(request, token, tx(account, 'income', max, '2025-03-01', { payee: 'huge 1' }));
  await recordTransaction(request, token, tx(account, 'income', max, '2025-03-02', { payee: 'huge 2' }));
  await recordTransaction(request, token, tx(account, 'expense', max, '2025-03-03', { payee: 'huge 3' }));

  // The engine keeps the exact BigInt intermediate (2 * max) even though a
  // single JSON number could not carry it...
  const totals = app.services.engine.periodTotals(company.id, { start: '2025-03-01', end: '2025-04-01' });
  assert.equal(totals.income, 2n * BigInt(max));
  assert.equal(totals.net, BigInt(max));
  // ...and the API refuses to serialize a figure it cannot represent exactly
  // rather than rounding it: a visible error, not a wrong number.
  const response = await request('GET', `/api/v1/financials/overview?${MARCH}`, { token });
  assert.equal(response.status, 500);
  assert.equal(response.error.code, 'INTERNAL_ERROR');
});

test('changeBasisPoints rounds half away from zero in exact arithmetic', () => {
  assert.equal(changeBasisPoints(11800n, 10000n), 1800);
  assert.equal(changeBasisPoints(2000n, 3000n), -3333);
  assert.equal(changeBasisPoints(1n, 3n), -6667);
  assert.equal(changeBasisPoints(3n, 2n), 5000);
  assert.equal(changeBasisPoints(-50n, -100n), 5000, 'a smaller loss is an improvement');
  assert.equal(changeBasisPoints(100n, 0n), null);
  assert.equal(changeBasisPoints(0n, 0n), null);
  assert.equal(changeBasisPoints(20001n, 10000n), 10001);
  assert.equal(changeBasisPoints(100005n, 100000n), 1, '0.5 bp rounds up');
});
