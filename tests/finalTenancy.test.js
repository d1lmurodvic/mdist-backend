/**
 * Final two-company isolation audit over every resource added in the final
 * backend completion, in both directions: a company sees its own records and
 * figures, and another company's ids behave exactly like ids that exist
 * nowhere (404). Company scope always comes from the session.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createContact, createInvoice, ledgerOwner, recordTransaction, sendInvoice, uzs } from './helpers/fixtures.js';
import { addDays, addMonths, startOfMonth, todayIso } from '../src/lib/dates.js';

const TODAY = todayIso();
const MISSING = (prefix) => `${prefix}_01M3EFNC4TMGZ36SQ8D1WYJ2TK`;

/** A company with history, an overdue invoice, a spike, insights, anomalies, a forecast, a request and a chat. */
async function company(app, email, name, scale) {
  const owner = await ledgerOwner(app.request, { email, companyName: name, opening: 1000 * scale });
  const call = (method, path, body) => app.request(method, `/api/v1${path}`, { token: owner.token, body });
  for (let m = 6; m >= 1; m -= 1) {
    const month = addMonths(startOfMonth(TODAY), -m);
    for (const [d, amount, payee] of [[2, 50, 'Landlord'], [8, 10, 'Shop'], [15, 12, 'Power'], [20, 11, 'Cafe']]) {
      await recordTransaction(app.request, owner.token, { type: 'expense', amount: uzs(amount * scale + m), date: addDays(month, d - 1), accountId: owner.account.id, payee });
    }
    await recordTransaction(app.request, owner.token, { type: 'income', amount: uzs(200 * scale), date: addDays(month, 9), accountId: owner.account.id, payee: 'Client' });
  }
  const spike = await recordTransaction(app.request, owner.token, { type: 'expense', amount: uzs(900 * scale), date: TODAY, accountId: owner.account.id, payee: 'Shop' });
  const customer = await createContact(app.request, owner.token);
  const invoice = await createInvoice(app.request, owner.token, customer, { issueDate: addDays(TODAY, -30), dueDate: addDays(TODAY, -3) });
  await sendInvoice(app.request, owner.token, invoice);

  const insights = (await call('POST', '/ai/insights', { period: 'last_month' })).data;
  const anomalies = (await call('POST', '/ai/anomalies/detect', {})).data.flagsInPeriod;
  const forecast = (await call('POST', '/forecast', {})).data;
  const request = (await call('POST', '/accountants/requests', { contactName: name, contactEmail: email, topic: 'other', description: 'Help' })).data;
  await call('POST', '/ai/assistant/messages', { message: 'What is my cash balance?' });
  const notifications = (await call('GET', '/notifications')).data;
  const members = (await call('GET', '/companies/current/members')).data;
  assert.ok(insights.length > 0 && anomalies.length > 0 && notifications.length > 0, `${name} fixture is complete`);
  return { ...owner, call, spike, invoice, insights, anomalies, forecast, request, notifications, members, scale };
}

async function looksMissing(call, method, path, missingPath, body) {
  const foreign = await call(method, path, body);
  const missing = await call(method, missingPath, body);
  assert.equal(foreign.status, 404, `${method} ${path}: ${foreign.raw}`);
  assertErrorEnvelope(foreign, 'NOT_FOUND');
  assert.equal(foreign.error.message, missing.error.message, `${method} ${path} answers like a missing id`);
}

