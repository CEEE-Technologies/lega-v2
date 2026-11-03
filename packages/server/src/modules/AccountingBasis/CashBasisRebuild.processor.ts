import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Scope } from '@nestjs/common';
import { ClsService, UseCls } from 'nestjs-cls';
import {
  CASH_BASIS_REBUILD_QUEUE,
  ICashBasisRebuildJobPayload,
} from './AccountingBasis.constants';
import { CashBasisRebuildService } from './CashBasisRebuild.service';
import { CashBasisAutoRebuildService } from './CashBasisAutoRebuild.service';
import { isCashBasisCheckClean } from './CashBasisCheck';

/**
 * Runs the cash basis rebuild of one organization inside the application,
 * where the GL builders and the tenant context are available. Queued by the
 * `tenants:rebuild-cash-basis` CLI command, and on startup for the
 * companies flagged by the migration (CashBasisAutoRebuild.service).
 */
@Processor({
  name: CASH_BASIS_REBUILD_QUEUE,
  scope: Scope.REQUEST,
})
export class CashBasisRebuildProcessor extends WorkerHost {
  constructor(
    private readonly cashBasisRebuild: CashBasisRebuildService,
    private readonly cashBasisAutoRebuild: CashBasisAutoRebuildService,
    private readonly clsService: ClsService,
  ) {
    super();
  }

  @UseCls()
  async process(job: Job<ICashBasisRebuildJobPayload>) {
    const { organizationId, userId, clearRebuildFlag } = job.data;

    this.clsService.set('organizationId', organizationId);
    this.clsService.set('userId', userId);

    const rebuild = await this.cashBasisRebuild.rebuild(organizationId);
    const check = await this.cashBasisRebuild.check();

    // The startup rebuild clears the company's flag once it checks clean
    // and no old landed cost is left to do (one in a locked period waits
    // for it to open); otherwise it stays, so the next startup tries again.
    if (clearRebuildFlag) {
      const pendingLandedCosts =
        await this.cashBasisRebuild.countPendingLandedCosts();

      if (
        isCashBasisCheckClean(check) &&
        rebuild.failures.length === 0 &&
        pendingLandedCosts === 0
      ) {
        await this.cashBasisAutoRebuild.clearFlag(organizationId);
        console.log(`[info] [${organizationId}] Cash basis rebuilt: clean.`);
      } else if (
        isCashBasisCheckClean(check) &&
        rebuild.failures.length === 0
      ) {
        console.warn(
          `[warn] [${organizationId}] Cash basis rebuilt; ${pendingLandedCosts} old landed cost(s) from bills are in a locked period and wait for it to open (the rebuild runs again on the next startup).`,
        );
      } else {
        console.warn(
          `[warn] [${organizationId}] Cash basis rebuilt with problems; run tenants:rebuild-cash-basis --check -o ${organizationId}.`,
        );
      }
    }
    return { rebuild, check };
  }
}
