import { RefundVendorCreditGLEntriesSubscriber } from './RefundVendorCreditGLEntriesSubscriber';
import { RefundVendorCreditGLEntries } from '../commands/RefundVendorCreditGLEntries';

describe('RefundVendorCreditGLEntriesSubscriber — vendor credit edited', () => {
  it('rewrites the refunds of the edited vendor credit', async () => {
    const glEntries = { rewriteVendorCreditRefundsGLEntries: jest.fn() };
    const subscriber = new RefundVendorCreditGLEntriesSubscriber(
      glEntries as any,
      { validateLinkedTransactionsNotLocked: jest.fn() } as any,
    );
    const trx = { trx: true } as any;

    await subscriber.rewriteRefundsGLEntriesOnceVendorCreditEdited({
      vendorCredit: { id: 8 },
      oldVendorCredit: { id: 8 },
      trx,
    } as any);

    expect(glEntries.rewriteVendorCreditRefundsGLEntries).toHaveBeenCalledWith(
      8,
      trx,
    );
  });
});

describe('RefundVendorCreditGLEntries.rewriteVendorCreditRefundsGLEntries', () => {
  it('rewrites every refund of the vendor credit, in order', async () => {
    const trx = { trx: true } as any;
    const refundModel = () => ({
      query: () => ({
        where: () => ({ orderBy: async () => [{ id: 1 }, { id: 2 }] }),
      }),
    });
    const service = new RefundVendorCreditGLEntries(
      {} as any,
      {} as any,
      (() => ({})) as any,
      refundModel as any,
    );
    const rewrite = jest
      .spyOn(service as any, 'rewriteRefundOnChange')
      .mockResolvedValue(undefined);

    await service.rewriteVendorCreditRefundsGLEntries(8, trx);

    expect(rewrite.mock.calls).toEqual([
      [1, trx],
      [2, trx],
    ]);
  });
});

describe('RefundVendorCreditGLEntriesSubscriber — vendor credit editing (locked refunds)', () => {
  it('checks the refunds of the vendor credit against the purchases lock before saving', async () => {
    const refunds = [{ label: 'A refund', date: '2026-03-28' }];
    const glEntries = {
      getVendorCreditRefunds: jest.fn().mockResolvedValue(refunds),
    };
    const guard = { validateLinkedTransactionsNotLocked: jest.fn() };
    const subscriber = new RefundVendorCreditGLEntriesSubscriber(
      glEntries as any,
      guard as any,
    );
    const trx = { trx: true } as any;

    await subscriber.validateLinkedRefundsNotLocked({
      oldVendorCredit: { id: 8 },
      trx,
    } as any);

    expect(glEntries.getVendorCreditRefunds).toHaveBeenCalledWith(8, trx);
    expect(guard.validateLinkedTransactionsNotLocked).toHaveBeenCalledWith(
      refunds,
      'purchases',
      'this vendor credit',
    );
  });
});
