/**
 * Routes of the final backend completion (API_CONTRACT.md §9.2–§9.13):
 * profile and settings, dashboard, financial breakdowns and health,
 * statements, forecast, AI capabilities, tax center, notifications and the
 * accountant connection.
 *
 * Every route requires a session; every company route also requires a company
 * (req.tenant) and scopes to it. Company configuration, member roles and demo
 * data are owner-only (API_CONTRACT.md §5). Groups whose prefix already exists
 * (/companies, /financials) are mounted beside the earlier routers.
 */

import { createRouter } from '../lib/router.js';
import { validateBody } from '../lib/validate.js';
import { authenticate, requireCompany, requireRole } from '../middleware/auth.js';
import { finalSchemas } from './schemas.js';
import { createAnalyticsController } from '../controllers/analytics.js';
import { createAiController } from '../controllers/ai.js';
import { createEngagementController } from '../controllers/engagement.js';
import { createSettingsController } from '../controllers/settings.js';

export function createFinalRouters({ services, config }) {
  const schemas = finalSchemas(config);
  const requireAuth = authenticate({ authService: services.auth });
  const withCompany = requireCompany({ companyService: services.companies });
  const tenant = [requireAuth, withCompany];
  const owner = [requireAuth, withCompany, requireRole('owner')];

  const analytics = createAnalyticsController({ services, schemas });
  const ai = createAiController({ services, config, schemas });
  const engagement = createEngagementController({ services, schemas });
  const settings = createSettingsController({ services });

  const users = createRouter()
    .get('/me', requireAuth, settings.profile)
    .patch('/me', requireAuth, validateBody(schemas.profileUpdate), settings.updateProfile)
    .post('/me/password', requireAuth, validateBody(schemas.passwordChange), settings.changePassword)
    .get('/me/preferences', requireAuth, settings.preferences)
    .patch('/me/preferences', requireAuth, validateBody(schemas.preferencesUpdate), settings.updatePreferences);

  const companies = createRouter()
    .patch('/current', ...owner, validateBody(schemas.companyUpdate), settings.updateCompany)
    .post('/current/demo-data', ...owner, validateBody(schemas.empty), settings.loadDemo)
    .delete('/current/demo-data', ...owner, settings.removeDemo);

  const members = createRouter().patch('/:memberId', ...owner, validateBody(schemas.memberUpdate), settings.updateMember);

  const dashboard = createRouter()
    .get('/', ...tenant, analytics.dashboard)
    .get('/activity', ...tenant, analytics.activity);

  const financials = createRouter()
    .get('/revenue-vs-expenses', ...tenant, analytics.revenueVsExpenses)
    .get('/expense-report', ...tenant, analytics.expenseReport)
    .get('/health', ...tenant, analytics.health);

  const reports = createRouter()
    .get('/', ...tenant, analytics.reportsIndex)
    .get('/profit-and-loss', ...tenant, analytics.profitAndLoss)
    .get('/balance-sheet', ...tenant, analytics.balanceSheet)
    .get('/cash-flow-statement', ...tenant, analytics.cashFlowStatement)
    .get('/expense-report', ...tenant, analytics.expenseReport);

  const forecast = createRouter()
    .post('/', ...tenant, validateBody(schemas.forecast), analytics.generateForecast)
    .get('/latest', ...tenant, analytics.latestForecast)
    .get('/methods', ...tenant, analytics.forecastMethods);

  const aiRouter = createRouter()
    .get('/capabilities', ...tenant, ai.capabilities)
    .post('/insights', ...tenant, validateBody(schemas.periodBody), ai.generateInsights)
    .get('/insights', ...tenant, ai.listInsights)
    .post('/insights/:insightId/dismiss', ...tenant, validateBody(schemas.empty), ai.dismissInsight)
    .get('/anomalies', ...tenant, ai.listAnomalies)
    .post('/anomalies/detect', ...tenant, validateBody(schemas.periodBody), ai.detectAnomalies)
    .patch('/anomalies/:anomalyId', ...tenant, validateBody(schemas.anomalyUpdate), ai.updateAnomaly)
    .post('/assistant/messages', ...tenant, validateBody(schemas.assistantMessage), ai.sendMessage)
    .get('/assistant/messages', ...tenant, ai.listMessages)
    .delete('/assistant/messages', ...tenant, ai.clearMessages)
    .post('/categorize', ...tenant, validateBody(schemas.categorize), ai.categorize);

  const tax = createRouter()
    .get('/summary', ...tenant, analytics.taxSummary)
    .get('/completeness', ...tenant, analytics.taxCompleteness)
    .get('/export', ...tenant, analytics.taxExport);

  const notifications = createRouter()
    .get('/', ...tenant, engagement.listNotifications)
    .get('/unread-count', ...tenant, engagement.unreadCount)
    .post('/read-all', ...tenant, validateBody(schemas.empty), engagement.markAllRead)
    .post('/:notificationId/read', ...tenant, validateBody(schemas.empty), engagement.markRead)
    .delete('/:notificationId', ...tenant, engagement.dismissNotification);

  const accountants = createRouter()
    .post('/requests', ...tenant, validateBody(schemas.accountantCreate), engagement.createRequest)
    .get('/requests', ...tenant, engagement.listRequests)
    .get('/requests/:requestId', ...tenant, engagement.getRequest)
    .patch('/requests/:requestId', ...tenant, validateBody(schemas.accountantUpdate), engagement.updateRequest)
    .get('/share-scope', ...tenant, engagement.shareScope);

  return { users, companies, members, dashboard, financials, reports, forecast, ai: aiRouter, tax, notifications, accountants };
}
