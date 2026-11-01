import { SaleInvoicesCost } from './SalesInvoicesCost';

/**
 * I1: a batch of stock movements is costed from the earliest date of each
 * item, not the latest (a later date skips the earlier movements).
 */
describe('SaleInvoicesCost', () => {
  let scheduleComputeItemCost: jest.Mock;
  let service: SaleInvoicesCost;

  beforeEach(() => {
    scheduleComputeItemCost = jest.fn().mockResolvedValue(undefined);
    service = new SaleInvoicesCost(
      { scheduleComputeItemCost } as any,
      {} as any,
      {} as any,
    );
  });

  const scheduled = () =>
    scheduleComputeItemCost.mock.calls
      .map(([itemId, date]) => [itemId, new Date(date).toISOString()])
      .sort((a, b) => a[0] - b[0]);

  it('schedules each item from its earliest movement date', async () => {
    await service.computeItemsCostByInventoryTransactions([
      { itemId: 1, date: '2026-06-01' },
      { itemId: 1, date: '2026-01-10' },
      { itemId: 1, date: '2026-03-01' },
      { itemId: 2, date: '2026-05-05' },
    ] as any);

    expect(scheduled()).toEqual([
      [1, new Date('2026-01-10').toISOString()],
      [2, new Date('2026-05-05').toISOString()],
    ]);
  });

  it('schedules the deleted movements of each item from their own earliest date', async () => {
    await service.scheduleComputeCostByInventoryTransactions([
      { itemId: 3, date: new Date('2026-06-01') },
      { itemId: 4, date: new Date('2026-02-01') },
      { itemId: 3, date: new Date('2026-04-01') },
    ] as any);

    expect(scheduled()).toEqual([
      [3, new Date('2026-04-01').toISOString()],
      [4, new Date('2026-02-01').toISOString()],
    ]);
  });
});
