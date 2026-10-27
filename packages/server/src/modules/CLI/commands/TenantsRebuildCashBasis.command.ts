import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, QueueEvents } from 'bullmq';
import { BaseCommand } from './BaseCommand';
import {
  CASH_BASIS_REBUILD_JOB,
  CASH_BASIS_REBUILD_QUEUE,
  ICashBasisRebuildJobPayload,
  ICashBasisRebuildResult,
} from '@/modules/AccountingBasis/AccountingBasis.constants';
import {
  checkCashBasis,
  formatCashBasisCheck,
  ICashBasisCheckResult,
  isCashBasisCheckClean,
} from '@/modules/AccountingBasis/CashBasisCheck';

interface TenantsRebuildCashBasisOptions {
  organization?: string;
  check?: boolean;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MINUTES = 30;

@Injectable()
@Command({
  name: 'tenants:rebuild-cash-basis',
  description:
    'Rebuild the cash basis entries of the payments and refunds of all the initialized tenants (or one with --organization). ' +
    'The rebuild runs as a job on the running server; --check only reports bank/cash accounts whose cash and accrual totals differ and unbalanced entry sets.',
})
export class TenantsRebuildCashBasisCommand extends BaseCommand {
  constructor(configService: ConfigService) {
    super(configService);
  }

  @Option({
    flags: '-o, --organization <organizationId>',
    description: 'Rebuild (or check) a specific organization only.',
  })
  parseOrganization(val: string): string {
    return val;
  }

  @Option({
    flags: '--check',
    description: 'Only check the cash basis ledger, without rebuilding it.',
  })
  parseCheck(): boolean {
    return true;
  }

  @Option({
    flags: '--timeout <minutes>',
    description: `Minutes to wait for each organization rebuild job (default ${DEFAULT_TIMEOUT_MINUTES}).`,
  })
  parseTimeout(val: string): number {
    return parseInt(val, 10);
  }

  async run(
    _passedParams: string[],
    options: TenantsRebuildCashBasisOptions,
  ): Promise<void> {
    try {
      const organizationIds = await this.getOrganizationIds(
        options.organization,
      );
      const failed = options.check
        ? await this.checkOrganizations(organizationIds)
        : await this.rebuildOrganizations(organizationIds, options);

      if (failed > 0) {
        this.exit(
          `${failed} of ${organizationIds.length} organizations have problems.`,
        );
      }
      this.success(
        options.check
          ? `${organizationIds.length} organizations checked: no differences.`
          : `${organizationIds.length} organizations rebuilt: no differences.`,
      );
    } catch (error) {
      this.exit(error);
    }
  }

  /**
   * Retrieves the organizations to process.
   */
  private async getOrganizationIds(organizationId?: string) {
    const sysKnex = this.initSystemKnex();
    try {
      const query = this.getAllInitializedTenants(sysKnex);

      if (organizationId) {
        query.where('organizationId', organizationId);
      }
      const tenants = await query;

      if (organizationId && tenants.length === 0) {
        throw new Error(
          `Organization ${organizationId} is not found or not initialized.`,
        );
      }
      return tenants.map((tenant: any) => tenant.organizationId as string);
    } finally {
      await sysKnex.destroy();
    }
  }

  /**
   * Checks the given organizations and prints the report.
   * @returns {Promise<number>} Count of organizations with problems.
   */
  private async checkOrganizations(organizationIds: string[]) {
    let failed = 0;

    for (const organizationId of organizationIds) {
      const knex = this.initTenantKnex(organizationId);
      try {
        const result = await checkCashBasis(knex);

        if (!this.printCheck(organizationId, result)) failed += 1;
      } catch (error) {
        failed += 1;
        this.log(`[${organizationId}] Check failed: ${error.message}`);
      } finally {
        await knex.destroy();
      }
    }
    return failed;
  }

  /**
   * Queues the rebuild job of each organization on the running server and
   * waits for it, then prints its report.
   * @returns {Promise<number>} Count of organizations with problems.
   */
  private async rebuildOrganizations(
    organizationIds: string[],
    options: TenantsRebuildCashBasisOptions,
  ) {
    const connection = {
      host: this.configService.get('queue.host'),
      port: this.configService.get('queue.port'),
    };
    const queue = new Queue(CASH_BASIS_REBUILD_QUEUE, { connection });
    const queueEvents = new QueueEvents(CASH_BASIS_REBUILD_QUEUE, {
      connection,
    });
    const timeoutMs = (options.timeout || DEFAULT_TIMEOUT_MINUTES) * 60 * 1000;
    let failed = 0;

    try {
      await queueEvents.waitUntilReady();

      for (const organizationId of organizationIds) {
        this.log(`[${organizationId}] Rebuilding the cash basis entries...`);

        const payload: ICashBasisRebuildJobPayload = { organizationId };
        const job = await queue.add(CASH_BASIS_REBUILD_JOB, payload, {
          removeOnComplete: true,
          removeOnFail: true,
        });
        try {
          const { rebuild, check } = (await job.waitUntilFinished(
            queueEvents,
            timeoutMs,
          )) as {
            rebuild: ICashBasisRebuildResult;
            check: ICashBasisCheckResult;
          };

          this.printRebuild(rebuild);
          const clean = this.printCheck(organizationId, check);

          if (!clean || rebuild.failures.length > 0) failed += 1;
        } catch (error) {
          failed += 1;
          this.log(
            `[${organizationId}] Rebuild failed: ${error.message}` +
              (/timed out/i.test(error.message)
                ? ' (is the server running? the job runs on its queue worker)'
                : ''),
          );
        }
      }
    } finally {
      await queueEvents.close();
      await queue.close();
    }
    return failed;
  }

  private printRebuild(rebuild: ICashBasisRebuildResult) {
    const counts = Object.entries(rebuild.rebuilt)
      .map(([type, count]) => `${type} ${count}`)
      .join(', ');

    this.log(
      `[${rebuild.organizationId}] Rebuilt: ${counts}. Orphan cash sets removed: ${rebuild.orphansRemoved}.`,
    );
    if ((rebuild.lockedSkipped || []).length > 0) {
      this.log(
        `  Skipped (locked period): ${rebuild.lockedSkipped
          .map((doc) => `${doc.referenceType} #${doc.referenceId}`)
          .join(', ')}`,
      );
    }
    rebuild.failures.forEach((failure) => {
      this.log(
        `  Failed ${failure.referenceType} #${failure.referenceId}: ${failure.error}`,
      );
    });
  }

  /**
   * Prints the check report.
   * @returns {boolean} Whether the check is clean.
   */
  private printCheck(organizationId: string, result: ICashBasisCheckResult) {
    this.log(`[${organizationId}] Cash basis check:`);
    formatCashBasisCheck(result).forEach((line) => this.log(line));

    return isCashBasisCheckClean(result);
  }
}
