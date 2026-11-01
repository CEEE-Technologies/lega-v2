import { CreditNoteCostGLEntries } from './CreditNoteCostGLEntries';

/**
 * I4: a credit note's ledger entries only reversed the sale; nothing put
 * the returned goods' cost back into stock or reversed the cost of sales.
 */
describe('CreditNoteCostGLEntries.getCostGLEntries', () => {
  const item = { id: 1, inventoryAccountId: 300, costAccountId: 500 };
  const lot = (attrs = {}): any => ({
    direction: 'IN',
    transactionType: 'CreditNote',
    transactionId: 4,
    itemId: 1,
    quantity: 1,
    cost: 50,
    date: '2026-03-01',
    item,
    ...attrs,
  });
  const creditNote: any = {
    id: 4,
    currencyCode: 'USD',
    exchangeRate: 1,
    creditNoteNumber: 'CN-0004',
    branchId: 3,
  };

  it('puts the returned cost back into stock and reverses the cost of sales', () => {
    const entries = CreditNoteCostGLEntries.getCostGLEntries([lot()], {
      4: creditNote,
    });
    expect(entries).toEqual([
      expect.objectContaining({ accountId: 300, debit: 50, credit: 0 }),
      expect.objectContaining({ accountId: 500, debit: 0, credit: 50 }),
    ]);
    entries.forEach((entry) =>
      expect(entry).toMatchObject({
        transactionType: 'CreditNote',
        transactionId: 4,
        transactionNumber: 'CN-0004',
        costable: true,
        // Like the invoice cost of sales.
        basis: 'accrual',
      }),
    );
  });

  it("uses the line's cost account when it has one", () => {
    const entries = CreditNoteCostGLEntries.getCostGLEntries(
      [lot({ costAccountId: 501 })],
      { 4: creditNote },
    );
    expect(entries[1].accountId).toBe(501);
  });

  it('skips lots of deleted credit notes', () => {
    expect(CreditNoteCostGLEntries.getCostGLEntries([lot()], {})).toEqual([]);
  });
});
