/**
 * Unusual transaction detection (PRODUCT_REQUIREMENTS.md #18; API_CONTRACT.md
 * §9.10). Rules live in ai/anomalies.js. Detection is idempotent (one flag per
 * transaction and rule, keeping its review status) and never modifies,
 * merges, deletes or re-categorizes a transaction.
 */

import { notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { addDays, nowIsoTimestamp } from '../lib/dates.js';
import { moneyJson } from '../lib/money.js';
import * as analytics from '../models/analytics.js';
import * as intelligence from '../models/intelligence.js';
import * as companies from '../models/companies.js';
import { detectAnomalies } from '../ai/anomalies.js';
import { resolveCompanyPeriod } from './periodQuery.js';

export const ANOMALY_STATUSES = Object.freeze(['open', 'resolved', 'false_positive', 'confirmed']);
export const ANOMALY_SEVERITIES = Object.freeze(['low', 'medium', 'high']);
const LOOKBACK_DAYS = 365;

const RULE_LABELS = Object.freeze({
  amount_outlier: 'Amount far from the category norm',
  first_time_payee: 'First-time payee',
  possible_duplicate: 'Possible duplicate',
  large_expense: 'Unusually large expense for the period',
});

const MONEY_KEYS = new Set(['medianMinor', 'madMinor', 'medianExpenseMinor', 'periodExpenseTotalMinor']);

export function createAnomalyService({ db, engine, notifications }) {
  function capability(history) {
    return {
      method: 'statistics',
      confidence: null,
      degraded: history ? !history.sufficient : false,
      note: history?.note ?? 'Deterministic rules and robust statistics over your own history. Flags are review items; nothing is changed automatically.',
    };
  }

  function present(anomaly, currency) {
    const comparison = {};
    for (const [key, value] of Object.entries(anomaly.comparison)) {
      if (MONEY_KEYS.has(key)) comparison[key.replace(/Minor$/, '')] = moneyJson(BigInt(value), currency);
      else comparison[key] = value;
    }
    return {
      id: anomaly.id,
      rule: { id: anomaly.ruleId, label: RULE_LABELS[anomaly.ruleId] },
      severity: anomaly.severity,
      score: anomaly.score,
      explanation: anomaly.explanation,
      comparison,
      status: anomaly.status,
      note: anomaly.note,
      transaction: {
        id: anomaly.transaction.id,
        type: anomaly.transaction.type,
        amount: moneyJson(anomaly.transaction.amountMinor, currency),
        date: anomaly.transaction.date,
        payee: anomaly.transaction.payee,
        description: anomaly.transaction.description,
        categoryId: anomaly.transaction.categoryId,
      },
      relatedTransactionId: anomaly.relatedTransactionId,
      detectedAt: anomaly.detectedAt,
      resolvedAt: anomaly.resolvedAt,
      updatedAt: anomaly.updatedAt,
    };
  }

  function currencyOf(companyId) {
    return companies.getCompany(db, companyId).currency;
  }

  return {
    detect(companyId, query) {
      const { period, company } = resolveCompanyPeriod(db, companyId, query);
      const targets = analytics.transactionsBetween(db, companyId, period);
      const history = analytics.transactionsBetween(db, companyId, { start: addDays(period.start, -LOOKBACK_DAYS), end: period.end });
      const { findings, history: historyInfo } = detectAnomalies({
        targets, history, period, periodExpenseTotal: engine.periodTotals(companyId, period).expense,
      });
      const now = nowIsoTimestamp();
      const created = [];
      db.transaction(() => {
        for (const finding of findings) {
          const id = newId('anm');
          if (intelligence.insertAnomalyIfNew(db, companyId, finding, { id, now })) created.push({ id, finding });
        }
      });
      for (const { id, finding } of created) {
        if (finding.severity === 'low') continue;
        notifications.notify(companyId, {
          type: 'anomaly_detected',
          severity: finding.severity === 'high' ? 'critical' : 'warning',
          title: `Unusual transaction: ${RULE_LABELS[finding.ruleId]}`,
          body: finding.explanation,
          entityType: 'anomaly',
          entityId: id,
          dedupeKey: `anomaly_detected:${id}`,
        });
      }
      const { items } = intelligence.listAnomalies(db, companyId, { from: period.start, to: period.end, page: 1, limit: 100 });
      return {
        data: {
          period,
          transactionsChecked: targets.length,
          newFlags: created.length,
          flagsInPeriod: items.map((anomaly) => present(anomaly, company.currency)),
          history: historyInfo,
        },
        meta: { period, capability: capability(historyInfo) },
      };
    },

    list(companyId, query) {
      const { items, total } = intelligence.listAnomalies(db, companyId, {
        statuses: query.status, severities: query.severity, from: query.from, to: query.to, page: query.page, limit: query.limit,
      });
      const currency = currencyOf(companyId);
      return { items: items.map((anomaly) => present(anomaly, currency)), total, capability: capability(null) };
    },

    update(companyId, anomalyId, { status, note }) {
      const current = intelligence.findAnomaly(db, companyId, anomalyId);
      if (!current) throw notFound('Anomaly not found.');
      intelligence.updateAnomalyStatus(db, companyId, anomalyId, {
        status, note: note === undefined ? current.note : note, now: nowIsoTimestamp(),
      });
      if (status === 'confirmed' && current.status !== 'confirmed') {
        notifications.notify(companyId, {
          type: 'anomaly_confirmed',
          severity: 'warning',
          title: `Confirmed: ${RULE_LABELS[current.ruleId]}`,
          body: `A flagged transaction on ${current.transaction.date} was confirmed as a problem.`,
          entityType: 'anomaly',
          entityId: anomalyId,
          dedupeKey: `anomaly_confirmed:${anomalyId}`,
        });
      }
      return { data: present(intelligence.findAnomaly(db, companyId, anomalyId), currencyOf(companyId)), meta: { capability: capability(null) } };
    },

    openSummary(companyId, { limit }) {
      const counts = { low: 0, medium: 0, high: 0 };
      for (const row of intelligence.countOpenAnomalies(db, companyId)) counts[row.severity] = row.count;
      const { items } = intelligence.listAnomalies(db, companyId, { statuses: ['open'], page: 1, limit });
      const currency = currencyOf(companyId);
      return { open: counts.low + counts.medium + counts.high, bySeverity: counts, latest: items.map((anomaly) => present(anomaly, currency)) };
    },
  };
}
