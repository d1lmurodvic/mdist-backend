/**
 * Demo data (PRODUCT_REQUIREMENTS.md #26; API_CONTRACT.md §9.3).
 *
 * The seed writes records only — accounts, categories, a rule, transactions,
 * contacts, invoices and documents — through the same services and
 * validation as the API. Nothing derived is stored: balances, statements,
 * insights, anomalies, forecasts and health are computed from these records
 * like any company's. Dates are relative to today and all amounts are fixed,
 * so a reset gives the same coherent dataset.
 *
 * Isolation: demo data is only loaded into a company with no business records
 * (which is then flagged is_demo) or into a company already flagged demo
 * (reset). Removal clears the demo company's records and the flag, leaving
 * the company, its members and the Uncategorized category.
 */

import { conflict, unprocessable } from '../lib/errors.js';
import { addDays, addMonths, nowIsoTimestamp, startOfMonth, todayIso } from '../lib/dates.js';
import * as analytics from '../models/analytics.js';
import * as companies from '../models/companies.js';
import * as settings from '../models/settings.js';
import { ledgerSchemas } from '../routes/ledger.js';
import { invoiceSchemas } from '../routes/invoices.js';

const DEMO_PDF = Buffer.from('%PDF-1.4\n% IFRSmart demo receipt\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const DEMO_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/** A fixed, reproducible variation (0–4) instead of randomness. */
const vary = (a, b) => (a * 7 + b * 13) % 5;

export function createDemoDataService({ db, ledger, invoices, documents, storage }) {
  function hasRecords(companyId) {
    const counts = analytics.companyRecordCounts(db, companyId);
    return Object.values(counts).some((count) => count > 0);
  }

  async function clear(companyId) {
    const storageKeys = db.transaction(() => settings.clearCompanyData(db, companyId));
    for (const key of storageKeys) await storage.remove(key);
  }

  function seedRecords(companyId, currency, today) {
    const money = (amount) => ({ amount, currency });
    const account = (input) => ledger.createAccount(companyId, ledgerSchemas.createAccount.parse(input));
    const category = (name, type) => ledger.createCategory(companyId, ledgerSchemas.createCategory.parse({ name, type }));
    const record = (input) => {
      const body = ledgerSchemas.createTransaction.parse({ allowDuplicate: true, ...input, amount: money(input.amount) });
      return ledger.createTransaction(companyId, body).transaction;
    };

    const bank = account({ name: 'Demo — Main bank', type: 'bank', openingBalance: money(50_000_000) });
    const cash = account({ name: 'Demo — Cash desk', type: 'cash', openingBalance: money(8_000_000) });
    account({ name: 'Demo — Bank loan', type: 'liability', openingBalance: money(20_000_000) });
    account({ name: 'Demo — Owner equity', type: 'equity', openingBalance: money(38_000_000) });

    const c = {
      sales: category('Sales', 'income'),
      consulting: category('Consulting', 'income'),
      rent: category('Rent', 'expense'),
      salaries: category('Salaries', 'expense'),
      utilities: category('Utilities', 'expense'),
      marketing: category('Marketing', 'expense'),
      supplies: category('Office supplies', 'expense'),
      software: category('Software', 'expense'),
      travel: category('Travel', 'expense'),
    };
    ledger.createRule(companyId, ledgerSchemas.createRule.parse({ matchType: 'contains', pattern: 'korzinka', categoryId: c.supplies.id }));

    const thisMonth = startOfMonth(today);
    const lastMonth = addMonths(thisMonth, -1);
    for (let m = 7; m >= 0; m -= 1) {
      const month = addMonths(thisMonth, -m);
      const day = (d) => addDays(month, d - 1);
      const due = (d) => day(d) <= today;
      if (due(1)) record({ type: 'expense', amount: 6_000_000, date: day(1), accountId: bank.id, categoryId: c.rent.id, payee: 'City Properties LLC' });
      if (due(5)) record({ type: 'expense', amount: 450_000, date: day(5), accountId: bank.id, categoryId: c.software.id, payee: 'CloudSoft' });
      if (due(10)) record({ type: 'expense', amount: 900_000 + m * 37_000, date: day(10), accountId: bank.id, categoryId: c.utilities.id, payee: 'Toshkent Energy' });
      if (due(12)) {
        // The last full month carries a marketing campaign far above the usual spend.
        const campaign = month === lastMonth;
        record({ type: 'expense', amount: campaign ? 9_500_000 : 1_200_000 + vary(m, 1) * 50_000, date: day(12), accountId: bank.id, categoryId: c.marketing.id, payee: 'AdSpot Media' });
      }
      if (due(25)) record({ type: 'expense', amount: 18_000_000, date: day(25), accountId: bank.id, categoryId: c.salaries.id, payee: 'Payroll' });
      if (due(28)) record({ type: 'expense', amount: 25_000, date: day(28), accountId: bank.id, description: 'Bank service fee' });
      for (const [index, d] of [8, 20].entries()) {
        if (due(d)) record({ type: 'expense', amount: 300_000 + vary(m, index) * 40_000, date: day(d), accountId: cash.id, payee: 'Korzinka' });
      }
      for (const [week, d] of [3, 10, 17, 24].entries()) {
        if (due(d)) record({ type: 'income', amount: 7_500_000 + vary(m, week) * 250_000, date: day(d), accountId: bank.id, categoryId: c.sales.id, payee: 'Retail sales' });
      }
    }
    // Last month's utility bill charged a second time two days later (a possible duplicate to review).
    record({ type: 'expense', amount: 900_000 + 37_000, date: addDays(lastMonth, 11), accountId: bank.id, categoryId: c.utilities.id, payee: 'Toshkent Energy' });
    // A first payment to a new counterparty this month.
    record({ type: 'expense', amount: 3_200_000, date: today, accountId: bank.id, categoryId: c.travel.id, payee: 'Uzbekistan Airways' });

    const contact = (input) => invoices.createContact(companyId, invoiceSchemas.createContact.parse(input));
    const samarkand = contact({ name: 'Samarkand Trading LLC', type: 'customer', email: 'accounts@samarkand-trading.example' });
    const bukhara = contact({ name: 'Bukhara Textiles', type: 'customer' });
    const officePro = contact({ name: 'Office Pro Supplies', type: 'vendor' });
    const adspot = contact({ name: 'AdSpot Media', type: 'vendor' });

    const invoice = (input) => invoices.createInvoice(companyId, invoiceSchemas.createInvoice.parse({
      ...input,
      lineItems: input.lineItems.map((line) => ({ ...line, unitPrice: money(line.unitPrice) })),
    }));
    const send = (created) => invoices.transition(companyId, created.id, 'sent');
    const pay = (created, date, categoryId) => invoices.pay(companyId, created.id, invoiceSchemas.payment.parse({ accountId: bank.id, date, categoryId }), null);

    const paidReceivable = invoice({ number: 'DEMO-INV-001', type: 'receivable', contactId: samarkand.id, issueDate: addDays(lastMonth, -20), dueDate: addDays(lastMonth, 5),
      lineItems: [{ description: 'Consulting — process review', quantity: 4, unitPrice: 1_000_000, taxRate: 1200 }] });
    send(paidReceivable);
    pay(paidReceivable, addDays(lastMonth, 3), c.consulting.id);

    const openReceivable = invoice({ number: 'DEMO-INV-002', type: 'receivable', contactId: bukhara.id, issueDate: addDays(today, -10), dueDate: addDays(today, 20),
      lineItems: [{ description: 'Consulting — monthly retainer', quantity: 1, unitPrice: 5_000_000, taxRate: 1200 }] });
    send(openReceivable);

    const overdueReceivable = invoice({ number: 'DEMO-INV-003', type: 'receivable', contactId: samarkand.id, issueDate: addDays(today, -40), dueDate: addDays(today, -10),
      lineItems: [{ description: 'Training workshop', quantity: 2, unitPrice: 1_500_000 }] });
    send(overdueReceivable);

    invoice({ number: 'DEMO-INV-004', type: 'receivable', contactId: bukhara.id, issueDate: today, dueDate: addDays(today, 30),
      lineItems: [{ description: 'Draft proposal', quantity: 1, unitPrice: 2_500_000 }] });

    const cancelled = invoice({ number: 'DEMO-INV-005', type: 'receivable', contactId: bukhara.id, issueDate: addDays(today, -25), dueDate: addDays(today, 5),
      lineItems: [{ description: 'Cancelled order', quantity: 1, unitPrice: 800_000 }] });
    send(cancelled);
    invoices.transition(companyId, cancelled.id, 'cancelled');

    const openPayable = invoice({ number: 'DEMO-BILL-001', type: 'payable', contactId: officePro.id, issueDate: addDays(today, -3), dueDate: addDays(today, 12),
      lineItems: [{ description: 'Office furniture', quantity: 3, unitPrice: 1_400_000, taxRate: 1200 }] });
    send(openPayable);

    const paidPayable = invoice({ number: 'DEMO-BILL-002', type: 'payable', contactId: adspot.id, issueDate: addDays(lastMonth, 1), dueDate: addDays(lastMonth, 20),
      lineItems: [{ description: 'Outdoor advertising', quantity: 1, unitPrice: 2_000_000 }] });
    send(paidPayable);
    pay(paidPayable, addDays(lastMonth, 18), c.marketing.id);
  }

  return {
    async load(companyId) {
      const company = companies.getCompany(db, companyId);
      if (!company.isDemo && hasRecords(companyId)) {
        throw conflict('Demo data can only be loaded into an empty workspace or a demo company; this company already has its own records.', [
          { field: 'company', issue: 'has records that are not demo data' },
        ]);
      }
      if (company.isDemo) await clear(companyId);
      const today = todayIso();
      db.transaction(() => {
        settings.setDemoFlag(db, companyId, true, nowIsoTimestamp());
        seedRecords(companyId, company.currency, today);
      });
      // Documents go through the real upload pipeline, so their extraction
      // results are whatever the configured reader actually produces.
      const uploaded = [
        await documents.upload(companyId, { bytes: DEMO_PDF, declaredType: 'application/pdf', filename: 'demo-receipt-office-supplies.pdf' }),
        await documents.upload(companyId, { bytes: DEMO_PNG, declaredType: 'image/png', filename: 'demo-invoice-scan.png' }),
      ];
      const counts = analytics.companyRecordCounts(db, companyId);
      return {
        data: { company: companies.getCompany(db, companyId), loaded: { ...counts, documents: uploaded.length } },
        meta: { demo: true, note: 'Demo data: a fictional dataset, clearly flagged. Every figure is calculated from these records.' },
      };
    },

    async remove(companyId) {
      const company = companies.getCompany(db, companyId);
      if (!company.isDemo) {
        throw unprocessable('This company is not a demo company; its records are real and are not removed.', [{ field: 'company', issue: 'not a demo company' }]);
      }
      await clear(companyId);
      db.transaction(() => settings.setDemoFlag(db, companyId, false, nowIsoTimestamp()));
    },
  };
}
