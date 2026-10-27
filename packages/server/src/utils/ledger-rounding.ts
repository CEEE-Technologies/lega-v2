import { round } from 'lodash';

/**
 * Decimal places stored by the ledger amount columns (DECIMAL(13, 3)).
 */
export const LEDGER_AMOUNT_PRECISION = 3;

/**
 * Smallest amount the ledger can store.
 */
const LEDGER_AMOUNT_UNIT = 1 / 10 ** LEDGER_AMOUNT_PRECISION;

/**
 * Rounds the given amount to the ledger precision.
 * @param {number} amount
 * @returns {number}
 */
export const roundLedgerAmount = (amount: number): number => {
  return round(amount || 0, LEDGER_AMOUNT_PRECISION);
};

interface IDebitCreditEntry {
  debit: number;
  credit: number;
}

/**
 * Rounds the debit and credit of every entry to the ledger precision and puts
 * the rounding remainder on the last non-zero entry, so a set of pro-rata
 * lines still balances once stored.
 *
 * Only a rounding-sized remainder (one unit per entry at most) is absorbed.
 * A bigger difference means the set itself is wrong, so it is left visible
 * instead of being hidden on the last line.
 * @param {T[]} entries
 * @returns {T[]}
 */
export const roundLedgerEntries = <T extends IDebitCreditEntry>(
  entries: T[],
): T[] => {
  const rounded = entries.map((entry) => ({
    ...entry,
    debit: roundLedgerAmount(entry.debit),
    credit: roundLedgerAmount(entry.credit),
  }));
  const totalDebit = rounded.reduce((sum, e) => sum + e.debit, 0);
  const totalCredit = rounded.reduce((sum, e) => sum + e.credit, 0);
  const remainder = roundLedgerAmount(totalDebit - totalCredit);

  const tolerance = rounded.length * LEDGER_AMOUNT_UNIT + 1e-9;

  if (remainder === 0 || Math.abs(remainder) > tolerance) {
    return rounded;
  }
  const lastIndex = findLastIndex(
    rounded,
    (entry) => entry.debit !== 0 || entry.credit !== 0,
  );
  if (lastIndex === -1) {
    return rounded;
  }
  const last = rounded[lastIndex];

  // Debits exceed credits by `remainder`: grow the credit, or shrink the debit.
  rounded[lastIndex] =
    last.credit !== 0
      ? { ...last, credit: roundLedgerAmount(last.credit + remainder) }
      : { ...last, debit: roundLedgerAmount(last.debit - remainder) };

  return rounded;
};

/**
 * Splits the given total over the given weights, rounding each part to the
 * ledger precision and putting the remainder on the last part, so the parts
 * always add up to the rounded total.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export const splitLedgerAmount = (
  total: number,
  weights: number[],
): number[] => {
  const roundedTotal = roundLedgerAmount(total);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  if (weights.length === 0) {
    return [];
  }
  if (totalWeight === 0) {
    return weights.map((_, index) =>
      index === weights.length - 1 ? roundedTotal : 0,
    );
  }
  const parts = weights.map((weight) =>
    roundLedgerAmount((roundedTotal * weight) / totalWeight),
  );
  const allocated = parts.slice(0, -1).reduce((sum, part) => sum + part, 0);

  parts[parts.length - 1] = roundLedgerAmount(roundedTotal - allocated);

  return parts;
};

const findLastIndex = <T>(items: T[], predicate: (item: T) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
};
