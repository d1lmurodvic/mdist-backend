/**
 * The assistant's deterministic fallback (PRODUCT_REQUIREMENTS.md #20;
 * AI_CONTEXT.md §4.6): a small intent matcher that maps common questions to
 * the same figures the reports use. It generates no free text beyond fixed
 * templates, reads nothing but the context the service assembled for the
 * caller's company, and cannot execute actions.
 */

export const ASSISTANT_DISCLAIMER = 'Informational only — not accounting, tax or legal advice.';
export const MAX_QUESTION_LENGTH = 1000;

export const SUGGESTED_QUESTIONS = Object.freeze([
  'What is my cash balance?',
  'How much did I spend this month?',
  'Why did expenses go up last month?',
  'What is my profit this month?',
  'How much do customers owe me?',
  'How much do I owe?',
  'When will I run out of cash?',
  'Are there unusual transactions?',
  'How healthy is my business?',
]);

const INTENTS = [
  { id: 'out_of_scope', pattern: /\b(other|another|different)\s+compan|system\s*prompt|api\s*key|secret|password|token|config|environment|database|\bsql\b|ignore\s+(all|any|previous|the)/i },
  { id: 'action', pattern: /^\s*(please\s+)?(delete|create|add|record|pay|send|transfer|remove|update|change|cancel|approve|categori[sz]e)\b/i },
  { id: 'expense_change', pattern: /\bwhy\b.*\b(expense|expenses|spend|spending|spent|cost|costs)\b/i },
  { id: 'forecast', pattern: /\b(forecast|runway|run out|afford|projection|project(ed)?|next 30 days)\b/i },
  { id: 'overdue', pattern: /\boverdue\b/i },
  { id: 'receivables', pattern: /\b(owe me|owed to me|owes me|receivables?|customers owe|clients owe)\b/i },
  { id: 'payables', pattern: /\b(i owe|we owe|do i owe|payables?|bills|to pay)\b/i },
  { id: 'anomalies', pattern: /\b(unusual|anomal\w*|suspicious|strange|duplicate)\b/i },
  { id: 'health', pattern: /\b(health|healthy|how (is|am|are) (my|the|i|we)\b.*(business|doing|company)|how am i doing)\b/i },
  { id: 'profit', pattern: /\b(profit|loss|net result|margin|earned net)\b/i },
  { id: 'expenses', pattern: /\b(expense|expenses|spend|spending|spent|costs?)\b/i },
  { id: 'income', pattern: /\b(income|revenue|sales|earn|earned|turnover)\b/i },
  { id: 'cash', pattern: /\b(cash|balance|bank|money)\b/i },
];

export function matchIntent(question) {
  return INTENTS.find((intent) => intent.pattern.test(question))?.id ?? null;
}

export function periodPresetFor(question) {
  if (/\blast month\b/i.test(question)) return 'last_month';
  if (/\b(this|current) year\b|\byear to date\b/i.test(question)) return 'this_year';
  if (/\b(this|current) quarter\b/i.test(question)) return 'this_quarter';
  if (/\blast 30 days\b/i.test(question)) return 'last_30_days';
  return 'this_month';
}
