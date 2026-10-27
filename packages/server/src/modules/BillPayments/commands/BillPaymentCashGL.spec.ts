import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { sumBy } from 'lodash';
import { BillPaymentCashGL } from './BillPaymentCashGL';

const buildBill = (overrides: Record<string, any> = {}) => ({
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
});

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
    Math.round(sumBy(entries, key) * 1000) / 1000;

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

  it('rounds pro-rata lines and puts the remainder on the last line (100 over 3)', () => {
    const bill = buildBill({
      totalLocal: 3,
      entries: [201, 202, 203].map((costAccountId) => ({
        itemId: costAccountId,
        totalExcludingTax: 1,
        taxAmount: 0,
        costAccountId,
        item: { type: 'service' },
      })),
    });
    const entries = buildExcessGL(
      buildBillPayment({
        amount: 100,
        entries: [{ paymentAmount: 100, bill }],
      }),
    ).GLEntries();

    expect(entries.find((e) => e.accountId === 201).debit).toBe(33.333);
    expect(entries.find((e) => e.accountId === 202).debit).toBe(33.333);
    expect(entries.find((e) => e.accountId === 203).debit).toBe(33.334);
    expect(sum(entries, 'debit')).toBe(100);
    expect(sum(entries, 'credit')).toBe(100);
  });
});
