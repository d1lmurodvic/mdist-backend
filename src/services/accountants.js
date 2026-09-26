/**
 * Human accountant connection (PRODUCT_REQUIREMENTS.md #23; API_CONTRACT.md
 * §9.13): a request and lead-capture front door, not a marketplace. No
 * accountant network is connected, nothing is sent anywhere, and nothing is
 * shared implicitly: the share scope states exactly what a request would
 * include, and the period summary is only included when the user opts in.
 */

import { notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { nowIsoTimestamp } from '../lib/dates.js';
import { moneyJson } from '../lib/money.js';
import * as engagement from '../models/engagement.js';
import * as companies from '../models/companies.js';

export const REQUEST_NOTE = 'Your request is recorded in IFRSmart. No accountant network is connected yet, so nobody is contacted automatically.';

export function createAccountantService({ db, engine }) {
  function shareScope(companyId, request) {
    const company = companies.getCompany(db, companyId);
    const scope = {
      sharedAutomatically: false,
      connectedAccountant: null,
      alwaysIncluded: ['Company name', 'Company currency', 'Your contact name, email and phone', 'The topic and description you wrote'],
      includedWhenShareSummary: ['Income, expenses and net result for the requested period'],
      neverIncluded: ['Individual transactions', 'Invoices', 'Documents and uploads', 'Other members\' data', 'Login details'],
    };
    if (request?.shareSummary && request.periodStart) {
      const totals = engine.periodTotals(companyId, { start: request.periodStart, end: request.periodEnd });
      scope.summary = {
        company: company.name,
        currency: company.currency,
        period: { start: request.periodStart, end: request.periodEnd },
        income: moneyJson(totals.income, company.currency),
        expenses: moneyJson(totals.expense, company.currency),
        netResult: moneyJson(totals.net, company.currency),
      };
    }
    return scope;
  }

  function present(companyId, request) {
    return { ...request, shareScope: shareScope(companyId, request) };
  }

  function requireRequest(companyId, requestId) {
    const request = engagement.findAccountantRequest(db, companyId, requestId);
    if (!request) throw notFound('Request not found.');
    return request;
  }

  function checkSummaryPeriod(fields) {
    if (fields.shareSummary && !fields.periodStart) {
      throw unprocessable('A period is needed to share a summary.', [{ field: 'periodStart', issue: 'required when shareSummary is true' }]);
    }
  }

  return {
    create(companyId, userId, input) {
      const fields = { contactPhone: null, periodStart: null, periodEnd: null, shareSummary: false, ...input };
      checkSummaryPeriod(fields);
      const request = engagement.insertAccountantRequest(db, companyId, { id: newId('acr'), createdBy: userId, ...fields, now: nowIsoTimestamp() });
      return present(companyId, request);
    },

    list(companyId, { statuses }) {
      return engagement.listAccountantRequests(db, companyId, { statuses }).map((request) => present(companyId, request));
    },

    get(companyId, requestId) {
      return present(companyId, requireRequest(companyId, requestId));
    },

    update(companyId, requestId, changes) {
      return db.transaction(() => {
        const current = requireRequest(companyId, requestId);
        if (current.status !== 'requested') {
          throw unprocessable('Only a request that is still "requested" can be changed.', [{ field: 'status', issue: `request is ${current.status}` }]);
        }
        const next = { ...current, ...changes };
        if ((changes.periodStart === undefined) !== (changes.periodEnd === undefined)) {
          throw unprocessable('Send periodStart and periodEnd together.', [{ field: changes.periodStart === undefined ? 'periodStart' : 'periodEnd', issue: 'both are required together' }]);
        }
        checkSummaryPeriod(next);
        engagement.updateAccountantRequest(db, companyId, requestId, { ...next, now: nowIsoTimestamp() });
        return present(companyId, requireRequest(companyId, requestId));
      });
    },

    shareScope(companyId) {
      return shareScope(companyId, null);
    },
  };
}
