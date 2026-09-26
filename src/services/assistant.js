/**
 * AI financial assistant (PRODUCT_REQUIREMENTS.md #20; API_CONTRACT.md §9.10).
 *
 * Every answer is assembled server-side from the caller's company only, using
 * the same engine and services as the reports; each figure is returned in
 * `references` with its period. No provider is called (no language-model
 * adapter exists), so this is the mandatory deterministic fallback, disclosed
 * in `meta.capability`. The assistant cannot execute actions, reach other
 * companies, or reveal configuration. History is per user and clearable.
 */

import { newId } from '../lib/ids.js';
import { addDays, nowIsoTimestamp, todayIso } from '../lib/dates.js';
import { changeBasisPoints, formatMajor, moneyJson } from '../lib/money.js';
import * as categories from '../models/categories.js';
import * as engagement from '../models/engagement.js';
import { ASSISTANT_DISCLAIMER, SUGGESTED_QUESTIONS, matchIntent, periodPresetFor } from '../ai/assistant.js';
import { assistantCapability } from '../ai/capabilities.js';
import { resolveCompanyPeriod } from './periodQuery.js';

export function createAssistantService({ db, config, engine, health, forecasts, anomalies }) {
  function answer(companyId, question) {
    const intent = matchIntent(question);
    if (intent === 'out_of_scope') {
      return { intent, answered: false, text: 'I can only discuss this company\'s own financial figures. I cannot access other companies, system settings or credentials.', references: [] };
    }
    if (intent === 'action') {
      return { intent, answered: false, text: 'I cannot make changes or perform actions. Use the app to record, edit or send anything; I can explain your figures.', references: [] };
    }
    if (intent === null) {
      return {
        intent,
        answered: false,
        text: 'I can\'t answer that question: open-ended questions need an AI provider, and none is available. I can answer questions about your cash, income, expenses, profit, invoices, forecast, unusual transactions and financial health.',
        references: [],
      };
    }

    const { company, period, previousPeriod } = resolveCompanyPeriod(db, companyId, { period: periodPresetFor(question) });
    const { currency } = company;
    const fmt = (value) => `${formatMajor(value, currency)} ${currency}`;
    const money = (value) => moneyJson(value, currency);
    const periodText = `${period.start} to ${period.end} (end exclusive)`;
    const ref = (label, value, extra = {}) => ({ label, value: typeof value === 'bigint' ? money(value) : value, ...extra });
    const today = todayIso();
    const totals = () => engine.periodTotals(companyId, period);

    switch (intent) {
      case 'cash': {
        const cash = engine.cashBalance(companyId, { before: addDays(today, 1) });
        return { intent, answered: true, text: `Your cash (cash and bank accounts) is ${fmt(cash)} as of ${today}.`, references: [ref('Cash position', cash, { asOf: today })] };
      }
      case 'income': {
        const current = totals();
        const previous = engine.periodTotals(companyId, previousPeriod);
        const change = changeBasisPoints(current.income, previous.income);
        return {
          intent, answered: true, period,
          text: `Income for ${periodText} is ${fmt(current.income)}${change === null ? '' : `, ${change >= 0 ? 'up' : 'down'} ${(Math.abs(change) / 100).toFixed(2)}% on the previous period (${fmt(previous.income)})`}.`,
          references: [ref('Income', current.income, { period }), ref('Previous income', previous.income, { period: previousPeriod })],
        };
      }
      case 'expenses': {
        const current = totals();
        return { intent, answered: true, period, text: `Expenses for ${periodText} are ${fmt(current.expense)}.`, references: [ref('Expenses', current.expense, { period })] };
      }
      case 'expense_change': {
        const current = totals();
        const previous = engine.periodTotals(companyId, previousPeriod);
        const change = changeBasisPoints(current.expense, previous.expense);
        const names = new Map(categories.listCategories(db, companyId).map((category) => [category.id, category.name]));
        const byCategory = (rows) => new Map(rows.filter((row) => row.type === 'expense').map((row) => [row.categoryId, row.total]));
        const now = byCategory(engine.categoryTotals(companyId, period));
        const before = byCategory(engine.categoryTotals(companyId, previousPeriod));
        const increases = [...now].map(([id, total]) => ({ id, increase: total - (before.get(id) ?? 0n) }))
          .filter((row) => row.increase > 0n).sort((a, b) => (b.increase > a.increase ? 1 : -1)).slice(0, 3);
        if (change === null) {
          return { intent, answered: false, period, text: `There were no expenses in the previous period (${previousPeriod.start} to ${previousPeriod.end}), so a change cannot be explained. Expenses for ${periodText} are ${fmt(current.expense)}.`, references: [ref('Expenses', current.expense, { period })] };
        }
        const direction = change >= 0 ? 'rose' : 'fell';
        const reasons = increases.length
          ? ` The largest increases: ${increases.map((row) => `${names.get(row.id)} +${fmt(row.increase)}`).join('; ')}.`
          : ' No category increased.';
        return {
          intent, answered: true, period,
          text: `Expenses ${direction} ${(Math.abs(change) / 100).toFixed(2)}%: ${fmt(current.expense)} in ${periodText} against ${fmt(previous.expense)} before.${reasons}`,
          references: [
            ref('Expenses', current.expense, { period }),
            ref('Previous expenses', previous.expense, { period: previousPeriod }),
            ...increases.map((row) => ref(`Increase in ${names.get(row.id)}`, row.increase, { period, ref: `category:${row.id}` })),
          ],
        };
      }
      case 'profit': {
        const current = totals();
        const result = current.net < 0n ? 'a loss' : 'a profit';
        return {
          intent, answered: true, period,
          text: `For ${periodText} you made ${result} of ${fmt(current.net < 0n ? -current.net : current.net)}: income ${fmt(current.income)} minus expenses ${fmt(current.expense)}. This is a cash-basis result.`,
          references: [ref('Income', current.income, { period }), ref('Expenses', current.expense, { period }), ref('Net result', current.net, { period })],
        };
      }
      case 'receivables':
      case 'payables':
      case 'overdue': {
        const outstanding = engine.outstandingInvoices(companyId, { today });
        const describe = (type, label) => {
          const figures = outstanding[type];
          return `${label}: ${figures.count} unpaid invoice${figures.count === 1 ? '' : 's'} for ${fmt(figures.total)}, of which ${figures.overdueCount} overdue (${fmt(figures.overdueTotal)})`;
        };
        const parts = [];
        const references = [];
        for (const [type, label] of [['receivable', 'Owed to you'], ['payable', 'You owe']]) {
          if (intent === 'receivables' && type !== 'receivable') continue;
          if (intent === 'payables' && type !== 'payable') continue;
          parts.push(describe(type, label));
          references.push(ref(`${label} (unpaid invoices)`, outstanding[type].total, { asOf: today }), ref(`${label} (overdue)`, outstanding[type].overdueTotal, { asOf: today }));
        }
        return { intent, answered: true, text: `${parts.join('. ')}. Figures as of ${today}.`, references };
      }
      case 'forecast': {
        const { result } = forecasts.project(companyId, 30);
        const text = result.belowZero.crosses
          ? `The 30-day projection falls below zero on ${result.belowZero.firstDate}; the lowest point is ${fmt(result.minimum.balanceMinor)} on ${result.minimum.date}.`
          : `The 30-day projection stays above zero; the lowest point is ${fmt(result.minimum.balanceMinor)} on ${result.minimum.date}, ending at ${fmt(result.endingBalanceMinor)}.`;
        return {
          intent, answered: true,
          text: `${text} This is a deterministic projection (confidence ${result.confidence}), not a guarantee.${result.history.sufficient ? '' : ' There is not enough history for recurring patterns, so only balances and invoice due dates were used.'}`,
          references: [ref('Projected minimum', result.minimum.balanceMinor, { date: result.minimum.date }), ref('Projected balance in 30 days', result.endingBalanceMinor, { date: addDays(today, 30) })],
        };
      }
      case 'anomalies': {
        const summary = anomalies.openSummary(companyId, { limit: 3 });
        return {
          intent, answered: true,
          text: summary.open === 0
            ? 'There are no open unusual-transaction flags. Run detection for a period to check.'
            : `There are ${summary.open} open unusual-transaction flags (${summary.bySeverity.high} high, ${summary.bySeverity.medium} medium, ${summary.bySeverity.low} low).`,
          references: summary.latest.map((anomaly) => ref(anomaly.rule.label, anomaly.transaction.amount, { ref: `transaction:${anomaly.transaction.id}`, date: anomaly.transaction.date })),
        };
      }
      case 'health': {
        const result = health.compute(companyId, { period: period.preset });
        if (result.overall.status === 'insufficient_data') {
          return { intent, answered: false, period, text: 'There is not enough data to estimate financial health yet.', references: [] };
        }
        return {
          intent, answered: true, period,
          text: `Estimated financial health for ${periodText}: ${result.overall.status.replace('_', ' ')} (${result.overall.score}/100 from ${result.overall.componentsUsed} of 5 components). This is an estimate, not an assessment.`,
          references: result.components.filter((component) => component.available).map((component) => ref(component.label, component.score, { status: component.status })),
        };
      }
      default:
        return { intent, answered: false, text: 'I cannot answer that.', references: [] };
    }
  }

  function present(message) {
    return { id: message.id, role: message.role, content: message.content, ...(message.details ?? {}), createdAt: message.createdAt };
  }

  return {
    send(companyId, userId, question) {
      const result = answer(companyId, question);
      const now = nowIsoTimestamp();
      const details = {
        method: 'rule',
        intent: result.intent,
        answered: result.answered,
        period: result.period ? { start: result.period.start, end: result.period.end } : null,
        references: result.references,
        disclaimer: ASSISTANT_DISCLAIMER,
        suggestions: result.answered ? [] : SUGGESTED_QUESTIONS,
      };
      const { questionMessage, answerMessage } = db.transaction(() => ({
        questionMessage: engagement.insertAssistantMessage(db, companyId, { id: newId('msg'), userId, role: 'user', content: question, details: null, now }),
        answerMessage: engagement.insertAssistantMessage(db, companyId, { id: newId('msg'), userId, role: 'assistant', content: result.text, details, now }),
      }));
      return { data: { question: present(questionMessage), answer: present(answerMessage) }, meta: { capability: assistantCapability(config) } };
    },

    history(companyId, userId, { page, limit }) {
      const { items, total } = engagement.listAssistantMessages(db, companyId, userId, { page, limit });
      return { items: items.map(present), total, capability: assistantCapability(config) };
    },

    clear(companyId, userId) {
      engagement.clearAssistantMessages(db, companyId, userId);
    },
  };
}
