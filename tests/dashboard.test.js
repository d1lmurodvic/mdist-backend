/**
 * Dashboard (PRODUCT_REQUIREMENTS.md #4; API_CONTRACT.md §9.4): an aggregation
 * of existing calculations, with purposeful empty states and a link on every
 * card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createContact, createInvoice, ledgerOwner, recordTransaction, sendInvoice, uzs } from './helpers/fixtures.js';
import { addDays, todayIso } from '../src/lib/dates.js';

const TODAY = todayIso();

test('an empty workspace is marked empty with next steps instead of zeros as facts', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const { token } = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A' });
  app.db.run('DELETE FROM accounts');
  const { data, meta } = await app.request('GET', '/api/v1/dashboard', { token });
  assert.equal(data.empty, true);
  assert.deepEqual(data.emptyState, { hasAccounts: false, hasTransactions: false, hasInvoices: false, periodHasTransactions: false });
  assert.equal(data.health.status, 'insufficient_data');
  assert.equal(data.forecast.historySufficient, false);
  assert.ok(data.forecast.note);
  assert.deepEqual(data.insights.items, []);
  assert.equal(meta.period.preset, 'this_month');
});

test('dashboard figures are the engine\'s figures, with outstanding invoices, previews and links', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A', opening: 5000 });
  const { token } = owner;
  await recordTransaction(app.request, token, { type: 'income', amount: uzs(3000), date: TODAY, accountId: owner.account.id, payee: 'Client' });
  await recordTransaction(app.request, token, { type: 'expense', amount: uzs(1200), date: TODAY, accountId: owner.account.id, payee: 'Shop' });
  const customer = await createContact(app.request, token);
  const vendor = await createContact(app.request, token, { name: 'Vendor', type: 'vendor' });
  const overdue = await createInvoice(app.request, token, customer, { number: 'R-1', issueDate: addDays(TODAY, -40), dueDate: addDays(TODAY, -10) });
  await sendInvoice(app.request, token, overdue);
  const bill = await createInvoice(app.request, token, vendor, { number: 'B-1', type: 'payable', issueDate: TODAY, dueDate: addDays(TODAY, 3), lineItems: [{ description: 'x', quantity: 1, unitPrice: uzs(9000) }] });
  await sendInvoice(app.request, token, bill);
  await createInvoice(app.request, token, customer, { number: 'D-1', issueDate: TODAY, dueDate: TODAY });

  const { data, meta } = await app.request('GET', '/api/v1/dashboard', { token });
  const overview = (await app.request('GET', '/api/v1/financials/overview', { token })).data;
  assert.deepEqual([data.income.amount, data.expenses.amount, data.netResult.amount], [overview.income, overview.expenses, overview.netResult]);
  assert.deepEqual(data.cash.current, uzs(6800));
  assert.deepEqual(data.outstandingInvoices.receivable, { count: 1, total: uzs(10000), overdueCount: 1, overdueTotal: uzs(10000) });
  assert.deepEqual(data.outstandingInvoices.payable, { count: 1, total: uzs(9000), overdueCount: 0, overdueTotal: uzs(0) }, 'drafts owe nothing');
  assert.deepEqual(data.forecast.belowZero, { crosses: true, firstDate: addDays(TODAY, 3) });
  assert.ok(data.insights.items.some((insight) => insight.type === 'overdue_receivables'));
  assert.ok(data.insights.items.some((insight) => insight.type === 'forecast_shortfall'));
  for (const card of ['cash', 'income', 'expenses', 'netResult', 'outstandingInvoices', 'insights', 'anomalies', 'forecast', 'health']) {
    assert.match(data[card].link, /^\/api\/v1\//, `${card} has a link`);
  }
  assert.equal(meta.capabilities.forecast.method, 'statistics');
  assert.equal(meta.capabilities.insights.method, 'rule');

  // A dismissed insight is not previewed again.
  const generated = (await app.request('POST', '/api/v1/ai/insights', { token, body: {} })).data;
  const overdueInsight = generated.find((insight) => insight.type === 'overdue_receivables');
  await app.request('POST', `/api/v1/ai/insights/${overdueInsight.id}/dismiss`, { token, body: {} });
  const again = (await app.request('GET', '/api/v1/dashboard', { token })).data;
  assert.ok(!again.insights.items.some((insight) => insight.type === 'overdue_receivables'));
});

test('activity feed: newest first, bounded, each item linked', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A' });
  for (let i = 0; i < 3; i += 1) {
    await recordTransaction(app.request, owner.token, { type: 'income', amount: uzs(10 + i), date: TODAY, accountId: owner.account.id, payee: `P${i}` });
  }
  const { data, meta } = await app.request('GET', '/api/v1/dashboard/activity?limit=2', { token: owner.token });
  assert.equal(meta.limit, 2);
  assert.deepEqual(data.map((item) => item.label), ['P2', 'P1']);
  assert.equal(data[0].entity.path, `/api/v1/transactions/${data[0].entity.id}`);
  assertErrorEnvelope(await app.request('GET', '/api/v1/dashboard/activity?limit=500', { token: owner.token }), 'VALIDATION_ERROR');
  assertErrorEnvelope(await app.request('GET', '/api/v1/dashboard'), 'UNAUTHENTICATED');
});
