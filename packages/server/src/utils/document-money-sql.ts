/**
 * SQL copies of the document money getters, for list filters, sorting and
 * reports that decide in the database whether a document is paid, due or
 * open.
 *
 * They follow `calcDocumentMoney()` / `sumMoney()` in
 * shared/bigcapital-utils/src/money.ts step by step: every part is rounded
 * to cents on its own and then added, and a percentage discount is
 * `ROUND(subtotal x % / 100, 2)`. The money columns are DECIMAL, so MariaDB
 * does this maths exactly and its ROUND rounds halves away from zero, the
 * same rule as `roundMoney()`. The money parity e2e test
 * (test/money-parity.e2e-spec.ts) selects these expressions and compares
 * them with the getters; change both sides together.
 *
 * Columns are written unqualified, as in the model modifiers that use them.
 */

/** One money column rounded to cents, a missing value counts as 0. */
export const sqlMoney = (column: string): string =>
  `ROUND(COALESCE(${column}, 0), 2)`;

/** Sum of money columns, each rounded to cents first (like `sumMoney`). */
export const sqlSumMoney = (...columns: string[]): string =>
  `(${columns.map(sqlMoney).join(' + ')})`;

/**
 * The document discount in cents (like `calcDiscountMoney`): a fixed
 * amount, or a percentage of the subtotal for any other discount type
 * (an empty type on old rows is a percentage, as it was always posted).
 * @param {string} subtotalColumn - `BALANCE` on invoices, `AMOUNT` elsewhere.
 */
export const sqlDiscountAmount = (subtotalColumn: string): string =>
  `(CASE WHEN DISCOUNT_TYPE = 'amount'
      THEN ${sqlMoney('DISCOUNT')}
      ELSE ROUND(COALESCE(${subtotalColumn}, 0) * COALESCE(DISCOUNT, 0) / 100, 2) END)`;

/**
 * The document total in cents (like `calcDocumentMoney().total`):
 * subtotal - discount + adjustment [+ tax when it is exclusive].
 * @param {string} subtotalColumn - `BALANCE` on invoices, `AMOUNT` elsewhere.
 * @param {boolean} withTax - Whether the document has a tax column
 *   (invoices and bills).
 */
export const sqlDocumentTotal = (
  subtotalColumn: string,
  withTax: boolean,
): string => {
  const tax = withTax
    ? `\n  + CASE WHEN IS_INCLUSIVE_TAX THEN 0 ELSE ${sqlMoney('TAX_AMOUNT_WITHHELD')} END`
    : '';
  return `(${sqlMoney(subtotalColumn)}
  - ${sqlDiscountAmount(subtotalColumn)}
  + ${sqlMoney('ADJUSTMENT')}${tax})`;
};

/**
 * What is left of a total after the settled amounts, in cents (like
 * `subtractMoney(total, sumMoney(...settled))`). It can be negative when a
 * document is over-settled; the getters clamp it to 0, which compares the
 * same way against 0.
 */
export const sqlMoneyLeft = (
  totalSql: string,
  ...settledColumns: string[]
): string => `(${totalSql} - ${sqlSumMoney(...settledColumns)})`;
