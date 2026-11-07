import { RevertRecognizedTransactionsService } from './RevertRecognizedTransactions.service';

/**
 * B6: an empty list of rules reverts nothing. It used to drop the rule
 * filter and revert every rule suggestion in every bank account.
 */
describe('RevertRecognizedTransactionsService', () => {
  it('reverts nothing for an empty list of rules', async () => {
    const uow = { withTransaction: jest.fn() };
    const lineModel = jest.fn();
    const service = new RevertRecognizedTransactionsService(
      { emitAsync: jest.fn() } as any,
      uow as any,
      jest.fn() as any,
      lineModel as any,
    );
    await service.revertRecognizedTransactions([], { accountId: 3 });

    expect(uow.withTransaction).not.toHaveBeenCalled();
    expect(lineModel).not.toHaveBeenCalled();
  });
});
