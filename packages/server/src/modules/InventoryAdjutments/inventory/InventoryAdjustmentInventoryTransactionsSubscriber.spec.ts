import { InventoryAdjustmentInventoryTransactionsSubscriber } from './InventoryAdjustmentInventoryTransactionsSubscriber';

/**
 * I6: a draft adjustment changed stock, publishing it later wrote nothing,
 * and deleting a draft skipped the clean-up.
 */
describe('InventoryAdjustmentInventoryTransactionsSubscriber', () => {
  let inventoryTransactions: {
    writeInventoryTransactions: jest.Mock;
    revertInventoryTransactions: jest.Mock;
  };
  let subscriber: InventoryAdjustmentInventoryTransactionsSubscriber;
  const trx = { id: 'trx' } as any;

  const adjustment = (isPublished: boolean) =>
    ({ id: 3, isPublished, entries: [{ itemId: 1, quantity: 5 }] }) as any;

  beforeEach(() => {
    inventoryTransactions = {
      writeInventoryTransactions: jest.fn().mockResolvedValue(undefined),
      revertInventoryTransactions: jest.fn().mockResolvedValue(undefined),
    };
    subscriber = new InventoryAdjustmentInventoryTransactionsSubscriber(
      inventoryTransactions as any,
    );
  });

  it('a draft does not move stock when created', async () => {
    await subscriber.handleWriteInventoryTransactionsOnceCreated({
      inventoryAdjustment: adjustment(false),
      trx,
    } as any);
    expect(inventoryTransactions.writeInventoryTransactions).not.toBeCalled();
  });

  it('a published adjustment moves stock when created', async () => {
    const published = adjustment(true);
    await subscriber.handleWriteInventoryTransactionsOnceCreated({
      inventoryAdjustment: published,
      trx,
    } as any);
    expect(inventoryTransactions.writeInventoryTransactions).toBeCalledWith(
      published,
      false,
      trx,
    );
  });

  it('publishing a draft moves stock', async () => {
    const published = adjustment(true);
    await subscriber.handleWriteInventoryTransactionsOncePublished({
      inventoryAdjustmentId: 3,
      inventoryAdjustment: published,
      oldInventoryAdjustment: adjustment(false),
      trx,
    } as any);
    // Override: a draft saved by the old code may have moved stock already.
    expect(inventoryTransactions.writeInventoryTransactions).toBeCalledWith(
      published,
      true,
      trx,
    );
  });

  it('editing a published adjustment rewrites its stock movement', async () => {
    const published = adjustment(true);
    await subscriber.handleRewriteInventoryTransactionsOnceEdited({
      inventoryAdjustment: published,
      oldInventoryAdjustment: adjustment(true),
      trx,
    } as any);
    expect(inventoryTransactions.writeInventoryTransactions).toBeCalledWith(
      published,
      true,
      trx,
    );
  });

  it('editing a draft moves no stock (and clears any it moved before)', async () => {
    await subscriber.handleRewriteInventoryTransactionsOnceEdited({
      inventoryAdjustment: adjustment(false),
      oldInventoryAdjustment: adjustment(false),
      trx,
    } as any);
    expect(inventoryTransactions.writeInventoryTransactions).not.toBeCalled();
    expect(inventoryTransactions.revertInventoryTransactions).toBeCalledWith(
      3,
      trx,
    );
  });

  it.each([true, false])(
    'deleting an adjustment (published: %s) always undoes its stock movement',
    async (isPublished) => {
      await subscriber.handleRevertInventoryTransactionsOnceDeleted({
        inventoryAdjustmentId: 3,
        oldInventoryAdjustment: adjustment(isPublished),
        trx,
      } as any);
      expect(inventoryTransactions.revertInventoryTransactions).toBeCalledWith(
        3,
        trx,
      );
    },
  );
});
