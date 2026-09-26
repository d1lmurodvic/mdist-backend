/**
 * Phase 3 routes: accounts, categories, category rules, transactions and
 * financial views (API_CONTRACT.md §9.3, §9.5, §9.6).
 *
 * Every route requires a session and a company (req.tenant). Configuration
 * writes — accounts, categories, category rules — are owner-only; members
 * record and categorize transactions (API_CONTRACT.md §5).
 */

import { createRouter } from '../lib/router.js';
import {
  dateRangeQuerySchema,
  idSchema,
  isoDateSchema,
  listQuerySchema,
  moneySchema,
  positiveMoneySchema,
  validateBody,
  z,
} from '../lib/validate.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { createLedgerController } from '../controllers/ledger.js';
import { createFinancialsController } from '../controllers/financials.js';
import { SORTABLE_FIELDS } from '../models/transactions.js';

const text = (max) => z.string().trim().min(1).max(max);
const atLeastOneField = (schema) =>
  schema.refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const ACCOUNT_TYPES = Object.freeze(['cash', 'bank', 'liability', 'equity']);
export const TRANSACTION_TYPES = Object.freeze(['income', 'expense']);
export const MAX_BULK_TRANSACTIONS = 100;

/** sort=<field>[:asc|:desc] over a whitelist; default newest first. */
const SORT_PATTERN = new RegExp(`^(${Object.keys(SORTABLE_FIELDS).join('|')})(:(asc|desc))?$`);
const DEFAULT_SORT = 'date:desc';

function checkSort(value, ctx) {
  if (value.sort !== undefined && !SORT_PATTERN.test(value.sort)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sort'],
      message: `must be one of ${Object.keys(SORTABLE_FIELDS).join(', ')}, optionally with :asc or :desc`,
    });
  }
}

function parseSort(value) {
  const [field, direction = 'desc'] = (value ?? DEFAULT_SORT).split(':');
  return { field, direction };
}

export const ledgerSchemas = {
  createAccount: z.strictObject({
    name: text(100),
    type: z.enum(ACCOUNT_TYPES),
    openingBalance: moneySchema.optional(),
  }),
  updateAccount: atLeastOneField(z.strictObject({
    name: text(100).optional(),
    type: z.enum(ACCOUNT_TYPES).optional(),
    openingBalance: moneySchema.optional(),
  })),
  createCategory: z.strictObject({
    name: text(100),
    type: z.enum(TRANSACTION_TYPES),
    parentId: idSchema.nullable().optional(),
  }),
  updateCategory: atLeastOneField(z.strictObject({
    name: text(100).optional(),
    parentId: idSchema.nullable().optional(),
  })),
  createRule: z.strictObject({
    matchType: z.enum(['exact', 'contains']),
    pattern: text(200),
    categoryId: idSchema,
  }),
  createTransaction: z.strictObject({
    type: z.enum(TRANSACTION_TYPES),
    amount: positiveMoneySchema,
    date: isoDateSchema,
    accountId: idSchema,
    categoryId: idSchema.optional(),
    description: text(500).nullable().optional(),
    payee: text(200).nullable().optional(),
    paymentMethod: text(50).nullable().optional(),
    notes: text(2000).nullable().optional(),
    allowDuplicate: z.boolean().optional(),
  }),
  updateTransaction: atLeastOneField(z.strictObject({
    type: z.enum(TRANSACTION_TYPES).optional(),
    amount: positiveMoneySchema.optional(),
    date: isoDateSchema.optional(),
    accountId: idSchema.optional(),
    categoryId: idSchema.optional(),
    description: text(500).nullable().optional(),
    payee: text(200).nullable().optional(),
    paymentMethod: text(50).nullable().optional(),
    notes: text(2000).nullable().optional(),
    reviewStatus: z.enum(['confirmed']).optional(),
  })),
  bulkCategorize: z.strictObject({
    transactionIds: z.array(idSchema).min(1).max(MAX_BULK_TRANSACTIONS),
    categoryId: idSchema,
  }),
  // Query strings: unknown parameters are ignored (API_CONTRACT.md §7).
  transactionListQuery: listQuerySchema
    .extend({
      type: z.enum(TRANSACTION_TYPES).optional(),
      accountId: idSchema.optional(),
      categoryId: z.array(idSchema).max(50).optional(),
      reviewStatus: z.enum(['confirmed', 'needs_review']).optional(),
    })
    .superRefine(checkSort)
    .transform((value) => ({ ...value, sort: parseSort(value.sort) })),
  suggestionQuery: z
    .object({
      type: z.enum(TRANSACTION_TYPES),
      payee: text(200).optional(),
      description: text(500).optional(),
    })
    .refine((value) => value.payee || value.description, { message: 'payee or description is required' }),
  financialsQuery: dateRangeQuerySchema.extend({ granularity: z.enum(['day', 'month']).optional() }),
};

function guards(services) {
  const requireAuth = authenticate({ authService: services.auth });
  const withCompany = requireCompany({ companyService: services.companies });
  return { tenant: [requireAuth, withCompany], owner: [requireAuth, withCompany, requireRole('owner')] };
}

/** Collection routes listed through the company: /companies/current/... */
export function mountCompanyLedgerRoutes(router, { services }) {
  const controller = createLedgerController({ services, schemas: ledgerSchemas });
  const { tenant, owner } = guards(services);
  router.get('/current/accounts', ...tenant, controller.listAccounts);
  router.post('/current/accounts', ...owner, validateBody(ledgerSchemas.createAccount), controller.createAccount);
  router.get('/current/categories', ...tenant, controller.listCategories);
  router.post('/current/categories', ...owner, validateBody(ledgerSchemas.createCategory), controller.createCategory);
  router.get('/current/category-rules', ...tenant, controller.listRules);
  router.post('/current/category-rules', ...owner, validateBody(ledgerSchemas.createRule), controller.createRule);
}

/** Resources addressed at their own root: /accounts, /categories, /category-rules, /transactions, /financials. */
export function createLedgerRouters({ services }) {
  const controller = createLedgerController({ services, schemas: ledgerSchemas });
  const financials = createFinancialsController({ services, schemas: ledgerSchemas });
  const { tenant, owner } = guards(services);

  const accounts = createRouter().patch('/:accountId', ...owner, validateBody(ledgerSchemas.updateAccount), controller.updateAccount);
  const categories = createRouter().patch('/:categoryId', ...owner, validateBody(ledgerSchemas.updateCategory), controller.updateCategory);
  const categoryRules = createRouter().delete('/:ruleId', ...owner, controller.deleteRule);

  const transactions = createRouter()
    .get('/', ...tenant, controller.listTransactions)
    .post('/', ...tenant, validateBody(ledgerSchemas.createTransaction), controller.createTransaction)
    .post('/bulk-categorize', ...tenant, validateBody(ledgerSchemas.bulkCategorize), controller.bulkCategorize)
    .get('/categories-suggestion', ...tenant, controller.suggestCategory)
    .get('/duplicates', ...tenant, controller.duplicates)
    .get('/:transactionId', ...tenant, controller.getTransaction)
    .patch('/:transactionId', ...tenant, validateBody(ledgerSchemas.updateTransaction), controller.updateTransaction)
    .delete('/:transactionId', ...tenant, controller.deleteTransaction);

  const financialsRouter = createRouter()
    .get('/overview', ...tenant, financials.overview)
    .get('/cash-flow', ...tenant, financials.cashFlow);

  return { accounts, categories, categoryRules, transactions, financials: financialsRouter };
}
