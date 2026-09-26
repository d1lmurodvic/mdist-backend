/**
 * Phase 5 routes: /documents (API_CONTRACT.md §9.7). Every route requires a
 * session and a company; members may use all of them (contract: "Yes").
 * The upload body is multipart and is read by the controller, not by the
 * JSON body parser.
 */

import { createRouter } from '../lib/router.js';
import { listQuerySchema, validateBody, z } from '../lib/validate.js';
import { authenticate, requireCompany } from '../middleware/auth.js';
import { createDocumentController } from '../controllers/documents.js';
import { DOCUMENT_SORTABLE_FIELDS } from '../models/documents.js';
import { ledgerSchemas } from './ledger.js';
import { invoiceSchemas } from './invoices.js';

export const DOCUMENT_STATUSES = Object.freeze(['processing', 'ready', 'failed']);

const SORT_PATTERN = new RegExp(`^(${Object.keys(DOCUMENT_SORTABLE_FIELDS).join('|')})(:(asc|desc))?$`);

export const documentSchemas = {
  documentListQuery: listQuerySchema
    .extend({ status: z.array(z.enum(DOCUMENT_STATUSES)).max(3).optional() })
    .superRefine((value, ctx) => {
      if (value.sort !== undefined && !SORT_PATTERN.test(value.sort)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sort'],
          message: `must be one of ${Object.keys(DOCUMENT_SORTABLE_FIELDS).join(', ')}, optionally with :asc or :desc`,
        });
      }
    })
    .transform((value) => {
      const [field, direction = 'desc'] = (value.sort ?? 'createdAt:desc').split(':');
      return { ...value, sort: { field, direction } };
    }),
  // The reviewed values, validated exactly like POST /transactions or POST /invoices.
  confirm: z.discriminatedUnion('target', [
    z.strictObject({ target: z.literal('transaction'), transaction: ledgerSchemas.createTransaction }),
    z.strictObject({ target: z.literal('invoice'), invoice: invoiceSchemas.createInvoice }),
  ]),
};

export function createDocumentsRouter({ services, config }) {
  const controller = createDocumentController({ services, config, schemas: documentSchemas });
  const tenant = [authenticate({ authService: services.auth }), requireCompany({ companyService: services.companies })];

  return createRouter()
    .get('/', ...tenant, controller.list)
    .post('/', ...tenant, controller.upload)
    .get('/:documentId', ...tenant, controller.get)
    .get('/:documentId/file', ...tenant, controller.file)
    .post('/:documentId/extract', ...tenant, controller.extract)
    .post('/:documentId/confirm', ...tenant, validateBody(documentSchemas.confirm), controller.confirm)
    .delete('/:documentId', ...tenant, controller.remove);
}
