/**
 * API v1 router.
 *
 * Mounted at /api/v1 (API_CONTRACT.md §1). Resource groups are added as their
 * phases land; an unimplemented group is not registered, so an unknown path
 * returns 404 rather than a stub that pretends to work.
 *
 * Registration order for a group:
 *   routes/<group>.js       URL, method, middleware, schema
 *   controllers/<group>.js read validated data, call one service, shape response
 *   services/<group>.js    business rules
 *   models/<group>.js      company-scoped SQL
 *
 * A group router is mounted with router.use('/<group>', groupRouter); it sees
 * paths relative to its mount point ('/login', not '/auth/login').
 */

import { createRouter } from '../lib/router.js';
import { createAuthRouter } from './auth.js';
import { createCompaniesRouter } from './companies.js';
import { createLedgerRouters } from './ledger.js';
import { createInvoiceRouters } from './invoices.js';
import { createDocumentsRouter } from './documents.js';
import { createFinalRouters } from './final.js';

export function createApiV1Router({ db, config, services, rateLimiter }) {
  const router = createRouter();

  // Health probe: unauthenticated, no database detail, no secrets.
  router.get('/health', () => ({
    data: {
      status: 'ok',
      service: 'ifrsmart-backend',
      database: db.closed ? 'closed' : 'connected',
      aiProvider: config.ai.enabled ? config.ai.provider : 'disabled',
      time: new Date().toISOString(),
    },
  }));

  router.use('/auth', createAuthRouter({ services, config, rateLimiter }));
  router.use('/companies', createCompaniesRouter({ services }));

  const ledger = createLedgerRouters({ services });
  router.use('/accounts', ledger.accounts);
  router.use('/categories', ledger.categories);
  router.use('/category-rules', ledger.categoryRules);
  router.use('/transactions', ledger.transactions);
  router.use('/financials', ledger.financials);

  const invoicing = createInvoiceRouters({ services });
  router.use('/contacts', invoicing.contacts);
  router.use('/invoices', invoicing.invoices);

  router.use('/documents', createDocumentsRouter({ services, config }));

  // Final backend completion. /companies and /financials are mounted a second
  // time: a request the earlier router does not match falls through to these.
  const final = createFinalRouters({ services, config });
  router.use('/users', final.users);
  router.use('/companies', final.companies);
  router.use('/members', final.members);
  router.use('/dashboard', final.dashboard);
  router.use('/financials', final.financials);
  router.use('/reports', final.reports);
  router.use('/forecast', final.forecast);
  router.use('/ai', final.ai);
  router.use('/tax', final.tax);
  router.use('/notifications', final.notifications);
  router.use('/accountants', final.accountants);

  return router;
}
