import { DeleteBankRulesService } from './DeleteBankRules.service';

/**
 * B9: a rule that fails to delete stops the save it is part of (such as
 * the account delete), instead of being collected and ignored.
 */
describe('DeleteBankRulesService', () => {
  it('throws the first rule-delete error', async () => {
    const failure = new Error('rule delete failed');
    const deleteBankRule = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    const service = new DeleteBankRulesService({ deleteBankRule } as any);

    await expect(service.deleteBankRules([1, 2], {} as any)).rejects.toBe(
      failure,
    );
  });

  it('deletes every rule when none fails', async () => {
    const deleteBankRule = jest.fn().mockResolvedValue(undefined);
    const service = new DeleteBankRulesService({ deleteBankRule } as any);
    const trx = { id: 'trx' } as any;

    await service.deleteBankRules([1, 2, 2], trx);
    expect(deleteBankRule.mock.calls).toEqual([
      [1, trx],
      [2, trx],
    ]);
  });
});
