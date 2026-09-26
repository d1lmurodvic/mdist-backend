/**
 * /ai controllers (API_CONTRACT.md §9.10). Every response carries
 * meta.capability so the client can say how a result was produced.
 */

import { CATEGORIZATION_NOTE } from '../services/categorization.js';
import { describeCapabilities } from '../ai/capabilities.js';
import { paginationMeta, parseQuery, pathId } from './common.js';

export function createAiController({ services, config, schemas }) {
  const company = (req) => req.tenant.companyId;
  return {
    capabilities() {
      const described = describeCapabilities({ config, documentReader: services.documentReader });
      return {
        data: described,
        meta: { capability: { method: 'rule', confidence: null, degraded: false, note: 'Derived from configuration and the adapters that exist.' } },
      };
    },

    generateInsights: (req) => services.insights.generate(company(req), req.validBody),
    listInsights: (req) => services.insights.list(company(req), parseQuery(req, schemas.insightsQuery)),
    dismissInsight: (req) => services.insights.dismiss(company(req), pathId(req, 'insightId', 'Insight not found.')),

    listAnomalies(req) {
      const query = parseQuery(req, schemas.anomalyListQuery, ['status', 'severity']);
      const { items, total, capability } = services.anomalies.list(company(req), query);
      return { data: items, meta: { ...paginationMeta(query, total, { sort: 'detectedAt:desc' }), capability } };
    },
    detectAnomalies: (req) => services.anomalies.detect(company(req), req.validBody),
    updateAnomaly: (req) => services.anomalies.update(company(req), pathId(req, 'anomalyId', 'Anomaly not found.'), req.validBody),

    async sendMessage(req) {
      const result = services.assistant.send(company(req), req.auth.userId, req.validBody.message);
      return { status: 201, ...result };
    },
    listMessages(req) {
      const query = parseQuery(req, schemas.assistantListQuery);
      const { items, total, capability } = services.assistant.history(company(req), req.auth.userId, query);
      return { data: items, meta: { ...paginationMeta(query, total, { sort: 'createdAt:asc' }), capability } };
    },
    clearMessages(req) {
      services.assistant.clear(company(req), req.auth.userId);
      return { status: 204 };
    },

    categorize(req) {
      let input = req.validBody;
      if (input.transactionId) {
        // Another company's transaction is not found, like any unknown id.
        const transaction = services.ledger.getTransaction(company(req), input.transactionId);
        input = { type: transaction.type, payee: transaction.payee ?? undefined, description: transaction.description ?? undefined };
      }
      return {
        data: services.ledger.suggestCategory(company(req), input),
        meta: { capability: { method: 'rule', confidence: null, degraded: false, note: CATEGORIZATION_NOTE } },
      };
    },
  };
}
