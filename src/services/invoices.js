/**
 * Invoice management (PRODUCT_REQUIREMENTS.md #9, API_CONTRACT.md §9.7):
 * contacts, invoices with line items, status transitions and payment.
 *
 * Lifecycle (stored status draft | sent | paid | cancelled; "overdue" is
 * derived — sent and past the due date, compared with today's UTC date):
 *
 *   draft ──send──▶ sent ──payment──▶ paid
 *     │               │                 │
 *     └──cancel──▶ cancelled ◀──cancel──┘   (a draft may also be deleted)
 *
 * - Payment creates the invoice's income (receivable) or expense (payable)
 *   transaction through the ledger service and links it, in one database
 *   transaction. The financial engine then sees it like any other
 *   transaction; nothing here computes ledger figures.
 * - Cancelling a paid invoice deletes its payment transaction in the same
 *   database transaction (decided by Sardor for Phase 4), so the ledger and
 *   the invoice never disagree.
 * - Paid and cancelled invoices cannot be edited (422).
 */

import { createHash } from 'node:crypto';
import { badRequest, conflict, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIsoTimestamp, requestedPeriod, todayIso } from '../lib/dates.js';
import { moneyJson } from '../lib/money.js';
import * as companies from '../models/companies.js';
import * as contacts from '../models/contacts.js';
import * as invoices from '../models/invoices.js';
import * as idempotency from '../models/idempotency.js';
import * as transactions from '../models/transactions.js';
import { computeInvoiceTotals } from './invoiceTotals.js';

/** Which contact type an invoice type needs. */
const CONTACT_TYPE_FOR = Object.freeze({ receivable: 'customer', payable: 'vendor' });
/** Which transaction a payment creates. */
const TRANSACTION_TYPE_FOR = Object.freeze({ receivable: 'income', payable: 'expense' });

/** The status a client sees: 'sent' past its due date is 'overdue'. */
export function effectiveStatus(invoice, today = todayIso()) {
  return invoice.status === 'sent' && invoice.dueDate < today ? 'overdue' : invoice.status;
}

