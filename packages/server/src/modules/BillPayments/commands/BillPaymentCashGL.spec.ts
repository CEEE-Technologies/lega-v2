import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { sumBy } from 'lodash';
import { BillPaymentCashGL } from './BillPaymentCashGL';

const buildBill = (overrides: Record<string, any> = {}) => {
  const bill = {
    id: 1,
    exchangeRate: 1,
    totalLocal: 1000,
    discountAmountLocal: null,
    adjustmentLocal: null,
    entries: [
      {
        itemId: 10,
        totalExcludingTax: 1000,
        taxAmount: 0,
        costAccountId: 200,
        item: { type: 'service' },
      },
    ],
    ...overrides,
  };
  // The bill currency figures the running-total split uses.
  const rate = bill.exchangeRate || 1;
  return {
    ...bill,
    total: bill.totalLocal / rate,
    discountAmount: (bill.discountAmountLocal || 0) / rate,
    adjustment: (bill.adjustmentLocal || 0) / rate,
  };
};

const buildBillPayment = (overrides: Record<string, any> = {}) => ({
  id: 1,
  currencyCode: 'USD',
  exchangeRate: 1,
  paymentNumber: 'PMT-100',
  reference: 'REF-100',
  paymentDate: '2023-01-01',
  createdAt: new Date('2023-01-01'),
  branchId: 1,
  paymentAccountId: 900,
  entries: [],
  ...overrides,
});

const buildLedger = (billPayment: any) =>
  new BillPaymentCashGL(billPayment)
    .setTaxPayableAccountId(1)
    .setPurchaseDiscountAccountId(2)
    .setOtherExpensesAccountId(3)
    .getLedger();

