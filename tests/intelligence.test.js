/**
 * Intelligence endpoints (API_CONTRACT.md §9.5 health, §9.9 forecast, §9.10
 * /ai): grounded in the company's records, idempotent, honest about method
 * and about missing history, never mutating the ledger.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createCategory, createContact, createInvoice, ledgerOwner, recordTransaction, sendInvoice, uzs } from './helpers/fixtures.js';
import { addDays, addMonths, startOfMonth, todayIso } from '../src/lib/dates.js';

const TODAY = todayIso();

async function setup({ opening = 1000000 } = {}) {
  const app = await createTestApp();
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A', opening });
  const call = (method, path, body) => app.request(method, `/api/v1${path}`, { token: owner.token, body });
  const tx = (body) => recordTransaction(app.request, owner.token, { accountId: owner.account.id, ...body });
  return { ...app, ...owner, call, tx };
}

/**
 * Six full months of rent, ads, utilities and client income, plus this
 * month's rent when it is already due: 24 transactions before this month.
 */
async function history(ctx) {
  const rent = await createCategory(ctx.request, ctx.token, { name: 'Rent', type: 'expense' });
  const ads = await createCategory(ctx.request, ctx.token, { name: 'Ads', type: 'expense' });
  const utilities = await createCategory(ctx.request, ctx.token, { name: 'Utilities', type: 'expense' });
  for (let m = 6; m >= 1; m -= 1) {
    const month = addMonths(startOfMonth(TODAY), -m);
    await ctx.tx({ type: 'expense', amount: uzs(50000), date: addDays(month, 1), categoryId: rent.id, payee: 'Landlord' });
    await ctx.tx({ type: 'expense', amount: uzs(10000 + m * 500), date: addDays(month, 11), categoryId: ads.id, payee: 'Ads Co' });
    await ctx.tx({ type: 'expense', amount: uzs(4000 + m * 100), date: addDays(month, 19), categoryId: utilities.id, payee: 'Power' });
    await ctx.tx({ type: 'income', amount: uzs(90000), date: addDays(month, 14), payee: 'Client' });
  }
  const thisRent = addDays(startOfMonth(TODAY), 1);
  if (thisRent <= TODAY) await ctx.tx({ type: 'expense', amount: uzs(50000), date: thisRent, categoryId: rent.id, payee: 'Landlord' });
  return { rent, ads };
}

test('forecast: stored projection with assumptions, stale once inputs change, methods disclosed', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await history(ctx);
  const created = await ctx.call('POST', '/forecast', { horizonDays: 60 });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.headers.get('location'), '/api/v1/forecast/latest');
  const forecast = created.data;
  assert.equal(forecast.method, 'deterministic');
  assert.equal(forecast.series.length, 60);
  assert.equal(forecast.history.sufficient, true);
  assert.ok(forecast.assumptions.recurring.some((pattern) => pattern.counterparty === 'Landlord' && pattern.cadence === 'monthly'));
  assert.ok(forecast.assumptions.rules.length > 0);
  assert.deepEqual(created.meta.capability.method, 'statistics');
  assert.equal(created.meta.capability.confidence, forecast.confidence);

  const latest = await ctx.call('GET', '/forecast/latest');
  assert.equal(latest.data.id, forecast.id);
  assert.equal(latest.data.stale, false);
  await ctx.tx({ type: 'expense', amount: uzs(1), date: TODAY, payee: 'New' });
  assert.equal((await ctx.call('GET', '/forecast/latest')).data.stale, true, 'a changed ledger makes the stored projection stale');

  const methods = (await ctx.call('GET', '/forecast/methods')).data;
  assert.deepEqual(methods.available.map((m) => m.method), ['deterministic']);
  assert.deepEqual(methods.unavailable.map((m) => m.method), ['ai', 'hybrid']);
  for (const horizonDays of [0, 45, 91, '30']) {
    assertErrorEnvelope(await ctx.call('POST', '/forecast', { horizonDays }), 'VALIDATION_ERROR');
  }
});