export function createInvoiceService({ db, ledger }) {
  function companyCurrency(companyId) {
    return companies.getCompany(db, companyId).currency;
  }

  function presentContact(contact) {
    return { ...contact };
  }

  function presentLineItem(line, currency) {
    return {
      id: line.id,
      description: line.description,
      quantity: line.quantity,
      unitPrice: moneyJson(line.unitPriceMinor, currency),
      taxRate: line.taxRate,
      lineTotal: moneyJson(line.lineTotalMinor, currency),
      tax: moneyJson(line.taxMinor, currency),
    };
  }

  function presentInvoice(companyId, invoice, { withLines = true } = {}) {
    const { currency } = invoice;
    const presented = {
      id: invoice.id,
      number: invoice.number,
      type: invoice.type,
      contact: invoice.contact,
      status: effectiveStatus(invoice),
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency,
      subtotal: moneyJson(invoice.subtotalMinor, currency),
      tax: moneyJson(invoice.taxMinor, currency),
      total: moneyJson(invoice.totalMinor, currency),
      notes: invoice.notes,
      payment: invoice.paidTransactionId
        ? { transactionId: invoice.paidTransactionId, date: invoice.paidDate, accountId: invoice.paidAccountId }
        : null,
      sentAt: invoice.sentAt,
      cancelledAt: invoice.cancelledAt,
      createdAt: invoice.createdAt,
      updatedAt: invoice.updatedAt,
    };
    if (withLines) {
      presented.lineItems = invoices.listLineItems(db, companyId, invoice.id).map((line) => presentLineItem(line, currency));
    }
    return presented;
  }

  function requireInvoice(companyId, invoiceId) {
    const invoice = invoices.findInvoice(db, companyId, invoiceId);
    if (!invoice) throw notFound('Invoice not found.');
    return invoice;
  }

  /** The contact must be in this company and of the type the invoice needs. */
  function requireContactFor(companyId, contactId, invoiceType) {
    const contact = contacts.findContact(db, companyId, contactId);
    if (!contact) throw unprocessable('Contact not found.', [{ field: 'contactId', issue: 'no such contact in this company' }]);
    const needed = CONTACT_TYPE_FOR[invoiceType];
    if (contact.type !== needed) {
      throw unprocessable(`A ${invoiceType} invoice needs a ${needed} contact.`, [{ field: 'contactId', issue: `must be a ${needed}` }]);
    }
    return contact;
  }

  function assertUniqueNumber(companyId, number, exceptId) {
    const existing = invoices.findInvoiceByNumber(db, companyId, number);
    if (existing && existing.id !== exceptId) {
      throw conflict('An invoice with this number already exists.', [{ field: 'number', issue: 'must be unique in the company' }]);
    }
  }

  function assertDueAfterIssue(issueDate, dueDate) {
    if (dueDate < issueDate) {
      throw badRequest('The due date cannot be before the issue date.', [{ field: 'dueDate', issue: 'must be on or after issueDate' }]);
    }
  }

  /** Line items in the company currency -> computed lines and totals. */
  function computeLines(lineItems, currency) {
    lineItems.forEach((line, index) => {
      if (line.unitPrice.currency !== currency) {
        throw unprocessable(`Amounts must be in the company currency (${currency}).`, [
          { field: `lineItems.${index}.unitPrice.currency`, issue: `must be ${currency}; multi-currency is not supported` },
        ]);
      }
    });
    return computeInvoiceTotals(lineItems.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice.amount,
      taxRate: line.taxRate,
    })));
  }

  function writeLines(companyId, invoiceId, lines) {
    invoices.replaceLineItems(db, companyId, invoiceId, lines, () => newId('inl'));
  }

  function paymentRequestHash(invoiceId, input) {
    const canonical = JSON.stringify({ invoiceId, accountId: input.accountId, date: input.date, categoryId: input.categoryId ?? null });
    return createHash('sha256').update(canonical).digest('hex');
  }

  return {
    // ----------------------------------------------------------- contacts
    listContacts(companyId, query) {
      return contacts.listContacts(db, companyId, query).map(presentContact);
    },

    createContact(companyId, input) {
      return presentContact(contacts.insertContact(db, companyId, {
        id: newId('con'),
        name: input.name,
        type: input.type,
        email: input.email ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        now: nowIsoTimestamp(),
      }));
    },

    updateContact(companyId, contactId, changes) {
      return db.transaction(() => {
        const current = contacts.findContact(db, companyId, contactId);
        if (!current) throw notFound('Contact not found.');
        const next = { ...current, ...changes };
        if (next.type !== current.type) {
          const used = contacts.invoiceTypesForContact(db, companyId, contactId);
          if (used.length > 0) {
            throw unprocessable('The contact type cannot change while invoices use this contact.', [
              { field: 'type', issue: 'contact is used by invoices' },
            ]);
          }
        }
        return presentContact(contacts.updateContact(db, companyId, contactId, { ...next, now: nowIsoTimestamp() }));
      });
    },

    // ----------------------------------------------------------- invoices
    listInvoices(companyId, query) {
      let { from, to } = query;
      if (query.period) {
        const { fiscalYearStartMonth } = companies.getCompany(db, companyId);
        ({ start: from, end: to } = requestedPeriod(query, { fiscalStartMonth: fiscalYearStartMonth }));
      }
      const { items, total } = invoices.listInvoices(db, companyId, {
        filters: { statuses: query.status, type: query.type, contactId: query.contactId, from, to, q: query.q },
        sort: query.sort,
        page: query.page,
        limit: query.limit,
        today: todayIso(),
      });
      return { items: items.map((invoice) => presentInvoice(companyId, invoice, { withLines: false })), total };
    },

    getInvoice(companyId, invoiceId) {
      return presentInvoice(companyId, requireInvoice(companyId, invoiceId));
    },

    createInvoice(companyId, input) {
      return db.transaction(() => {
        const currency = companyCurrency(companyId);
        requireContactFor(companyId, input.contactId, input.type);
        assertUniqueNumber(companyId, input.number);
        assertDueAfterIssue(input.issueDate, input.dueDate);
        const totals = computeLines(input.lineItems, currency);
        const id = newId('inv');
        invoices.insertInvoice(db, companyId, {
          id,
          number: input.number,
          type: input.type,
          contactId: input.contactId,
          currency,
          issueDate: input.issueDate,
          dueDate: input.dueDate,
          subtotalMinor: totals.subtotalMinor,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          notes: input.notes ?? null,
          now: nowIsoTimestamp(),
        });
        writeLines(companyId, id, totals.lines);
        return presentInvoice(companyId, requireInvoice(companyId, id));
      });
    },

    /** Draft and sent (incl. overdue) invoices only; line items are replaced as a whole. */
    updateInvoice(companyId, invoiceId, changes) {
      return db.transaction(() => {
        const current = requireInvoice(companyId, invoiceId);
        if (current.status === 'paid' || current.status === 'cancelled') {
          throw unprocessable(`A ${current.status} invoice cannot be edited.`, [{ field: 'status', issue: `invoice is ${current.status}` }]);
        }
        const next = {
          number: changes.number ?? current.number,
          contactId: changes.contactId ?? current.contact.id,
          issueDate: changes.issueDate ?? current.issueDate,
          dueDate: changes.dueDate ?? current.dueDate,
          notes: changes.notes === undefined ? current.notes : changes.notes,
          subtotalMinor: current.subtotalMinor,
          taxMinor: current.taxMinor,
          totalMinor: current.totalMinor,
        };
        if (changes.number !== undefined) assertUniqueNumber(companyId, next.number, invoiceId);
        if (changes.contactId !== undefined) requireContactFor(companyId, next.contactId, current.type);
        assertDueAfterIssue(next.issueDate, next.dueDate);
        if (changes.lineItems !== undefined) {
          const totals = computeLines(changes.lineItems, current.currency);
          Object.assign(next, { subtotalMinor: totals.subtotalMinor, taxMinor: totals.taxMinor, totalMinor: totals.totalMinor });
          writeLines(companyId, invoiceId, totals.lines);
        }
        invoices.updateInvoiceDetails(db, companyId, invoiceId, { ...next, now: nowIsoTimestamp() });
        return presentInvoice(companyId, requireInvoice(companyId, invoiceId));
      });
    },

    /**
     * POST /invoices/{id}/status: 'sent' (from draft) or 'cancelled' (from
     * draft, sent/overdue or paid). 'paid' goes through the payment endpoint;
     * 'overdue' is derived; nothing returns to 'draft'.
     */
    transition(companyId, invoiceId, target) {
      return db.transaction(() => {
        const current = requireInvoice(companyId, invoiceId);
        const now = nowIsoTimestamp();
        const invalid = (message) => unprocessable(message, [{ field: 'status', issue: `cannot change from ${effectiveStatus(current)} to ${target}` }]);

        if (target === 'sent') {
          if (current.status !== 'draft') throw invalid('Only a draft invoice can be sent.');
          invoices.setInvoiceStatus(db, companyId, invoiceId, { status: 'sent', now });
        } else if (target === 'cancelled') {
          if (current.status === 'cancelled') throw invalid('The invoice is already cancelled.');
          // Unlink first (a paid invoice must have a payment), then remove the payment.
          invoices.setInvoiceStatus(db, companyId, invoiceId, { status: 'cancelled', now });
          if (current.paidTransactionId) transactions.deleteTransaction(db, companyId, current.paidTransactionId);
        } else if (target === 'paid') {
          throw invalid('Record a payment with POST /invoices/{invoiceId}/payment.');
        } else if (target === 'overdue') {
          throw invalid('Overdue is derived from the due date and payment state; it cannot be set.');
        } else {
          throw invalid('An invoice cannot return to draft.');
        }
        return presentInvoice(companyId, requireInvoice(companyId, invoiceId));
      });
    },

    /**
     * Record the full payment of a sent (or overdue) invoice: create and link
     * its transaction atomically. With an Idempotency-Key, a repeat of the
     * same request returns the stored outcome instead of paying twice.
     *
     * @returns {{ status: number, body: object, replayed: boolean }}
     */
    pay(companyId, invoiceId, input, idempotencyKey) {
      return db.transaction(() => {
        const requestHash = paymentRequestHash(invoiceId, input);
        if (idempotencyKey) {
          const record = idempotency.findIdempotencyRecord(db, companyId, idempotencyKey);
          if (record) {
            if (record.scope !== 'invoice_payment' || record.requestHash !== requestHash) {
              throw unprocessable('This Idempotency-Key was already used for a different request.', [
                { field: 'Idempotency-Key', issue: 'reuse with different parameters' },
              ]);
            }
            return { status: record.status, body: record.body, replayed: true };
          }
        }

        const invoice = requireInvoice(companyId, invoiceId);
        if (invoice.status === 'paid') {
          throw conflict('The invoice is already paid.', [{ field: 'status', issue: `paid by transaction ${invoice.paidTransactionId}` }]);
        }
        if (invoice.status !== 'sent') {
          throw unprocessable(
            invoice.status === 'draft' ? 'Send the invoice before recording its payment.' : 'A cancelled invoice cannot be paid.',
            [{ field: 'status', issue: `invoice is ${invoice.status}` }],
          );
        }
        if (input.date < invoice.issueDate) {
          throw unprocessable('The payment date cannot be before the issue date.', [{ field: 'date', issue: 'must be on or after the issue date' }]);
        }

        const { transaction, possibleDuplicateOf } = ledger.createTransaction(companyId, {
          type: TRANSACTION_TYPE_FOR[invoice.type],
          amount: { amount: invoice.totalMinor, currency: invoice.currency },
          date: input.date,
          accountId: input.accountId,
          categoryId: input.categoryId,
          payee: invoice.contact.name,
          description: `Invoice ${invoice.number}`,
          // A manually recorded copy is reported (meta), not a reason to refuse payment.
          allowDuplicate: true,
        });
        invoices.setInvoiceStatus(db, companyId, invoiceId, { status: 'paid', paidTransactionId: transaction.id, now: nowIsoTimestamp() });

        const body = {
          success: true,
          data: {
            invoice: presentInvoice(companyId, requireInvoice(companyId, invoiceId)),
            transaction: ledger.getTransaction(companyId, transaction.id),
          },
        };
        if (possibleDuplicateOf.length > 0) body.meta = { possibleDuplicateOf };
        if (idempotencyKey) {
          idempotency.insertIdempotencyRecord(db, companyId, {
            key: idempotencyKey, scope: 'invoice_payment', requestHash, status: 201, body, now: nowIsoTimestamp(),
          });
        }
        return { status: 201, body, replayed: false };
      });
    },

    deleteInvoice(companyId, invoiceId) {
      return db.transaction(() => {
        const current = requireInvoice(companyId, invoiceId);
        if (current.status !== 'draft') {
          throw unprocessable('Only a draft invoice can be deleted; cancel it instead.', [{ field: 'status', issue: `invoice is ${effectiveStatus(current)}` }]);
        }
        invoices.deleteInvoice(db, companyId, invoiceId);
      });
    },
  };
}
