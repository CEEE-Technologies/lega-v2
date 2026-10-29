import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { sumBy } from 'lodash';
import { RefundCreditNoteCashGL } from './RefundCreditNoteCashGL';

const buildCreditNote = (overrides: Record<string, any> = {}) => {
  const creditNote = {
    exchangeRate: 1,
    totalLocal: 1000,
    discountAmountLocal: null,
    adjustmentLocal: null,
    customerId: 50,
    entries: [
      {
        itemId: 10,
        totalExcludingTax: 1000,
        sellAccountId: null,
        description: 'Item description',
        item: { sellAccountId: 500 },
      },
    ],
    ...overrides,
  };
  // The credit note currency figures the running-total split uses.
  const rate = creditNote.exchangeRate || 1;
  return {
    ...creditNote,
    total: creditNote.totalLocal / rate,
    discountAmount: (creditNote.discountAmountLocal || 0) / rate,
    adjustment: (creditNote.adjustmentLocal || 0) / rate,
  };
};

const buildRefund = (overrides: Record<string, any> = {}) => ({
  id: 1,
  currencyCode: 'USD',
  exchangeRate: 1,
  amount: 1000,
  date: '2023-01-01',
  referenceNo: 'REF-1',
  description: 'Refund description',
  createdAt: new Date('2023-01-01'),
  branchId: 1,
  fromAccountId: 900,
  creditNote: buildCreditNote(),
  ...overrides,
});

const buildLedger = (refund: any) =>
  new RefundCreditNoteCashGL(refund)
    .setDiscountAccountId(2)
    .setAdjustmentAccountId(3)
    .getLedger();

describe('RefundCreditNoteCashGL', () => {
  it('credits the withdrawal account and debits the income accounts', () => {
    const refund = buildRefund();
    const entries = buildLedger(refund).getEntries();

    const withdrawalEntry = entries.find((entry) => entry.accountId === 900);
    const incomeEntry = entries.find((entry) => entry.accountId === 500);

    expect(withdrawalEntry.credit).toBe(1000);
    expect(withdrawalEntry.accountNormal).toBe(AccountNormal.DEBIT);
    expect(withdrawalEntry.basis).toBe('cash');
    expect(withdrawalEntry.indexGroup).toBe(50);

    expect(incomeEntry.debit).toBe(1000);
    expect(incomeEntry.accountNormal).toBe(AccountNormal.CREDIT);
    expect(incomeEntry.itemId).toBe(10);

    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('scales the entries by the refunded proportion for partial refunds', () => {
    const refund = buildRefund({
      amount: 900,
      creditNote: buildCreditNote({
        totalLocal: 1800,
        discountAmountLocal: 200,
        entries: [
          {
            itemId: 10,
            totalExcludingTax: 2000,
            sellAccountId: null,
            description: 'Item description',
            item: { sellAccountId: 500 },
          },
        ],
      }),
    });
    const entries = buildLedger(refund).getEntries();

    const withdrawalEntry = entries.find((entry) => entry.accountId === 900);
    const incomeEntry = entries.find((entry) => entry.accountId === 500);
    const discountEntry = entries.find((entry) => entry.accountId === 2);

    expect(withdrawalEntry.credit).toBe(900);
    expect(incomeEntry.debit).toBe(1000);
    expect(discountEntry.credit).toBe(100);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('mirrors the credit note adjustment sign', () => {
    const refund = buildRefund({
      amount: 850,
      creditNote: buildCreditNote({
        totalLocal: 850,
        adjustmentLocal: 50,
        entries: [
          {
            itemId: 10,
            totalExcludingTax: 800,
            sellAccountId: null,
            description: 'Item description',
            item: { sellAccountId: 500 },
          },
        ],
      }),
    });
    const entries = buildLedger(refund).getEntries();

    const adjustmentEntry = entries.find((entry) => entry.accountId === 3);

    expect(adjustmentEntry.debit).toBe(50);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('mirrors multiple items and prefers the entry-level income account', () => {
    const refund = buildRefund({
      creditNote: buildCreditNote({
        entries: [
          {
            itemId: 10,
            totalExcludingTax: 600,
            sellAccountId: 501,
            description: 'Item one',
            item: { sellAccountId: 500 },
          },
          {
            itemId: 11,
            totalExcludingTax: 400,
            sellAccountId: null,
            description: 'Item two',
            item: { sellAccountId: 502 },
          },
        ],
      }),
    });
    const entries = buildLedger(refund).getEntries();

    expect(entries.find((entry) => entry.itemId === 10).accountId).toBe(501);
    expect(entries.find((entry) => entry.itemId === 11).accountId).toBe(502);
    expect(sumBy(entries, 'debit')).toBeCloseTo(sumBy(entries, 'credit'), 2);
  });

  it('keeps the withdrawal line when the refunded proportion cannot be computed', () => {
    const refund = buildRefund({
      creditNote: buildCreditNote({ totalLocal: 0 }),
    });
    const entries = new RefundCreditNoteCashGL(refund as any)
      .setDiscountAccountId(2)
      .setAdjustmentAccountId(3)
      .setUnearnedRevenueAccountId(4)
      .getLedger()
      .getEntries();

    // The money still left the bank: Cr withdrawal / Dr unearned revenue.
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.accountId === 900).credit).toBe(1000);
    expect(entries.find((entry) => entry.accountId === 4).debit).toBe(1000);
    expect(sumBy(entries, 'debit')).toBe(sumBy(entries, 'credit'));
  });
});

describe('RefundCreditNoteCashGL — running-total split', () => {
  const creditNote3x100 = () =>
    buildCreditNote({
      totalLocal: 300,
      entries: [501, 502, 503].map((sellAccountId) => ({
        itemId: sellAccountId,
        totalExcludingTax: 100,
        sellAccountId,
        item: {},
      })),
    });
  const debitsOf = (refundedBefore: number) => {
    const entries = new RefundCreditNoteCashGL(
      buildRefund({ amount: 100, creditNote: creditNote3x100() }) as any,
    )
      .setDiscountAccountId(2)
      .setAdjustmentAccountId(3)
      .setRefundedBefore(refundedBefore)
      .getLedger()
      .getEntries();
    return [501, 502, 503].map(
      (id) => entries.find((e) => e.accountId === id).debit,
    );
  };

  it('ends every line at exactly 100: 3 x 100 refunded in three refunds', () => {
    expect([debitsOf(0), debitsOf(100), debitsOf(200)]).toEqual([
      [33.34, 33.33, 33.33],
      [33.33, 33.34, 33.33],
      [33.33, 33.33, 33.34],
    ]);
  });

  it('takes a refund above the credit note total from unearned revenue', () => {
    const entries = new RefundCreditNoteCashGL(
      buildRefund({
        amount: 150,
        creditNote: buildCreditNote({
          totalLocal: 100,
          entries: [
            {
              itemId: 10,
              totalExcludingTax: 100,
              sellAccountId: 500,
              item: {},
            },
          ],
        }),
      }) as any,
    )
      .setDiscountAccountId(2)
      .setAdjustmentAccountId(3)
      .setUnearnedRevenueAccountId(4)
      .getLedger()
      .getEntries();
    expect(entries.find((e) => e.accountId === 500).debit).toBe(100);
    expect(entries.find((e) => e.accountId === 4).debit).toBe(50);
    expect(sumBy(entries, 'debit')).toBe(sumBy(entries, 'credit'));
  });
});
