/**
 * Statements and breakdowns (PRODUCT_REQUIREMENTS.md #6, #12–#16): exact
 * figures on a known ledger, and agreement with the Phase 3 views — one
 * engine, one set of numbers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import {
  createAccount, createCategory, createContact, createInvoice, ledgerOwner, recordTransaction, sendInvoice, uzs,
} from './helpers/fixtures.js';

const MARCH = 'period=custom&periodStart=2025-03-01&periodEnd=2025-04-01';

async function ledger() {
  const app = await createTestApp();
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A', opening: 100000 });
  const { request, token } = { request: app.request, token: owner.token };
  const sales = await createCategory(request, token, { name: 'Sales', type: 'income' });
  const rent = await createCategory(request, token, { name: 'Rent', type: 'expense' });
  const office = await createCategory(request, token, { name: 'Office', type: 'expense' });
  const paper = await createCategory(request, token, { name: 'Paper', type: 'expense', parentId: office.id });
  const tx = (body) => recordTransaction(request, token, { accountId: owner.account.id, ...body });
  // February (previous period)
  await tx({ type: 'income', amount: uzs(40000), date: '2025-02-10', categoryId: sales.id, payee: 'Client' });
  await tx({ type: 'expense', amount: uzs(10000), date: '2025-02-01', categoryId: rent.id, payee: 'Landlord' });
  // March
  await tx({ type: 'income', amount: uzs(50000), date: '2025-03-05', categoryId: sales.id, payee: 'Client' });
  await tx({ type: 'income', amount: uzs(7000), date: '2025-03-06', payee: 'Unknown payer' });
  await tx({ type: 'expense', amount: uzs(12000), date: '2025-03-01', categoryId: rent.id, payee: 'Landlord' });
  await tx({ type: 'expense', amount: uzs(3000), date: '2025-03-10', categoryId: office.id, payee: 'Shop' });
  await tx({ type: 'expense', amount: uzs(2000), date: '2025-03-11', categoryId: paper.id, payee: 'Paper Co' });
  await tx({ type: 'expense', amount: uzs(500), date: '2025-03-31', payee: 'Mystery' });
  // April (outside the period)
  await tx({ type: 'expense', amount: uzs(99999), date: '2025-04-01', categoryId: rent.id, payee: 'Landlord' });
  return { ...app, ...owner, categories: { sales, rent, office, paper } };
}

const get = async (app, path) => {
  const response = await app.request('GET', path, { token: app.token });
  assert.equal(response.status, 200, response.raw);
  return response;
};

test('profit and loss: exact totals, nested categories, Uncategorized, previous period and drill-down', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const { data, meta } = await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`);
  const overview = (await get(app, `/api/v1/financials/overview?${MARCH}`)).data;

  assert.deepEqual(data.revenue.amount, uzs(57000));
  assert.deepEqual(data.expenses.amount, uzs(17500));
  assert.deepEqual(data.netResult.amount, uzs(39500));
  assert.equal(data.netResult.result, 'profit');
  assert.deepEqual([data.revenue.amount, data.expenses.amount, data.netResult.amount], [overview.income, overview.expenses, overview.netResult], 'same engine as the overview');
  assert.deepEqual(data.revenue.previous, uzs(40000));
  assert.deepEqual(data.expenses.change, { amount: uzs(7500), basisPoints: 7500 });
  assert.equal(data.netMarginBasisPoints, 6930);

  const lines = Object.fromEntries(data.expenses.lines.map((line) => [line.category.name, line]));
  assert.deepEqual(lines.Rent.total, uzs(12000));
  assert.deepEqual(lines.Office.total, uzs(5000), 'a parent includes its subcategories');
  assert.deepEqual(lines.Office.ownTotal, uzs(3000));
  assert.deepEqual(lines.Office.children.map((child) => [child.category.name, child.total.amount]), [['Paper', 2000]]);
  assert.deepEqual(lines.Uncategorized.total, uzs(500), 'Uncategorized is its own line, not dropped');
  assert.equal(lines.Uncategorized.category.isSystem, true);
  const sum = data.expenses.lines.reduce((total, line) => total + line.total.amount, 0);
  assert.equal(sum, data.expenses.amount.amount, 'lines add up to the total');
  assert.deepEqual(lines.Rent.drilldown, { path: '/api/v1/transactions', query: { type: 'expense', categoryId: app.categories.rent.id, from: '2025-03-01', to: '2025-04-01' } });
  assert.ok(meta.notes.some((note) => /not certified statutory/.test(note)));
});

test('a loss is shown as a negative net result', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A' });
  await recordTransaction(app.request, owner.token, { type: 'expense', amount: uzs(700), date: '2025-03-02', accountId: owner.account.id, payee: 'X' });
  const { data } = await get({ ...app, token: owner.token }, `/api/v1/reports/profit-and-loss?${MARCH}`);
  assert.deepEqual(data.netResult.amount, uzs(-700));
  assert.equal(data.netResult.result, 'loss');
  assert.equal(data.netMarginBasisPoints, null, 'no margin without income');
});

test('expense report: every expense once, shares against the period total, no invented targets', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const report = (await get(app, `/api/v1/financials/expense-report?${MARCH}`)).data;
  const statement = (await get(app, `/api/v1/reports/expense-report?${MARCH}`)).data;
  assert.deepEqual(statement, report, 'one calculation, two presentations');
  assert.deepEqual(report.total.amount, uzs(17500));
  assert.equal(report.transactionCount, 4);
  assert.equal(report.targets, null);
  const shares = Object.fromEntries(report.groups.map((group) => [group.category.name, group.shareBasisPoints]));
  assert.deepEqual(shares, { Rent: 6857, Office: 2857, Uncategorized: 286 });
  assert.equal(report.groups.reduce((total, group) => total + group.transactionCount, 0), 4);
});

test('revenue vs expenses: totals, week buckets inside the period, category filter', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const { data } = await get(app, `/api/v1/financials/revenue-vs-expenses?${MARCH}&granularity=week`);
  assert.deepEqual([data.income.amount, data.expenses.amount, data.difference.amount], [uzs(57000), uzs(17500), uzs(39500)]);
  assert.equal(data.series[0].start, '2025-03-01', 'the first week is reported from the period start');
  assert.deepEqual(data.series.map((bucket) => bucket.start), ['2025-03-01', '2025-03-03', '2025-03-10', '2025-03-31']);
  assert.equal(data.series.reduce((total, bucket) => total + bucket.expenses.amount, 0), 17500);

  const filtered = (await get(app, `/api/v1/financials/revenue-vs-expenses?${MARCH}&categoryId=${app.categories.rent.id}`)).data;
  assert.deepEqual([filtered.income.amount, filtered.expenses.amount], [uzs(0), uzs(12000)]);
  assert.deepEqual(filtered.filters.categoryId, [app.categories.rent.id]);

  const bad = await app.request('GET', `/api/v1/financials/revenue-vs-expenses?${MARCH}&granularity=year`, { token: app.token });
  assertErrorEnvelope(bad, 'VALIDATION_ERROR');
  const unknown = await app.request('GET', `/api/v1/financials/revenue-vs-expenses?${MARCH}&categoryId=cat_01M3EFNC4TMGZ36SQ8D1WYJ2TK`, { token: app.token });
  assert.equal(unknown.status, 422);
});

test('balance sheet: assets = liabilities + equity, as of a date, with incompleteness stated', async (t) => {
  const app = await ledger();
  t.after(app.close);
  await createAccount(app.request, app.token, { name: 'Loan', type: 'liability', openingBalance: uzs(30000) });
  await createAccount(app.request, app.token, { name: 'Capital', type: 'equity', openingBalance: uzs(50000) });
  const sheet = (await get(app, '/api/v1/reports/balance-sheet?asOf=2025-03-31')).data;
  // Cash: 100,000 opening + (40,000 − 10,000) Feb + (57,000 − 17,500) Mar = 169,500.
  assert.deepEqual(sheet.assets.total, uzs(169500));
  assert.deepEqual(sheet.liabilities.total, uzs(30000));
  assert.deepEqual(sheet.equity.lines.map((line) => line.label ?? line.account.name), ['Capital', 'Accumulated net result', 'Unreconciled opening balances']);
  assert.deepEqual(sheet.equity.lines[1].amount, uzs(69500));
  assert.deepEqual(sheet.equity.lines[2].amount, uzs(20000), '100,000 cash opening − 30,000 − 50,000');
  assert.deepEqual(sheet.totalLiabilitiesAndEquity, sheet.assets.total);
  assert.equal(sheet.balanced, true);
  assert.equal(sheet.completeness.complete, false);
  assert.deepEqual(sheet.completeness.issues.map((issue) => issue.code), ['unreconciled_opening_balances', 'liabilities_at_opening_balance']);
  const cashFlow = (await get(app, '/api/v1/financials/cash-flow?period=custom&periodStart=2025-03-01&periodEnd=2025-04-01')).data;
  assert.deepEqual(sheet.assets.total, cashFlow.closingCash, 'balance sheet cash ties to the cash-flow view');

  const earlier = (await get(app, '/api/v1/reports/balance-sheet?asOf=2025-02-28')).data;
  assert.deepEqual(earlier.assets.total, uzs(130000), 'only activity up to the as-of date');
  const bad = await app.request('GET', '/api/v1/reports/balance-sheet?asOf=2025-02-30x', { token: app.token });
  assert.equal(bad.status, 400);
});

test('cash flow statement ties opening and closing cash to the cash-flow view and states its mapping', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const statement = (await get(app, `/api/v1/reports/cash-flow-statement?${MARCH}`)).data;
  const view = (await get(app, `/api/v1/financials/cash-flow?${MARCH}`)).data;
  assert.deepEqual([statement.openingCash, statement.closingCash, statement.netChange], [view.openingCash, view.closingCash, view.netMovement]);
  assert.deepEqual(statement.activities.operating.cashIn, uzs(57000));
  assert.equal(statement.activities.investing, null, 'unclassified activity is not shown as zero');
  assert.equal(statement.mapping.rule, 'all_operating');
  assert.equal(statement.reconciles, true);
});

test('reports reflect edits immediately and an empty period is marked empty, not zero-as-fact', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const empty = (await get(app, '/api/v1/reports/profit-and-loss?period=custom&periodStart=2020-01-01&periodEnd=2020-02-01')).data;
  assert.equal(empty.empty, true);
  const txn = await recordTransaction(app.request, app.token, { type: 'expense', amount: uzs(1000), date: '2025-03-20', accountId: app.account.id, payee: 'Later' });
  assert.deepEqual((await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`)).data.expenses.amount, uzs(18500));
  await app.request('DELETE', `/api/v1/transactions/${txn.id}`, { token: app.token });
  assert.deepEqual((await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`)).data.expenses.amount, uzs(17500));
});

test('invoice payment flows into every statement, and cancelling it reverses the effect', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const customer = await createContact(app.request, app.token);
  const invoice = await createInvoice(app.request, app.token, customer, { issueDate: '2025-03-01', dueDate: '2025-03-31', lineItems: [{ description: 'Work', quantity: 1, unitPrice: uzs(8000) }] });
  await sendInvoice(app.request, app.token, invoice);
  const unpaid = (await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`)).data;
  assert.deepEqual(unpaid.revenue.amount, uzs(57000), 'unpaid invoice: no figure changes');
  const sheetUnpaid = (await get(app, '/api/v1/reports/balance-sheet?asOf=2025-03-31')).data;
  assert.deepEqual(sheetUnpaid.memo.unpaidReceivables, { count: 1, total: uzs(8000) });

  const paid = await app.request('POST', `/api/v1/invoices/${invoice.id}/payment`, { token: app.token, body: { accountId: app.account.id, date: '2025-03-20' } });
  assert.equal(paid.status, 201);
  const after = (await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`)).data;
  assert.deepEqual(after.revenue.amount, uzs(65000));
  const flow = (await get(app, `/api/v1/reports/cash-flow-statement?${MARCH}`)).data;
  assert.deepEqual(flow.activities.operating.cashIn, uzs(65000));
  const sheetPaid = (await get(app, '/api/v1/reports/balance-sheet?asOf=2025-03-31')).data;
  assert.deepEqual(sheetPaid.memo.unpaidReceivables, { count: 0, total: uzs(0) });
  assert.deepEqual(sheetPaid.assets.total, uzs(sheetUnpaid.assets.total.amount + 8000));

  await app.request('POST', `/api/v1/invoices/${invoice.id}/status`, { token: app.token, body: { status: 'cancelled' } });
  assert.deepEqual((await get(app, `/api/v1/reports/profit-and-loss?${MARCH}`)).data.revenue.amount, uzs(57000), 'cancellation reverses the payment');
});

test('exact money at the safe boundary: no float drift, no silent rounding', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A' });
  const big = 4503599627370495; // (2^53 − 1) / 2, twice fits exactly
  for (const date of ['2025-03-01', '2025-03-02']) {
    await recordTransaction(app.request, owner.token, { type: 'income', amount: uzs(big), date, accountId: owner.account.id, payee: `P${date}` });
  }
  const { data } = await get({ ...app, token: owner.token }, `/api/v1/reports/profit-and-loss?${MARCH}`);
  assert.equal(data.revenue.amount.amount, 9007199254740990);
  await recordTransaction(app.request, owner.token, { type: 'income', amount: uzs(2), date: '2025-03-03', accountId: owner.account.id, payee: 'One more' });
  const overflow = await app.request('GET', `/api/v1/reports/profit-and-loss?${MARCH}`, { token: owner.token });
  assert.equal(overflow.status, 500, 'a total beyond ±(2^53 − 1) is refused, not rounded');
  assertErrorEnvelope(overflow, 'INTERNAL_ERROR');
});

test('cash-flow view warns about unpaid bills due in the rest of the period', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A' });
  const vendor = await createContact(app.request, owner.token, { name: 'Vendor', type: 'vendor' });
  const today = new Date().toISOString().slice(0, 10);
  const bill = await createInvoice(app.request, owner.token, vendor, { type: 'payable', number: 'B-1', issueDate: today, dueDate: today });
  await sendInvoice(app.request, owner.token, bill);
  const { data } = await get({ ...app, token: owner.token }, '/api/v1/financials/cash-flow?period=last_30_days');
  assert.deepEqual(data.upcomingObligations.payables, { count: 1, total: uzs(10000) });
  assert.equal(data.upcomingObligations.warning, true);
  const past = (await get({ ...app, token: owner.token }, `/api/v1/financials/cash-flow?${MARCH}`)).data;
  assert.equal(past.upcomingObligations.warning, false);
});

test('reports index lists the statements; every report needs a company session', async (t) => {
  const app = await ledger();
  t.after(app.close);
  const index = (await get(app, '/api/v1/reports')).data;
  assert.deepEqual(index.map((report) => report.id), ['profit-and-loss', 'balance-sheet', 'cash-flow-statement', 'expense-report']);
  for (const path of ['/reports', '/reports/profit-and-loss', '/reports/balance-sheet', '/reports/cash-flow-statement', '/reports/expense-report',
    '/financials/revenue-vs-expenses', '/financials/expense-report', '/financials/health']) {
    assertErrorEnvelope(await app.request('GET', `/api/v1${path}`), 'UNAUTHENTICATED');
  }
});
