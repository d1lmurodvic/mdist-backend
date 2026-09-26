/**
 * notifications, user_preferences, assistant_messages, accountant_requests
 * (migration 006). Tenant tables are company-scoped (tenantScope.js); user
 * records are additionally scoped to the user.
 */

import { assertCompanyScope } from './tenantScope.js';

// ------------------------------------------------------------- notifications

function toNotification(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

const NOTIFICATION_COLUMNS = 'id, type, severity, title, body, entity_type, entity_id, read_at, created_at';

/** Insert unless this user was already notified of the same event. */
export function insertNotificationIfNew(db, companyId, { id, userId, type, severity, title, body, entityType, entityId, dedupeKey, now }) {
  assertCompanyScope(companyId);
  return db.run(
    `INSERT INTO notifications (id, company_id, user_id, type, severity, title, body, entity_type, entity_id, dedupe_key,
                                read_at, dismissed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT (user_id, company_id, dedupe_key) DO NOTHING`,
    [id, companyId, userId, type, severity, title, body, entityType, entityId, dedupeKey, now],
  ).changes > 0;
}

export function listNotifications(db, companyId, userId, { unreadOnly, page, limit }) {
  assertCompanyScope(companyId);
  const where = `company_id = ? AND user_id = ? AND dismissed_at IS NULL${unreadOnly ? ' AND read_at IS NULL' : ''}`;
  const total = db.getValue(`SELECT count(*) FROM notifications WHERE ${where}`, [companyId, userId]);
  const rows = db.all(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [companyId, userId, limit, (page - 1) * limit],
  );
  return { items: rows.map(toNotification), total };
}

export function countUnread(db, companyId, userId) {
  assertCompanyScope(companyId);
  return db.getValue(
    'SELECT count(*) FROM notifications WHERE company_id = ? AND user_id = ? AND dismissed_at IS NULL AND read_at IS NULL',
    [companyId, userId],
  );
}

export function findNotification(db, companyId, userId, notificationId) {
  assertCompanyScope(companyId);
  return toNotification(db.get(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE company_id = ? AND user_id = ? AND id = ? AND dismissed_at IS NULL`,
    [companyId, userId, notificationId],
  ));
}

export function markRead(db, companyId, userId, notificationId, now) {
  assertCompanyScope(companyId);
  db.run(
    'UPDATE notifications SET read_at = coalesce(read_at, ?) WHERE company_id = ? AND user_id = ? AND id = ?',
    [now, companyId, userId, notificationId],
  );
}

export function markAllRead(db, companyId, userId, now) {
  assertCompanyScope(companyId);
  return db.run(
    'UPDATE notifications SET read_at = ? WHERE company_id = ? AND user_id = ? AND read_at IS NULL AND dismissed_at IS NULL',
    [now, companyId, userId],
  ).changes;
}

export function dismissNotification(db, companyId, userId, notificationId, now) {
  assertCompanyScope(companyId);
  db.run(
    'UPDATE notifications SET dismissed_at = ?, read_at = coalesce(read_at, ?) WHERE company_id = ? AND user_id = ? AND id = ?',
    [now, now, companyId, userId, notificationId],
  );
}

// --------------------------------------------------------------- preferences

export function findPreferences(db, userId) {
  const row = db.get('SELECT notifications, updated_at FROM user_preferences WHERE user_id = ?', [userId]);
  return row ? { notifications: JSON.parse(row.notifications), updatedAt: row.updated_at } : undefined;
}

export function savePreferences(db, userId, { notifications, now }) {
  db.run(
    `INSERT INTO user_preferences (user_id, notifications, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET notifications = excluded.notifications, updated_at = excluded.updated_at`,
    [userId, JSON.stringify(notifications), now],
  );
}

// ----------------------------------------------------------------- assistant

function toMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    details: row.details ? JSON.parse(row.details) : null,
    createdAt: row.created_at,
  };
}

export function insertAssistantMessage(db, companyId, { id, userId, role, content, details, now }) {
  assertCompanyScope(companyId);
  db.run(
    'INSERT INTO assistant_messages (id, company_id, user_id, role, content, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, companyId, userId, role, content, details ? JSON.stringify(details) : null, now],
  );
  return toMessage(db.get('SELECT id, role, content, details, created_at FROM assistant_messages WHERE id = ?', [id]));
}

export function listAssistantMessages(db, companyId, userId, { page, limit }) {
  assertCompanyScope(companyId);
  const total = db.getValue('SELECT count(*) FROM assistant_messages WHERE company_id = ? AND user_id = ?', [companyId, userId]);
  // rowid breaks ties between a question and its answer stored in the same millisecond.
  const rows = db.all(
    `SELECT id, role, content, details, created_at FROM assistant_messages WHERE company_id = ? AND user_id = ?
     ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
    [companyId, userId, limit, (page - 1) * limit],
  );
  return { items: rows.map(toMessage), total };
}

export function clearAssistantMessages(db, companyId, userId) {
  assertCompanyScope(companyId);
  return db.run('DELETE FROM assistant_messages WHERE company_id = ? AND user_id = ?', [companyId, userId]).changes;
}

// -------------------------------------------------------- accountant requests

function toRequest(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    topic: row.topic,
    description: row.description,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    shareSummary: row.share_summary === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const REQUEST_COLUMNS = `id, contact_name, contact_email, contact_phone, topic, description, period_start, period_end,
  share_summary, status, created_at, updated_at`;

export function insertAccountantRequest(db, companyId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `INSERT INTO accountant_requests (id, company_id, created_by, contact_name, contact_email, contact_phone, topic, description,
                                      period_start, period_end, share_summary, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`,
    [fields.id, companyId, fields.createdBy, fields.contactName, fields.contactEmail, fields.contactPhone, fields.topic,
      fields.description, fields.periodStart, fields.periodEnd, fields.shareSummary ? 1 : 0, fields.now, fields.now],
  );
  return findAccountantRequest(db, companyId, fields.id);
}

export function findAccountantRequest(db, companyId, requestId) {
  assertCompanyScope(companyId);
  return toRequest(db.get(`SELECT ${REQUEST_COLUMNS} FROM accountant_requests WHERE company_id = ? AND id = ?`, [companyId, requestId]));
}

export function listAccountantRequests(db, companyId, { statuses }) {
  assertCompanyScope(companyId);
  const params = [companyId];
  let filter = '';
  if (statuses?.length) { filter = ` AND status IN (${statuses.map(() => '?').join(', ')})`; params.push(...statuses); }
  return db.all(
    `SELECT ${REQUEST_COLUMNS} FROM accountant_requests WHERE company_id = ?${filter} ORDER BY created_at DESC, id DESC`,
    params,
  ).map(toRequest);
}

export function updateAccountantRequest(db, companyId, requestId, fields) {
  assertCompanyScope(companyId);
  db.run(
    `UPDATE accountant_requests SET contact_name = ?, contact_email = ?, contact_phone = ?, topic = ?, description = ?,
       period_start = ?, period_end = ?, share_summary = ?, updated_at = ?
     WHERE company_id = ? AND id = ? AND status = 'requested'`,
    [fields.contactName, fields.contactEmail, fields.contactPhone, fields.topic, fields.description, fields.periodStart,
      fields.periodEnd, fields.shareSummary ? 1 : 0, fields.now, companyId, requestId],
  );
}
