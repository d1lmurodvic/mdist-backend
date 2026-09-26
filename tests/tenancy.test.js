/**
 * Phase 2 tenancy: companies, owner membership and tenant isolation.
 *
 * DEVELOPMENT_RULES.md §9.5: a test proving one company cannot read another's
 * data is required before any feature is called done. Two companies (A and B)
 * are built through the real API in every isolation test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, assertErrorEnvelope, assertSuccessEnvelope } from './helpers/testApp.js';
import { createCompany, errorWithoutRequestId, ownerWithCompany, registerUser } from './helpers/fixtures.js';
import { authenticate, requireCompany, requireRole } from '../src/middleware/auth.js';
import { assertCompanyScope } from '../src/models/tenantScope.js';
import { notFound } from '../src/lib/errors.js';
import * as memberships from '../src/models/memberships.js';

async function twoCompanies() {
  const env = await createTestApp();
  const a = await ownerWithCompany(env.request, { email: 'owner@a.example', companyName: 'Company A' });
  const b = await ownerWithCompany(env.request, { email: 'owner@b.example', companyName: 'Company B' });
  return { ...env, a, b };
}

// ---------------------------------------------------------------- onboarding

test('onboarding creates the company and an owner membership together', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { user, token } = await registerUser(request, { email: 'owner@example.com' });

  const response = await request('POST', '/api/v1/companies', {
    token,
    body: { name: '  Acme LLC ', currency: 'UZS', industry: 'Retail', size: '1-10', fiscalYearStartMonth: 4 },
  });
  assert.equal(response.status, 201);
  assertSuccessEnvelope(response);
  assert.equal(response.headers.get('location'), '/api/v1/companies/current');
  assert.deepEqual(
    { ...response.data, id: 'x', createdAt: 'x', updatedAt: 'x' },
    {
      id: 'x', name: 'Acme LLC', industry: 'Retail', size: '1-10', currency: 'UZS', fiscalYearStartMonth: 4,
      timezone: 'UTC', isDemo: false, onboardedAt: null, createdAt: 'x', updatedAt: 'x',
    },
  );

  const rows = db.all('SELECT user_id, company_id, role FROM memberships');
  assert.deepEqual(rows, [{ user_id: user.id, company_id: response.data.id, role: 'owner' }]);

  const identity = await request('GET', '/api/v1/auth/me', { token });
  assert.equal(identity.data.currentCompanyId, response.data.id);
  assert.deepEqual(identity.data.memberships, [
    { id: identity.data.memberships[0].id, role: 'owner', company: { id: response.data.id, name: 'Acme LLC', onboarded: false } },
  ]);
  assert.deepEqual(identity.data.onboarding, { companyCreated: true, completed: false });
});

test('onboarding is atomic: if the membership fails, no company is left behind', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  db.exec("CREATE TRIGGER fail_memberships BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
  const response = await request('POST', '/api/v1/companies', { token, body: { name: 'Acme', currency: 'UZS' } });
  assert.equal(response.status, 500);
  assertErrorEnvelope(response, 'INTERNAL_ERROR');
  assert.equal(db.getValue('SELECT count(*) FROM companies'), 0, 'the company insert was rolled back');

  db.exec('DROP TRIGGER fail_memberships');
  assert.equal((await request('POST', '/api/v1/companies', { token, body: { name: 'Acme', currency: 'UZS' } })).status, 201);
});

test('one company per user: a second onboarding is a 409 and changes nothing', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });
  await createCompany(request, token);

  const second = await request('POST', '/api/v1/companies', { token, body: { name: 'Second', currency: 'USD' } });
  assert.equal(second.status, 409);
  assertErrorEnvelope(second, 'CONFLICT');
  assert.equal(db.getValue('SELECT count(*) FROM companies'), 1);
});

test('onboarding input is validated, and a client-supplied companyId is refused', async (t) => {
  const { request, db, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });

  const cases = [
    [{ currency: 'UZS' }, 'name'],
    [{ name: 'Acme' }, 'currency'],
    [{ name: 'Acme', currency: 'usd' }, 'currency'],
    [{ name: 'Acme', currency: 'ZZZ' }, 'currency'],
    [{ name: 'Acme', currency: 'UZS', fiscalYearStartMonth: 13 }, 'fiscalYearStartMonth'],
    [{ name: 'Acme', currency: 'UZS', fiscalYearStartMonth: '4' }, 'fiscalYearStartMonth'],
    [{ name: 'Acme', currency: 'UZS', id: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }, '_root'],
    [{ name: 'Acme', currency: 'UZS', companyId: 'cmp_01M3EFNC4TMGZ36SQ8D1WYJ2TK' }, '_root'],
  ];
  for (const [body, field] of cases) {
    const response = await request('POST', '/api/v1/companies', { token, body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.ok(response.error.details.some((detail) => detail.field === field), `${field}: ${response.raw}`);
  }
  assert.equal(db.getValue('SELECT count(*) FROM companies'), 0);
});

test('company routes require a session, and /current requires a company', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);

  const anonymous = await request('POST', '/api/v1/companies', { body: { name: 'Acme', currency: 'UZS' } });
  assert.equal(anonymous.status, 401);
  assertErrorEnvelope(anonymous, 'UNAUTHENTICATED');
  assert.equal((await request('GET', '/api/v1/companies/current')).status, 401);

  const { token } = await registerUser(request, { email: 'owner@example.com' });
  for (const [method, path] of [
    ['GET', '/api/v1/companies/current'],
    ['GET', '/api/v1/companies/current/members'],
    ['POST', '/api/v1/companies/current/complete-onboarding'],
  ]) {
    const response = await request(method, path, { token });
    assert.equal(response.status, 403, `${method} ${path} before onboarding`);
    assertErrorEnvelope(response, 'FORBIDDEN');
  }
});

test('complete-onboarding marks the company once and is idempotent', async (t) => {
  const { request, close } = await createTestApp();
  t.after(close);
  const { token } = await registerUser(request, { email: 'owner@example.com' });
  await createCompany(request, token);

  const first = await request('POST', '/api/v1/companies/current/complete-onboarding', { token });
  assert.equal(first.status, 200);
  assert.ok(first.data.onboardedAt);
  const second = await request('POST', '/api/v1/companies/current/complete-onboarding', { token });
  assert.equal(second.data.onboardedAt, first.data.onboardedAt, 'the original timestamp is kept');

  const identity = await request('GET', '/api/v1/auth/me', { token });
  assert.deepEqual(identity.data.onboarding, { companyCreated: true, completed: true });
});

// ---------------------------------------------------------------- isolation (mandatory)

test('each owner sees exactly their own company', async (t) => {
  const { request, a, b, close } = await twoCompanies();
  t.after(close);

  const currentA = await request('GET', '/api/v1/companies/current', { token: a.token });
  const currentB = await request('GET', '/api/v1/companies/current', { token: b.token });
  assert.equal(currentA.data.id, a.company.id);
  assert.equal(currentA.data.name, 'Company A');
  assert.equal(currentB.data.id, b.company.id);
  assert.ok(!currentA.raw.includes(b.company.id) && !currentA.raw.includes('Company B'));
  assert.ok(!currentB.raw.includes(a.company.id) && !currentB.raw.includes('Company A'));

  const meA = await request('GET', '/api/v1/auth/me', { token: a.token });
  assert.deepEqual(meA.data.memberships.map((m) => m.company.id), [a.company.id]);
  assert.ok(!meA.raw.includes(b.company.id));
});

test('members are listed for the caller\'s company only', async (t) => {
  const { request, a, b, close } = await twoCompanies();
  t.after(close);

  const membersA = await request('GET', '/api/v1/companies/current/members', { token: a.token });
  assert.equal(membersA.status, 200);
  assert.deepEqual(membersA.data.map((member) => [member.user.email, member.role]), [['owner@a.example', 'owner']]);
  assert.ok(!membersA.raw.includes('owner@b.example'));

  const membersB = await request('GET', '/api/v1/companies/current/members', { token: b.token });
  assert.deepEqual(membersB.data.map((member) => member.user.email), ['owner@b.example']);
});

test('a companyId in the query or body never overrides the authenticated tenant', async (t) => {
  const { request, db, a, b, close } = await twoCompanies();
  t.after(close);

  // Query: unknown parameters are ignored (API_CONTRACT §7), so A still gets A.
  const viaQuery = await request('GET', `/api/v1/companies/current?companyId=${b.company.id}`, { token: a.token });
  assert.equal(viaQuery.data.id, a.company.id);
  const membersViaQuery = await request('GET', `/api/v1/companies/current/members?companyId=${b.company.id}`, { token: a.token });
  assert.ok(!membersViaQuery.raw.includes('owner@b.example'));

  // Body: rejected outright, and B is untouched.
  const viaBody = await request('POST', '/api/v1/companies/current/complete-onboarding', {
    token: a.token,
    body: { companyId: b.company.id },
  });
  assert.equal(viaBody.status, 400);
  assertErrorEnvelope(viaBody, 'VALIDATION_ERROR');
  assert.equal(db.getValue('SELECT onboarded_at FROM companies WHERE id = ?', [b.company.id]), null);

  // The action applies to A only.
  await request('POST', '/api/v1/companies/current/complete-onboarding', { token: a.token });
  assert.ok(db.getValue('SELECT onboarded_at FROM companies WHERE id = ?', [a.company.id]));
  assert.equal(db.getValue('SELECT onboarded_at FROM companies WHERE id = ?', [b.company.id]), null);
});

test('another company\'s resource is a 404 indistinguishable from one that does not exist', async (t) => {
  const { app, request, a, b, close } = await twoCompanies();
  t.after(close);

  // An id-addressed, company-scoped read built exactly as feature routes will
  // be: session -> tenant from membership -> scoped model query.
  const { services } = app;
  app.apiRouter.get(
    '/__test/members/:memberId',
    authenticate({ authService: services.auth }),
    requireCompany({ companyService: services.companies }),
    (req) => {
      const member = services.companies.findMember(req.tenant.companyId, req.params.memberId);
      if (!member) throw notFound('Member not found.');
      return { data: member };
    },
  );
  const [memberA] = (await request('GET', '/api/v1/companies/current/members', { token: a.token })).data;
  const [memberB] = (await request('GET', '/api/v1/companies/current/members', { token: b.token })).data;

  // Own resources are found.
  assert.equal((await request('GET', `/api/v1/__test/members/${memberA.id}`, { token: a.token })).data.id, memberA.id);
  assert.equal((await request('GET', `/api/v1/__test/members/${memberB.id}`, { token: b.token })).data.id, memberB.id);

  // Cross-tenant, in both directions, is a 404 — the same response as an id
  // that exists nowhere, so the other company's data is not even confirmed.
  const aReadsB = await request('GET', `/api/v1/__test/members/${memberB.id}`, { token: a.token });
  const bReadsA = await request('GET', `/api/v1/__test/members/${memberA.id}`, { token: b.token });
  const nowhere = await request('GET', '/api/v1/__test/members/mem_01M3EFNC4TMGZ36SQ8D1WYJ2TK', { token: a.token });
  for (const response of [aReadsB, bReadsA, nowhere]) {
    assert.equal(response.status, 404);
    assertErrorEnvelope(response, 'NOT_FOUND');
  }
  assert.deepEqual(errorWithoutRequestId(aReadsB), errorWithoutRequestId(nowhere));
  assert.deepEqual(errorWithoutRequestId(bReadsA), errorWithoutRequestId(nowhere));
  assert.ok(!aReadsB.raw.includes('owner@b.example') && !bReadsA.raw.includes('owner@a.example'));

  // The same holds at the model layer.
  assert.equal(memberships.findMemberInCompany(app.db, a.company.id, memberB.id), undefined);
  assert.equal(memberships.findMemberInCompany(app.db, b.company.id, memberA.id), undefined);
});

test('tenant-scoped models refuse to run without a company scope', () => {
  for (const missing of [undefined, null, '', 42]) {
    assert.throws(() => assertCompanyScope(missing), /without a companyId/);
  }
  assert.equal(assertCompanyScope('cmp_1'), 'cmp_1');
});

// ---------------------------------------------------------------- roles

test('roles: a member reads the company but owner-only actions are 403', async (t) => {
  const { app, request, db, a, close } = await twoCompanies();
  t.after(close);

  // Members cannot be invited through the API yet; add one directly.
  const member = await registerUser(request, { email: 'member@a.example', name: 'Member' });
  db.run('INSERT INTO memberships (id, user_id, company_id, role, created_at) VALUES (?, ?, ?, ?, ?)', [
    'mem_01M3EFNC4TMGZ36SQ8D1WYJ2TA', member.user.id, a.company.id, 'member', new Date().toISOString(),
  ]);

  const { services } = app;
  app.apiRouter.post(
    '/__test/owner-only',
    authenticate({ authService: services.auth }),
    requireCompany({ companyService: services.companies }),
    requireRole('owner'),
    (req) => ({ data: { companyId: req.tenant.companyId, role: req.tenant.role } }),
  );

  const asMember = await request('POST', '/api/v1/__test/owner-only', { token: member.token, body: {} });
  assert.equal(asMember.status, 403);
  assertErrorEnvelope(asMember, 'FORBIDDEN');
  const asOwner = await request('POST', '/api/v1/__test/owner-only', { token: a.token, body: {} });
  assert.deepEqual(asOwner.data, { companyId: a.company.id, role: 'owner' });

  const memberView = await request('GET', '/api/v1/companies/current', { token: member.token });
  assert.equal(memberView.data.id, a.company.id, 'the member resolves to company A');
  const identity = await request('GET', '/api/v1/auth/me', { token: member.token });
  assert.equal(identity.data.memberships[0].role, 'member');
});

test('403 and 401 responses never reveal another tenant', async (t) => {
  const { request, a, b, close } = await twoCompanies();
  t.after(close);
  const { token } = await registerUser(request, { email: 'fresh@example.com' });

  const noCompany = await request('GET', '/api/v1/companies/current', { token });
  const bogus = await request('GET', '/api/v1/companies/current', { token: 'C'.repeat(43) });
  for (const response of [noCompany, bogus]) {
    for (const secret of [a.company.id, b.company.id, 'Company A', 'Company B']) {
      assert.ok(!response.raw.includes(secret), response.raw);
    }
  }
  assert.equal(errorWithoutRequestId(bogus).code, 'UNAUTHENTICATED');
  assert.equal(errorWithoutRequestId(noCompany).code, 'FORBIDDEN');
});
