/**
 * Ledger controllers: accounts, categories, category rules, transactions.
 * HTTP only — validated input in, one service call, response descriptor out.
 * The company is always req.tenant.companyId.
 */

import { notFound } from '../lib/errors.js';
import { idSchema, parseOrThrow } from '../lib/validate.js';
import { CATEGORIZATION_NOTE } from '../services/categorization.js';

/** A path id that is not even well-formed cannot exist: same 404 as any other. */
function pathId(req, name, message) {
  const result = idSchema.safeParse(req.params[name]);
  if (!result.success) throw notFound(message);
  return result.data;
}

/** Query parameters as an object; repeatable keys become arrays. */
function queryObject(searchParams, repeatable = []) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    query[key] = repeatable.includes(key) ? searchParams.getAll(key) : searchParams.get(key);
  }
  return query;
}

function paginationMeta({ page, limit, total, sort }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { page, limit, total, totalPages, hasNext: page < totalPages, hasPrevious: page > 1, sort };
}

export function createLedgerController({ services, schemas }) {
  const { ledger } = services;

  return {
    // ----------------------------------------------------------- accounts
    listAccounts: (req) => ({ data: ledger.listAccounts(req.tenant.companyId) }),

    createAccount(req) {
      const account = ledger.createAccount(req.tenant.companyId, req.validBody);
      return { status: 201, headers: { Location: `/api/v1/accounts/${account.id}` }, data: account };
    },

    updateAccount(req) {
      const accountId = pathId(req, 'accountId', 'Account not found.');
      return { data: ledger.updateAccount(req.tenant.companyId, accountId, req.validBody) };
    },

    // ----------------------------------------------------------- categories
    listCategories: (req) => ({ data: ledger.listCategories(req.tenant.companyId) }),

    createCategory(req) {
      const category = ledger.createCategory(req.tenant.companyId, req.validBody);
      return { status: 201, headers: { Location: `/api/v1/categories/${category.id}` }, data: category };
    },

    updateCategory(req) {
      const categoryId = pathId(req, 'categoryId', 'Category not found.');
      return { data: ledger.updateCategory(req.tenant.companyId, categoryId, req.validBody) };
    },

    // ----------------------------------------------------------- rules
    listRules: (req) => ({ data: ledger.listRules(req.tenant.companyId) }),

    createRule(req) {
      return { status: 201, data: ledger.createRule(req.tenant.companyId, req.validBody) };
    },

    deleteRule(req) {
      ledger.deleteRule(req.tenant.companyId, pathId(req, 'ruleId', 'Category rule not found.'));
      return { status: 204 };
    },

    // ----------------------------------------------------------- transactions
    listTransactions(req) {
      const query = parseOrThrow(schemas.transactionListQuery, queryObject(req.searchParams, ['categoryId']));
      const { items, total } = ledger.listTransactions(req.tenant.companyId, query);
      return {
        data: items,
        meta: paginationMeta({ page: query.page, limit: query.limit, total, sort: `${query.sort.field}:${query.sort.direction}` }),
      };
    },

    getTransaction(req) {
      return { data: ledger.getTransaction(req.tenant.companyId, pathId(req, 'transactionId', 'Transaction not found.')) };
    },

    createTransaction(req) {
      const { transaction, possibleDuplicateOf } = ledger.createTransaction(req.tenant.companyId, req.validBody);
      return {
        status: 201,
        headers: { Location: `/api/v1/transactions/${transaction.id}` },
        data: transaction,
        // Present only when the caller chose to record a flagged duplicate.
        meta: possibleDuplicateOf.length > 0 ? { possibleDuplicateOf } : undefined,
      };
    },

    updateTransaction(req) {
      const transactionId = pathId(req, 'transactionId', 'Transaction not found.');
      return { data: ledger.updateTransaction(req.tenant.companyId, transactionId, req.validBody) };
    },

    deleteTransaction(req) {
      ledger.deleteTransaction(req.tenant.companyId, pathId(req, 'transactionId', 'Transaction not found.'));
      return { status: 204 };
    },

    bulkCategorize(req) {
      return { data: ledger.bulkCategorize(req.tenant.companyId, req.validBody) };
    },

    duplicates(req) {
      const { groups, truncated } = ledger.findDuplicateGroups(req.tenant.companyId);
      return { data: groups, meta: { truncated } };
    },

    suggestCategory(req) {
      const query = parseOrThrow(schemas.suggestionQuery, queryObject(req.searchParams));
      const suggestion = ledger.suggestCategory(req.tenant.companyId, query);
      return {
        data: suggestion,
        meta: {
          capability: {
            method: 'rule',
            confidence: null,
            degraded: false,
            note: CATEGORIZATION_NOTE,
          },
        },
      };
    },
  };
}
