import { calcLineMoney, roundMoney, sumMoneyBy } from '@bigcapital/utils';
import {
  SaleInvoice,
  SALE_INVOICE_MONEY_SQL,
} from '../src/modules/SaleInvoices/models/SaleInvoice';
import { Bill, BILL_MONEY_SQL } from '../src/modules/Bills/models/Bill';
import {
  CreditNote,
  CREDIT_NOTE_MONEY_SQL,
} from '../src/modules/CreditNotes/models/CreditNote';
import {
  VendorCredit,
  VENDOR_CREDIT_MONEY_SQL,
} from '../src/modules/VendorCredit/models/VendorCredit';
import {
  ADJUSTMENT,
  MATRIX_DISCOUNTS,
  MATRIX_SUBTOTALS,
  TAX_RATE,
  closeTenantKnex,
  getTenantKnex,
} from './_utils/money-matrix';

/**
 * Money parity on the database: the SQL a model uses to filter and sort
 * (paid / partially paid / due / open) must give the same answer as the
 * model getters, on the real column types (DECIMAL), for every
 * combination of the matrix: discount (amount 3.33, 2.5%, 0.5%, 3.33%,
 * 33.33%, 10%) x subtotal (101.00, 1.00, 33.33, 3 x 33.33, 1.5 x 33.33,
 * 999.99) x line or document discount x no / exclusive / inclusive tax x
 * with or without adjustment x unpaid / part paid / fully paid / over paid.
 * Plus old rows stored with 3 decimals and an empty discount type.
 *
 * The rows go into a TEMPORARY table (dropped with the connection), so
 * nothing is written to the tenant data.
 *
 * Codex P2: the % discount was not rounded in the SQL, so 101.00 at 2.5%
 * paid 98.47 was "paid" for the getter and 0.01 due for the SQL.
 */