describe('BillPaymentCashGL', () => {
  it('credits the payment account and debits the bill item cost accounts', () => {
    const billPayment = buildBillPayment({
      entries: [{ paymentAmount: 1000, bill: buildBill() }],
    });
    const entries = buildLedger(billPayment).getEntries();

    const paymentEntry = entries.find((entry) => entry.accountId === 900);
    const costEntry = entries.find((entry) => entry.accountId === 200);

    expect(paymentEntry.credit).toBe(1000);
    expect(paymentEntry.accountNormal).toBe(AccountNormal.DEBIT);
    expect(paymentEntry.basis).toBe('cash');
    expect(paymentEntry.indexGroup).toBe(50);

    expect(costEntry.debit).toBe(1000);
    expect(costEntry.accountNormal).toBe(AccountNormal.DEBIT);
    expect(costEntry.itemId).toBe(10);

    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('scales the entries by the paid proportion for partial payments', () => {
    const billPayment = buildBillPayment({
      entries: [
        {
          paymentAmount: 900,
          bill: buildBill({
            totalLocal: 1800,
            discountAmountLocal: 200,
            entries: [
              {
                itemId: 10,
                totalExcludingTax: 2000,
                taxAmount: 0,
                costAccountId: 200,
                item: { type: 'service' },
              },
            ],
          }),
        },
      ],
    });
    const entries = buildLedger(billPayment).getEntries();

    const paymentEntry = entries.find((entry) => entry.accountId === 900);
    const costEntry = entries.find((entry) => entry.accountId === 200);
    const discountEntry = entries.find((entry) => entry.accountId === 2);

    expect(paymentEntry.credit).toBe(900);
    expect(costEntry.debit).toBe(1000);
    expect(discountEntry.credit).toBe(100);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('mirrors the taxes and uses the inventory account for inventory items', () => {
    const billPayment = buildBillPayment({
      entries: [
        {
          paymentAmount: 1100,
          bill: buildBill({
            totalLocal: 1100,
            entries: [
              {
                itemId: 11,
                totalExcludingTax: 1000,
                taxAmount: 100,
                costAccountId: 200,
                item: { type: 'inventory', inventoryAccountId: 300 },
              },
            ],
          }),
        },
      ],
    });
    const entries = buildLedger(billPayment).getEntries();

    const inventoryEntry = entries.find((entry) => entry.accountId === 300);
    const taxEntry = entries.find((entry) => entry.accountId === 1);

    expect(inventoryEntry.debit).toBe(1000);
    expect(taxEntry.debit).toBe(100);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('mirrors the bill adjustment sign', () => {
    const billPayment = buildBillPayment({
      entries: [
        {
          paymentAmount: 850,
          bill: buildBill({
            totalLocal: 850,
            adjustmentLocal: 50,
            entries: [
              {
                itemId: 10,
                totalExcludingTax: 800,
                taxAmount: 0,
                costAccountId: 200,
                item: { type: 'service' },
              },
            ],
          }),
        },
      ],
    });
    const entries = buildLedger(billPayment).getEntries();

    const adjustmentEntry = entries.find((entry) => entry.accountId === 3);

    expect(adjustmentEntry.debit).toBe(50);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('keeps the payment account line when the paid proportion cannot be computed', () => {
    const billPayment = buildBillPayment({
      amount: 1000,
      entries: [{ paymentAmount: 1000, bill: buildBill({ totalLocal: 0 }) }],
    });
    const entries = new BillPaymentCashGL(billPayment as any)
      .setTaxPayableAccountId(1)
      .setPurchaseDiscountAccountId(2)
      .setOtherExpensesAccountId(3)
      .setPrepaidExpensesAccountId(4)
      .getLedger()
      .getEntries();

    // The money still left the bank: Cr payment account / Dr prepaid expenses.
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.accountId === 900).credit).toBe(1000);
    expect(entries.find((e) => e.accountId === 4).debit).toBe(1000);
    expect(sumBy(entries, 'debit')).toBe(sumBy(entries, 'credit'));
  });
});

describe('BillPaymentCashGL — unapplied amount (excess)', () => {
  const PREPAID_EXPENSES = 700;
  const OTHER_EXPENSES = 800;
  const PAYMENT_ACCOUNT = 900;

  const buildExcessGL = (billPayment: any) =>
    new BillPaymentCashGL(billPayment)
      .setTaxPayableAccountId(1)
      .setPurchaseDiscountAccountId(2)
      .setOtherExpensesAccountId(3)
      .setPrepaidExpensesAccountId(PREPAID_EXPENSES);

  const sum = (entries: any[], key: 'debit' | 'credit') =>
    Math.round(sumBy(entries, key) * 100) / 100;

  const sumAccount = (
    entries: any[],
    accountId: number,
    key: 'debit' | 'credit',
  ) =>
    sum(
      entries.filter((e) => e.accountId === accountId),
      key,
    );

  const buildPayment = () =>
    buildBillPayment({
      amount: 1500,
      vendorId: 7,
      entries: [{ paymentAmount: 1000, bill: buildBill() }],
    });

  it('posts the excess to prepaid expenses when there is no opening balance', () => {
    const gl = buildExcessGL(buildPayment());
    const entries = gl.GLEntries();

    expect(gl.getExcessAmount()).toBe(500);
    expect(sumAccount(entries, PAYMENT_ACCOUNT, 'credit')).toBe(1500);
    expect(sumAccount(entries, 200, 'debit')).toBe(1000);
    expect(sumAccount(entries, PREPAID_EXPENSES, 'debit')).toBe(500);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  // Plan example: opening balance 400, bill 500, payment 1,000.
  const buildOpeningBalancePayment = (openingBalancePaid = 400) =>
    buildBillPayment({
      amount: 1000,
      vendorId: 7,
      entries: [
        {
          entryType: 'opening_balance',
          billId: null,
          paymentAmount: openingBalancePaid,
          bill: null,
        },
        {
          entryType: 'invoice',
          paymentAmount: 500,
          bill: buildBill({
            totalLocal: 500,
            entries: [
              {
                itemId: 10,
                totalExcludingTax: 500,
                taxAmount: 0,
                costAccountId: 200,
                item: { type: 'service' },
              },
            ],
          }),
        },
      ],
    });

  it('debits the opening balance account with the opening balance line, only the true excess is prepaid', () => {
    const gl = buildExcessGL(
      buildOpeningBalancePayment(),
    ).setOpeningBalanceAccountId(OTHER_EXPENSES);
    const entries = gl.GLEntries();

    expect(gl.hasOpeningBalanceEntries()).toBe(true);
    expect(gl.getExcessAmount()).toBe(100);
    expect(sumAccount(entries, PAYMENT_ACCOUNT, 'credit')).toBe(1000);
    expect(sumAccount(entries, OTHER_EXPENSES, 'debit')).toBe(400);
    expect(sumAccount(entries, 200, 'debit')).toBe(500);
    expect(sumAccount(entries, PREPAID_EXPENSES, 'debit')).toBe(100);
    expect(entries.find((e) => e.accountId === OTHER_EXPENSES).contactId).toBe(
      7,
    );
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('posts everything not applied to prepaid expenses when the opening balance line is 0', () => {
    const entries = buildExcessGL(buildOpeningBalancePayment(0))
      .setOpeningBalanceAccountId(OTHER_EXPENSES)
      .GLEntries();

    expect(entries.filter((e) => e.accountId === OTHER_EXPENSES)).toHaveLength(
      0,
    );
    expect(sumAccount(entries, PREPAID_EXPENSES, 'debit')).toBe(500);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('keeps the payment account line (as prepaid) when the opening balance account is unknown', () => {
    const entries = buildExcessGL(buildOpeningBalancePayment()).GLEntries();

    expect(sumAccount(entries, PAYMENT_ACCOUNT, 'credit')).toBe(1000);
    expect(sumAccount(entries, PREPAID_EXPENSES, 'debit')).toBe(500);
    expect(sum(entries, 'debit')).toBe(sum(entries, 'credit'));
  });

  it('keeps the payment account line when the bill is missing', () => {
    const entries = buildExcessGL(
      buildBillPayment({
        amount: 400,
        entries: [{ paymentAmount: 400, bill: null }],
      }),
    ).GLEntries();

    expect(sumAccount(entries, PAYMENT_ACCOUNT, 'credit')).toBe(400);
    expect(sumAccount(entries, PREPAID_EXPENSES, 'debit')).toBe(400);
  });

  it('splits a full payment of 100 over 3 lines with the largest remainder', () => {
    const bill = buildBill({
      totalLocal: 100,
      entries: [201, 202, 203].map((costAccountId, index) => ({
        itemId: costAccountId,
        totalExcludingTax: index === 2 ? 33.34 : 33.33,
        taxAmount: 0,
        costAccountId,
        item: { type: 'service' },
      })),
    });
    const entries = buildExcessGL(
      buildBillPayment({
        amount: 100,
        entries: [{ billId: 1, paymentAmount: 100, bill }],
      }),
    ).GLEntries();

    expect(entries.find((e) => e.accountId === 201).debit).toBe(33.33);
    expect(entries.find((e) => e.accountId === 202).debit).toBe(33.33);
    expect(entries.find((e) => e.accountId === 203).debit).toBe(33.34);
    expect(sum(entries, 'debit')).toBe(100);
    expect(sum(entries, 'credit')).toBe(100);
  });

  it('ends every line at exactly 100: 3 x 100 paid in three payments of 100', () => {
    const bill = buildBill({
      totalLocal: 300,
      entries: [201, 202, 203].map((costAccountId) => ({
        itemId: costAccountId,
        totalExcludingTax: 100,
        taxAmount: 0,
        costAccountId,
        item: { type: 'service' },
      })),
    });
    const debitsOf = (paidBefore: number) => {
      const entries = new BillPaymentCashGL(
        buildBillPayment({
          amount: 100,
          entries: [{ billId: 1, paymentAmount: 100, bill }],
        }) as any,
      )
        .setTaxPayableAccountId(1)
        .setPurchaseDiscountAccountId(2)
        .setOtherExpensesAccountId(3)
        .setPaidBefore({ 1: paidBefore })
        .GLEntries();
      return [201, 202, 203].map(
        (id) => entries.find((e) => e.accountId === id).debit,
      );
    };
    const parts = [debitsOf(0), debitsOf(100), debitsOf(200)];
    expect(parts).toEqual([
      [33.34, 33.33, 33.33],
      [33.33, 33.34, 33.33],
      [33.33, 33.33, 33.34],
    ]);
  });
});

// Codex: converting each bill's share on its own made the payment account
// lines add up to a cent more or less than the accrual line,
// round(amount x rate).
describe('BillPaymentCashGL — payment account lines add up to the accrual line', () => {
  const cents = (value: number) => Math.round((value || 0) * 100);
  const sumCents = (entries: any[], accountId: number, side: string) =>
    entries
      .filter((entry) => entry.accountId === accountId)
      .reduce((total, entry) => total + cents(entry[side]), 0);
  const expectBalanced = (entries: any[]) =>
    expect(entries.reduce((t, e) => t + cents(e.debit), 0)).toBe(
      entries.reduce((t, e) => t + cents(e.credit), 0),
    );

  const foreignBill = (id: number, total: number, rate: number) =>
    buildBill({
      id,
      exchangeRate: rate,
      totalLocal: total * rate,
      entries: [
        {
          itemId: 10,
          totalExcludingTax: total,
          taxAmount: 0,
          costAccountId: 200,
          item: { type: 'service' },
        },
      ],
    });

  const glOf = (rate: number, amount: number, entries: any[]) =>
    new BillPaymentCashGL(
      buildBillPayment({ exchangeRate: rate, amount, entries }) as any,
    )
      .setTaxPayableAccountId(1)
      .setPurchaseDiscountAccountId(2)
      .setOtherExpensesAccountId(3)
      .setPrepaidExpensesAccountId(4)
      .setExchangeGainOrLossAccountId(5)
      .setOpeningBalanceAccountId(6);

  it('0.02 at 1.5 split 0.01 + 0.01 credits 0.03, not 0.04', () => {
    const gl = glOf(1.5, 0.02, [
      { billId: 11, paymentAmount: 0.01, bill: foreignBill(11, 0.01, 1.5) },
      { billId: 12, paymentAmount: 0.01, bill: foreignBill(12, 0.01, 1.5) },
    ]);
    const entries = gl.GLEntries();
    expect(sumCents(entries, 900, 'credit')).toBe(3);
    expect(gl.getExcessAmount()).toBe(0);
    expect(entries.find((e) => e.accountId === 4)).toBeUndefined();
    expectBalanced(entries);
  });

  it('USD 100.02 at 300.005 over 3 bills of 33.34 credits 30,006.50', () => {
    const gl = glOf(
      300.005,
      100.02,
      [21, 22, 23].map((id) => ({
        billId: id,
        paymentAmount: 33.34,
        bill: foreignBill(id, 33.34, 300.005),
      })),
    );
    const entries = gl.GLEntries();
    expect(sumCents(entries, 900, 'credit')).toBe(3000650);
    expect(gl.getExcessAmount()).toBe(0);
    expect(sumCents(entries, 200, 'debit')).toBe(3 * 1000217);
    expectBalanced(entries);
  });

  it('includes the opening balance and the excess in the split', () => {
    const gl = glOf(300.005, 100.03, [
      ...[31, 32].map((id) => ({
        billId: id,
        paymentAmount: 33.34,
        bill: foreignBill(id, 33.34, 300.005),
      })),
      { entryType: 'opening_balance', billId: null, paymentAmount: 0.01 },
    ]);
    const entries = gl.GLEntries();
    expect(sumCents(entries, 900, 'credit')).toBe(3000950);
    expect(gl.getExcessAmount()).toBeGreaterThan(0);
    expect(sumCents(entries, 4, 'debit')).toBe(cents(gl.getExcessAmount()));
    expectBalanced(entries);
  });
});

// Codex: a payment that converts to 0.00 (EUR 0.01 at 0.4) was not
// recognized, so a bill paid as 3 x EUR 0.01 never had its expense
// (EUR 0.03 = USD 0.01) recognized in cash basis.
describe('BillPaymentCashGL — payments that convert to zero', () => {
  const cents = (value: number) => Math.round((value || 0) * 100);

  it('recognizes EUR 0.03 at 0.4 paid as 3 x 0.01 on the payment where the cent crosses', () => {
    const bill = buildBill({
      id: 51,
      exchangeRate: 0.4,
      totalLocal: 0.012,
      entries: [
        {
          itemId: 10,
          totalExcludingTax: 0.03,
          taxAmount: 0,
          costAccountId: 200,
          item: { type: 'service' },
        },
      ],
    });
    let paid = 0;
    let expense = 0;
    let bank = 0;
    let exchange = 0;
    for (let i = 0; i < 3; i += 1) {
      const entries = new BillPaymentCashGL(
        buildBillPayment({
          exchangeRate: 0.4,
          amount: 0.01,
          entries: [{ billId: 51, paymentAmount: 0.01, bill }],
        }) as any,
      )
        .setTaxPayableAccountId(1)
        .setPurchaseDiscountAccountId(2)
        .setOtherExpensesAccountId(3)
        .setPrepaidExpensesAccountId(4)
        .setExchangeGainOrLossAccountId(5)
        .setPaidBefore({ 51: paid })
        .GLEntries();
      const sum = (accountId: number, side: string) =>
        entries
          .filter((e) => e.accountId === accountId)
          .reduce((t, e) => t + cents(e[side]), 0);
      expect(entries.reduce((t, e) => t + cents(e.debit), 0)).toBe(
        entries.reduce((t, e) => t + cents(e.credit), 0),
      );
      expect(sum(4, 'debit')).toBe(0);
      expense += sum(200, 'debit') - sum(200, 'credit');
      bank += sum(900, 'credit') - sum(900, 'debit');
      exchange += sum(5, 'credit') - sum(5, 'debit');
      paid = Math.round((paid + 0.01) * 100) / 100;
    }
    expect(expense).toBe(1);
    expect(bank).toBe(0);
    expect(exchange).toBe(1);
  });
});
