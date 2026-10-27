/**
 * Money helpers shared by the server and the webapp.
 *
 * Every money amount is a whole number of cents (2 decimals), rounded half
 * away from zero ("commercial rounding": 0.125 -> 0.13, -0.125 -> -0.13).
 * Additions, subtractions and comparisons are done on integer cents, so float
 * error (1.10 + 2.20 = 3.3000000000000003) never leaks into a result.
 *
 * Not money, so these keep their own decimals: quantity, unit price,
 * exchange rate, tax %, inventory unit cost.
 */

/** Decimal places of a money amount. */
export const MONEY_PRECISION = 2;

const CENTS_PER_UNIT = 10 ** MONEY_PRECISION;

/** Value a money helper accepts: a number, a numeric string, or nothing. */
export type MoneyInput = number | string | null | undefined;

/**
 * Converts the given value to a finite number. Empty, null, undefined and
 * non-numeric values ("abc") count as 0, and -0 becomes 0. Strings may use
 * thousands separators ("1,234.50").
 * @param {MoneyInput} value
 * @returns {number}
 */
export const toMoneyNumber = (value: MoneyInput): number => {
  if (value === null || value === undefined || value === '') return 0;

  const number =
    typeof value === 'string'
      ? Number(value.replace(/[,\s]/g, ''))
      : Number(value);

  return Number.isFinite(number) && number !== 0 ? number : 0;
};

/**
 * Scales the absolute value to the given precision, removing the float error
 * of the multiplication first (1.005 * 100 = 100.49999999999999 -> 100.5).
 */
const scaleAbs = (value: number, precision: number): number =>
  Number((Math.abs(value) * 10 ** precision).toPrecision(15));

/**
 * Rounds the given value to the given precision, halves away from zero.
 * @param {MoneyInput} value
 * @param {number} precision - Decimal places (default 2).
 * @returns {number}
 */
export const roundHalfAwayFromZero = (
  value: MoneyInput,
  precision: number = MONEY_PRECISION,
): number => {
  const number = toMoneyNumber(value);
  if (number === 0) return 0;

  const rounded =
    (Math.sign(number) * Math.round(scaleAbs(number, precision))) /
    10 ** precision;

  return rounded === 0 ? 0 : rounded;
};

/**
 * Converts money to whole cents for safe maths: 3.30 -> 330.
 * @param {MoneyInput} value
 * @returns {number} Integer cents.
 */
export const toCents = (value: MoneyInput): number => {
  const number = toMoneyNumber(value);
  if (number === 0) return 0;

  const cents =
    Math.sign(number) * Math.round(scaleAbs(number, MONEY_PRECISION));
  return cents === 0 ? 0 : cents;
};

/**
 * Converts whole cents back to money: 330 -> 3.3.
 * @param {number} cents
 * @returns {number}
 */
export const fromCents = (cents: number): number => {
  const value = Math.round(cents) / CENTS_PER_UNIT;
  return value === 0 ? 0 : value;
};

/**
 * Rounds the given value to cents, halves away from zero:
 * 1.005 -> 1.01, -0.125 -> -0.13.
 * @param {MoneyInput} value
 * @returns {number}
 */
export const roundMoney = (value: MoneyInput): number =>
  fromCents(toCents(value));

/**
 * Compares two amounts in cents.
 * @returns {number} -1, 0 or 1.
 */
export const compareMoney = (a: MoneyInput, b: MoneyInput): number =>
  Math.sign(toCents(a) - toCents(b));

/** Whether the amounts are equal in cents: moneyEq(1.10 + 2.20, 3.30). */
export const moneyEq = (a: MoneyInput, b: MoneyInput): boolean =>
  toCents(a) === toCents(b);

/** Whether `a` is less than `b` in cents. */
export const moneyLt = (a: MoneyInput, b: MoneyInput): boolean =>
  toCents(a) < toCents(b);

/** Whether `a` is less than or equal to `b` in cents. */
export const moneyLte = (a: MoneyInput, b: MoneyInput): boolean =>
  toCents(a) <= toCents(b);

/** Whether `a` is greater than `b` in cents. */
export const moneyGt = (a: MoneyInput, b: MoneyInput): boolean =>
  toCents(a) > toCents(b);

/** Whether `a` is greater than or equal to `b` in cents. */
export const moneyGte = (a: MoneyInput, b: MoneyInput): boolean =>
  toCents(a) >= toCents(b);

/** Whether the amount is zero in cents (0.004 counts as zero). */
export const moneyIsZero = (value: MoneyInput): boolean => toCents(value) === 0;

/**
 * Adds amounts in cents: each amount is rounded to cents, then summed.
 * Accepts the amounts as arguments or as one array.
 * sumMoney(1.10, 2.20) -> 3.3
 * @returns {number}
 */
