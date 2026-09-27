/**
 * Notifications (API_CONTRACT.md §9.12), accountant requests (§9.13), profile
 * and settings (§9.2, §9.3), and demo data (§9.3).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope } from './helpers/testApp.js';
import { createContact, createInvoice, ledgerOwner, recordTransaction, registerUser, sendInvoice, uzs, PASSWORD } from './helpers/fixtures.js';
import { createDocumentsApp, settled, uploadFile } from './helpers/documents.js';
import { addDays, todayIso } from '../src/lib/dates.js';

const TODAY = todayIso();

async function setup(app) {
  const owner = await ledgerOwner(app.request, { email: 'o@a.example', companyName: 'A', opening: 100000 });
  const call = (method, path, body, token = owner.token) => app.request(method, `/api/v1${path}`, { token, body });
  return { ...owner, call };
}

test('notifications come from real events, once each, with exact links and persistent read state', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  const ctx = await setup(app);
  assert.deepEqual((await ctx.call('GET', '/notifications')).data, [], 'no filler notifications');

  const customer = await createContact(app.request, ctx.token);
  const overdue = await createInvoice(app.request, ctx.token, customer, { number: 'OD-1', issueDate: addDays(TODAY, -20), dueDate: addDays(TODAY, -5) });
  await sendInvoice(app.request, ctx.token, overdue);
  const toPay = await createInvoice(app.request, ctx.token, customer, { number: 'PD-1', issueDate: TODAY, dueDate: addDays(TODAY, 5) });
  await sendInvoice(app.request, ctx.token, toPay);
  await ctx.call('POST', `/invoices/${toPay.id}/payment`, { accountId: ctx.account.id, date: TODAY });
  const document = (await uploadFile(app.request, ctx.token)).data;
  await settled(app.request, ctx.token, document.id);

  const list = await ctx.call('GET', '/notifications');
  const byType = Object.fromEntries(list.data.map((n) => [n.type, n]));
  assert.deepEqual(Object.keys(byType).sort(), ['document_processed', 'invoice_overdue', 'invoice_paid']);
  assert.deepEqual(byType.invoice_overdue.link, { entityType: 'invoice', entityId: overdue.id, path: `/api/v1/invoices/${overdue.id}` });
  assert.equal(byType.invoice_paid.entityId, toPay.id);
  assert.equal(byType.document_processed.link.path, `/api/v1/documents/${document.id}`);
  assert.equal(list.meta.unreadCount, 3);
  assert.equal((await ctx.call('GET', '/notifications')).meta.total, 3, 'reading again creates nothing new');

  const read = await ctx.call('POST', `/notifications/${byType.invoice_paid.id}/read`, {});
  assert.ok(read.data.readAt);
  assert.equal((await ctx.call('GET', '/notifications/unread-count')).data.unreadCount, 2);
  assert.equal((await ctx.call('GET', '/notifications?unreadOnly=true')).meta.total, 2);
  assert.equal((await ctx.call('DELETE', `/notifications/${byType.invoice_overdue.id}`)).status, 204);
  assert.ok(!(await ctx.call('GET', '/notifications')).data.some((n) => n.id === byType.invoice_overdue.id), 'a dismissed event does not come back');
  assert.equal((await ctx.call('POST', '/notifications/read-all', {})).data.updated, 1);
  assert.equal((await ctx.call('GET', '/notifications/unread-count')).data.unreadCount, 0);
  assertErrorEnvelope(await ctx.call('POST', '/notifications/ntf_01M3EFNC4TMGZ36SQ8D1WYJ2TK/read', {}), 'NOT_FOUND');
});

test('notification preferences: types can be disabled; the critical forecast warning needs acknowledgement', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const ctx = await setup(app);
  const prefs = (await ctx.call('GET', '/users/me/preferences')).data;
  assert.ok(Object.values(prefs.notifications).every(Boolean));
  const refused = await ctx.call('PATCH', '/users/me/preferences', { notifications: { forecast_below_zero: false } });
  assertErrorEnvelope(refused, 'UNPROCESSABLE');
  const ok = await ctx.call('PATCH', '/users/me/preferences', { notifications: { forecast_below_zero: false, invoice_overdue: false }, acknowledgeCritical: true });
  assert.equal(ok.data.notifications.forecast_below_zero, false);

  const customer = await createContact(app.request, ctx.token);
  const invoice = await createInvoice(app.request, ctx.token, customer, { issueDate: addDays(TODAY, -20), dueDate: addDays(TODAY, -5) });
  await sendInvoice(app.request, ctx.token, invoice);
  assert.deepEqual((await ctx.call('GET', '/notifications')).data, [], 'a disabled type is not delivered');
  assertErrorEnvelope(await ctx.call('PATCH', '/users/me/preferences', { notifications: { made_up: true } }), 'VALIDATION_ERROR');
});

test('accountant requests: lead capture only, explicit share scope, editable while requested', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const ctx = await setup(app);
  await recordTransaction(app.request, ctx.token, { type: 'income', amount: uzs(9000), date: '2025-03-10', accountId: ctx.account.id, payee: 'C' });
  const scope = (await ctx.call('GET', '/accountants/share-scope')).data;
  assert.equal(scope.sharedAutomatically, false);
  assert.equal(scope.connectedAccountant, null);
  assert.ok(scope.neverIncluded.includes('Individual transactions'));

  const body = { contactName: 'Owner', contactEmail: 'Owner@A.example', topic: 'tax_preparation', description: 'Year-end help' };
  assertErrorEnvelope(await ctx.call('POST', '/accountants/requests', { ...body, shareSummary: true }), 'UNPROCESSABLE');
  assertErrorEnvelope(await ctx.call('POST', '/accountants/requests', { ...body, periodStart: '2025-03-01' }), 'VALIDATION_ERROR');
  assertErrorEnvelope(await ctx.call('POST', '/accountants/requests', { ...body, topic: 'marketplace' }), 'VALIDATION_ERROR');
  const created = await ctx.call('POST', '/accountants/requests', { ...body, periodStart: '2025-03-01', periodEnd: '2025-04-01', shareSummary: true });
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'requested');
  assert.equal(created.data.contactEmail, 'owner@a.example');
  assert.deepEqual(created.data.shareScope.summary.income, uzs(9000), 'the shared summary is the engine figure');
  assert.match(created.meta.note, /No accountant network is connected/);

  const updated = await ctx.call('PATCH', `/accountants/requests/${created.data.id}`, { description: 'Year-end and VAT questions', shareSummary: false });
  assert.equal(updated.data.description, 'Year-end and VAT questions');
  assert.equal(updated.data.shareScope.summary, undefined, 'nothing shared once the user opts out');
  assert.equal((await ctx.call('GET', '/accountants/requests?status=requested')).data.length, 1);
  assert.equal((await ctx.call('GET', `/accountants/requests/${created.data.id}`)).data.id, created.data.id);
  assert.equal((await ctx.call('GET', '/accountants/requests?status=closed')).data.length, 0);
  app.db.run("UPDATE accountant_requests SET status = 'in_contact'");
  assertErrorEnvelope(await ctx.call('PATCH', `/accountants/requests/${created.data.id}`, { description: 'x' }), 'UNPROCESSABLE');
  assertErrorEnvelope(await ctx.call('PATCH', `/accountants/requests/${created.data.id}`, {}), 'VALIDATION_ERROR');
});

test('profile: read, update, email uniqueness; password change needs the current password and ends other sessions', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const ctx = await setup(app);
  const other = await registerUser(app.request, { email: 'taken@a.example' });
  assert.deepEqual((await ctx.call('GET', '/users/me')).data.email, 'o@a.example');
  const renamed = await ctx.call('PATCH', '/users/me', { name: 'New Name', email: 'NEW@a.example' });
  assert.deepEqual([renamed.data.name, renamed.data.email], ['New Name', 'new@a.example']);
  assertErrorEnvelope(await ctx.call('PATCH', '/users/me', { email: 'TAKEN@a.example' }), 'CONFLICT');
  assertErrorEnvelope(await ctx.call('PATCH', '/users/me', {}), 'VALIDATION_ERROR');
  assert.ok(!JSON.stringify((await ctx.call('GET', '/users/me')).data).includes('password'));

  const second = await app.request('POST', '/api/v1/auth/login', { body: { email: 'new@a.example', password: PASSWORD } });
  assert.equal(second.status, 200);
  assertErrorEnvelope(await ctx.call('POST', '/users/me/password', { currentPassword: 'wrong password', newPassword: 'another long password' }), 'UNPROCESSABLE');
  assertErrorEnvelope(await ctx.call('POST', '/users/me/password', { currentPassword: PASSWORD, newPassword: 'short' }), 'VALIDATION_ERROR');
  assert.equal((await ctx.call('POST', '/users/me/password', { currentPassword: PASSWORD, newPassword: 'another long password' })).status, 204);
  assert.equal((await ctx.call('GET', '/users/me')).status, 200, 'the current session stays');
  assertErrorEnvelope(await app.request('GET', '/api/v1/users/me', { token: second.data.session.token }), 'UNAUTHENTICATED');
  assert.equal((await app.request('POST', '/api/v1/auth/login', { body: { email: 'new@a.example', password: 'another long password' } })).status, 200);
  assert.equal((await app.request('GET', '/api/v1/users/me', { token: other.token })).data.email, 'taken@a.example');
});

test('company settings: owner-only, currency locked once records exist, fiscal change needs confirmation', async (t) => {
  const app = await createTestApp();
  t.after(app.close);
  const ctx = await setup(app);
  const renamed = await ctx.call('PATCH', '/companies/current', { name: 'Renamed LLC', industry: 'Retail' });
  assert.deepEqual([renamed.data.name, renamed.data.industry], ['Renamed LLC', 'Retail']);
  assertErrorEnvelope(await ctx.call('PATCH', '/companies/current', { currency: 'USD' }), 'UNPROCESSABLE');
  assertErrorEnvelope(await ctx.call('PATCH', '/companies/current', { companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }), 'VALIDATION_ERROR');
  assert.equal((await ctx.call('PATCH', '/companies/current', { fiscalYearStartMonth: 4 })).data.fiscalYearStartMonth, 4, 'no transactions yet: no confirmation needed');
  await recordTransaction(app.request, ctx.token, { type: 'income', amount: uzs(1), date: TODAY, accountId: ctx.account.id, payee: 'C' });
  assertErrorEnvelope(await ctx.call('PATCH', '/companies/current', { fiscalYearStartMonth: 7 }), 'UNPROCESSABLE');
  assert.equal((await ctx.call('PATCH', '/companies/current', { fiscalYearStartMonth: 7, confirm: true })).data.fiscalYearStartMonth, 7);

  const members = (await ctx.call('GET', '/companies/current/members')).data;
  assertErrorEnvelope(await ctx.call('PATCH', `/members/${members[0].id}`, { role: 'member' }), 'UNPROCESSABLE');
  assertErrorEnvelope(await ctx.call('PATCH', '/members/mem_01M3EFNC4TMGZ36SQ8D1WYJ2TK', { role: 'member' }), 'NOT_FOUND');
  assert.equal((await ctx.call('PATCH', `/members/${members[0].id}`, { role: 'owner' })).data.role, 'owner');

  // A member (added directly: invitations are not part of the API) cannot change configuration.
  const member = await registerUser(app.request, { email: 'm@a.example' });
  app.db.run("INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES ('mem_01M3EFNC4TMGZ36SQ8D1WYJ2TA', ?, ?, 'member', ?)", [member.user.id, ctx.company.id, new Date().toISOString()]);
  assertErrorEnvelope(await ctx.call('PATCH', '/companies/current', { name: 'Hijack' }, member.token), 'FORBIDDEN');
  assertErrorEnvelope(await ctx.call('POST', '/companies/current/demo-data', {}, member.token), 'FORBIDDEN');
  assert.equal((await ctx.call('GET', '/dashboard', undefined, member.token)).status, 200, 'members read financial screens');
});

test('demo data reset and removal keep the user\'s own accountant requests and assistant history', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  const { token } = await registerUser(app.request, { email: 'demo@a.example' });
  await app.request('POST', '/api/v1/companies', { token, body: { name: 'Demo Workspace', currency: 'UZS' } });
  const call = (method, path, body) => app.request(method, `/api/v1${path}`, { token, body });

  const request = await call('POST', '/accountants/requests', { contactName: 'Owner', contactEmail: 'owner@a.example', topic: 'tax_preparation', description: 'Year-end help' });
  assert.equal(request.status, 201, request.raw);
  assert.equal((await call('POST', '/ai/assistant/messages', { message: 'What is my cash balance?' })).status, 201);

  const kept = async (label) => {
    assert.equal((await call('GET', '/accountants/requests')).data.length, 1, `${label}: accountant request kept`);
    assert.equal((await call('GET', '/ai/assistant/messages')).meta.total, 2, `${label}: assistant history kept`);
  };
  assert.equal((await call('POST', '/companies/current/demo-data', {})).status, 200);
  for (const document of (await call('GET', '/documents')).data) await settled(app.request, token, document.id);
  assert.equal((await call('POST', '/companies/current/demo-data', {})).status, 200);
  for (const document of (await call('GET', '/documents')).data) await settled(app.request, token, document.id);
  await kept('after reset');
  assert.equal((await call('DELETE', '/companies/current/demo-data')).status, 204);
  await kept('after removal');
});

test('demo data: coherent, calculated, labelled, isolated, resettable and removable', async (t) => {
  const app = await createDocumentsApp();
  t.after(app.close);
  const { user, token } = await registerUser(app.request, { email: 'demo@a.example' });
  await app.request('POST', '/api/v1/companies', { token, body: { name: 'Demo Workspace', currency: 'UZS' } });
  const call = (method, path, body) => app.request(method, `/api/v1${path}`, { token, body });

  const loaded = await call('POST', '/companies/current/demo-data', {});
  assert.equal(loaded.status, 200, loaded.raw);
  assert.equal(loaded.data.company.isDemo, true);
  assert.ok(loaded.data.loaded.transactions > 50 && loaded.data.loaded.invoices >= 5);
  const documents = (await call('GET', '/documents')).data;
  for (const document of documents) await settled(app.request, token, document.id);
  assert.equal(documents.length, 2);

  // Coherence: statements tie to the ledger and to each other.
  const overview = (await call('GET', '/financials/overview?period=last_month')).data;
  const pnl = (await call('GET', '/reports/profit-and-loss?period=last_month')).data;
  assert.deepEqual([pnl.revenue.amount, pnl.expenses.amount], [overview.income, overview.expenses]);
  const sheet = (await call('GET', '/reports/balance-sheet')).data;
  assert.equal(sheet.balanced, true);
  assert.ok(!sheet.completeness.issues.some((issue) => issue.code === 'unreconciled_opening_balances'), 'demo opening balances agree');
  const accounts = (await call('GET', '/companies/current/accounts')).data;
  const cash = accounts.filter((a) => a.acceptsTransactions).reduce((total, a) => total + a.balance.amount.amount, 0);
  assert.equal(sheet.assets.total.amount, cash, 'account balances tie to the balance sheet');
  assert.ok(accounts.every((a) => a.name.startsWith('Demo')), 'demo records are labelled');
  assert.ok(accounts.filter((a) => a.acceptsTransactions).every((a) => a.balance.amount.amount >= 0));
  const dashboard = (await call('GET', '/dashboard')).data;
  assert.equal(dashboard.company.isDemo, true);
  assert.equal(dashboard.outstandingInvoices.receivable.overdueCount, 1);
  const detection = (await call('POST', '/ai/anomalies/detect', { period: 'last_month' })).data;
  assert.deepEqual([...new Set(detection.flagsInPeriod.map((flag) => flag.rule.id))].sort(), ['amount_outlier', 'possible_duplicate']);
  const forecast = (await call('POST', '/forecast', { horizonDays: 90 })).data;
  assert.ok(forecast.history.sufficient && forecast.assumptions.recurring.length >= 3);

  // Reset gives the same dataset again; real data blocks loading.
  const reset = await call('POST', '/companies/current/demo-data', {});
  assert.deepEqual(reset.data.loaded, loaded.data.loaded);
  for (const document of (await call('GET', '/documents')).data) await settled(app.request, token, document.id);

  assert.equal((await call('DELETE', '/companies/current/demo-data')).status, 204);
  const cleared = (await call('GET', '/dashboard')).data;
  assert.equal(cleared.empty, true);
  assert.equal(cleared.company.isDemo, false);
  assert.equal((await call('GET', '/companies/current/categories')).data.length, 1, 'only Uncategorized remains');
  assert.equal(app.db.getValue('SELECT count(*) FROM memberships WHERE user_id = ?', [user.id]), 1, 'members are kept');
  assertErrorEnvelope(await call('DELETE', '/companies/current/demo-data'), 'UNPROCESSABLE');

  const real = await ledgerOwner(app.request, { email: 'real@a.example', companyName: 'Real' });
  await recordTransaction(app.request, real.token, { type: 'income', amount: uzs(5), date: TODAY, accountId: real.account.id, payee: 'C' });
  assertErrorEnvelope(await app.request('POST', '/api/v1/companies/current/demo-data', { token: real.token, body: {} }), 'CONFLICT');
  assert.equal(app.db.getValue('SELECT count(*) FROM transactions t JOIN companies c ON c.id = t.company_id WHERE c.name = ?', ['Real']), 1, 'real data untouched');
});
