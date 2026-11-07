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

  // B3: categorizing never sets the deposit's `uncategorizedTransactionId`,
  // so the line is looked up by the deposit's own id.
  it('looks the bank line up by the deposit id when uncategorizedTransactionId is empty', async () => {
    const { subscriber, where } = setup([{ id: 1 }]);
    await expect(
      subscriber.preventDeleteCashflowTransactionHasUncategorizedTransaction(
        payload(null),
      ),
    ).rejects.toMatchObject({
      errorType: 'CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED',
    });
    expect(where).toHaveBeenCalledWith({
      categorized: true,
      categorizeRefId: 9,
      categorizeRefType: 'CashflowTransaction',
    });
  });

  // B3, expense part: an expense a bank line was categorized to.
  it('refuses deleting an expense a bank line is categorized to', async () => {
    const { subscriber, where, query } = setup([{ id: 4 }]);
    await expect(
      subscriber.preventDeleteExpenseHasUncategorizedTransaction({
        oldExpense: { id: 12 },
        trx: { id: 'trx' },
      } as any),
    ).rejects.toMatchObject({
      errorType: 'CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED',
    });
    expect(query).toHaveBeenCalledWith({ id: 'trx' });
    expect(where).toHaveBeenCalledWith({
      categorized: true,
      categorizeRefId: 12,
      categorizeRefType: 'Expense',
    });
  });

  it('allows deleting an expense no bank line points at', async () => {
    const { subscriber } = setup([]);
    await expect(
      subscriber.preventDeleteExpenseHasUncategorizedTransaction({
        oldExpense: { id: 12 },
        trx: { id: 'trx' },
      } as any),
    ).resolves.toBeUndefined();
  });
});
