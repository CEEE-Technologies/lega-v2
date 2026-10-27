import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Scope } from '@nestjs/common';
import { ClsService, UseCls } from 'nestjs-cls';
import {
  CASH_BASIS_REBUILD_QUEUE,
  ICashBasisRebuildJobPayload,
} from './AccountingBasis.constants';
import { CashBasisRebuildService } from './CashBasisRebuild.service';

/**
 * Runs the cash basis rebuild of one organization inside the application,
 * where the GL builders and the tenant context are available. Queued by the
 * `tenants:rebuild-cash-basis` CLI command.
 */
@Processor({
  name: CASH_BASIS_REBUILD_QUEUE,
  scope: Scope.REQUEST,
})
export class CashBasisRebuildProcessor extends WorkerHost {
  constructor(
    private readonly cashBasisRebuild: CashBasisRebuildService,
    private readonly clsService: ClsService,
  ) {
    super();
  }

  @UseCls()
  async process(job: Job<ICashBasisRebuildJobPayload>) {
    const { organizationId, userId } = job.data;

    this.clsService.set('organizationId', organizationId);
    this.clsService.set('userId', userId);

    const rebuild = await this.cashBasisRebuild.rebuild(organizationId);
    const check = await this.cashBasisRebuild.check();

    return { rebuild, check };
  }
}
