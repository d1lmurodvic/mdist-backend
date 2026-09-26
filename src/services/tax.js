/**
 * Tax center (PRODUCT_REQUIREMENTS.md #22; API_CONTRACT.md §9.11).
 *
 * Organisation only: figures a professional needs, the gaps in the records,
 * and a period export. IFRSmart calculates no tax, files nothing and gives no
 * advice; no jurisdiction is configured, so no country's rules are applied.
 * Invoice tax amounts are the rates the user typed on invoices, reported as
 * inputs for a preparer.
 */

import { moneyJson } from '../lib/money.js';
import * as analytics from '../models/analytics.js';
import * as categories from '../models/categories.js';
import * as companies from '../models/companies.js';
import { resolveCompanyPeriod } from './periodQuery.js';

export const TAX_DISCLAIMER = 'Inputs for a tax professional, not a tax calculation, filing or advice. No jurisdiction is configured, so no country\'s tax rules are applied.';
export const MAX_EXPORT_TRANSACTIONS = 10000;
const MAX_LISTED_IDS = 100;

export function createTaxService({ db, engine }) {
  function summaryData(companyId, query) {
    const { company, period } = resolveCompanyPeriod(db, companyId, query);
    const { currency } = company;
    const money = (value) => moneyJson(value, currency);
    const totals = engine.periodTotals(companyId, period);
    const names = new Map(categories.listCategories(db, companyId).map((category) => [category.id, category]));
    const byCategory = { income: [], expense: [] };
    for (const row of engine.categoryTotals(companyId, period)) {
      const category = names.get(row.categoryId);
      byCategory[row.type].push({
        category: { id: category.id, name: category.name, parentId: category.parentId, isSystem: category.isSystem },
        total: money(row.total),
        transactionCount: row.count,
      });
    }
    for (const list of Object.values(byCategory)) list.sort((a, b) => b.total.amount - a.total.amount || a.category.name.localeCompare(b.category.name));
    const invoiceTax = engine.paidInvoiceTax(companyId, period);
    return {
      company,
      period,
      data: {
        currency,
        period,
        jurisdiction: null,
        income: { total: money(totals.income), byCategory: byCategory.income },
        expenses: { total: money(totals.expense), byCategory: byCategory.expense },
        transactionCount: totals.transactionCount,
        invoiceTax: {
          basis: 'Invoices whose payment is dated in the period; tax amounts as entered on the invoices.',
          onReceivables: { invoiceCount: invoiceTax.receivable.count, tax: money(invoiceTax.receivable.tax), total: money(invoiceTax.receivable.total) },
          onPayables: { invoiceCount: invoiceTax.payable.count, tax: money(invoiceTax.payable.tax), total: money(invoiceTax.payable.total) },
        },
        empty: totals.transactionCount === 0,
        disclaimer: TAX_DISCLAIMER,
      },
    };
  }

  const listed = (ids) => ({ count: ids.length, transactionIds: ids.slice(0, MAX_LISTED_IDS), truncated: ids.length > MAX_LISTED_IDS });

  return {
    summary(companyId, query) {
      const { data, period } = summaryData(companyId, query);
      return { data, meta: { period } };
    },

    completeness(companyId, query) {
      const { period } = resolveCompanyPeriod(db, companyId, query);
      const uncategorized = analytics.uncategorizedTransactionIds(db, companyId, period);
      const withoutReceipt = analytics.expensesWithoutDocumentIds(db, companyId, period);
      const unpaid = analytics.unpaidInvoiceIdsIssuedBetween(db, companyId, period);
      return {
        data: {
          period,
          uncategorizedTransactions: { ...listed(uncategorized), link: `/api/v1/transactions?from=${period.start}&to=${period.end}&includeUncategorized=true` },
          expensesWithoutReceipt: {
            ...listed(withoutReceipt),
            basis: 'Expenses with no confirmed document linked to them. Invoice payments are excluded: the invoice is their record.',
          },
          invoicesWithoutPayment: {
            count: unpaid.length,
            invoiceIds: unpaid.slice(0, MAX_LISTED_IDS),
            truncated: unpaid.length > MAX_LISTED_IDS,
            basis: 'Sent invoices issued in the period that have no payment recorded.',
          },
          complete: uncategorized.length === 0 && withoutReceipt.length === 0 && unpaid.length === 0,
          note: 'Gaps are listed, not resolved. Missing information is shown as missing, never as zero income or tax.',
          disclaimer: TAX_DISCLAIMER,
        },
        meta: { period },
      };
    },

    export(companyId, query) {
      const { data: summary, period, company } = summaryData(companyId, query);
      const money = (value) => moneyJson(BigInt(value), company.currency);
      const rows = analytics.transactionsForExport(db, companyId, { ...period, limit: MAX_EXPORT_TRANSACTIONS + 1 });
      const truncated = rows.length > MAX_EXPORT_TRANSACTIONS;
      const current = companies.getCompany(db, companyId);
      return {
        data: {
          company: { name: current.name, currency: current.currency, isDemo: current.isDemo },
          period,
          summary,
          transactions: rows.slice(0, MAX_EXPORT_TRANSACTIONS).map((row) => ({
            id: row.id, date: row.date, type: row.type, amount: money(row.amount_minor), category: row.category,
            payee: row.payee, description: row.description, paymentMethod: row.payment_method, source: row.source,
            documentId: row.document_id, invoiceId: row.invoice_id,
          })),
          invoices: analytics.invoicesForExport(db, companyId, period).map((row) => ({
            id: row.id, number: row.number, type: row.type, status: row.status, contact: row.contact,
            issueDate: row.issue_date, dueDate: row.due_date,
            subtotal: money(row.subtotal_minor), tax: money(row.tax_minor), total: money(row.total_minor),
          })),
          format: 'json',
          disclaimer: TAX_DISCLAIMER,
        },
        meta: { period, truncated },
      };
    },
  };
}
