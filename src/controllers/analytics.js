/**
 * Controllers for financial breakdowns, statements, the dashboard, the
 * forecast and the tax center. HTTP only: every figure comes from a service.
 */

import { parseQuery } from './common.js';

export function createAnalyticsController({ services, schemas }) {
  const company = (req) => req.tenant.companyId;
  return {
    revenueVsExpenses: (req) => services.reports.revenueVsExpenses(company(req), parseQuery(req, schemas.revenueQuery, ['categoryId'])),
    expenseReport: (req) => services.reports.expenseReport(company(req), parseQuery(req, schemas.periodQuery)),
    health: (req) => services.health.health(company(req), parseQuery(req, schemas.periodQuery)),

    reportsIndex: (req) => services.reports.index(company(req), parseQuery(req, schemas.periodQuery)),
    profitAndLoss: (req) => services.reports.profitAndLoss(company(req), parseQuery(req, schemas.periodQuery)),
    balanceSheet: (req) => services.reports.balanceSheet(company(req), parseQuery(req, schemas.balanceSheetQuery)),
    cashFlowStatement: (req) => services.reports.cashFlowStatement(company(req), parseQuery(req, schemas.periodQuery)),

    dashboard: (req) => services.dashboard.dashboard(company(req), parseQuery(req, schemas.periodQuery)),
    activity(req) {
      const { limit } = parseQuery(req, schemas.activityQuery);
      return { data: services.dashboard.activity(company(req), { limit }), meta: { limit } };
    },

    generateForecast(req) {
      const result = services.forecasts.generate(company(req), req.validBody);
      return { status: 201, headers: { Location: '/api/v1/forecast/latest' }, ...result };
    },
    latestForecast: (req) => services.forecasts.latest(company(req)),
    forecastMethods: (req) => services.forecasts.methods(company(req)),

    taxSummary: (req) => services.tax.summary(company(req), parseQuery(req, schemas.periodQuery)),
    taxCompleteness: (req) => services.tax.completeness(company(req), parseQuery(req, schemas.periodQuery)),
    taxExport: (req) => services.tax.export(company(req), parseQuery(req, schemas.periodQuery)),
  };
}
