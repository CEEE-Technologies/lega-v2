import {
  MONEY_PRECISION,
  allocateMoney,
  fromCents,
  roundMoney,
  toCents,
} from '@bigcapital/utils';

/**
 * Decimal places of a ledger amount: money is whole cents.
 * (The amount columns are DECIMAL(13, 3), but every amount is stored in
 * cents since the ledger storage normalises the entries.)
 */
export const LEDGER_AMOUNT_PRECISION = MONEY_PRECISION;

/**
 * Rounds the given amount to cents, halves away from zero.
 * @param {number} amount
 * @returns {number}
 */
export const roundLedgerAmount = (amount: number): number => roundMoney(amount);

interface IDebitCreditEntry {
  debit: number;
  credit: number;
}

/**
 * Rounds the debit and credit of every entry to cents and puts the rounding
 * remainder on the last non-zero entry, so a set of pro-rata lines still
 * balances once stored.
 *
 * Only a rounding-sized remainder (one cent per entry at most) is absorbed.
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
    debit: roundMoney(entry.debit),
    credit: roundMoney(entry.credit),
  }));
  const remainderCents = rounded.reduce(
    (sum, e) => sum + toCents(e.debit) - toCents(e.credit),
    0,
  );
  if (remainderCents === 0 || Math.abs(remainderCents) > rounded.length) {
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

  // Debits exceed credits by the remainder: grow the credit, or shrink the debit.
  rounded[lastIndex] =
    last.credit !== 0
      ? { ...last, credit: fromCents(toCents(last.credit) + remainderCents) }
      : { ...last, debit: fromCents(toCents(last.debit) - remainderCents) };

  return rounded;
};

/**
 * Splits the given total over the given weights in whole cents with the
 * largest remainder method, so the parts always add up to the rounded total.
 * @param {number} total
 * @param {number[]} weights
 * @returns {number[]}
 */
export const splitLedgerAmount = (total: number, weights: number[]): number[] =>
  allocateMoney(total, weights);

const findLastIndex = <T>(items: T[], predicate: (item: T) => boolean) => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
};

/**
 * The credit side of an amount: a positive amount is a credit, a negative
 * one a debit (e.g. a running-total part that rounds below zero).
 * @param {number} amount
 * @returns {{ credit: number; debit: number }}
 */
export const creditSide = (amount: number) =>
  amount >= 0
    ? { credit: amount || 0, debit: 0 }
    : { credit: 0, debit: -amount };

/**
 * The debit side of an amount: a positive amount is a debit, a negative one
 * a credit.
 * @param {number} amount
 * @returns {{ credit: number; debit: number }}
 */
export const debitSide = (amount: number) =>
  amount >= 0
    ? { debit: amount || 0, credit: 0 }
    : { debit: 0, credit: -amount };

interface IForeignAmountsEntry {
  debit: number;
  credit: number;
  exchangeRate?: number | null;
  foreignDebit?: number | null;
  foreignCredit?: number | null;
}

/**
 * The transaction currency amounts of a ledger line: the ones the builder
 * gave, else the base amounts when the rate is 1, else none (a row posted
 * before the foreign amounts were stored).
 * @returns {{ foreignDebit: number | null; foreignCredit: number | null }}
 */
export const resolveForeignAmounts = (
  entry: IForeignAmountsEntry,
): { foreignDebit: number | null; foreignCredit: number | null } => {
  const given =
    (entry.foreignDebit !== undefined && entry.foreignDebit !== null) ||
    (entry.foreignCredit !== undefined && entry.foreignCredit !== null);
  if (given) {
    return {
      foreignDebit: roundMoney(entry.foreignDebit || 0),
      foreignCredit: roundMoney(entry.foreignCredit || 0),
    };
  }
  const rate = entry.exchangeRate || 1;
  return rate === 1
    ? {
        foreignDebit: roundMoney(entry.debit || 0),
        foreignCredit: roundMoney(entry.credit || 0),
      }
    : { foreignDebit: null, foreignCredit: null };
};

/**
 * The foreign amounts of a line on the debit side of the given transaction
 * currency amount (a negative amount is a credit).
 * @param {number} amount - In the transaction currency.
 */
export const foreignDebitSide = (amount: number) =>
  amount >= 0
    ? { foreignDebit: roundMoney(amount || 0), foreignCredit: 0 }
    : { foreignDebit: 0, foreignCredit: roundMoney(-amount) };

/**
 * The foreign amounts of a line on the credit side of the given transaction
 * currency amount (a negative amount is a debit).
 * @param {number} amount - In the transaction currency.
 */
export const foreignCreditSide = (amount: number) =>
  amount >= 0
    ? { foreignCredit: roundMoney(amount || 0), foreignDebit: 0 }
    : { foreignCredit: 0, foreignDebit: roundMoney(-amount) };

/** An exchange gain/loss line: no amount in the transaction currency. */
export const NO_FOREIGN_AMOUNT = { foreignDebit: 0, foreignCredit: 0 };
