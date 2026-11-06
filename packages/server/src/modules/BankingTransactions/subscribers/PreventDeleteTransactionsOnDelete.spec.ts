import { PreventDeleteTransactionOnDeleteSubscriber } from './PreventDeleteTransactionsOnDelete';

/**
 * Since handler errors stop the save (E1), this check must not crash: the
 * model is a tenant model proxy (a function), not the model class.
 */
describe('PreventDeleteTransactionOnDeleteSubscriber', () => {
  const setup = (rows: unknown[]) => {
    const where = jest.fn(async () => rows);
    const query = jest.fn(() => ({ where }));
    const modelProxy = jest.fn(() => ({ query }));
    const subscriber = new PreventDeleteTransactionOnDeleteSubscriber(
      modelProxy as any,
    );
    return { subscriber, modelProxy, query, where };
  };

  const payload = (uncategorizedTransactionId: number | null) =>
    ({
      oldCashflowTransaction: { id: 9, uncategorizedTransactionId },
      trx: { id: 'trx' },
    }) as any;

  it('refuses the delete while a bank line is still categorized to it', async () => {
    const { subscriber, query } = setup([{ id: 1 }]);
    await expect(
      subscriber.preventDeleteCashflowTransactionHasUncategorizedTransaction(
        payload(5),
      ),
    ).rejects.toMatchObject({
      errorType: 'CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED',
    });
    expect(query).toHaveBeenCalledWith({ id: 'trx' });
  });

  it('allows the delete when no bank line points at it', async () => {
    const { subscriber } = setup([]);
    await expect(
      subscriber.preventDeleteCashflowTransactionHasUncategorizedTransaction(
        payload(5),
      ),
    ).resolves.toBeUndefined();
  });

  it('skips the lookup for a transaction not made from a bank line', async () => {
    const { subscriber, modelProxy } = setup([{ id: 1 }]);
    await subscriber.preventDeleteCashflowTransactionHasUncategorizedTransaction(
      payload(null),
    );
    expect(modelProxy).not.toHaveBeenCalled();
  });
});