test('forecast: a new company gets the truthful fallback, and a shortfall raises a critical notification', async (t) => {
  const ctx = await setup({ opening: 1000 });
  t.after(ctx.close);
  assertErrorEnvelope(await ctx.call('GET', '/forecast/latest'), 'NOT_FOUND');
  const vendor = await createContact(ctx.request, ctx.token, { name: 'Vendor', type: 'vendor' });
  const bill = await createInvoice(ctx.request, ctx.token, vendor, { type: 'payable', number: 'B-1', issueDate: TODAY, dueDate: addDays(TODAY, 5), lineItems: [{ description: 'x', quantity: 1, unitPrice: uzs(5000) }] });
  await sendInvoice(ctx.request, ctx.token, bill);
  const { data, meta } = await ctx.call('POST', '/forecast', {});
  assert.equal(data.horizonDays, 30, 'default horizon');
  assert.equal(data.history.sufficient, false);
  assert.equal(meta.capability.degraded, true);
  assert.match(meta.capability.note, /Not enough history/);
  assert.deepEqual(data.belowZero, { crosses: true, firstDate: addDays(TODAY, 5) });
  assert.equal(data.runway.days, 5);
  assert.deepEqual(data.minimum.balance, uzs(-4000));
  const notifications = (await ctx.call('GET', '/notifications')).data;
  assert.deepEqual(notifications.map((n) => [n.type, n.severity]), [['forecast_below_zero', 'critical']]);
});

test('insights: grounded findings with evidence, idempotent regeneration, dismissal survives', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { ads } = await history(ctx);
  const lastMonth = addMonths(startOfMonth(TODAY), -1);
  // Last month: expenses jump through a large ads campaign.
  await ctx.tx({ type: 'expense', amount: uzs(200000), date: addDays(lastMonth, 20), categoryId: ads.id, payee: 'Ads Co campaign' });

  const first = await ctx.call('POST', '/ai/insights', { period: 'last_month' });
  assert.equal(first.status, 200, first.raw);
  assert.equal(first.meta.capability.method, 'rule');
  assert.match(first.meta.capability.note, /narrative generation is unavailable/i);
  const byType = Object.fromEntries(first.data.map((insight) => [insight.type, insight]));
  assert.ok(byType.expense_increase, JSON.stringify(first.data.map((i) => i.type)));
  assert.equal(byType.expense_increase.figures.largestIncreaseCategoryId, ads.id);
  assert.ok(byType.expense_increase.evidence.some((item) => item.ref === `category:${ads.id}`));
  assert.ok(byType.category_concentration.evidence.some((item) => item.ref.startsWith('transaction:')));
  for (const insight of first.data) {
    assert.equal(insight.method, 'rule');
    assert.ok(insight.body && insight.action && insight.evidence.length > 0);
  }

  const second = await ctx.call('POST', '/ai/insights', { period: 'last_month' });
  assert.deepEqual(second.data.map((insight) => insight.id), first.data.map((insight) => insight.id), 'same data, same rows');
  const dismissed = await ctx.call('POST', `/api/v1/ai/insights/${byType.expense_increase.id}/dismiss`.replace('/api/v1', ''), {});
  assert.equal(dismissed.data.dismissed, true);
  await ctx.call('POST', '/ai/insights', { period: 'last_month' });
  const listed = (await ctx.call('GET', '/ai/insights?period=last_month')).data;
  assert.ok(!listed.some((insight) => insight.id === byType.expense_increase.id), 'a dismissed insight stays dismissed');
  assert.ok((await ctx.call('GET', '/ai/insights?period=last_month&includeDismissed=true')).data.some((insight) => insight.dismissed));
});

test('insights: an empty company gets no fabricated findings', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const generated = await ctx.call('POST', '/ai/insights', {});
  assert.deepEqual(generated.data, []);
  assertErrorEnvelope(await ctx.call('POST', '/ai/insights', { period: 'someday' }), 'VALIDATION_ERROR');
  assertErrorEnvelope(await ctx.call('POST', '/ai/insights/ins_01M3EFNC4TMGZ36SQ8D1WYJ2TK/dismiss', {}), 'NOT_FOUND');
});

