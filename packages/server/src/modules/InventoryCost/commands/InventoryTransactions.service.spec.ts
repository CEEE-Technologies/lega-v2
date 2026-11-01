import { InventoryTransactionsService } from './InventoryTransactions.service';
import { events } from '@/common/events/events';

/**
 * I2: re-saving a document undid its old stock movements once per line, all
 * at once, so each re-save added the movements again. Removing every stock
 * line never undid the old movements at all.
 *
 * The fake storage below mirrors what the subscribers do with the events:
 * a created movement changes the item quantity, a deleted one reverts it.
 */
describe('InventoryTransactionsService', () => {
  let rows: any[];
  let quantities: Record<number, number>;
  let warehouses: Record<string, number>;
  let nextId: number;
  let service: InventoryTransactionsService;

  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const signed = (t: any) => (t.direction === 'IN' ? t.quantity : -t.quantity);

  beforeEach(() => {
    rows = [];
    quantities = {};
    warehouses = {};
    nextId = 1;
    const byWarehouse = (t: any) => `${t.itemId}@${t.warehouseId}`;

    const eventEmitter = {
      emitAsync: jest.fn(async (event: string, payload: any) => {
        if (event === events.inventory.onInventoryTransactionsCreated) {
          payload.inventoryTransactions.forEach((t: any) => {
            quantities[t.itemId] = (quantities[t.itemId] || 0) + signed(t);
            warehouses[byWarehouse(t)] =
              (warehouses[byWarehouse(t)] || 0) + signed(t);
          });
        }
        if (event === events.inventory.onInventoryTransactionsDeleted) {
          payload.oldInventoryTransactions.forEach((t: any) => {
            quantities[t.itemId] = (quantities[t.itemId] || 0) - signed(t);
            warehouses[byWarehouse(t)] =
              (warehouses[byWarehouse(t)] || 0) - signed(t);
          });
        }
      }),
    };
    // Each query reads the rows asynchronously, like the database: the old
    // code ran one delete per line in parallel, and each one saw every row.
    const model = () => ({
      query: () => {
        let filter: any = null;
        const builder: any = {
          where(where: any) {
            filter = where;
            return builder;
          },
          async delete() {
            await tick();
            const before = rows.length;
            rows = rows.filter(
              (r) =>
                !(
                  r.transactionId === filter.transactionId &&
                  r.transactionType === filter.transactionType
                ),
            );
            return before - rows.length;
          },
          async insertGraph(row: any) {
            await tick();
            const inserted = { ...row, id: nextId++ };
            rows.push(inserted);
            return inserted;
          },
          then(resolve: any, reject: any) {
            return tick()
              .then(() =>
                rows.filter(
                  (r) =>
                    r.transactionId === filter.transactionId &&
                    r.transactionType === filter.transactionType,
                ),
              )
              .then(resolve, reject);
          },
        };
        return builder;
      },
    });
    service = new InventoryTransactionsService(
      eventEmitter as any,
      model as any,
      model as any,
    );
  });

  const invoice = (lines: Array<[number, number]>): any => ({
    transactionId: 7,
    transactionType: 'SaleInvoice' as const,
    date: '2026-06-01',
    direction: 'OUT' as const,
    createdAt: new Date(),
    entries: lines.map(([itemId, quantity], index) => ({
      id: index + 1,
      itemId,
      quantity,
      rate: 10,
    })) as any,
  });

  it.each([1, 2, 5])(
    'a re-save of a %i-line invoice leaves stock unchanged',
    async (linesCount) => {
      const lines: Array<[number, number]> = Array.from(
        { length: linesCount },
        (_, i) => [100 + i, i + 1.5],
      );
      await service.recordInventoryTransactionsFromItemsEntries(
        invoice(lines),
        false,
      );
      const afterCreate = { ...quantities };

      await service.recordInventoryTransactionsFromItemsEntries(
        invoice(lines),
        true,
      );
      await service.recordInventoryTransactionsFromItemsEntries(
        invoice(lines),
        true,
      );
      expect(quantities).toEqual(afterCreate);
      expect(rows).toHaveLength(linesCount);
    },
  );

  it('a re-save of a 1-line warehouse transfer (2 movements) leaves stock unchanged', async () => {
    const transfer = (quantity: number) => [
      {
        transactionId: 9,
        transactionType: 'WarehouseTransfer',
        itemId: 1,
        quantity,
        direction: 'IN',
        warehouseId: 2,
        date: '2026-06-01',
      },
      {
        transactionId: 9,
        transactionType: 'WarehouseTransfer',
        itemId: 1,
        quantity,
        direction: 'OUT',
        warehouseId: 1,
        date: '2026-06-01',
      },
    ];
    await service.recordInventoryTransactions(transfer(4) as any, false);
    const afterCreate = { ...warehouses };
    await service.recordInventoryTransactions(transfer(4) as any, true);

    expect(afterCreate).toEqual({ '1@1': -4, '1@2': 4 });
    expect(warehouses).toEqual(afterCreate);
    expect(quantities[1]).toBe(0);
    expect(rows).toHaveLength(2);
  });

  it('an edit that changes the quantity moves stock by the difference only', async () => {
    await service.recordInventoryTransactionsFromItemsEntries(
      invoice([
        [1, 5],
        [2, 3],
      ]),
      false,
    );
    await service.recordInventoryTransactionsFromItemsEntries(
      invoice([
        [1, 4],
        [2, 3],
      ]),
      true,
    );
    expect(quantities).toEqual({ 1: -4, 2: -3 });
  });

  it('an edit that removes every stock line still undoes the old movements', async () => {
    await service.recordInventoryTransactionsFromItemsEntries(
      invoice([
        [1, 5],
        [2, 3],
      ]),
      false,
    );
    await service.recordInventoryTransactionsFromItemsEntries(
      invoice([]),
      true,
    );
    expect(quantities).toEqual({ 1: 0, 2: 0 });
    expect(rows).toHaveLength(0);
  });

  it('a create with no stock lines writes nothing', async () => {
    await service.recordInventoryTransactionsFromItemsEntries(
      invoice([]),
      false,
    );
    expect(rows).toHaveLength(0);
    expect(quantities).toEqual({});
  });
});
