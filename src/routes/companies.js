/**
 * /api/v1/companies (API_CONTRACT.md §9.3) — the Phase 2 subset: onboarding
 * creates the company, and the caller's current company can be read.
 * Every route requires a session; /current routes also require a company.
 */

import { createRouter } from '../lib/router.js';
import { currencySchema, validateBody, z } from '../lib/validate.js';
import { authenticate, requireCompany } from '../middleware/auth.js';
import { createCompanyController } from '../controllers/companies.js';
import { mountCompanyLedgerRoutes } from './ledger.js';
import { mountCompanyContactRoutes } from './invoices.js';

const optionalText = z.string().trim().min(1).max(100).nullable().default(null);

/** Onboarding fields (PRODUCT_REQUIREMENTS.md #3). companyId is never accepted. */
export const createCompanySchema = z.strictObject({
  name: z.string().trim().min(1, 'is required').max(200),
  currency: currencySchema,
  industry: optionalText,
  size: optionalText,
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
});

export function createCompaniesRouter({ services }) {
  const router = createRouter();
  const controller = createCompanyController({ services });
  const requireAuth = authenticate({ authService: services.auth });
  const withCompany = requireCompany({ companyService: services.companies });

  router.post('/', requireAuth, validateBody(createCompanySchema), controller.create);
  router.get('/current', requireAuth, withCompany, controller.current);
  // The action takes no input; anything sent (e.g. a companyId) is rejected.
  router.post('/current/complete-onboarding', requireAuth, withCompany, validateBody(z.strictObject({})), controller.completeOnboarding);
  router.get('/current/members', requireAuth, withCompany, controller.members);
  mountCompanyLedgerRoutes(router, { services });
  mountCompanyContactRoutes(router, { services });

  return router;
}
