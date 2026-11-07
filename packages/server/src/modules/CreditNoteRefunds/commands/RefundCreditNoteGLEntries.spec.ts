import { sumBy } from 'lodash';
import { toCents } from '@bigcapital/utils';
import { RefundCreditNoteGLEntries } from './RefundCreditNoteGLEntries';
import { RefundCreditNoteCashGL } from './RefundCreditNoteCashGL';

/**
 * A refund of a foreign currency credit note is posted in the base
 * currency: the refund amount x the refund's exchange rate, on both the
 * A/R line and the bank line (accrual), and on the bank line and the
 * reversed income lines (cash basis).
 */
const BANK = 900;
const AR = 300;

const buildRefund = (overrides: Record<string, any> = {}) => ({
  id: 1,
  creditNoteId: 7,
  currencyCode: 'EUR',
  exchangeRate: 1.23,
  amount: 65.18,
  date: '2026-06-01',
  referenceNo: 'REF-FX',
  description: 'FX refund',
  createdAt: new Date('2026-06-01'),
  branchId: 1,
  fromAccountId: BANK,
  creditNote: {
    id: 7,
    customerId: 50,
    currencyCode: 'EUR',
    exchangeRate: 1.2,
    total: 100,
    discountAmount: 0,
    adjustment: 0,
    entries: [
      {
        itemId: 10,
        totalExcludingTax: 100,
        sellAccountId: 500,
        description: 'Line',
        item: { sellAccountId: 500 },
      },
    ],
  },
  ...overrides,
});

const accrualEntries = (refund: any) =>
  new RefundCreditNoteGLEntries(
    {} as any,
    {} as any,
    (() => ({})) as any,
    (() => ({})) as any,
  ).getRefundCreditGLEntries(refund, AR);

const cashEntries = (refund: any) =>
  new RefundCreditNoteCashGL(refund)
    .setDiscountAccountId(2)
    .setAdjustmentAccountId(3)
    .setUnearnedRevenueAccountId(4)
    .getLedger()
    .getEntries();

const expectBalanced = (entries: Array<{ debit: number; credit: number }>) =>
  expect(
    entries.reduce((sum, e) => sum + toCents(e.debit) - toCents(e.credit), 0),
  ).toBe(0);

describe('RefundCreditNoteGLEntries — accrual, foreign currency', () => {
  it('posts the A/R and bank lines at amount x the refund rate', () => {
    const entries = accrualEntries(buildRefund());
    const receivable = entries.find((e) => e.accountId === AR);
    const bank = entries.find((e) => e.accountId === BANK);

    // EUR 65.18 x 1.23 = USD 80.17 (was posted as USD 65.18).
    expect(receivable.debit).toBe(80.17);
    expect(receivable.foreignDebit).toBe(65.18);
    expect(bank.credit).toBe(80.17);
    expect(bank.foreignCredit).toBe(65.18);
    expectBalanced(entries);
  });

  it('rounds the converted amount to the cent', () => {
    const entries = accrualEntries(
      buildRefund({ amount: 10.01, exchangeRate: 1.23456 }),
    );
    // 10.01 x 1.23456 = 12.3579... -> 12.36
    expect(entries.map((e) => e.debit + e.credit)).toEqual([12.36, 12.36]);
    expectBalanced(entries);
  });

  it('leaves a base currency refund as it was', () => {
    const entries = accrualEntries(
      buildRefund({ currencyCode: 'USD', exchangeRate: 1, amount: 65.18 }),
    );
    expect(entries.find((e) => e.accountId === AR).debit).toBe(65.18);
    expect(entries.find((e) => e.accountId === BANK).credit).toBe(65.18);
  });
});

describe('RefundCreditNoteCashGL — foreign currency', () => {
  it('posts the bank line and the reversed income at the refund rate', () => {
    const entries = cashEntries(buildRefund());
    const bank = entries.find((e) => e.accountId === BANK);
    const income = entries.find((e) => e.accountId === 500);

    expect(bank.credit).toBe(80.17);
    expect(income.debit).toBe(80.17);
    expectBalanced(entries);
  });

  it('balances to the cent when the converted lines round apart', () => {
    const line = (itemId: number, amount: number) => ({
      itemId,
      totalExcludingTax: amount,
      sellAccountId: 500 + itemId,
      description: 'Line',
      item: { sellAccountId: 500 + itemId },
    });
    const refund = buildRefund({
      amount: 10,
      exchangeRate: 1.2345,
      creditNote: {
        ...buildRefund().creditNote,
        total: 100,
        entries: [line(1, 33.33), line(2, 33.33), line(3, 33.34)],
      },
    });
    const entries = cashEntries(refund);

    expect(entries.find((e) => e.accountId === BANK).credit).toBe(12.35);
    expectBalanced(entries);
  });

  it('takes a refund above the credit note left from unearned revenue, converted', () => {
    const refund = buildRefund({
      amount: 65.18,
      creditNote: { ...buildRefund().creditNote, total: 0, entries: [] },
    });
    const entries = cashEntries(refund);

    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.accountId === BANK).credit).toBe(80.17);
    expect(entries.find((e) => e.accountId === 4).debit).toBe(80.17);
  });

  it('leaves a base currency refund as it was', () => {
    const entries = cashEntries(
      buildRefund({ currencyCode: 'USD', exchangeRate: 1 }),
    );
    expect(entries.find((e) => e.accountId === BANK).credit).toBe(65.18);
    expect(sumBy(entries, 'debit')).toBeCloseTo(65.18, 2);
  });
});
