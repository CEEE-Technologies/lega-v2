import { InventoryAdjustmentCostGLEntries } from './InventoryAdjustmentCostGLEntries';

/**
 * I5: a decrease adjustment lowered the quantity but wrote nothing to the
 * ledger, so the stock value of written-off goods stayed on the Balance
 * Sheet and no loss showed in Profit & Loss.
 */
describe('InventoryAdjustmentCostGLEntries.getCostGLEntries', () => {
  const item = { id: 1, inventoryAccountId: 300, costAccountId: 500 };
  const lot = (attrs = {}): any => ({
    direction: 'OUT',
    transactionType: 'InventoryAdjustment',
    transactionId: 7,
    itemId: 1,
    quantity: 5,
    cost: 250,
    date: '2026-03-01',
    item,
    ...attrs,
  });
  const adjustment = (attrs = {}): any => ({
    id: 7,
    type: 'decrement',
    isPublished: true,
    adjustmentAccountId: 900,
    referenceNo: 'ADJ-9',
    branchId: 2,
    ...attrs,
  });

  it('moves the cost of the written-off units from stock to the adjustment account', () => {
    const entries = InventoryAdjustmentCostGLEntries.getCostGLEntries(
      [lot()],
      { 7: adjustment() },
      'USD',
    );
    expect(entries).toHaveLength(2);
    expect(entries).toEqual([
      expect.objectContaining({ accountId: 900, debit: 250, credit: 0 }),
      expect.objectContaining({ accountId: 300, debit: 0, credit: 250 }),
    ]);
    entries.forEach((entry) => {
      expect(entry).toMatchObject({
        transactionType: 'InventoryAdjustment',
        transactionId: 7,
        costable: true,
        currencyCode: 'USD',
        exchangeRate: 1,
        date: '2026-03-01',
        branchId: 2,
      });
      // Non-cash: on both bases.
      expect(entry.basis).toBeUndefined();
    });
  });

  it('balances with several lots and decimal costs', () => {
    const entries = InventoryAdjustmentCostGLEntries.getCostGLEntries(
      [lot({ cost: 83.325 }), lot({ cost: 16.675, entryId: 2 })],
      { 7: adjustment() },
      'USD',
    );
    const debit = entries.reduce((a, e) => a + e.debit, 0);
    const credit = entries.reduce((a, e) => a + e.credit, 0);
    expect(debit).toBeCloseTo(100, 8);
    expect(credit).toBeCloseTo(100, 8);
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3, 4]);
  });

  it('skips drafts, increases and lots without cost', () => {
    expect(
      InventoryAdjustmentCostGLEntries.getCostGLEntries(
        [lot(), lot({ transactionId: 8 }), lot({ transactionId: 9, cost: 0 })],
        {
          7: adjustment({ isPublished: false }),
          8: adjustment({ id: 8, type: 'increment' }),
          9: adjustment({ id: 9 }),
        },
        'USD',
      ),
    ).toEqual([]);
  });
});
