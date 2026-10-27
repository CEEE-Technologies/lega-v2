import { BillPaymentGLRewriteSubscriber } from './BillPaymentGLRewriteSubscriber';
import { BillPaymentsGLEntriesRewrite } from '../commands/BillPaymentsGLRewrite';

describe('BillPaymentGLRewriteSubscriber', () => {
  it('rewrites the payments of the edited bill on the same transaction', async () => {
    const rewrite = { rewriteBillPaymentsGLEntries: jest.fn() };
    const subscriber = new BillPaymentGLRewriteSubscriber(
      rewrite as any,
      { validateLinkedTransactionsNotLocked: jest.fn() } as any,
    );
    const trx = { trx: true } as any;

    await subscriber.paymentGLEntriesRewriteOnBillEdited({
      oldBill: { id: 21 },
      bill: { id: 21 },
      trx,
    } as any);

    expect(rewrite.rewriteBillPaymentsGLEntries).toHaveBeenCalledWith(21, trx);
  });
});

describe('BillPaymentsGLEntriesRewrite', () => {
  it('rewrites each payment applied to the bill once, inside the transaction', async () => {
    const trx = { trx: true } as any;
    const queryTrx = jest.fn();
    const entryModel = () => ({
      query: (t) => {
        queryTrx(t);
        return {
          where: () => ({
            // Payment 2 is dated before payment 1: rewritten first.
            withGraphFetched: async () => [
              {
                billPaymentId: 1,
                payment: { id: 1, paymentDate: '2026-02-01' },
              },
              {
                billPaymentId: 2,
                payment: { id: 2, paymentDate: '2026-01-15' },
              },
              {
                billPaymentId: 1,
                payment: { id: 1, paymentDate: '2026-02-01' },
              },
            ],
          }),
        };
      },
    });
    const glEntries = { rewritePaymentGLEntries: jest.fn() };
    const service = new BillPaymentsGLEntriesRewrite(
      glEntries as any,
      entryModel as any,
    );

    await service.rewriteBillPaymentsGLEntries(21, trx);

    expect(queryTrx).toHaveBeenCalledWith(trx);
    expect(glEntries.rewritePaymentGLEntries.mock.calls).toEqual([
      [2, trx],
      [1, trx],
    ]);
  });
});

describe('BillPaymentGLRewriteSubscriber — bill editing (locked payments)', () => {
  it('checks the payments of the bill against the purchases lock before saving', async () => {
    const payments = [{ label: 'PAY-5', date: '2026-03-28' }];
    const rewrite = {
      getBillLinkedPayments: jest.fn().mockResolvedValue(payments),
    };
    const guard = { validateLinkedTransactionsNotLocked: jest.fn() };
    const subscriber = new BillPaymentGLRewriteSubscriber(
      rewrite as any,
      guard as any,
    );
    const trx = { trx: true } as any;

    await subscriber.validateLinkedPaymentsNotLocked({
      oldBill: { id: 21 },
      trx,
    } as any);

    expect(rewrite.getBillLinkedPayments).toHaveBeenCalledWith(21, trx);
    expect(guard.validateLinkedTransactionsNotLocked).toHaveBeenCalledWith(
      payments,
      'purchases',
      'this bill',
    );
  });

  it('lists each linked payment with its number and date', async () => {
    const entryModel = () => ({
      query: () => ({
        where: () => ({
          withGraphFetched: async () => [
            {
              payment: {
                id: 1,
                paymentNumber: 'PAY-5',
                paymentDate: '2026-03-28',
              },
            },
            { payment: null },
          ],
        }),
      }),
    });
    const service = new BillPaymentsGLEntriesRewrite(
      {} as any,
      entryModel as any,
    );

    await expect(service.getBillLinkedPayments(21)).resolves.toEqual([
      { label: 'PAY-5', date: '2026-03-28' },
    ]);
  });
});
