import { UnmatchMatchedBankTransaction } from './UnmatchMatchedTransaction.service';
import { events } from '@/common/events/events';

/**
 * Found by E1: the unmatch handler crashed on an unknown bank line (now a
 * 500 instead of a logged error), and unmatching a line that had no match
 * still added 1 to the account's uncategorized counter.
 */
describe('UnmatchMatchedBankTransaction', () => {
  const trx = { id: 'trx' } as any;

  const setup = ({
    line,
    deletedMatches,
  }: {
    line: unknown;
    deletedMatches: number;
  }) => {
    const uow = { withTransaction: jest.fn((work) => work(trx)) };
    const eventPublisher = { emitAsync: jest.fn().mockResolvedValue([]) };
    const matchedModel = jest.fn(() => ({
      query: jest.fn(() => ({
        where: jest.fn(() => ({
          delete: jest.fn().mockResolvedValue(deletedMatches),
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
        findById: jest.fn(() => ({ throwIfNotFound })),
      })),
    }));
    const service = new UnmatchMatchedBankTransaction(
      uow as any,
      eventPublisher as any,
      matchedModel as any,
      lineModel as any,
    );
    return { service, eventPublisher };
  };

  const emitted = (eventPublisher: { emitAsync: jest.Mock }) =>
    eventPublisher.emitAsync.mock.calls.map(([name]) => name);

  it('refuses an unknown bank line with "not found"', async () => {
    const { service, eventPublisher } = setup({
      line: null,
      deletedMatches: 0,
    });
    await expect(service.unmatchMatchedTransaction(999)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(emitted(eventPublisher)).not.toContain(events.bankMatch.onUnmatched);
  });

  it('changes nothing for a bank line that has no match', async () => {
    const { service, eventPublisher } = setup({
      line: { id: 5, accountId: 1 },
      deletedMatches: 0,
    });
    await service.unmatchMatchedTransaction(5);
    expect(emitted(eventPublisher)).not.toContain(events.bankMatch.onUnmatched);
  });

  it('unmatches a matched bank line inside the transaction', async () => {
    const { service, eventPublisher } = setup({
      line: { id: 5, accountId: 1 },
      deletedMatches: 1,
    });
    await service.unmatchMatchedTransaction(5);
    expect(eventPublisher.emitAsync).toHaveBeenCalledWith(
      events.bankMatch.onUnmatched,
      expect.objectContaining({ uncategorizedTransactionId: 5, trx }),
    );
  });
});
