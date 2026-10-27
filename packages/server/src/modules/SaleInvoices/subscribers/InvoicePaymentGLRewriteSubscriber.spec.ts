import { InvoicePaymentGLRewriteSubscriber } from './InvoicePaymentGLRewriteSubscriber';
import { InvoicePaymentsGLEntriesRewrite } from '../InvoicePaymentsGLRewrite';

describe('InvoicePaymentGLRewriteSubscriber', () => {
  it('rewrites the payments of the edited invoice on the same transaction', async () => {
    const trx = { trx: true } as any;
    const queryTrx = jest.fn();
    const entryModel = () => ({
      query: (t) => {
        queryTrx(t);
        return {
          where: () => ({
            withGraphFetched: async () => [
              {
                paymentReceiveId: 3,
                payment: { id: 3, paymentDate: '2026-01-01' },
              },
            ],
          }),
        };
      },
    });
    const glEntries = { rewritePaymentGLEntries: jest.fn() };
    const rewrite = new InvoicePaymentsGLEntriesRewrite(
      glEntries as any,
      entryModel as any,
    );
    const subscriber = new InvoicePaymentGLRewriteSubscriber(rewrite, {
      validateLinkedTransactionsNotLocked: jest.fn(),
    } as any);

    await subscriber.paymentGLEntriesRewriteOnPaymentEdit({
      oldSaleInvoice: { id: 9 },
      trx,
    } as any);

    // The payment entries are read inside the edit transaction.
    expect(queryTrx).toHaveBeenCalledWith(trx);
    expect(glEntries.rewritePaymentGLEntries).toHaveBeenCalledWith(3, trx);
  });
});

describe('InvoicePaymentGLRewriteSubscriber — invoice editing (locked payments)', () => {
  it('checks the payments of the invoice against the sales lock before saving', async () => {
    const payments = [{ label: 'PAY-0001', date: '2026-03-28' }];
    const rewrite = {
      getInvoiceLinkedPayments: jest.fn().mockResolvedValue(payments),
    };
    const guard = { validateLinkedTransactionsNotLocked: jest.fn() };
    const subscriber = new InvoicePaymentGLRewriteSubscriber(
      rewrite as any,
      guard as any,
    );
    const trx = { trx: true } as any;

    await subscriber.validateLinkedPaymentsNotLocked({
      oldSaleInvoice: { id: 9 },
      trx,
    } as any);

    expect(rewrite.getInvoiceLinkedPayments).toHaveBeenCalledWith(9, trx);
    expect(guard.validateLinkedTransactionsNotLocked).toHaveBeenCalledWith(
      payments,
      'sales',
      'this invoice',
    );
  });
});
