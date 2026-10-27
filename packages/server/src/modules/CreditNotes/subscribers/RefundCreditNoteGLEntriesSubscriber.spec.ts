import { RefundCreditNoteGLEntriesSubscriber } from './RefundCreditNoteGLEntriesSubscriber';
import { RefundCreditNoteGLEntries } from '@/modules/CreditNoteRefunds/commands/RefundCreditNoteGLEntries';

describe('RefundCreditNoteGLEntriesSubscriber — credit note edited', () => {
  it('rewrites the refunds cash entries of the edited credit note', async () => {
    const glEntries = { rewriteCreditNoteRefundsCashGLEntries: jest.fn() };
    const subscriber = new RefundCreditNoteGLEntriesSubscriber(
      glEntries as any,
      { validateLinkedTransactionsNotLocked: jest.fn() } as any,
    );
    const trx = { trx: true } as any;

    await subscriber.rewriteRefundsCashGLEntriesOnceCreditNoteEdited({
      creditNote: { id: 6 },
      oldCreditNote: { id: 6 },
      trx,
    } as any);

    expect(
      glEntries.rewriteCreditNoteRefundsCashGLEntries,
    ).toHaveBeenCalledWith(6, trx);
  });
});

describe('RefundCreditNoteGLEntriesSubscriber — credit note editing (locked refunds)', () => {
  it('checks the refunds of the credit note against the sales lock before saving', async () => {
    const refunds = [{ label: 'Refund R-1', date: '2026-03-28' }];
    const glEntries = {
      getCreditNoteRefunds: jest.fn().mockResolvedValue(refunds),
    };
    const guard = { validateLinkedTransactionsNotLocked: jest.fn() };
    const subscriber = new RefundCreditNoteGLEntriesSubscriber(
      glEntries as any,
      guard as any,
    );
    const trx = { trx: true } as any;

    await subscriber.validateLinkedRefundsNotLocked({
      oldCreditNote: { id: 6 },
      trx,
    } as any);

    expect(glEntries.getCreditNoteRefunds).toHaveBeenCalledWith(6, trx);
    expect(guard.validateLinkedTransactionsNotLocked).toHaveBeenCalledWith(
      refunds,
      'sales',
      'this credit note',
    );
  });

  it('lets the lock error stop the edit', async () => {
    const subscriber = new RefundCreditNoteGLEntriesSubscriber(
      { getCreditNoteRefunds: jest.fn().mockResolvedValue([{}]) } as any,
      {
        validateLinkedTransactionsNotLocked: jest
          .fn()
          .mockRejectedValue(new Error('locked')),
      } as any,
    );
    await expect(
      subscriber.validateLinkedRefundsNotLocked({
        oldCreditNote: { id: 6 },
      } as any),
    ).rejects.toThrow('locked');
  });
});

describe('RefundCreditNoteGLEntries.rewriteRefundCreditCashGLEntries', () => {
  it('deletes only the cash set and writes it again from the credit note', async () => {
    const trx = { trx: true } as any;
    const ledgerStorage = { deleteByReference: jest.fn(), commit: jest.fn() };
    const refund = {
      id: 4,
      amount: 100,
      fromAccountId: 900,
      creditNote: {
        customerId: 1,
        exchangeRate: 1,
        totalLocal: 100,
        total: 100,
        entries: [
          { itemId: 1, totalExcludingTax: 100, sellAccountId: 500, item: {} },
        ],
      },
    };
    const refundModel = () => ({
      query: () => {
        const builder: any = {
          findById: () => builder,
          withGraphFetched: async () => refund,
        };
        return builder;
      },
    });
    const accountRepository = {
      findOrCreateDiscountAccount: async () => ({ id: 2 }),
      findOrCreateOtherChargesAccount: async () => ({ id: 3 }),
      findOrCreateUnearnedRevenue: async () => ({ id: 4 }),
    };
    const service = new RefundCreditNoteGLEntries(
      ledgerStorage as any,
      accountRepository as any,
      (() => ({})) as any,
      refundModel as any,
    );

    await service.rewriteRefundCreditCashGLEntries(4, trx);

    expect(ledgerStorage.deleteByReference).toHaveBeenCalledWith(
      4,
      'RefundCreditNote',
      trx,
      { basis: 'cash' },
    );
    const ledger = ledgerStorage.commit.mock.calls[0][0];
    expect(ledger.getEntries().every((e) => e.basis === 'cash')).toBe(true);
    expect(ledger.getEntries().find((e) => e.accountId === 500).debit).toBe(
      100,
    );
  });
});