test('every final-completion resource is isolated in both directions', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const a = await company(app, 'a@a.example', 'A', 1);
  const b = await company(app, 'b@b.example', 'B', 1000);

  for (const [actor, victim] of [[a, b], [b, a]]) {
    const probes = [
      ['POST', `/ai/insights/${victim.insights[0].id}/dismiss`, `/ai/insights/${MISSING('ins')}/dismiss`, {}],
      ['PATCH', `/ai/anomalies/${victim.anomalies[0].id}`, `/ai/anomalies/${MISSING('anm')}`, { status: 'false_positive' }],
      ['POST', `/notifications/${victim.notifications[0].id}/read`, `/notifications/${MISSING('ntf')}/read`, {}],
      ['DELETE', `/notifications/${victim.notifications[0].id}`, `/notifications/${MISSING('ntf')}`],
      ['GET', `/accountants/requests/${victim.request.id}`, `/accountants/requests/${MISSING('acr')}`],
      ['PATCH', `/accountants/requests/${victim.request.id}`, `/accountants/requests/${MISSING('acr')}`, { description: 'Hijack' }],
      ['PATCH', `/members/${victim.members[0].id}`, `/members/${MISSING('mem')}`, { role: 'member' }],
      ['POST', '/ai/categorize', '/ai/categorize', { transactionId: victim.spike.id }],
    ];
    for (const [method, path, missingPath, body] of probes) {
      if (path === '/ai/categorize') {
        const foreign = await actor.call('POST', path, body);
        assert.equal(foreign.status, 404, foreign.raw);
        continue;
      }
      await looksMissing(actor.call, method, path, missingPath, body);
    }

    // Lists hold only the caller's records.
    const own = (list, ids) => list.every((item) => ids.includes(item.id));
    assert.ok(own((await actor.call('GET', '/ai/insights?period=last_month&includeDismissed=true')).data, actor.insights.map((i) => i.id)));
    assert.ok((await actor.call('GET', '/ai/anomalies?limit=100')).data.every((item) => item.transaction.id !== victim.spike.id));
    assert.ok(own((await actor.call('GET', '/notifications?limit=100')).data, actor.notifications.map((n) => n.id)));
    assert.deepEqual((await actor.call('GET', '/accountants/requests')).data.map((r) => r.id), [actor.request.id]);
    assert.equal((await actor.call('GET', '/ai/assistant/messages')).meta.total, 2);
    assert.equal((await actor.call('GET', '/forecast/latest')).data.id, actor.forecast.id);
    assert.ok((await actor.call('GET', '/dashboard/activity?limit=50')).data.every((item) => item.entity.id !== victim.spike.id && item.entity.id !== victim.invoice.id));

    // Figures are the caller's own: every amount scales with the caller only.
    const dashboard = (await actor.call('GET', '/dashboard')).data;
    const overview = (await actor.call('GET', '/financials/overview')).data;
    assert.deepEqual([dashboard.income.amount, dashboard.expenses.amount], [overview.income, overview.expenses]);
    assert.deepEqual(dashboard.outstandingInvoices.receivable.total, uzs(10000));
    const pnl = (await actor.call('GET', '/reports/profit-and-loss?period=last_month')).data;
    assert.equal(pnl.revenue.amount.amount, 200 * actor.scale);
    const tax = (await actor.call('GET', '/tax/summary?period=last_month')).data;
    assert.equal(tax.income.total.amount, 200 * actor.scale);
    const exported = (await actor.call('GET', '/tax/export?period=this_month')).data;
    assert.ok(exported.transactions.every((row) => row.id !== victim.spike.id));
    const answer = (await actor.call('POST', '/ai/assistant/messages', { message: 'What is my cash balance?' })).data.answer;
    assert.deepEqual(answer.references[0].value, dashboard.cash.current);
    await actor.call('DELETE', '/ai/assistant/messages');
    await actor.call('POST', '/ai/assistant/messages', { message: 'What is my cash balance?' });
  }

  // The victim's records were not changed by any probe.
  assert.equal((await a.call('GET', `/accountants/requests/${a.request.id}`)).data.description, 'Help');
  assert.equal(app.db.getValue("SELECT count(*) FROM insights WHERE dismissed_at IS NOT NULL"), 0);
  assert.equal(app.db.getValue("SELECT count(*) FROM anomalies WHERE status <> 'open'"), 0);
});

test('the database refuses an anomaly that points at another company\'s transaction', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const a = await ledgerOwner(app.request, { email: 'a@a.example', companyName: 'A' });
  const b = await ledgerOwner(app.request, { email: 'b@b.example', companyName: 'B' });
  const bTxn = await recordTransaction(app.request, b.token, { type: 'expense', amount: uzs(5), date: TODAY, accountId: b.account.id, payee: 'X' });
  assert.throws(() => app.db.run(
    `INSERT INTO anomalies (id, company_id, transaction_id, rule_id, severity, score, explanation, comparison, detected_at, updated_at)
     VALUES ('anm_x', ?, ?, 'large_expense', 'low', 1, 'x', '{}', 'x', 'x')`,
    [a.company.id, bTxn.id],
  ), /FOREIGN KEY/);
});

test('a client-supplied company id is never trusted', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const a = await ledgerOwner(app.request, { email: 'a@a.example', companyName: 'A' });
  const b = await ledgerOwner(app.request, { email: 'b@b.example', companyName: 'B' });
  await recordTransaction(app.request, b.token, { type: 'income', amount: uzs(777), date: TODAY, accountId: b.account.id, payee: 'X' });
  const viaQuery = await app.request('GET', `/api/v1/dashboard?companyId=${b.company.id}`, { token: a.token });
  assert.deepEqual(viaQuery.data.income.amount, uzs(0), 'a companyId in the query is ignored');
  for (const [path, body] of [['/ai/insights', { companyId: b.company.id }], ['/forecast', { companyId: b.company.id }],
    ['/accountants/requests', { companyId: b.company.id, contactName: 'x', contactEmail: 'x@a.example', topic: 'other', description: 'x' }]]) {
    assertErrorEnvelope(await app.request('POST', `/api/v1${path}`, { token: a.token, body }), 'VALIDATION_ERROR');
  }
});