export const sumMoney = (
  ...values: Array<MoneyInput | MoneyInput[]>
): number => {
  const cents = values.reduce<number>(
    (sum, value) =>
      Array.isArray(value)
        ? value.reduce<number>((inner, v) => inner + toCents(v), sum)
        : sum + toCents(value),
    0,
  );
  return fromCents(cents);
};

/**
 * Sums the given property (or mapped value) of the items in cents.
 * @param {T[]} items
 * @param {keyof T | ((item: T) => MoneyInput)} iteratee
 * @returns {number}
 */
export const sumMoneyBy = <T>(
  items: T[] | null | undefined,
  iteratee: keyof T | ((item: T) => MoneyInput),
): number => {
  const getValue =
    typeof iteratee === 'function'
      ? iteratee
      : (item: T) => item?.[iteratee] as unknown as MoneyInput;

  return fromCents(
    (items || []).reduce((sum, item) => sum + toCents(getValue(item)), 0),
  );
};

/**
 * Subtracts `b` from `a` in cents: subtractMoney(3.3, 1.1) -> 2.2.
 * @returns {number}
 */
export const subtractMoney = (a: MoneyInput, b: MoneyInput): number =>
  fromCents(toCents(a) - toCents(b));

/**
 * Multiplies an amount by a factor (exchange rate, quantity, ratio) and
 * rounds the result to cents.
 * @returns {number}
 */
export const multiplyMoney = (value: MoneyInput, factor: MoneyInput): number =>
  roundMoney(toMoneyNumber(value) * toMoneyNumber(factor));

/**
 * Splits the given total into whole-cent parts proportional to the weights
 * with the largest remainder method (Hamilton method), so the parts always
 * add up exactly to the total rounded to cents:
 * 1. each part gets its share rounded down to the cent,
 * 2. the missing cents go one at a time to the parts with the largest
 *    cut-off fractions; ties go to the larger weight, then the first part.
 *
 * allocateMoney(100, [1, 1, 1]) -> [33.34, 33.33, 33.33]
 *
 * Weights may be zero, negative or mixed (e.g. invoice lines and a negative
 * discount). When the weights add up to zero, the total is split equally.
 * @param {MoneyInput} total
 * @param {MoneyInput[]} weights
 * @returns {number[]}
 */
export const allocateMoney = (
  total: MoneyInput,
  weights: MoneyInput[],
): number[] => {
  return allocateCents(toCents(total), weights).map(fromCents);
};

/**
 * Same as `allocateMoney`, on whole cents.
 * @param {number} totalCents - Integer cents.
 * @param {MoneyInput[]} weights
 * @returns {number[]} Integer cents.
 */
export const allocateCents = (
  totalCents: number,
  weights: MoneyInput[],
): number[] => {
  if (weights.length === 0) return [];

  const numbers = weights.map(toMoneyNumber);
  const weightSum = numbers.reduce((sum, w) => sum + w, 0);
  const effective =
    Math.abs(weightSum) < 1e-12 ? numbers.map(() => 1) : numbers;
  const effectiveSum = effective.reduce((sum, w) => sum + w, 0);

  const shares = effective.map((weight, index) => {
    const exact = Number(
      ((totalCents * weight) / effectiveSum).toPrecision(15),
    );
    const floor = Math.floor(exact);
    return { index, floor, fraction: exact - floor, weight: Math.abs(weight) };
  });
  const allocated = shares.reduce((sum, share) => sum + share.floor, 0);
  let missing = Math.round(totalCents - allocated);

  const order = [...shares].sort(
    (a, b) =>
      b.fraction - a.fraction || b.weight - a.weight || a.index - b.index,
  );
  const parts = shares.map((share) => share.floor);

  // `missing` is between 0 and the number of parts; the loop guards against
  // a degenerate float case anyway.
  for (let i = 0; missing > 0; i = (i + 1) % order.length) {
    parts[order[i].index] += 1;
    missing -= 1;
  }
  return parts.map((part) => (part === 0 ? 0 : part));
};

/**
 * Splits one payment over the lines of a document with the running-total
 * (cumulative) method: the rounded share of the lines recognized after the
 * payment minus the share recognized before it, each computed with
 * `allocateMoney`. The parts add up exactly to the payment, and once the
 * payments reach the document total every line ends exactly at its amount.
 *
 * Invoice 3 x 100 paid in three payments of 100:
 *   allocateCumulative(0, 100, [100, 100, 100])   -> [33.34, 33.33, 33.33]
 *   allocateCumulative(100, 100, [100, 100, 100]) -> [33.33, 33.34, 33.33]
 *   allocateCumulative(200, 100, [100, 100, 100]) -> [33.33, 33.33, 33.34]
 * @param {MoneyInput} paidBefore - Amount paid by the earlier payments.
 * @param {MoneyInput} payment - Amount of this payment.
 * @param {MoneyInput[]} lines - Amounts of the document lines.
 * @returns {number[]}
 */
