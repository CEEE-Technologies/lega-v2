import { UnmatchMatchedBankTransaction } from './UnmatchMatchedTransaction.service';
import { events } from '@/common/events/events';

/**
 * Found by E1: the unmatch handler crashed on an unknown bank line (now a
 * 500 instead of a logged error), and unmatching a line that had no match
 * still added 1 to the account's uncategorized counter.
 * B4: unmatching deletes the payment the match created.
 */
describe('UnmatchMatchedBankTransaction', () => {
  const trx = { id: 'trx' } as any;

  type Match = {
    uncategorizedTransactionId: number;
    referenceType: string;
    referenceId: number;
  };

  const setup = ({ line, matches }: { line: unknown; matches: Match[] }) => {
    const uow = { withTransaction: jest.fn((work) => work(trx)) };
    const eventPublisher = { emitAsync: jest.fn().mockResolvedValue([]) };
    const deletePaymentReceived = {
      deletePaymentReceive: jest.fn().mockResolvedValue(undefined),
    };
    const deleteBillPayment = {
      deleteBillPayment: jest.fn().mockResolvedValue(undefined),
    };
    const deletedLines: number[][] = [];

    // A tiny stand-in for the matched-transactions table.
    const matchedModel = jest.fn(() => ({
      query: jest.fn(() => ({
        where: jest.fn((column: any, value?: any) => {
          if (typeof column === 'function') {
            const pairs: Array<Record<string, unknown>> = [];
            column({ orWhere: (pair) => pairs.push(pair) });
            return Promise.resolve(
              matches.filter((m) =>
                pairs.some(
                  (p) =>
                    p.referenceType === m.referenceType &&
                    p.referenceId === m.referenceId,
                ),
              ),
            );
          }
          return Promise.resolve(matches.filter((m) => m[column] === value));
        }),
        whereIn: jest.fn((_column: string, ids: number[]) => ({
          delete: jest.fn(async () => {
            deletedLines.push(ids);
            return matches.filter((m) =>
              ids.includes(m.uncategorizedTransactionId),
            ).length;
          }),
        })),
      })),
    }));
    const throwIfNotFound = jest.fn(async () => {
      if (!line)
        throw Object.assign(new Error('NotFound'), { statusCode: 404 });
      return line;
    });
    const lineModel = jest.fn(() => ({
      query: jest.fn(() => ({
        findById: jest.fn(() => ({
          forUpdate: jest.fn(() => ({ throwIfNotFound })),
        })),
      })),
    }));
    const service = new UnmatchMatchedBankTransaction(
      uow as any,
      eventPublisher as any,
      deletePaymentReceived as any,
      deleteBillPayment as any,
      matchedModel as any,
      lineModel as any,
    );
    return {
      service,
      eventPublisher,
      deletePaymentReceived,
      deleteBillPayment,
      deletedLines,
    };
  };

  const emitted = (eventPublisher: { emitAsync: jest.Mock }) =>
    eventPublisher.emitAsync.mock.calls.map(([name]) => name);

  it('refuses an unknown bank line with "not found"', async () => {
    const { service, eventPublisher } = setup({ line: null, matches: [] });
    await expect(service.unmatchMatchedTransaction(999)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(emitted(eventPublisher)).not.toContain(events.bankMatch.onUnmatched);
  });

  it('changes nothing for a bank line that has no match', async () => {
    const { service, eventPublisher, deletedLines } = setup({
      line: { id: 5, accountId: 1 },
      matches: [],
    });
    await service.unmatchMatchedTransaction(5);
    expect(emitted(eventPublisher)).not.toContain(events.bankMatch.onUnmatched);
    expect(deletedLines).toEqual([]);
  });

  it('only unlinks a document that existed before the match', async () => {
    const {
      service,
      eventPublisher,
      deletePaymentReceived,
      deleteBillPayment,
    } = setup({
      line: { id: 5, accountId: 1 },
      matches: [
        {
          uncategorizedTransactionId: 5,
          referenceType: 'Expense',
          referenceId: 3,
        },
      ],
    });
    await service.unmatchMatchedTransaction(5);
    expect(deletePaymentReceived.deletePaymentReceive).not.toHaveBeenCalled();
    expect(deleteBillPayment.deleteBillPayment).not.toHaveBeenCalled();
    expect(eventPublisher.emitAsync).toHaveBeenCalledWith(
      events.bankMatch.onUnmatched,
      expect.objectContaining({ uncategorizedTransactionId: 5, trx }),
    );
  });

  it('deletes the payment an invoice match created, inside the transaction', async () => {
    const { service, deletePaymentReceived, deletedLines } = setup({
      line: { id: 5, accountId: 1 },
      matches: [
        {
          uncategorizedTransactionId: 5,
          referenceType: 'SaleInvoice',
          referenceId: 8,
        },
        {
          uncategorizedTransactionId: 5,
          referenceType: 'PaymentReceive',
          referenceId: 21,
        },
      ],
    });
    await service.unmatchMatchedTransaction(5);
    expect(deletedLines).toEqual([[5]]);
    expect(deletePaymentReceived.deletePaymentReceive).toHaveBeenCalledWith(
      21,
      trx,
    );
  });

  it('deletes the payment a bill match created', async () => {
    const { service, deleteBillPayment } = setup({
      line: { id: 5, accountId: 1 },
      matches: [
        {
          uncategorizedTransactionId: 5,
          referenceType: 'Bill',
          referenceId: 8,
        },
        {
          uncategorizedTransactionId: 5,
          referenceType: 'BillPayment',
          referenceId: 13,
        },
      ],
    });
    await service.unmatchMatchedTransaction(5);
    expect(deleteBillPayment.deleteBillPayment).toHaveBeenCalledWith(13, trx);
  });

  it('unmatches every line that shares the deleted payment', async () => {
    const { service, eventPublisher, deletePaymentReceived, deletedLines } =
      setup({
        line: { id: 5, accountId: 1 },
        matches: [
          {
            uncategorizedTransactionId: 5,
            referenceType: 'SaleInvoice',
            referenceId: 8,
          },
          {
            uncategorizedTransactionId: 6,
            referenceType: 'SaleInvoice',
            referenceId: 8,
          },
          {
            uncategorizedTransactionId: 5,
            referenceType: 'PaymentReceive',
            referenceId: 21,
          },
          {
            uncategorizedTransactionId: 6,
            referenceType: 'PaymentReceive',
            referenceId: 21,
          },
        ],
      });
    await service.unmatchMatchedTransaction(5);
    expect(deletedLines).toEqual([[5, 6]]);
    expect(deletePaymentReceived.deletePaymentReceive).toHaveBeenCalledTimes(1);
    const unmatched = eventPublisher.emitAsync.mock.calls
      .filter(([name]) => name === events.bankMatch.onUnmatched)
      .map(([, payload]) => payload.uncategorizedTransactionId);
    expect(unmatched).toEqual([5, 6]);
  });
});
