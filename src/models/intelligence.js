/**
 * insights, anomalies and forecasts (migration 006): stored results of
 * deterministic calculations. Company-scoped (tenantScope.js).
 */

import { assertCompanyScope } from './tenantScope.js';

const json = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

// ------------------------------------------------------------------ insights

function toInsight(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    key: row.key,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    action: row.action,
    method: row.method,
    confidence: row.confidence,
    figures: JSON.parse(row.figures),
    evidence: JSON.parse(row.evidence),
    dismissedAt: row.dismissed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INSIGHT_COLUMNS = `id, period_start, period_end, key, type, severity, title, body, action, method, confidence,
  figures, evidence, dismissed_at, created_at, updated_at`;

/**
 * Store the findings for one period: update existing keys (keeping their
 * dismissal), insert new ones, and remove findings that no longer hold.
 */
export function replaceInsights(db, companyId, { start, end }, findings, { newId, now }) {
  assertCompanyScope(companyId);
  const keys = findings.map((finding) => finding.key);
  for (const finding of findings) {
    db.run(
      `INSERT INTO insights (id, company_id, period_start, period_end, key, type, severity, title, body, action, method,
                             confidence, figures, evidence, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (company_id, period_start, period_end, key) DO UPDATE SET
         type = excluded.type, severity = excluded.severity, title = excluded.title, body = excluded.body,
         action = excluded.action, method = excluded.method, confidence = excluded.confidence,
         figures = excluded.figures, evidence = excluded.evidence, updated_at = excluded.updated_at`,
      [newId(), companyId, start, end, finding.key, finding.type, finding.severity, finding.title, finding.body,
        finding.action, finding.method, finding.confidence, json(finding.figures), json(finding.evidence), now, now],
    );
  }
  const placeholders = keys.map(() => '?').join(', ');
  db.run(
    `DELETE FROM insights WHERE company_id = ? AND period_start = ? AND period_end = ?${keys.length ? ` AND key NOT IN (${placeholders})` : ''}`,
    [companyId, start, end, ...keys],
  );
}

export function listInsights(db, companyId, { start, end, includeDismissed }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT ${INSIGHT_COLUMNS} FROM insights
     WHERE company_id = ? AND period_start = ? AND period_end = ?${includeDismissed ? '' : ' AND dismissed_at IS NULL'}
     ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, type, id`,
    [companyId, start, end],
  ).map(toInsight);
}

/** The most recently updated, undismissed insights of the company, any period. */
export function latestInsights(db, companyId, { limit }) {
  assertCompanyScope(companyId);
  return db.all(
    `SELECT ${INSIGHT_COLUMNS} FROM insights WHERE company_id = ? AND dismissed_at IS NULL
     ORDER BY updated_at DESC, CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END, id LIMIT ?`,
    [companyId, limit],
  ).map(toInsight);
}

export function findInsight(db, companyId, insightId) {
  assertCompanyScope(companyId);
  return toInsight(db.get(`SELECT ${INSIGHT_COLUMNS} FROM insights WHERE company_id = ? AND id = ?`, [companyId, insightId]));
}

export function dismissInsight(db, companyId, insightId, now) {
  assertCompanyScope(companyId);
  db.run('UPDATE insights SET dismissed_at = coalesce(dismissed_at, ?) WHERE company_id = ? AND id = ?', [now, companyId, insightId]);
}

// ----------------------------------------------------------------- anomalies

function toAnomaly(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    transactionId: row.transaction_id,
    relatedTransactionId: row.related_exists ? row.related_transaction_id : null,
    ruleId: row.rule_id,
    severity: row.severity,
    score: row.score,
    explanation: row.explanation,
    comparison: JSON.parse(row.comparison),
    status: row.status,
    note: row.note,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
    transaction: {
      id: row.transaction_id, type: row.t_type, amountMinor: BigInt(row.t_amount), date: row.t_date,
      payee: row.t_payee, description: row.t_description, categoryId: row.t_category_id,
    },
  };
}

const ANOMALY_SELECT = `SELECT a.id, a.transaction_id, a.related_transaction_id, a.rule_id, a.severity, a.score, a.explanation,
    a.comparison, a.status, a.note, a.detected_at, a.resolved_at, a.updated_at,
    t.type AS t_type, t.amount_minor AS t_amount, t.date AS t_date, t.payee AS t_payee, t.description AS t_description,
    t.category_id AS t_category_id,
    EXISTS (SELECT 1 FROM transactions r WHERE r.company_id = a.company_id AND r.id = a.related_transaction_id) AS related_exists
  FROM anomalies a JOIN transactions t ON t.company_id = a.company_id AND t.id = a.transaction_id`;

/** Insert a finding unless the same transaction was already flagged by the same rule. Returns true when new. */
export function insertAnomalyIfNew(db, companyId, finding, { id, now }) {
  assertCompanyScope(companyId);
  const result = db.run(
    `INSERT INTO anomalies (id, company_id, transaction_id, related_transaction_id, rule_id, severity, score, explanation,
                            comparison, status, note, detected_at, resolved_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, NULL, ?)
     ON CONFLICT (company_id, transaction_id, rule_id) DO NOTHING`,
    [id, companyId, finding.transactionId, finding.relatedTransactionId ?? null, finding.ruleId, finding.severity,
      finding.score, finding.explanation, json(finding.comparison), now, now],
  );
  return result.changes > 0;
}

export function listAnomalies(db, companyId, { statuses, severities, from, to, page, limit }) {
  assertCompanyScope(companyId);
  const conditions = ['a.company_id = ?'];
  const params = [companyId];
  if (statuses?.length) { conditions.push(`a.status IN (${statuses.map(() => '?').join(', ')})`); params.push(...statuses); }
  if (severities?.length) { conditions.push(`a.severity IN (${severities.map(() => '?').join(', ')})`); params.push(...severities); }
  if (from) { conditions.push('t.date >= ?'); params.push(from); }
  if (to) { conditions.push('t.date < ?'); params.push(to); }
  const where = conditions.join(' AND ');
  const total = db.getValue(
    `SELECT count(*) FROM anomalies a JOIN transactions t ON t.company_id = a.company_id AND t.id = a.transaction_id WHERE ${where}`,
    params,
  );
  const rows = db.all(
    `${ANOMALY_SELECT} WHERE ${where}
     ORDER BY a.detected_at DESC, CASE a.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  return { items: rows.map(toAnomaly), total };
}

export function findAnomaly(db, companyId, anomalyId) {
  assertCompanyScope(companyId);
  return toAnomaly(db.get(`${ANOMALY_SELECT} WHERE a.company_id = ? AND a.id = ?`, [companyId, anomalyId]));
}

export function updateAnomalyStatus(db, companyId, anomalyId, { status, note, now }) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE anomalies SET status = ?, note = ?, resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE ? END, updated_at = ?
     WHERE company_id = ? AND id = ?`,
    [status, note, status, now, now, companyId, anomalyId],
  );
}

export function countOpenAnomalies(db, companyId) {
  assertCompanyScope(companyId);
  return db.all(
    "SELECT severity, count(*) AS count FROM anomalies WHERE company_id = ? AND status = 'open' GROUP BY severity",
    [companyId],
  );
}

// ----------------------------------------------------------------- forecasts

export function insertForecast(db, companyId, { id, asOf, horizonDays, method, result, now }) {
  assertCompanyScope(companyId);
  db.run(
    'INSERT INTO forecasts (id, company_id, as_of, horizon_days, method, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, companyId, asOf, horizonDays, method, json(result), now],
  );
}

export function latestForecast(db, companyId) {
  assertCompanyScope(companyId);
  const row = db.get(
    `SELECT id, as_of, horizon_days, method, result, created_at FROM forecasts WHERE company_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [companyId],
  );
  if (!row) return undefined;
  return { id: row.id, asOf: row.as_of, horizonDays: row.horizon_days, method: row.method, result: JSON.parse(row.result), createdAt: row.created_at };
}

export function listForecastMethods(db, companyId) {
  assertCompanyScope(companyId);
  return db.all('SELECT method, count(*) AS count, max(created_at) AS latest FROM forecasts WHERE company_id = ? GROUP BY method', [companyId]);
}
