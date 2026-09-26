/**
 * Deterministic transaction categorization (PRODUCT_REQUIREMENTS.md #11,
 * AI_CONTEXT.md §4.2). Layers, in order — the first match wins:
 *
 *   1. rule     — owner-curated rules: exact counterparty, then "contains"
 *                 (longer patterns first)
 *   2. learned  — rules recorded from users' category corrections (exact)
 *   3. ai       — skipped: no AI provider adapter exists yet (AI_CONTEXT.md
 *                 phase B); the result says so rather than pretending
 *   4. fallback — the company's Uncategorized category, marked for review
 *
 * A suggestion is a proposal: it is stored with review_status 'needs_review'
 * until a user confirms or corrects it. Rules are deterministic, so no
 * statistical confidence is invented for them (DEVELOPMENT_RULES.md §7).
 */

import * as rules from '../models/categoryRules.js';
import * as categories from '../models/categories.js';

/** Trimmed, lower-cased, single-spaced; null when nothing is left. */
export function normalizeText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

/** The counterparty used by exact rules and duplicate detection: payee, else description. */
export function counterpartyKey(payee, description) {
  return normalizeText(payee) ?? normalizeText(description);
}

export const CATEGORIZATION_NOTE =
  'Deterministic rules only: no AI provider is used for categorization. Suggestions need confirmation.';

export function createCategorizationService({ db }) {
  return {
    /** @returns {{categoryId, method: 'rule'|'learned'|'fallback', ruleId: string|null}} */
    suggest(companyId, { type, payee, description }) {
      const key = counterpartyKey(payee, description);
      // Payee and description are matched separately: a pattern never spans both.
      const text = [normalizeText(payee), normalizeText(description)].filter(Boolean).join('\n');

      for (const [source, method] of [['user', 'rule'], ['learned', 'learned']]) {
        const rule = rules.findMatchingRule(db, companyId, { source, type, key, text });
        if (rule) return { categoryId: rule.categoryId, method, ruleId: rule.id };
      }
      return { categoryId: categories.findUncategorized(db, companyId).id, method: 'fallback', ruleId: null };
    },
  };
}