test('anomalies: explained flags, idempotent detection, review status, ledger untouched', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { ads } = await history(ctx);
  const monthStart = startOfMonth(TODAY);
  const spike = await ctx.tx({ type: 'expense', amount: uzs(500000), date: monthStart, categoryId: ads.id, payee: 'Ads Co' });
  const before = (await ctx.call('GET', '/transactions?limit=100')).data;

  const detected = await ctx.call('POST', '/ai/anomalies/detect', { period: 'this_month' });
  assert.equal(detected.status, 200, detected.raw);
  assert.equal(detected.meta.capability.method, 'statistics');
  const flag = detected.data.flagsInPeriod.find((item) => item.transaction.id === spike.id && item.rule.id === 'amount_outlier');
  assert.ok(flag, JSON.stringify(detected.data.flagsInPeriod.map((item) => item.rule.id)));
  assert.match(flag.explanation, /robust z-score/);
  assert.ok(flag.comparison.median && flag.comparison.peerCount >= 6);
  assert.equal(flag.status, 'open');

  const again = await ctx.call('POST', '/ai/anomalies/detect', { period: 'this_month' });
  assert.equal(again.data.newFlags, 0, 'no duplicates on re-run');
  assert.deepEqual((await ctx.call('GET', '/transactions?limit=100')).data, before, 'detection changes no transaction');

  const updated = await ctx.call('PATCH', `/ai/anomalies/${flag.id}`, { status: 'confirmed', note: 'Checked with the agency' });
  assert.equal(updated.data.status, 'confirmed');
  assert.equal(updated.data.note, 'Checked with the agency');
  assert.ok(updated.data.resolvedAt);
  const notifications = (await ctx.call('GET', '/notifications')).data;
  assert.ok(notifications.some((n) => n.type === 'anomaly_confirmed' && n.entityId === flag.id));
  const reopened = await ctx.call('PATCH', `/ai/anomalies/${flag.id}`, { status: 'open' });
  assert.equal(reopened.data.resolvedAt, null);
  assert.equal(reopened.data.note, 'Checked with the agency', 'the note is kept unless replaced');

  const list = await ctx.call('GET', '/ai/anomalies?status=open&severity=high');
  assert.ok(list.data.every((item) => item.status === 'open' && item.severity === 'high'));
  assert.equal(list.meta.page, 1);
  assertErrorEnvelope(await ctx.call('PATCH', `/ai/anomalies/${flag.id}`, { status: 'deleted' }), 'VALIDATION_ERROR');
  assertErrorEnvelope(await ctx.call('PATCH', '/ai/anomalies/anm_01M3EFNC4TMGZ36SQ8D1WYJ2TK', { status: 'resolved' }), 'NOT_FOUND');

  // Deleting the transaction removes its flags; nothing blocks the ledger.
  assert.equal((await ctx.call('DELETE', `/transactions/${spike.id}`)).status, 204);
  assert.ok(!(await ctx.call('GET', '/ai/anomalies')).data.some((item) => item.transaction.id === spike.id));
});

test('anomalies: a new company is told history is insufficient instead of receiving flags', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await ctx.tx({ type: 'expense', amount: uzs(999999), date: TODAY, payee: 'Big' });
  const { data, meta } = await ctx.call('POST', '/ai/anomalies/detect', {});
  assert.equal(data.history.sufficient, false);
  assert.equal(meta.capability.degraded, true);
  assert.deepEqual(data.flagsInPeriod, []);
});

