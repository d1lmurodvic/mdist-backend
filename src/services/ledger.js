/**
 * Ledger services: accounts, categories, category rules and transactions
 * (PRODUCT_REQUIREMENTS.md #8, #11; API_CONTRACT.md §9.3, §9.6).
 *
 * Every function takes the tenant's companyId from req.tenant. A referenced
 * account, category or rule that is not in that company is "not found" — the
 * same answer as an id that does not exist anywhere.
 *
 * Money rules: one currency per company (no conversion); every amount must be
 * in the company's currency (422 otherwise). Totals are never computed here —
 * the financial engine owns them.
 */

import { conflict, notFound, unprocessable } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { addDays, nowIsoTimestamp, requestedPeriod, todayIso } from '../lib/dates.js';
import { moneyJson, toSqlInteger } from '../lib/money.js';
import * as accounts from '../models/accounts.js';
import * as categories from '../models/categories.js';
import * as rules from '../models/categoryRules.js';
import * as transactions from '../models/transactions.js';
import * as companies from '../models/companies.js';
import { CASH_ACCOUNT_TYPES } from './financialEngine.js';
import { counterpartyKey, normalizeText } from './categorization.js';

/** Returned in one response at most; larger results say they were truncated. */
export const MAX_DUPLICATE_GROUPS = 100;

function companyCurrency(db, companyId) {
  return companies.getCompany(db, companyId).currency;
}

/** A money input must be in the company's currency: no multi-currency in the MVP. */
function assertCompanyCurrency(money, currency, field) {
  if (money.currency !== currency) {
    throw unprocessable(`Amounts must be in the company currency (${currency}).`, [
      { field: `${field}.currency`, issue: `must be ${currency}; multi-currency is not supported` },
    ]);
  }
}

