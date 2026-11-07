import { sumBy } from 'lodash';
import { toCents } from '@bigcapital/utils';
import { RefundVendorCreditGLEntries } from './RefundVendorCreditGLEntries';
import { RefundVendorCreditCashGL } from './RefundVendorCreditCashGL';

/**
 * A refund of a foreign currency vendor credit is posted in the base
 * currency: the refund amount x the refund's exchange rate, on both the
 * A/P line and the bank line (accrual), and on the bank line and the
 * reversed expense lines (cash basis).
 */
const BANK = 900;
const AP = 400;

const buildRefund = (overrides: Record<string, any> = {}) => ({
  id: 1,
  vendorCreditId: 7,
  currencyCode: 'EUR',
  exchangeRate: 1.23,
  amount: 65.18,
  date: '2026-06-01',
  referenceNo: 'REF-FX',
  description: 'FX refund',
  createdAt: new Date('2026-06-01'),
  branchId: 1,
  depositAccountId: BANK,
  vendorCredit: {
    id: 7,
    vendorId: 60,
    currencyCode: 'EUR',
    exchangeRate: 1.2,
    total: 100,
    discountAmount: 0,
    adjustment: 0,
    entries: [
      {
        itemId: 10,
        totalExcludingTax: 100,
        costAccountId: 500,
        description: 'Line',
        item: { type: 'service', costAccountId: 500 },
      },
    ],
  },
  ...overrides,
});

const accrualEntries = (refund: any) =>
  new RefundVendorCreditGLEntries(
    {} as any,
    {} as any,
    (() => ({})) as any,
    (() => ({})) as any,
  ).getRefundVendorCreditGLEntries(refund, AP);

const cashEntries = (refund: any) =>
  new RefundVendorCreditCashGL(refund)
    .setPurchaseDiscountAccountId(2)
    .setOtherExpensesAccountId(3)
    .setPrepaidExpensesAccountId(4)
    .getLedger()
    .getEntries();

const expectBalanced = (entries: Array<{ debit: number; credit: number }>) =>
  expect(
    entries.reduce((sum, e) => sum + toCents(e.debit) - toCents(e.credit), 0),
  ).toBe(0);

describe('RefundVendorCreditGLEntries — accrual, foreign currency', () => {
  it('posts the A/P and bank lines at amount x the refund rate', () => {
    const entries = accrualEntries(buildRefund());
    const payable = entries.find((e) => e.accountId === AP);
    const bank = entries.find((e) => e.accountId === BANK);

    // EUR 65.18 x 1.23 = USD 80.17 (was posted as USD 65.18).
    expect(payable.credit).toBe(80.17);
    expect(payable.foreignCredit).toBe(65.18);
    expect(bank.debit).toBe(80.17);
    expect(bank.foreignDebit).toBe(65.18);
    expectBalanced(entries);
  });

  it('leaves a base currency refund as it was', () => {
    const entries = accrualEntries(
      buildRefund({ currencyCode: 'USD', exchangeRate: 1 }),
    );
    expect(entries.find((e) => e.accountId === AP).credit).toBe(65.18);
    expect(entries.find((e) => e.accountId === BANK).debit).toBe(65.18);
  });
});

describe('RefundVendorCreditCashGL — foreign currency', () => {
  it('posts the bank line at the refund rate, like the accrual bank line', () => {
    const entries = cashEntries(buildRefund());
    const bank = entries.find((e) => e.accountId === BANK);
    const expense = entries.find((e) => e.accountId === 500);

    // At the vendor credit rate (1.2) it was 78.22, off the accrual 80.17.
    expect(bank.debit).toBe(80.17);
    expect(expense.credit).toBe(80.17);
    expectBalanced(entries);
  });

  it('balances to the cent when the converted lines round apart', () => {
    const line = (itemId: number, amount: number) => ({
      itemId,
      totalExcludingTax: amount,
      costAccountId: 500 + itemId,
      description: 'Line',
      item: { type: 'service', costAccountId: 500 + itemId },
    });
    const refund = buildRefund({
      amount: 10,
      exchangeRate: 1.2345,
      vendorCredit: {
        ...buildRefund().vendorCredit,
        entries: [line(1, 33.33), line(2, 33.33), line(3, 33.34)],
      },
    });
    const entries = cashEntries(refund);

    expect(entries.find((e) => e.accountId === BANK).debit).toBe(12.35);
    expectBalanced(entries);
  });

  it('leaves a base currency refund as it was', () => {
    const entries = cashEntries(
      buildRefund({
        currencyCode: 'USD',
        exchangeRate: 1,
        vendorCredit: { ...buildRefund().vendorCredit, exchangeRate: 1 },
      }),
    );
    expect(entries.find((e) => e.accountId === BANK).debit).toBe(65.18);
    expect(sumBy(entries, 'credit')).toBeCloseTo(65.18, 2);
  });
});
