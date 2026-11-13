import { WriteTaxTransactionsItemEntries } from './WriteTaxTransactionsItemEntries';

/**
 * Q6: a document's tax rows are removed first and written after, one after
 * the other, so the removal can never delete the new rows.
 */
describe('WriteTaxTransactionsItemEntries.rewriteTaxRateTransactionsFromItemEntries', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const build = (featureDelays: number[]) => {
    const calls: string[] = [];
    let accessibleCall = 0;

    const taxRateTransactionModel = () => ({
      query: () => ({
        where: () => ({
          delete: async () => {
            calls.push('delete');
          },
        }),
        upsertGraph: async () => {
          calls.push('insert');
        },
      }),
    });
    const taxRateModel = () => ({
      query: () => ({
        whereIn: async () => [{ id: 1, rate: 10 }],
      }),
    });
    // The first feature check (the removal's) is the slow one here, as a
    // busy database could make it.
    const featuresManager = {
      accessible: async () => {
        const delay = featureDelays[accessibleCall++] ?? 0;
        await sleep(delay);
        return true;
      },
    };
    const service = new WriteTaxTransactionsItemEntries(
      taxRateTransactionModel as any,
      taxRateModel as any,
      featuresManager as any,
    );
    return { service, calls };
  };

  it('removes the old rows before it writes the new ones, even when the removal is slow', async () => {
    const { service, calls } = build([50, 0]);

    await service.rewriteTaxRateTransactionsFromItemEntries(
      [
        {
          taxRateId: 1,
          referenceType: 'SaleInvoice',
          referenceId: 7,
          amount: 100,
        } as any,
      ],
      'SaleInvoice',
      7,
    );
    expect(calls).toEqual(['delete', 'insert']);
  });
});
