/**
 * Service registry. Built once per app; tests may override any service.
 */

import { createAuthService } from './auth.js';
import { createCategorizationService } from './categorization.js';
import { createCompanyService } from './companies.js';
import { createFinancialEngine } from './financialEngine.js';
import { createFinancialsService } from './financials.js';
import { createLedgerService } from './ledger.js';
import { createInvoiceService } from './invoices.js';
import { createDocumentService } from './documents.js';
import { createDocumentReader } from '../ai/documentReader.js';
import { createLocalStorage } from '../storage/localStorage.js';
import { createReportsService } from './reports.js';
import { createHealthService } from './health.js';
import { createNotificationService } from './notifications.js';
import { createForecastService } from './forecasts.js';
import { createInsightService } from './insights.js';
import { createAnomalyService } from './anomalies.js';
import { createAssistantService } from './assistant.js';
import { createDashboardService } from './dashboard.js';
import { createTaxService } from './tax.js';
import { createAccountantService } from './accountants.js';
import { createSettingsService } from './settings.js';
import { createDemoDataService } from './demoData.js';

export function createServices({ db, config, overrides = {} }) {
  const engine = createFinancialEngine({ db });
  const categorization = createCategorizationService({ db });
  const ledger = createLedgerService({ db, engine, categorization });
  const invoices = createInvoiceService({ db, ledger });
  // Tests may inject a reader with a stand-in adapter; production uses the registry.
  const documentReader = overrides.documentReader ?? createDocumentReader({ config });
  const storage = createLocalStorage({ rootDir: config.storage.uploadDir });
  const documents = createDocumentService({ db, config, storage, reader: documentReader, ledger, invoices });

  // Final backend completion: every service below reads figures from `engine`.
  const notifications = createNotificationService({ db });
  const health = createHealthService({ db, engine });
  const forecasts = createForecastService({ db, engine, notifications });
  const insights = createInsightService({ db, engine, forecasts });
  const anomalies = createAnomalyService({ db, engine, notifications });
  return {
    auth: createAuthService({ db, config }),
    companies: createCompanyService({ db }),
    engine,
    ledger,
    financials: createFinancialsService({ db, engine }),
    invoices,
    documentReader,
    documents,
    reports: createReportsService({ db, engine }),
    health,
    notifications,
    forecasts,
    insights,
    anomalies,
    assistant: createAssistantService({ db, config, engine, health, forecasts, anomalies }),
    dashboard: createDashboardService({ db, engine, insights, anomalies, forecasts, health }),
    tax: createTaxService({ db, engine }),
    accountants: createAccountantService({ db, engine }),
    settings: createSettingsService({ db, config, notifications }),
    demoData: createDemoDataService({ db, ledger, invoices, documents, storage }),
    ...overrides,
  };
}
