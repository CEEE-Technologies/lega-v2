import { entriesAmountDiff, entriesMoneyDiff } from './entries-amount-diff';

describe('entriesMoneyDiff', () => {
  it('leaves out amounts unchanged to the cent (1.10 + 2.20 vs 3.30)', () => {
    const diff = entriesMoneyDiff(
      [
        { invoiceId: 1, paymentAmount: 1.1 },
        { invoiceId: 1, paymentAmount: 2.2 },
      ],
      [{ invoiceId: 1, paymentAmount: 3.3 }],
      'paymentAmount',
      'invoiceId',
    );
    expect(diff).toEqual([]);
  });

  it('returns the change per id in cents, including removed ids', () => {
    const diff = entriesMoneyDiff(
      [{ invoiceId: 1, paymentAmount: 0.3 }],
      [
        { invoiceId: 1, paymentAmount: 0.1 },
        { invoiceId: 2, paymentAmount: 5.5 },
      ],
      'paymentAmount',
      'invoiceId',
    );
    expect(diff).toEqual([
      { invoiceId: '1', paymentAmount: 0.2 },
      { invoiceId: '2', paymentAmount: -5.5 },
    ]);
  });
});

describe('entriesAmountDiff', () => {
  it('keeps the decimals of quantities', () => {
    const diff = entriesAmountDiff(
      [{ itemId: 1, quantity: 0.333 }],
      [],
      'quantity',
      'itemId',
    );
    expect(diff).toEqual([{ itemId: '1', quantity: 0.333 }]);
  });
});
