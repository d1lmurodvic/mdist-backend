/**
 * Invoice and contact controllers — HTTP only. The company is always
 * req.tenant.companyId.
 */

import { badRequest, notFound } from '../lib/errors.js';
import { idSchema, parseOrThrow } from '../lib/validate.js';

/** Printable ASCII without spaces, 1–255 characters. */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

function pathId(req, name, message) {
  const result = idSchema.safeParse(req.params[name]);
  if (!result.success) throw notFound(message);
  return result.data;
}

function queryObject(searchParams, repeatable = []) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    query[key] = repeatable.includes(key) ? searchParams.getAll(key) : searchParams.get(key);
  }
  return query;
}

function idempotencyKey(req) {
  const value = req.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw badRequest('The Idempotency-Key header is malformed.', [
      { field: 'Idempotency-Key', issue: 'must be 1–255 printable characters without spaces' },
    ]);
  }
  return value;
}

export function createInvoiceController({ services, schemas }) {
  const { invoices } = services;

  return {
    // ----------------------------------------------------------- contacts
    listContacts(req) {
      const query = parseOrThrow(schemas.contactListQuery, queryObject(req.searchParams));
      return { data: invoices.listContacts(req.tenant.companyId, query) };
    },

    createContact(req) {
      const contact = invoices.createContact(req.tenant.companyId, req.validBody);
      return { status: 201, headers: { Location: `/api/v1/contacts/${contact.id}` }, data: contact };
    },

    updateContact(req) {
      const contactId = pathId(req, 'contactId', 'Contact not found.');
      return { data: invoices.updateContact(req.tenant.companyId, contactId, req.validBody) };
    },

    // ----------------------------------------------------------- invoices
    list(req) {
      const query = parseOrThrow(schemas.invoiceListQuery, queryObject(req.searchParams, ['status']));
      const { items, total } = invoices.listInvoices(req.tenant.companyId, query);
      const totalPages = Math.max(1, Math.ceil(total / query.limit));
      return {
        data: items,
        meta: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages,
          hasNext: query.page < totalPages,
          hasPrevious: query.page > 1,
          sort: `${query.sort.field}:${query.sort.direction}`,
        },
      };
    },

    get(req) {
      return { data: invoices.getInvoice(req.tenant.companyId, pathId(req, 'invoiceId', 'Invoice not found.')) };
    },

    create(req) {
      const invoice = invoices.createInvoice(req.tenant.companyId, req.validBody);
      return { status: 201, headers: { Location: `/api/v1/invoices/${invoice.id}` }, data: invoice };
    },

    update(req) {
      const invoiceId = pathId(req, 'invoiceId', 'Invoice not found.');
      return { data: invoices.updateInvoice(req.tenant.companyId, invoiceId, req.validBody) };
    },

    transition(req) {
      const invoiceId = pathId(req, 'invoiceId', 'Invoice not found.');
      return { data: invoices.transition(req.tenant.companyId, invoiceId, req.validBody.status) };
    },

    pay(req) {
      const invoiceId = pathId(req, 'invoiceId', 'Invoice not found.');
      const key = idempotencyKey(req);
      const outcome = invoices.pay(req.tenant.companyId, invoiceId, req.validBody, key);
      return {
        status: outcome.status,
        headers: outcome.replayed ? { 'Idempotent-Replayed': 'true' } : undefined,
        data: outcome.body.data,
        meta: outcome.body.meta,
      };
    },

    remove(req) {
      invoices.deleteInvoice(req.tenant.companyId, pathId(req, 'invoiceId', 'Invoice not found.'));
      return { status: 204 };
    },
  };
}
