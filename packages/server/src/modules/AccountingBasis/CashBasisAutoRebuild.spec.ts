import { CashBasisAutoRebuildService } from './CashBasisAutoRebuild.service';
import { CashBasisRebuildProcessor } from './CashBasisRebuild.processor';
import { CASH_BASIS_REBUILD_JOB } from './AccountingBasis.constants';

/**
 * P6: the cash basis rebuild had to be run by hand after the deploy. The
 * migration now flags the companies, the server queues their rebuild on
 * startup and the job clears the flag once the rebuild checks clean.
 */
describe('Cash basis rebuild after deploy', () => {
  describe('CashBasisAutoRebuildService', () => {
    const makeService = (flagged: string[]) => {
      const queue = { add: jest.fn().mockResolvedValue(undefined) };
      const service = new CashBasisAutoRebuildService({} as any, queue as any);
      jest.spyOn(service, 'getFlaggedOrganizations').mockResolvedValue(flagged);
      return { service, queue };
    };

    it('queues the rebuild of each flagged company, once per company', async () => {
      const { service, queue } = makeService(['org-a', 'org-b']);

      await expect(service.queueFlaggedRebuilds()).resolves.toEqual([
        'org-a',
        'org-b',
      ]);
      expect(queue.add).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledWith(
        CASH_BASIS_REBUILD_JOB,
        { organizationId: 'org-a', clearRebuildFlag: true },
        expect.objectContaining({ jobId: 'cash-basis-auto-rebuild-org-a' }),
      );
    });

    it('queues nothing when no company is flagged', async () => {
      const { service, queue } = makeService([]);
      await service.queueFlaggedRebuilds();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each([
      ['false', 'production', false],
      ['0', 'production', false],
      [undefined, 'production', true],
      [undefined, 'test', false],
      ['true', 'test', true],
    ])(
      'CASH_BASIS_AUTO_REBUILD=%s, NODE_ENV=%s -> runs on startup: %s',
      (setting, nodeEnv, expected) => {
        const env = { ...process.env };
        if (setting === undefined) delete process.env.CASH_BASIS_AUTO_REBUILD;
        else process.env.CASH_BASIS_AUTO_REBUILD = setting;
        process.env.NODE_ENV = nodeEnv;
        try {
          const { service } = makeService([]);
          expect((service as any).isEnabled).toBe(expected);
        } finally {
          process.env = env;
        }
      },
    );
  });

  describe('CashBasisRebuildProcessor', () => {
    const run = async (
      data: any,
      check: any,
      failures: any[] = [],
      pendingLandedCosts = 0,
    ): Promise<jest.Mock> => {
      const clearFlag = jest.fn().mockResolvedValue(undefined);
      const processor = new CashBasisRebuildProcessor(
        {
          rebuild: jest.fn().mockResolvedValue({ failures }),
          check: jest.fn().mockResolvedValue(check),
          countPendingLandedCosts: jest
            .fn()
            .mockResolvedValue(pendingLandedCosts),
        } as any,
        { clearFlag } as any,
        { set: jest.fn() } as any,
      );
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      // `process` is wrapped by @UseCls; run its body directly.
      await (CashBasisRebuildProcessor.prototype.process as any).call(
        processor,
        { data },
      );
      return clearFlag;
    };
    const clean = {
      accountDifferences: [],
      unbalancedSets: [],
      openingBalancePaidMismatches: [],
    };

    it('clears the flag once the startup rebuild checks clean', async () => {
      const clearFlag = await run(
        { organizationId: 'org-a', clearRebuildFlag: true },
        clean,
      );
      expect(clearFlag).toHaveBeenCalledWith('org-a');
    });

    it('keeps the flag when the rebuild has failures', async () => {
      const clearFlag = await run(
        { organizationId: 'org-a', clearRebuildFlag: true },
        clean,
        [{ referenceType: 'BillPayment', referenceId: 1, error: 'x' }],
      );
      expect(clearFlag).not.toHaveBeenCalled();
    });

    it('keeps the flag when the check finds differences', async () => {
      const clearFlag = await run(
        { organizationId: 'org-a', clearRebuildFlag: true },
        { ...clean, unbalancedSets: [{ referenceType: 'BillPayment' }] },
      );
      expect(clearFlag).not.toHaveBeenCalled();
    });

    it('keeps the flag while old landed costs wait for a locked period', async () => {
      const clearFlag = await run(
        { organizationId: 'org-a', clearRebuildFlag: true },
        clean,
        [],
        2,
      );
      expect(clearFlag).not.toHaveBeenCalled();
    });

    it('a rebuild from the CLI leaves the flag alone', async () => {
      const clearFlag = await run({ organizationId: 'org-a' }, clean);
      expect(clearFlag).not.toHaveBeenCalled();
    });
  });
});