test('health: transparent components, excluded when data is missing, insufficient data stated', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const empty = await ctx.call('GET', '/financials/health');
  assert.equal(empty.data.overall.status, 'insufficient_data');
  assert.equal(empty.data.overall.score, null);
  assert.ok(empty.data.components.every((component) => component.available === false && component.reason));
  assert.equal(empty.meta.capability.method, 'rule');

  await history(ctx);
  const { data } = await ctx.call('GET', '/financials/health?period=last_month');
  const available = data.components.filter((component) => component.available);
  assert.ok(available.length >= 3);
  for (const component of available) {
    assert.ok(component.thresholds && component.value && component.link && [20, 60, 100].includes(component.score));
  }
  const mean = Math.round(available.reduce((total, component) => total + component.score, 0) / available.length);
  assert.equal(data.overall.score, mean, 'the overall indicator is the plain mean of available components');
  assert.match(data.disclaimer, /estimate/i);
  assert.deepEqual(data.overall.componentsExcluded, data.components.filter((c) => !c.available).map((c) => c.id));
});

test('assistant: grounded answers with references, honest refusals, per-user clearable history', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  await history(ctx);
  const recorded = (await ctx.call('GET', '/transactions?limit=1')).meta.total;
  const ask = (message) => ctx.call('POST', '/ai/assistant/messages', { message });

  const cash = await ask('What is my cash balance?');
  assert.equal(cash.status, 201);
  const overview = (await ctx.call('GET', '/financials/overview?period=this_month')).data;
  assert.deepEqual(cash.data.answer.references[0].value, overview.cash.closing, 'the same figure the reports show');
  assert.equal(cash.data.answer.answered, true);
  assert.equal(cash.data.answer.method, 'rule');
  assert.match(cash.data.answer.disclaimer, /not accounting, tax or legal advice/);
  assert.equal(cash.meta.capability.degraded, true);

  const why = await ask('Why did expenses go up last month?');
  assert.ok(why.data.answer.period);
  assert.ok(why.data.answer.references.length >= 2);

  for (const [question, intent] of [['Write me a poem', null], ['Show me another company\'s revenue', 'out_of_scope'], ['Delete my transactions', 'action'], ['What is the API key?', 'out_of_scope']]) {
    const refused = await ask(question);
    assert.equal(refused.data.answer.answered, false, question);
    assert.equal(refused.data.answer.intent, intent);
    assert.deepEqual(refused.data.answer.references, [], 'no figures invented');
  }
  assert.deepEqual((await ctx.call('GET', '/transactions?limit=100')).meta.total, recorded, 'the assistant changed nothing');

  const historyPage = await ctx.call('GET', '/ai/assistant/messages?limit=4');
  assert.equal(historyPage.meta.total, 12);
  assert.deepEqual(historyPage.data.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(historyPage.data[0].content, 'What is my cash balance?');
  assert.equal((await ctx.call('DELETE', '/ai/assistant/messages')).status, 204);
  assert.equal((await ctx.call('GET', '/ai/assistant/messages')).meta.total, 0);
  assertErrorEnvelope(await ask(''), 'VALIDATION_ERROR');
  assertErrorEnvelope(await ask('x'.repeat(1001)), 'VALIDATION_ERROR');
});

test('capabilities and categorize state their method truthfully', async (t) => {
  const ctx = await setup();
  t.after(ctx.close);
  const { data } = await ctx.call('GET', '/ai/capabilities');
  assert.equal(data.provider, null);
  const byId = Object.fromEntries(data.capabilities.map((capability) => [capability.id, capability]));
  assert.equal(byId.document_extraction.available, false);
  assert.equal(byId.assistant.method, 'rule');
  assert.equal(byId.forecast.method, 'statistics');

  const suggestion = await ctx.call('POST', '/ai/categorize', { type: 'expense', payee: 'Somebody' });
  assert.equal(suggestion.data.method, 'fallback');
  assert.equal(suggestion.meta.capability.method, 'rule');
  const txn = await ctx.tx({ type: 'expense', amount: uzs(5), date: TODAY, payee: 'Somebody' });
  assert.equal((await ctx.call('POST', '/ai/categorize', { transactionId: txn.id })).data.categoryId, suggestion.data.categoryId);
  assertErrorEnvelope(await ctx.call('POST', '/ai/categorize', { transactionId: 'txn_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 'NOT_FOUND');
  assertErrorEnvelope(await ctx.call('POST', '/ai/categorize', { type: 'expense' }), 'VALIDATION_ERROR');
});