describe('Money parity — model SQL equals model getters (e2e, database)', () => {
  afterAll(async () => {
    await closeTenantKnex();
  });

  interface DocRow {
    subtotal: number;
    tax: number;
    inclusive: boolean;
    discount: number | null;
    discountType: string | null;
    adjustment: number | null;
  }

  /** Every subtotal x discount x level x tax x adjustment of the matrix. */
  const documentRows = (withTax: boolean): DocRow[] => {
    const rows: DocRow[] = [];
    const taxModes = withTax ? ['none', 'exclusive', 'inclusive'] : ['none'];

    MATRIX_SUBTOTALS.forEach((subtotal) =>
      MATRIX_DISCOUNTS.forEach((discount) =>
        ['line', 'document'].forEach((level) =>
          taxModes.forEach((tax) =>
            [null, ADJUSTMENT].forEach((adjustment) => {
              const lines = [
                calcLineMoney({
                  quantity: subtotal.quantity,
                  rate: subtotal.rate,
                  discount: level === 'line' ? discount.value : 0,
                  discountType: discount.type,
                  taxRate: tax === 'none' ? 0 : TAX_RATE,
                  isInclusiveTax: tax === 'inclusive',
                }),
              ];
              rows.push({
                subtotal: sumMoneyBy(lines, 'taxableAmount'),
                tax: sumMoneyBy(lines, 'taxAmount'),
                inclusive: tax === 'inclusive',
                discount: level === 'document' ? discount.value : null,
                discountType: level === 'document' ? discount.type : null,
                adjustment,
              });
            }),
          ),
        ),
      ),
    );
    // Old rows: 3-decimal stored amounts, an empty discount type with a
    // discount (a percentage on both sides, as always posted), missing
    // values.
    rows.push(
      {
        subtotal: 100.005,
        tax: 0,
        inclusive: false,
        discount: 2.5,
        discountType: 'percentage',
        adjustment: null,
      },
      {
        subtotal: 49.995,
        tax: 7.5,
        inclusive: false,
        discount: 0.5,
        discountType: 'percentage',
        adjustment: 0.01,
      },
      {
        subtotal: 50,
        tax: 0,
        inclusive: false,
        discount: 5,
        discountType: null,
        adjustment: null,
      },
      {
        subtotal: 10,
        tax: 0,
        inclusive: false,
        discount: null,
        discountType: null,
        adjustment: null,
      },
    );
    return rows;
  };

  /** Unpaid, a third paid (3 decimals, as old rows may be), fully paid, over paid. */
  const settledCases = (total: number) => [
    0,
    Math.round((total / 3) * 1000) / 1000,
    total,
    roundMoney(total + 0.01),
  ];

  /**
   * Loads the rows into a temporary table with the given column types,
   * selects the SQL expressions and returns them in row order.
   */
  const runSql = async (
    columns: Record<string, string>,
    rows: Record<string, any>[],
    expressions: Record<string, string>,
  ) => {
    const knex = getTenantKnex();
    return knex.transaction(async (trx) => {
      const table = `MONEY_PARITY_${Date.now()}`;
      const columnsSql = Object.entries(columns)
        .map(([name, type]) => `${name} ${type}`)
        .join(', ');
      await trx.raw(
        `CREATE TEMPORARY TABLE ${table} (ID INT PRIMARY KEY, ${columnsSql})`,
      );
      const names = Object.keys(columns);
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        await trx.raw(
          `INSERT INTO ${table} (ID, ${names.join(', ')}) VALUES ${chunk
            .map(() => `(${['?', ...names.map(() => '?')].join(', ')})`)
            .join(', ')}`,
          chunk.flatMap((row, j) => [i + j + 1, ...names.map((n) => row[n])]),
        );
      }
      const select = Object.entries(expressions)
        .map(([key, sql]) => `${sql} AS \`${key}\``)
        .join(', ');
      const [result] = await trx.raw(
        `SELECT ID, ${select} FROM ${table} ORDER BY ID`,
      );
      await trx.raw(`DROP TEMPORARY TABLE ${table}`);
      return result.map((row) =>
        Object.fromEntries(
          Object.keys(expressions).map((key) => [key, Number(row[key])]),
        ),
      );
    });
  };

  const DOC_COLUMNS = {
    DISCOUNT: 'DECIMAL(10,2) NULL',
    DISCOUNT_TYPE: 'VARCHAR(255) NULL',
    ADJUSTMENT: 'DECIMAL(10,2) NULL',
  };

  it('invoices: total, due, paid and partially paid agree on every row', async () => {
    const rows = documentRows(true).flatMap((doc) => {
      const total = SaleInvoice.fromJson(
        {
          balance: doc.subtotal,
          discount: doc.discount,
          discountType: doc.discountType,
          adjustment: doc.adjustment,
          taxAmountWithheld: doc.tax,
          isInclusiveTax: doc.inclusive,
        } as any,
        { skipValidation: true },
      ).total;
      return settledCases(total).map((paid) => ({ doc, paid }));
    });
    const sql = await runSql(
      {
        ...DOC_COLUMNS,
        BALANCE: 'DECIMAL(13,3) NULL',
        TAX_AMOUNT_WITHHELD: 'DECIMAL(13,2) NULL',
        IS_INCLUSIVE_TAX: 'TINYINT(1) NULL',
        PAYMENT_AMOUNT: 'DECIMAL(13,3) NULL',
        WRITTENOFF_AMOUNT: 'DECIMAL(13,3) NULL',
        CREDITED_AMOUNT: 'DECIMAL(13,3) NULL',
      },
      rows.map(({ doc, paid }) => ({
        BALANCE: doc.subtotal,
        DISCOUNT: doc.discount,
        DISCOUNT_TYPE: doc.discountType,
        ADJUSTMENT: doc.adjustment,
        TAX_AMOUNT_WITHHELD: doc.tax,
        IS_INCLUSIVE_TAX: doc.inclusive ? 1 : 0,
        PAYMENT_AMOUNT: paid,
        WRITTENOFF_AMOUNT: 0,
        CREDITED_AMOUNT: null,
      })),
      SALE_INVOICE_MONEY_SQL,
    );
    const mismatches = rows.filter(({ doc, paid }, i) => {
      const invoice = SaleInvoice.fromJson(
        {
          balance: doc.subtotal,
          discount: doc.discount,
          discountType: doc.discountType,
          adjustment: doc.adjustment,
          taxAmountWithheld: doc.tax,
          isInclusiveTax: doc.inclusive,
          paymentAmount: paid,
          writtenoffAmount: 0,
          creditedAmount: null,
        } as any,
        { skipValidation: true },
      );
      const row = sql[i];
      return (
        row.total !== invoice.total ||
        Math.max(row.due, 0) !== invoice.dueAmount ||
        row.due <= 0 !== invoice.isFullyPaid ||
        (row.settled > 0 && row.due > 0) !== invoice.isPartiallyPaid
      );
    });
    expect(rows.length).toBeGreaterThan(1700);
    expect(mismatches).toEqual([]);
  });

  it('bills: total, due, paid and partially paid agree on every row', async () => {
    const rows = documentRows(true).flatMap((doc) => {
      const total = Bill.fromJson(
        {
          amount: doc.subtotal,
          discount: doc.discount,
          discountType: doc.discountType,
          adjustment: doc.adjustment,
          taxAmountWithheld: doc.tax,
          isInclusiveTax: doc.inclusive,
        } as any,
        { skipValidation: true },
      ).total;
      return settledCases(total).map((paid) => ({ doc, paid }));
    });
    const sql = await runSql(
      {
        ...DOC_COLUMNS,
        AMOUNT: 'DECIMAL(13,3) NULL',
        TAX_AMOUNT_WITHHELD: 'DECIMAL(13,2) NULL',
        IS_INCLUSIVE_TAX: 'TINYINT(1) NULL',
        PAYMENT_AMOUNT: 'DECIMAL(13,3) NULL',
        CREDITED_AMOUNT: 'DECIMAL(13,3) NULL',
      },
      rows.map(({ doc, paid }) => ({
        AMOUNT: doc.subtotal,
        DISCOUNT: doc.discount,
        DISCOUNT_TYPE: doc.discountType,
        ADJUSTMENT: doc.adjustment,
        TAX_AMOUNT_WITHHELD: doc.tax,
        IS_INCLUSIVE_TAX: doc.inclusive ? 1 : 0,
        PAYMENT_AMOUNT: paid,
        CREDITED_AMOUNT: 0,
      })),
      BILL_MONEY_SQL,
    );
    const mismatches = rows.filter(({ doc, paid }, i) => {
      const bill = Bill.fromJson(
        {
          amount: doc.subtotal,
          discount: doc.discount,
          discountType: doc.discountType,
          adjustment: doc.adjustment,
          taxAmountWithheld: doc.tax,
          isInclusiveTax: doc.inclusive,
          paymentAmount: paid,
          creditedAmount: 0,
        } as any,
        { skipValidation: true },
      );
      const row = sql[i];
      return (
        row.total !== bill.total ||
        Math.max(row.due, 0) !== bill.dueAmount ||
        row.due <= 0 !== bill.isFullyPaid ||
        (row.settled > 0 && row.due > 0) !== bill.isPartiallyPaid
      );
    });
    expect(rows.length).toBeGreaterThan(1700);
    expect(mismatches).toEqual([]);
  });

  it.each([
    [
      'credit notes',
      CreditNote,
      CREDIT_NOTE_MONEY_SQL,
      'INVOICES_AMOUNT',
      'invoicesAmount',
    ],
    [
      'vendor credits',
      VendorCredit,
      VENDOR_CREDIT_MONEY_SQL,
      'INVOICED_AMOUNT',
      'invoicedAmount',
    ],
  ])(
    '%s: total and credits remaining agree on every row',
    async (_label, Model: any, moneySql, usedColumn, usedKey) => {
      const rows = documentRows(false).flatMap((doc) => {
        const total = Model.fromJson(
          {
            amount: doc.subtotal,
            discount: doc.discount,
            discountType: doc.discountType,
            adjustment: doc.adjustment,
          },
          { skipValidation: true },
        ).total;
        return settledCases(total).map((used) => ({ doc, used }));
      });
      const sql = await runSql(
        {
          ...DOC_COLUMNS,
          AMOUNT: 'DECIMAL(13,3) NULL',
          REFUNDED_AMOUNT: 'DECIMAL(13,3) NULL',
          [usedColumn]: 'DECIMAL(13,3) NULL',
        },
        rows.map(({ doc, used }) => ({
          AMOUNT: doc.subtotal,
          DISCOUNT: doc.discount,
          DISCOUNT_TYPE: doc.discountType,
          ADJUSTMENT: doc.adjustment,
          REFUNDED_AMOUNT: 0,
          [usedColumn]: used,
        })),
        moneySql,
      );
      const mismatches = rows.filter(({ doc, used }, i) => {
        const credit = Model.fromJson(
          {
            amount: doc.subtotal,
            discount: doc.discount,
            discountType: doc.discountType,
            adjustment: doc.adjustment,
            refundedAmount: 0,
            [usedKey]: used,
            openedAt: '2025-01-01',
          },
          { skipValidation: true },
        );
        const row = sql[i];
        return (
          row.total !== credit.total ||
          Math.max(row.remaining, 0) !== credit.creditsRemaining ||
          row.remaining > 0 !== credit.isOpen
        );
      });
      expect(rows.length).toBeGreaterThan(290);
      expect(mismatches).toEqual([]);
    },
  );

  it('Codex P2 example: 101.00 at 2.5% paid 98.47 is paid in both', async () => {
    const [row] = await runSql(
      {
        ...DOC_COLUMNS,
        BALANCE: 'DECIMAL(13,3) NULL',
        TAX_AMOUNT_WITHHELD: 'DECIMAL(13,2) NULL',
        IS_INCLUSIVE_TAX: 'TINYINT(1) NULL',
        PAYMENT_AMOUNT: 'DECIMAL(13,3) NULL',
        WRITTENOFF_AMOUNT: 'DECIMAL(13,3) NULL',
        CREDITED_AMOUNT: 'DECIMAL(13,3) NULL',
      },
      [
        {
          BALANCE: 101,
          DISCOUNT: 2.5,
          DISCOUNT_TYPE: 'percentage',
          ADJUSTMENT: null,
          TAX_AMOUNT_WITHHELD: 0,
          IS_INCLUSIVE_TAX: 0,
          PAYMENT_AMOUNT: 98.47,
          WRITTENOFF_AMOUNT: 0,
          CREDITED_AMOUNT: 0,
        },
      ],
      SALE_INVOICE_MONEY_SQL,
    );
    // Before the fix: ROUND(101 - 2.525 - 98.47, 2) = 0.01 still due.
    expect(row).toEqual({ total: 98.47, due: 0, settled: 98.47 });
  });
});