export function createLedgerService({ db, engine, categorization }) {
  // ------------------------------------------------------------- accounts

  function presentAccount(account, balances, asOf) {
    const figures = balances.get(account.id);
    return {
      id: account.id,
      name: account.name,
      type: account.type,
      currency: account.currency,
      openingBalance: moneyJson(account.openingBalanceMinor, account.currency),
      // Opening balance + every transaction dated up to and including asOf.
      balance: { asOf, amount: moneyJson(figures?.balance ?? account.openingBalanceMinor, account.currency) },
      acceptsTransactions: CASH_ACCOUNT_TYPES.includes(account.type),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  function presentAccounts(companyId, list) {
    const asOf = todayIso();
    const balances = engine.accountBalances(companyId, { before: addDays(asOf, 1) });
    return list.map((account) => presentAccount(account, balances, asOf));
  }

  function requireAccount(companyId, accountId) {
    const account = accounts.findAccount(db, companyId, accountId);
    if (!account) throw notFound('Account not found.');
    return account;
  }

  // ------------------------------------------------------------- categories

  function requireCategory(companyId, categoryId, field = 'categoryId') {
    const category = categories.findCategory(db, companyId, categoryId);
    if (!category) {
      throw unprocessable('Category not found.', [{ field, issue: 'no such category in this company' }]);
    }
    return category;
  }

  /** A transaction's category must be Uncategorized or have the transaction's type. */
  function assertCategoryFits(category, type) {
    if (!category.isSystem && category.type !== type) {
      throw unprocessable('Category type does not match the transaction type.', [
        { field: 'categoryId', issue: `must be an ${type} category (or Uncategorized)` },
      ]);
    }
  }

  function assertUniqueCategoryName(companyId, name, exceptId) {
    const existing = categories.findCategoryByName(db, companyId, name);
    if (existing && existing.id !== exceptId) {
      throw conflict('A category with this name already exists.', [{ field: 'name', issue: 'must be unique in the company' }]);
    }
  }

  /** Parents must be top-level categories of the same type (two levels). */
  function resolveParent(companyId, parentId, type) {
    if (parentId === null) return null;
    const parent = categories.findCategory(db, companyId, parentId);
    if (!parent) throw unprocessable('Parent category not found.', [{ field: 'parentId', issue: 'no such category in this company' }]);
    if (parent.isSystem) throw unprocessable('Uncategorized cannot have subcategories.', [{ field: 'parentId', issue: 'cannot be Uncategorized' }]);
    if (parent.parentId !== null) throw unprocessable('Categories have two levels only.', [{ field: 'parentId', issue: 'must be a top-level category' }]);
    if (parent.type !== type) throw unprocessable('A subcategory must have its parent\'s type.', [{ field: 'parentId', issue: `must be an ${type} category` }]);
    return parent.id;
  }

  // ------------------------------------------------------------- transactions

  function presentTransaction(transaction) {
    return {
      id: transaction.id,
      type: transaction.type,
      amount: moneyJson(transaction.amountMinor, transaction.currency),
      date: transaction.date,
      accountId: transaction.accountId,
      categoryId: transaction.categoryId,
      description: transaction.description,
      payee: transaction.payee,
      paymentMethod: transaction.paymentMethod,
      notes: transaction.notes,
      source: transaction.source,
      categorization: {
        method: transaction.categorySource,
        ruleId: transaction.categoryRuleId,
        reviewStatus: transaction.reviewStatus,
      },
      // The invoice this transaction pays (set by invoice payment; read-only here).
      invoiceId: transaction.invoiceId,
      createdAt: transaction.createdAt,
      updatedAt: transaction.updatedAt,
    };
  }

  function requireTransaction(companyId, transactionId) {
    const transaction = transactions.findTransaction(db, companyId, transactionId);
    if (!transaction) throw notFound('Transaction not found.');
    return transaction;
  }

  function requirePostingAccount(companyId, accountId) {
    const account = accounts.findAccount(db, companyId, accountId);
    if (!account) throw unprocessable('Account not found.', [{ field: 'accountId', issue: 'no such account in this company' }]);
    if (!CASH_ACCOUNT_TYPES.includes(account.type)) {
      throw unprocessable('Transactions can only be recorded on cash or bank accounts.', [
        { field: 'accountId', issue: 'must be a cash or bank account' },
      ]);
    }
    return account;
  }

  /**
   * Record a user's category correction as a learned rule for the
   * counterparty, so the next transaction from them is categorized the same
   * way. Uncategorized is never learned.
   */
  function learnCorrection(companyId, { key, category, now }) {
    if (!key || category.isSystem) return;
    const existing = rules.findRuleByPattern(db, companyId, { source: 'learned', matchType: 'exact', pattern: key });
    if (existing) rules.updateRuleCategory(db, companyId, existing.id, category.id, now);
    else rules.insertRule(db, companyId, { id: newId('rul'), source: 'learned', matchType: 'exact', pattern: key, categoryId: category.id, now });
  }

  return {
    // ----------------------------------------------------------- accounts
    listAccounts(companyId) {
      return presentAccounts(companyId, accounts.listAccounts(db, companyId));
    },

    createAccount(companyId, input) {
      return db.transaction(() => {
        const currency = companyCurrency(db, companyId);
        const opening = input.openingBalance ?? { amount: 0n, currency };
        assertCompanyCurrency(opening, currency, 'openingBalance');
        if (accounts.findAccountByName(db, companyId, input.name)) {
          throw conflict('An account with this name already exists.', [{ field: 'name', issue: 'must be unique in the company' }]);
        }
        const account = accounts.insertAccount(db, companyId, {
          id: newId('acc'),
          name: input.name,
          type: input.type,
          currency,
          openingBalanceMinor: toSqlInteger(opening.amount, 'openingBalance.amount'),
          now: nowIsoTimestamp(),
        });
        return presentAccounts(companyId, [account])[0];
      });
    },

    updateAccount(companyId, accountId, changes) {
      return db.transaction(() => {
        const account = requireAccount(companyId, accountId);
        const hasTransactions = accounts.countAccountTransactions(db, companyId, accountId) > 0;
        if (changes.name !== undefined) {
          const clash = accounts.findAccountByName(db, companyId, changes.name);
          if (clash && clash.id !== accountId) {
            throw conflict('An account with this name already exists.', [{ field: 'name', issue: 'must be unique in the company' }]);
          }
        }
        if (changes.openingBalance !== undefined) {
          assertCompanyCurrency(changes.openingBalance, account.currency, 'openingBalance');
          if (hasTransactions && changes.openingBalance.amount !== account.openingBalanceMinor) {
            throw unprocessable('The opening balance cannot change once the account has transactions.', [
              { field: 'openingBalance', issue: 'account already has transactions' },
            ]);
          }
        }
        if (changes.type !== undefined && changes.type !== account.type && hasTransactions) {
          throw unprocessable('The account type cannot change once the account has transactions.', [
            { field: 'type', issue: 'account already has transactions' },
          ]);
        }
        const updated = accounts.updateAccount(db, companyId, accountId, {
          name: changes.name,
          type: changes.type,
          openingBalanceMinor: changes.openingBalance === undefined ? undefined : toSqlInteger(changes.openingBalance.amount, 'openingBalance.amount'),
          now: nowIsoTimestamp(),
        });
        return presentAccounts(companyId, [updated])[0];
      });
    },

    // ----------------------------------------------------------- categories
    listCategories(companyId) {
      return categories.listCategories(db, companyId);
    },

    createCategory(companyId, input) {
      return db.transaction(() => {
        assertUniqueCategoryName(companyId, input.name);
        const parentId = resolveParent(companyId, input.parentId ?? null, input.type);
        return categories.insertCategory(db, companyId, {
          id: newId('cat'), name: input.name, type: input.type, parentId, now: nowIsoTimestamp(),
        });
      });
    },

    updateCategory(companyId, categoryId, changes) {
      return db.transaction(() => {
        const category = categories.findCategory(db, companyId, categoryId);
        if (!category) throw notFound('Category not found.');
        if (category.isSystem) throw unprocessable('Uncategorized is a system category and cannot be changed.');
        if (changes.name !== undefined) assertUniqueCategoryName(companyId, changes.name, categoryId);
        let parentId;
        if (changes.parentId !== undefined) {
          if (changes.parentId === categoryId) throw unprocessable('A category cannot be its own parent.', [{ field: 'parentId', issue: 'cannot be the category itself' }]);
          if (changes.parentId !== null && categories.countChildren(db, companyId, categoryId) > 0) {
            throw unprocessable('A category with subcategories cannot become a subcategory.', [{ field: 'parentId', issue: 'category has subcategories' }]);
          }
          parentId = resolveParent(companyId, changes.parentId, category.type);
        }
        return categories.updateCategory(db, companyId, categoryId, { name: changes.name, parentId, now: nowIsoTimestamp() });
      });
    },

    // ----------------------------------------------------------- rules
    listRules(companyId) {
      return rules.listRules(db, companyId);
    },

    createRule(companyId, input) {
      return db.transaction(() => {
        const category = requireCategory(companyId, input.categoryId);
        if (category.isSystem) throw unprocessable('A rule cannot target Uncategorized.', [{ field: 'categoryId', issue: 'cannot be Uncategorized' }]);
        const pattern = normalizeText(input.pattern);
        if (rules.findRuleByPattern(db, companyId, { source: 'user', matchType: input.matchType, pattern })) {
          throw conflict('A rule with this pattern already exists.', [{ field: 'pattern', issue: 'must be unique per match type' }]);
        }
        return rules.insertRule(db, companyId, {
          id: newId('rul'), source: 'user', matchType: input.matchType, pattern, categoryId: category.id, now: nowIsoTimestamp(),
        });
      });
    },

    deleteRule(companyId, ruleId) {
      if (!rules.deleteRule(db, companyId, ruleId)) throw notFound('Category rule not found.');
    },

    // ----------------------------------------------------------- transactions
    /** @param {object} query the validated list query (validate transactionListQuery) */
    listTransactions(companyId, query) {
      let { from, to } = query;
      if (query.period) {
        const { fiscalYearStartMonth } = companies.getCompany(db, companyId);
        ({ start: from, end: to } = requestedPeriod(query, { fiscalStartMonth: fiscalYearStartMonth }));
      }
      // Uncategorized is a real category, so "include uncategorized" adds it to the filter.
      const categoryIds = [...(query.categoryId ?? [])];
      if (query.includeUncategorized && categoryIds.length > 0) {
        categoryIds.push(categories.findUncategorized(db, companyId).id);
      }
      const { items, total } = transactions.listTransactions(db, companyId, {
        filters: { from, to, type: query.type, accountId: query.accountId, categoryIds, reviewStatus: query.reviewStatus, q: query.q },
        sort: query.sort,
        page: query.page,
        limit: query.limit,
      });
      return { items: items.map(presentTransaction), total };
    },

    getTransaction(companyId, transactionId) {
      return presentTransaction(requireTransaction(companyId, transactionId));
    },

    /**
     * Create a transaction. Without a categoryId the categorizer proposes one
     * (stored as 'needs_review'). A possible duplicate is refused with 409
     * unless the caller sets allowDuplicate after reviewing it.
     */
    createTransaction(companyId, input) {
      return db.transaction(() => {
        const currency = companyCurrency(db, companyId);
        assertCompanyCurrency(input.amount, currency, 'amount');
        requirePostingAccount(companyId, input.accountId);

        const key = counterpartyKey(input.payee, input.description);
        const duplicates = transactions.findDuplicatesOf(db, companyId, {
          type: input.type, amountMinor: toSqlInteger(input.amount.amount, 'amount.amount'), date: input.date, counterpartyKey: key,
        });
        if (duplicates.length > 0 && !input.allowDuplicate) {
          throw conflict(
            'This looks like a duplicate of an existing transaction. Send allowDuplicate: true to record it anyway.',
            duplicates.map((duplicate) => ({
              field: 'transaction',
              transactionId: duplicate.id,
              issue: 'same type, amount, date and payee',
            })),
          );
        }

        let categorizationFields;
        if (input.categoryId !== undefined) {
          const category = requireCategory(companyId, input.categoryId);
          assertCategoryFits(category, input.type);
          categorizationFields = { categoryId: category.id, categorySource: 'user', categoryRuleId: null, reviewStatus: 'confirmed' };
        } else {
          const suggestion = categorization.suggest(companyId, input);
          categorizationFields = {
            categoryId: suggestion.categoryId,
            categorySource: suggestion.method,
            categoryRuleId: suggestion.ruleId,
            reviewStatus: 'needs_review',
          };
        }

        const created = transactions.insertTransaction(db, companyId, {
          id: newId('txn'),
          type: input.type,
          amountMinor: toSqlInteger(input.amount.amount, 'amount.amount'),
          currency,
          date: input.date,
          accountId: input.accountId,
          ...categorizationFields,
          description: input.description ?? null,
          payee: input.payee ?? null,
          counterpartyKey: key,
          paymentMethod: input.paymentMethod ?? null,
          notes: input.notes ?? null,
          now: nowIsoTimestamp(),
        });
        return { transaction: presentTransaction(created), possibleDuplicateOf: duplicates.map((duplicate) => duplicate.id) };
      });
    },

    /**
     * Update editable fields. Choosing a different category is a user
     * correction: it is confirmed and recorded as a learned rule.
     */
    updateTransaction(companyId, transactionId, changes) {
      return db.transaction(() => {
        const current = requireTransaction(companyId, transactionId);
        const now = nowIsoTimestamp();
        const next = {
          type: changes.type ?? current.type,
          amountMinor: current.amountMinor,
          date: changes.date ?? current.date,
          accountId: changes.accountId ?? current.accountId,
          categoryId: current.categoryId,
          description: changes.description === undefined ? current.description : changes.description,
          payee: changes.payee === undefined ? current.payee : changes.payee,
          paymentMethod: changes.paymentMethod === undefined ? current.paymentMethod : changes.paymentMethod,
          notes: changes.notes === undefined ? current.notes : changes.notes,
          categorySource: current.categorySource,
          categoryRuleId: current.categoryRuleId,
          reviewStatus: changes.reviewStatus ?? current.reviewStatus,
          now,
        };
        if (changes.amount !== undefined) {
          assertCompanyCurrency(changes.amount, current.currency, 'amount');
          next.amountMinor = changes.amount.amount;
        }
        // An invoice payment's amount and direction follow its invoice, so the
        // ledger and the receivable/payable can never disagree (PRD #9).
        if (current.invoiceId && (next.amountMinor !== current.amountMinor || next.type !== current.type)) {
          throw unprocessable('This transaction is an invoice payment: its amount and type follow the invoice.', [
            { field: next.type !== current.type ? 'type' : 'amount', issue: `linked to invoice ${current.invoiceId}` },
          ]);
        }
        if (changes.accountId !== undefined) requirePostingAccount(companyId, changes.accountId);
        next.counterpartyKey = counterpartyKey(next.payee, next.description);

        let category = categories.findCategory(db, companyId, current.categoryId);
        if (changes.categoryId !== undefined) {
          category = requireCategory(companyId, changes.categoryId);
          if (category.id !== current.categoryId) {
            Object.assign(next, { categoryId: category.id, categorySource: 'user', categoryRuleId: null, reviewStatus: 'confirmed' });
            assertCategoryFits(category, next.type);
            learnCorrection(companyId, { key: next.counterpartyKey, category, now });
          }
        }
        assertCategoryFits(category, next.type);

        const updated = transactions.updateTransaction(db, companyId, transactionId, {
          ...next,
          amountMinor: toSqlInteger(next.amountMinor, 'amount.amount'),
        });
        return presentTransaction(updated);
      });
    },

    deleteTransaction(companyId, transactionId) {
      const transaction = requireTransaction(companyId, transactionId);
      if (transaction.invoiceId) {
        throw unprocessable('This transaction is an invoice payment. Cancel the invoice to remove its payment.', [
          { field: 'transactionId', issue: `linked to invoice ${transaction.invoiceId}` },
        ]);
      }
      transactions.deleteTransaction(db, companyId, transactionId);
    },

    /** Apply one category to many transactions; one result per requested id. */
    bulkCategorize(companyId, { transactionIds, categoryId }) {
      return db.transaction(() => {
        const category = requireCategory(companyId, categoryId);
        const now = nowIsoTimestamp();
        const results = [...new Set(transactionIds)].map((id) => {
          const current = transactions.findTransaction(db, companyId, id);
          if (!current) return { transactionId: id, status: 'not_found' };
          if (!category.isSystem && category.type !== current.type) return { transactionId: id, status: 'type_mismatch' };
          const key = counterpartyKey(current.payee, current.description);
          transactions.updateTransaction(db, companyId, id, {
            ...current,
            amountMinor: toSqlInteger(current.amountMinor),
            counterpartyKey: key,
            categoryId: category.id,
            categorySource: 'user',
            categoryRuleId: null,
            reviewStatus: 'confirmed',
            now,
          });
          if (current.categoryId !== category.id) learnCorrection(companyId, { key, category, now });
          return { transactionId: id, status: 'updated' };
        });
        return {
          results,
          updated: results.filter((result) => result.status === 'updated').length,
        };
      });
    },

    findDuplicateGroups(companyId) {
      const { groups, truncated } = transactions.findDuplicateGroups(db, companyId, { limit: MAX_DUPLICATE_GROUPS });
      return {
        groups: groups.map((group) => ({ transactions: group.transactions.map(presentTransaction) })),
        truncated,
      };
    },

    suggestCategory(companyId, input) {
      const suggestion = categorization.suggest(companyId, input);
      const category = categories.findCategory(db, companyId, suggestion.categoryId);
      return { ...suggestion, category: { id: category.id, name: category.name, type: category.type } };
    },
  };
}
