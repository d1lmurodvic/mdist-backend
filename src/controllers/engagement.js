/**
 * Notifications (API_CONTRACT.md §9.12) and accountant requests (§9.13).
 * Notifications belong to the caller (req.auth.userId) within their company.
 */

import { paginationMeta, parseQuery, pathId } from './common.js';
import { REQUEST_NOTE } from '../services/accountants.js';

export function createEngagementController({ services, schemas }) {
  const company = (req) => req.tenant.companyId;
  const user = (req) => req.auth.userId;
  return {
    listNotifications(req) {
      const query = parseQuery(req, schemas.notificationListQuery);
      const { items, total, unreadCount } = services.notifications.list(company(req), user(req), query);
      return { data: items, meta: { ...paginationMeta(query, total, { sort: 'createdAt:desc' }), unreadCount } };
    },
    unreadCount: (req) => ({ data: { unreadCount: services.notifications.unreadCount(company(req), user(req)) } }),
    markRead: (req) => ({ data: services.notifications.markRead(company(req), user(req), pathId(req, 'notificationId', 'Notification not found.')) }),
    markAllRead: (req) => ({ data: { updated: services.notifications.markAllRead(company(req), user(req)) } }),
    dismissNotification(req) {
      services.notifications.dismiss(company(req), user(req), pathId(req, 'notificationId', 'Notification not found.'));
      return { status: 204 };
    },

    createRequest(req) {
      const request = services.accountants.create(company(req), user(req), req.validBody);
      return { status: 201, headers: { Location: `/api/v1/accountants/requests/${request.id}` }, data: request, meta: { note: REQUEST_NOTE } };
    },
    listRequests(req) {
      const query = parseQuery(req, schemas.accountantListQuery, ['status']);
      return { data: services.accountants.list(company(req), { statuses: query.status }), meta: { note: REQUEST_NOTE } };
    },
    getRequest: (req) => ({ data: services.accountants.get(company(req), pathId(req, 'requestId', 'Request not found.')), meta: { note: REQUEST_NOTE } }),
    updateRequest: (req) => ({ data: services.accountants.update(company(req), pathId(req, 'requestId', 'Request not found.'), req.validBody), meta: { note: REQUEST_NOTE } }),
    shareScope: (req) => ({ data: services.accountants.shareScope(company(req)), meta: { note: REQUEST_NOTE } }),
  };
}
