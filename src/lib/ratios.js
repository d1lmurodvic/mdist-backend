/**
 * Exact ratios over BigInt minor units, as integer basis points
 * (1 bp = 0.01%, 10000 bp = 100%). No floating point touches money.
 */

/** numerator / denominator (denominator > 0), rounded half away from zero. */
export function divideRoundHalfAway(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const magnitude = remainder < 0n ? -remainder : remainder;
  const roundAway = magnitude * 2n >= denominator ? (numerator < 0n ? -1n : 1n) : 0n;
  return quotient + roundAway;
}

/** part / whole in basis points, or null when whole is 0. Whole is taken as its magnitude. */
export function shareBasisPoints(part, whole) {
  const base = whole < 0n ? -whole : whole;
  if (base === 0n) return null;
  return Number(divideRoundHalfAway(part * 10000n, base));
}
