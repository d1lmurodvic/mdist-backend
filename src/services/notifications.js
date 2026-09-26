/**
 * In-app notifications (PRODUCT_REQUIREMENTS.md #24; API_CONTRACT.md §9.12).
 *
 * A notification exists only because a real event happened:
 *   - raised directly by the feature that caused it: anomaly detected or
 *     confirmed, forecast crossing below zero;
 *   - derived from stored state when notifications are read (sync): an invoice
 *     past its due date, an invoice paid, a document that finished processing.
 *     Each event has a dedupe key, so it notifies each member at most once,
 *     and a dismissed notification never comes back.
 * Delivery is in-app only. Each member's preferences decide which types they
 * receive; the critical forecast warning can only be turned off explicitly.
 */

import { notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { addDays, nowIsoTimestamp, todayIso } from '../lib/dates.js';
import * as engagement from '../models/engagement.js';
import * as analytics from '../models/analytics.js';
import * as memberships from '../models/memberships.js';

export const NOTIFICATION_TYPES = Object.freeze([
  'anomaly_detected', 'anomaly_confirmed', 'forecast_below_zero', 'invoice_overdue', 'invoice_paid', 'document_processed',
]);
/** Warnings that are on by default and only switched off with an explicit acknowledgement. */
export const CRITICAL_TYPES = Object.freeze(['forecast_below_zero']);
/** How far back state-derived events (payments, processed documents) are picked up. */
export const SYNC_LOOKBACK_DAYS = 30;

const ENTITY_PATHS = Object.freeze({
  anomaly: () => '/api/v1/ai/anomalies',
  forecast: () => '/api/v1/forecast/latest',
  invoice: (id) => `/api/v1/invoices/${id}`,
  document: (id) => `/api/v1/documents/${id}`,
});

export function defaultPreferences() {
  return Object.fromEntries(NOTIFICATION_TYPES.map((type) => [type, true]));
}

export function createNotificationService({ db }) {
  function preferencesOf(userId) {
    return { ...defaultPreferences(), ...(engagement.findPreferences(db, userId)?.notifications ?? {}) };
  }

  /** Notify every member of the company who has this type enabled. */
  function notify(companyId, event) {
    const now = nowIsoTimestamp();
    for (const member of memberships.listMembersOfCompany(db, companyId)) {
      if (!preferencesOf(member.user.id)[event.type]) continue;
      engagement.insertNotificationIfNew(db, companyId, { id: newId('ntf'), userId: member.user.id, ...event, now });
    }
  }

  /** Raise notifications for events visible in stored state. Idempotent. */
  function sync(companyId) {
    const today = todayIso();
    const since = `${addDays(today, -SYNC_LOOKBACK_DAYS)}T00:00:00.000Z`;
    for (const invoice of analytics.unpaidInvoices(db, companyId)) {
      if (invoice.dueDate >= today) continue;
      notify(companyId, {
        type: 'invoice_overdue',
        severity: 'warning',
        title: `Invoice ${invoice.number} is overdue`,
        body: `${invoice.type === 'receivable' ? 'Payment from' : 'Payment to'} ${invoice.contactName} was due on ${invoice.dueDate}.`,
        entityType: 'invoice',
        entityId: invoice.id,
        dedupeKey: `invoice_overdue:${invoice.id}:${invoice.dueDate}`,
      });
    }
    for (const invoice of analytics.recentlyPaidInvoices(db, companyId, { since })) {
      notify(companyId, {
        type: 'invoice_paid',
        severity: 'info',
        title: `Invoice ${invoice.number} was paid`,
        body: `The payment was recorded as a ${invoice.type === 'receivable' ? 'income' : 'expense'} transaction.`,
        entityType: 'invoice',
        entityId: invoice.id,
        dedupeKey: `invoice_paid:${invoice.id}:${invoice.transactionId}`,
      });
    }
    for (const document of analytics.recentlyProcessedDocuments(db, companyId, { since })) {
      const ready = document.status === 'ready';
      notify(companyId, {
        type: 'document_processed',
        severity: ready ? 'info' : 'warning',
        title: ready ? 'A document is ready for review' : 'A document could not be read automatically',
        body: ready
          ? `${document.originalFilename ?? 'Your upload'} was read; review the extracted fields before confirming.`
          : `${document.originalFilename ?? 'Your upload'}: enter the details manually (${document.failureCode}).`,
        entityType: 'document',
        entityId: document.id,
        dedupeKey: `document_processed:${document.id}:${document.processedAt}`,
      });
    }
  }

  function present(notification) {
    return { ...notification, link: { entityType: notification.entityType, entityId: notification.entityId, path: ENTITY_PATHS[notification.entityType](notification.entityId) } };
  }

  function requireNotification(companyId, userId, notificationId) {
    const notification = engagement.findNotification(db, companyId, userId, notificationId);
    if (!notification) throw notFound('Notification not found.');
    return notification;
  }

  return {
    notify,
    preferencesOf,

    list(companyId, userId, { page, limit, unreadOnly }) {
      sync(companyId);
      const { items, total } = engagement.listNotifications(db, companyId, userId, { page, limit, unreadOnly });
      return { items: items.map(present), total, unreadCount: engagement.countUnread(db, companyId, userId) };
    },

    unreadCount(companyId, userId) {
      sync(companyId);
      return engagement.countUnread(db, companyId, userId);
    },

    markRead(companyId, userId, notificationId) {
      requireNotification(companyId, userId, notificationId);
      engagement.markRead(db, companyId, userId, notificationId, nowIsoTimestamp());
      return present(engagement.findNotification(db, companyId, userId, notificationId));
    },

    markAllRead(companyId, userId) {
      return engagement.markAllRead(db, companyId, userId, nowIsoTimestamp());
    },

    dismiss(companyId, userId, notificationId) {
      requireNotification(companyId, userId, notificationId);
      engagement.dismissNotification(db, companyId, userId, notificationId, nowIsoTimestamp());
    },

    /** @param {{ notifications: Record<string, boolean>, acknowledgeCritical?: boolean }} changes */
    updatePreferences(userId, { notifications, acknowledgeCritical = false }) {
      const current = preferencesOf(userId);
      for (const type of CRITICAL_TYPES) {
        if (notifications[type] === false && current[type] && !acknowledgeCritical) {
          throw unprocessable('Turning off a critical financial warning needs an explicit acknowledgement.', [
            { field: `notifications.${type}`, issue: 'set acknowledgeCritical: true to turn this warning off' },
          ]);
        }
      }
      const next = { ...current, ...notifications };
      engagement.savePreferences(db, userId, { notifications: next, now: nowIsoTimestamp() });
      return next;
    },
  };
}
