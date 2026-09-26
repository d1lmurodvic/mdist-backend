/**
 * Financial view controllers (API_CONTRACT.md §9.5). Figures come from the
 * financial engine through services.financials; nothing is computed here.
 */

import { parseOrThrow } from '../lib/validate.js';

function queryObject(searchParams) {
  return Object.fromEntries(searchParams);
}

export function createFinancialsController({ services, schemas }) {
  return {
    overview(req) {
      const query = parseOrThrow(schemas.financialsQuery, queryObject(req.searchParams));
      return services.financials.overview(req.tenant.companyId, query);
    },

    cashFlow(req) {
      const query = parseOrThrow(schemas.financialsQuery, queryObject(req.searchParams));
      return services.financials.cashFlow(req.tenant.companyId, query);
    },
  };
}
