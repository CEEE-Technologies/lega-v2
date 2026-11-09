import { events } from '@/common/events/events';
import { ActivateBranches } from './ActivateBranchesFeature.service';

/**
 * F26: turning branches on creates the first branch and saves the setting
 * inside the activation's transaction, so a failing step undoes both.
 */
describe('ActivateBranches', () => {
  const trx = { id: 'trx' } as any;

  const build = (onActivatedError?: Error) => {
    const uow = {
      withTransaction: jest.fn((work: (trx: any) => any) => work(trx)),
    };
    const eventPublisher = {
      emitAsync: jest.fn(async (event: string) => {
        if (event === events.branch.onActivated && onActivatedError) {
          throw onActivatedError;
        }
      }),
    };
    const createBranch = {
      createBranch: jest.fn().mockResolvedValue({ id: 1, primary: true }),
    };
    const branchesSettings = {
      isMultiBranchesActive: jest.fn().mockResolvedValue(false),
      markMultiBranchesAsActivated: jest.fn().mockResolvedValue(undefined),
    };
    const i18n = { t: jest.fn(() => 'Head Branch') };
    const service = new ActivateBranches(
      uow as any,
      eventPublisher as any,
      createBranch as any,
      branchesSettings as any,
      i18n as any,
    );
    return { service, createBranch, branchesSettings };
  };

  it('creates the first branch and saves the setting inside the transaction', async () => {
    const { service, createBranch, branchesSettings } = build();
    await service.activateBranches();

    expect(createBranch.createBranch).toHaveBeenCalledWith(
      expect.objectContaining({ primary: true }),
      trx,
    );
    expect(branchesSettings.markMultiBranchesAsActivated).toHaveBeenCalledWith(
      trx,
    );
  });

  it('a failing step fails the activation (the transaction is undone)', async () => {
    const { service } = build(new Error('assigning the branch failed'));
    await expect(service.activateBranches()).rejects.toThrow(
      'assigning the branch failed',
    );
  });
});
