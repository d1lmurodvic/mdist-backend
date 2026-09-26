/**
 * Phase 4 routes: contacts and invoices (API_CONTRACT.md §9.3, §9.7).
 * Every route requires a session and a company; members may use all of them
 * (the contract marks them "Yes", not "Owner").
 */

import { createRouter } from '../lib/router.js';
import {
  emailSchema, idSchema, isoDateSchema, listQuerySchema, positiveMoneySchema, validateBody, z,
} from '../lib/validate.js';
import { authenticate, requireCompany } from '../middleware/auth.js';
import { createInvoiceController } from '../controllers/invoices.js';
import { INVOICE_SORTABLE_FIELDS } from '../models/invoices.js';

const text = (max) => z.string().trim().min(1).max(max);
const atLeastOneField = (schema) =>
  schema.refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

export const CONTACT_TYPES = Object.freeze(['customer', 'vendor']);
export const INVOICE_TYPES = Object.freeze(['receivable', 'payable']);
/** Every status a client can see or ask about (API_CONTRACT.md §9.7). */
export const INVOICE_STATUSES = Object.freeze(['draft', 'sent', 'paid', 'overdue', 'cancelled']);
export const MAX_LINE_ITEMS = 200;

const SORT_PATTERN = new RegExp(`^(${Object.keys(INVOICE_SORTABLE_FIELDS).join('|')})(:(asc|desc))?$`);

const lineItemSchema = z.strictObject({
  description: text(500),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPrice: positiveMoneySchema,
  // Basis points: 1200 = 12%. An input for the invoice arithmetic, not tax advice.
  taxRate: z.number().int().min(0).max(10000).default(0),
});

const lineItemsSchema = z.array(lineItemSchema).min(1, 'at least one line item is required').max(MAX_LINE_ITEMS);

export const invoiceSchemas = {
  createContact: z.strictObject({
    name: text(200),
    type: z.enum(CONTACT_TYPES),
    email: emailSchema.nullable().optional(),
    phone: text(50).nullable().optional(),
    address: text(500).nullable().optional(),
  }),
  updateContact: atLeastOneField(z.strictObject({
    name: text(200).optional(),
    type: z.enum(CONTACT_TYPES).optional(),
    email: emailSchema.nullable().optional(),
    phone: text(50).nullable().optional(),
    address: text(500).nullable().optional(),
  })),
  contactListQuery: z.object({
    type: z.enum(CONTACT_TYPES).optional(),
    q: z.string().max(200).optional(),
  }),
  createInvoice: z
    .strictObject({
      number: text(50),
      type: z.enum(INVOICE_TYPES),
      contactId: idSchema,
      issueDate: isoDateSchema,
      dueDate: isoDateSchema,
      notes: text(2000).nullable().optional(),
      lineItems: lineItemsSchema,
    }),
  updateInvoice: atLeastOneField(z.strictObject({
    number: text(50).optional(),
    contactId: idSchema.optional(),
    issueDate: isoDateSchema.optional(),
    dueDate: isoDateSchema.optional(),
    notes: text(2000).nullable().optional(),
    lineItems: lineItemsSchema.optional(),
  })),
  transition: z.strictObject({ status: z.enum(INVOICE_STATUSES) }),
  payment: z.strictObject({
    accountId: idSchema,
    date: isoDateSchema,
    categoryId: idSchema.optional(),
  }),
  invoiceListQuery: listQuerySchema
    .extend({
      status: z.array(z.enum(INVOICE_STATUSES)).max(5).optional(),
      type: z.enum(INVOICE_TYPES).optional(),
      contactId: idSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (value.sort !== undefined && !SORT_PATTERN.test(value.sort)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sort'],
          message: `must be one of ${Object.keys(INVOICE_SORTABLE_FIELDS).join(', ')}, optionally with :asc or :desc`,
        });
      }
    })
    .transform((value) => {
      const [field, direction = 'desc'] = (value.sort ?? 'issueDate:desc').split(':');
      return { ...value, sort: { field, direction } };
    }),
};

function guards(services) {
  return [authenticate({ authService: services.auth }), requireCompany({ companyService: services.companies })];
}

/** Contacts listed and created through the company: /companies/current/contacts. */
export function mountCompanyContactRoutes(router, { services }) {
  const controller = createInvoiceController({ services, schemas: invoiceSchemas });
  const tenant = guards(services);
  router.get('/current/contacts', ...tenant, controller.listContacts);
  router.post('/current/contacts', ...tenant, validateBody(invoiceSchemas.createContact), controller.createContact);
}

export function createInvoiceRouters({ services }) {
  const controller = createInvoiceController({ services, schemas: invoiceSchemas });
  const tenant = guards(services);

  const contacts = createRouter().patch('/:contactId', ...tenant, validateBody(invoiceSchemas.updateContact), controller.updateContact);

  const invoices = createRouter()
    .get('/', ...tenant, controller.list)
    .post('/', ...tenant, validateBody(invoiceSchemas.createInvoice), controller.create)
    .get('/:invoiceId', ...tenant, controller.get)
    .patch('/:invoiceId', ...tenant, validateBody(invoiceSchemas.updateInvoice), controller.update)
    .post('/:invoiceId/status', ...tenant, validateBody(invoiceSchemas.transition), controller.transition)
    .post('/:invoiceId/payment', ...tenant, validateBody(invoiceSchemas.payment), controller.pay)
    .delete('/:invoiceId', ...tenant, controller.remove);

  return { contacts, invoices };
}
