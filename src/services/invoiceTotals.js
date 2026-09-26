/**
 * Invoice arithmetic (ARCHITECTURE.md §7.5: the total is computed, never typed
 * in). Client-supplied totals are never read.
 *
 *   line net   = quantity × unit price
 *   line tax   = line net × taxRate / 10000, rounded half away from zero
 *   subtotal   = Σ line net
 *   tax        = Σ line tax
 *   total      = subtotal + tax
 *
 * Exact BigInt throughout. This is invoice arithmetic only: ledger figures
 * (income, expenses, cash, balances) belong to the financial engine and are
 * affected by an invoice only through its payment transaction.
 */

import { unprocessable } from '../lib/errors.js';
import { MAX_SAFE_MINOR, applyBasisPoints, toMinor } from '../lib/money.js';

function assertInRange(value, field) {
  if (value > MAX_SAFE_MINOR) {
    throw unprocessable('The invoice amount exceeds the supported range.', [
      { field, issue: `must be at most ${MAX_SAFE_MINOR} minor units` },
    ]);
  }
  return value;
}

/** @param {Array<{quantity: number, unitPriceMinor: bigint, taxRate: number}>} lines */
export function computeInvoiceTotals(lines) {
  let subtotal = 0n;
  let tax = 0n;
  const computed = lines.map((line, index) => {
    const lineTotal = assertInRange(BigInt(line.quantity) * toMinor(line.unitPriceMinor), `lineItems.${index}.unitPrice.amount`);
    const lineTax = applyBasisPoints(lineTotal, line.taxRate);
    subtotal += lineTotal;
    tax += lineTax;
    return { ...line, lineTotalMinor: lineTotal, taxMinor: lineTax };
  });
  assertInRange(subtotal, 'lineItems');
  const total = assertInRange(subtotal + tax, 'lineItems');
  return { lines: computed, subtotalMinor: subtotal, taxMinor: tax, totalMinor: total };
}