export const allocateCumulative = (
  paidBefore: MoneyInput,
  payment: MoneyInput,
  lines: MoneyInput[],
): number[] => {
  const beforeCents = toCents(paidBefore);
  const afterCents = beforeCents + toCents(payment);

  const before = allocateCents(beforeCents, lines);
  const after = allocateCents(afterCents, lines);

  return after.map((part, index) => fromCents(part - before[index]));
};

/**
 * Splits one payment over lines recognized in proportion to the paid part
 * of a document, with the running-total method: after a payment, the lines
 * recognized so far are `sum(lines) x paid / documentTotal` (rounded to
 * cents, split with the largest remainder method), and this payment's parts
 * are that minus the same before it. Once the payments reach the document
 * total, every line ends exactly at its amount.
 *
 * Same as `allocateCumulative` when the lines add up to the document total;
 * also works for lines that don't, such as the cost of goods of an invoice:
 *   allocateCumulativeShare(0, 50, 100, [30, 30]) -> [15, 15]
 * @param {MoneyInput} paidBefore - Amount paid by the earlier payments.
 * @param {MoneyInput} payment - Amount of this payment.
 * @param {MoneyInput} documentTotal - Total of the document being paid.
 * @param {MoneyInput[]} lines - Amounts of the lines to recognize.
 * @returns {number[]}
 */
export const allocateCumulativeShare = (
  paidBefore: MoneyInput,
  payment: MoneyInput,
  documentTotal: MoneyInput,
  lines: MoneyInput[],
): number[] => {
  const totalCents = toCents(documentTotal);
  const linesCents = lines.reduce<number>((sum, line) => sum + toCents(line), 0);
  const beforeCents = Math.max(toCents(paidBefore), 0);
  const afterCents = Math.max(beforeCents + toCents(payment), 0);

  if (totalCents <= 0) return lines.map(() => 0);

  // The lines recognized after the given paid amount, in cents.
  const recognizedCents = (paidCents: number) =>
    paidCents >= totalCents
      ? linesCents
      : roundHalfAwayFromZero((linesCents * paidCents) / totalCents, 0);

  const before = allocateCents(recognizedCents(beforeCents), lines);
  const after = allocateCents(recognizedCents(afterCents), lines);

  return after.map((part, index) => fromCents(part - before[index]));
};

export type LineDiscountType = 'percentage' | 'amount';

export interface ILineMoneyInput {
  quantity: MoneyInput;
  /** Unit price (not money: may have more decimals). */
  rate: MoneyInput;
  discount?: MoneyInput;
  /** Defaults to percentage. */
  discountType?: LineDiscountType | string | null;
  /** Tax rate in percent (15 = 15%). */
  taxRate?: MoneyInput;
  isInclusiveTax?: boolean | number | null;
}

export interface ILineMoney {
  /** quantity x rate, rounded to cents. */
  amount: number;
  /** Line discount, rounded to cents. */
  discountAmount: number;
  /** amount - discount: the amount the tax is calculated on. */
  taxableAmount: number;
  /** Line tax, rounded to cents. */
  taxAmount: number;
  /** Line amount without tax, after discount. */
  totalExcludingTax: number;
  /** Line amount with tax, after discount. */
  total: number;
}

/**
 * Calculates the money amounts of a document line (invoice, bill, receipt,
 * estimate, credit note, vendor credit), each rounded to cents:
 * 1. amount = quantity x rate
 * 2. discount = % of the amount, or a fixed amount
 * 3. taxable = amount - discount
 * 4. tax: exclusive = taxable x rate%; inclusive = taxable x rate / (100 + rate)
 * 5. total = taxable (+ tax when exclusive); excluding tax = total - tax.
 *
 * 1.5 x 33.33, 2.5% discount, 15% exclusive tax:
 *   amount 50.00, discount 1.25, taxable 48.75, tax 7.31, total 56.06.
 * @param {ILineMoneyInput} line
 * @returns {ILineMoney}
 */
export const calcLineMoney = (line: ILineMoneyInput): ILineMoney => {
  const amountCents = toCents(
    toMoneyNumber(line.quantity) * toMoneyNumber(line.rate),
  );
  const discount = toMoneyNumber(line.discount);
  const discountCents =
    line.discountType === 'amount'
      ? toCents(discount)
      : roundHalfAwayFromZero((amountCents * discount) / 100, 0);

  const taxableCents = amountCents - discountCents;
  const taxRate = toMoneyNumber(line.taxRate);

  const taxCents = !taxRate
    ? 0
    : line.isInclusiveTax
      ? roundHalfAwayFromZero((taxableCents * taxRate) / (100 + taxRate), 0)
      : roundHalfAwayFromZero((taxableCents * taxRate) / 100, 0);

  const totalCents = line.isInclusiveTax
    ? taxableCents
    : taxableCents + taxCents;

  return {
    amount: fromCents(amountCents),
    discountAmount: fromCents(discountCents),
    taxableAmount: fromCents(taxableCents),
    taxAmount: fromCents(taxCents),
    totalExcludingTax: fromCents(totalCents - taxCents),
    total: fromCents(totalCents),
  };
};

/**
 * Calculates a document-level discount (fixed or % of the subtotal),
 * rounded to cents.
 * @param {MoneyInput} subtotal
 * @param {MoneyInput} discount
 * @param {string} discountType - 'percentage' or 'amount' (default amount).
 * @returns {number}
 */
export const calcDiscountMoney = (
  subtotal: MoneyInput,
  discount: MoneyInput,
  discountType?: LineDiscountType | string | null,
): number =>
  discountType === 'percentage'
    ? roundMoney((toMoneyNumber(subtotal) * toMoneyNumber(discount)) / 100)
    : roundMoney(discount);

export interface IBalanceEntry {
  debit: number;
  credit: number;
}

export interface IBalanceEntriesOptions<T> {
  /**
   * Whether the entry may take the rounding leftover. The leftover goes on
   * the largest such entry. Defaults to every entry.
   */
  canAbsorb?: (entry: T) => boolean;
  /**
   * Largest leftover (in cents) treated as rounding. A bigger difference
   * means the set itself is wrong: it is left unbalanced and reported.
   * Defaults to one cent per entry.
   */
  maxLeftoverCents?: number;
}

export interface IBalanceEntriesResult<T> {
  entries: T[];
  /** Debits minus credits in cents after rounding, before the plug. */
  leftoverCents: number;
  /** Index of the entry that took the leftover, or -1. */
  pluggedIndex: number;
  /** Whether the returned entries balance to the cent. */
  balanced: boolean;
}

/**
 * Rounds the debit and credit of every entry to cents and puts a rounding
 * leftover on one chosen entry (the largest that `canAbsorb`), so the set
 * balances to the cent. A leftover bigger than `maxLeftoverCents` is not
 * hidden: the entries are returned rounded but unbalanced.
 * @param {T[]} entries
 * @param {IBalanceEntriesOptions<T>} options
 * @returns {IBalanceEntriesResult<T>}
 */
export const balanceEntries = <T extends IBalanceEntry>(
  entries: T[],
  options: IBalanceEntriesOptions<T> = {},
): IBalanceEntriesResult<T> => {
  const rounded = entries.map((entry) => ({
    ...entry,
    debit: roundMoney(entry.debit),
    credit: roundMoney(entry.credit),
  }));
  const leftoverCents = rounded.reduce(
    (sum, entry) => sum + toCents(entry.debit) - toCents(entry.credit),
    0,
  );
  if (leftoverCents === 0) {
    return {
      entries: rounded,
      leftoverCents,
      pluggedIndex: -1,
      balanced: true,
    };
  }
  const maxLeftover = options.maxLeftoverCents ?? rounded.length;

  if (Math.abs(leftoverCents) > maxLeftover) {
    return {
      entries: rounded,
      leftoverCents,
      pluggedIndex: -1,
      balanced: false,
    };
  }
  const canAbsorb = options.canAbsorb || (() => true);
  let pluggedIndex = -1;
  let largest = -1;

  rounded.forEach((entry, index) => {
    const size = Math.abs(toCents(entry.debit) - toCents(entry.credit));
    if (size > 0 && size > largest && canAbsorb(entries[index])) {
      largest = size;
      pluggedIndex = index;
    }
  });
  if (pluggedIndex === -1) {
    return {
      entries: rounded,
      leftoverCents,
      pluggedIndex,
      balanced: false,
    };
  }
  const entry = rounded[pluggedIndex];

  // Debits exceed credits by the leftover: grow the credit side of a credit
  // entry, or shrink the debit side of a debit entry (and vice versa).
  rounded[pluggedIndex] =
    toCents(entry.credit) > toCents(entry.debit)
      ? { ...entry, credit: fromCents(toCents(entry.credit) + leftoverCents) }
      : { ...entry, debit: fromCents(toCents(entry.debit) - leftoverCents) };

  return { entries: rounded, leftoverCents, pluggedIndex, balanced: true };
};

/**
 * Whether the value has at most the given decimals (default 2).
 * hasAtMostDecimals(100.5) -> true, hasAtMostDecimals(100.005) -> false.
 * @param {MoneyInput} value
 * @param {number} decimals
 * @returns {boolean}
 */
export const hasAtMostDecimals = (
  value: MoneyInput,
  decimals: number = MONEY_PRECISION,
): boolean => {
  const number = toMoneyNumber(value);
  return roundHalfAwayFromZero(number, decimals) === number;
};
