import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import type {
  IRefundJournal,
  IRefundJournalsRepairResult,
} from '@/modules/AccountingBasis/RefundJournalsRepair.service';

interface TenantsRepairRefundJournalsOptions {
  organization?: string;
  apply?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:repair-refund-journals',
  description:
    'Lists the foreign currency refunds (credit note and vendor credit refunds) posted before they were converted ' +
    'to the base currency: their A/R or A/P and bank lines hold the refund amount unconverted. Dry run by default: ' +
    'nothing is changed. --apply (with --organization, after a database backup) rewrites only those refund ' +
    'journals the way saving the refund again would; refunds in a locked period are listed and skipped.',
})
export class TenantsRepairRefundJournalsCommand extends BaseCommand {
  constructor(configService: ConfigService) {
    super(configService);
  }

  @Option({
    flags: '-o, --organization <organizationId>',
    description: 'The organization to check (required with --apply).',
  })
  parseOrganization(val: string): string {
    return val;
  }

  @Option({
    flags: '--apply',
    description:
      'Rewrite the listed refund journals (take a database backup first). Without it nothing is changed.',
  })
  parseApply(): boolean {
    return true;
  }

  // `--dry-run` is the default; the flag is accepted so it can be said out loud.
  @Option({
    flags: '--dry-run',
    description: 'Only list the refunds to repair (the default).',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsRepairRefundJournalsOptions & { dryRun?: boolean },
  ): Promise<void> {
    try {
      if (options.apply && options.dryRun) {
        this.exit('Choose one: --apply or --dry-run.');
      }
      if (options.apply && !options.organization) {
        this.exit('--apply needs --organization: repair one tenant at a time.');
      }
      const organizationIds = await this.getOrganizationIds(
        options.organization,
      );
      let failed = 0;
      await this.withApp(async (runInTenant) => {
        for (const organizationId of organizationIds) {
          await runInTenant(organizationId, async (service) => {
            if (options.apply) {
              const result = await service.repair();
              this.report(organizationId, result);
              failed += result.failed.length;
            } else {
              this.list(organizationId, await service.scan());
            }
            this.listRateOne(
              organizationId,
              await service.foreignRefundsAtRateOne(),
            );
          });
        }
      });
      // Exits unsuccessfully, so maintenance scripts see the failures.
      if (failed > 0) {
        this.exit(
          `The repair failed for ${failed} refund journals (listed above); the rest were applied.`,
        );
      }
      this.success(
        options.apply
          ? 'Repair applied.'
          : 'Dry run done: nothing was changed.',
      );
    } catch (error) {
      this.exit(error);
    }
  }

  private describe(item: IRefundJournal): string {
    const differences = item.differences
      .map(
        (d) =>
          `${d.basis} account ${d.accountId}: ${d.stored} (should be ${d.expected})`,
      )
      .join('; ');
    return `${item.referenceType} #${item.referenceId}${item.number ? ` (${item.number})` : ''} ${item.date} ${item.currencyCode} ${item.amount} at ${item.exchangeRate}${item.locked ? ' [locked period: skipped]' : ''}: ${differences}`;
  }

  private list(organizationId: string, found: IRefundJournal[]) {
    this.log(
      `[${organizationId}] Refund journals to repair — dry run (nothing changed): ${found.length}`,
    );
    found.forEach((item) => this.log(`  ${this.describe(item)}`));
  }

  private report(organizationId: string, result: IRefundJournalsRepairResult) {
    this.log(
      `[${organizationId}] Rewrote ${result.repaired.length} refund journals; skipped ${result.skipped.length} (locked); failed ${result.failed.length}.`,
    );
    result.repaired.forEach((item) =>
      this.log(`  Rewrote ${this.describe(item)}`),
    );
    result.skipped.forEach((item) =>
      this.log(`  Skipped ${this.describe(item)}`),
    );
    result.failed.forEach((item) =>
      this.log(`  Failed ${this.describe(item)}: ${item.error}`),
    );
  }

  private listRateOne(
    organizationId: string,
    refunds: Array<Omit<IRefundJournal, 'locked' | 'differences'>>,
  ) {
    if (refunds.length === 0) return;
    this.log(
      `[${organizationId}] Foreign currency refunds stored at the rate 1 (not changed; check the rate by hand): ${refunds.length}`,
    );
    refunds.forEach((refund) =>
      this.log(
        `  ${refund.referenceType} #${refund.referenceId} ${refund.date} ${refund.currencyCode} ${refund.amount}`,
      ),
    );
  }

  /**
   * Boots the application (this code, not a running server) once, and
   * runs the work in each organization's tenant context. The dynamic
   * imports use relative paths: the build doesn't rewrite the `@/` alias
   * inside them, so `node dist/cli.js` couldn't load an aliased one.
   */
  private async withApp(
    work: (
      runInTenant: (
        organizationId: string,
        fn: (service: any) => Promise<void>,
      ) => Promise<void>,
    ) => Promise<void>,
  ) {
    const { ClsService } = await import('nestjs-cls');
    const { RefundJournalsRepairService } = await import(
      '../../AccountingBasis/RefundJournalsRepair.service'
    );
    const { createMaintenanceApp } = await import('../MaintenanceApp');
    const app = await createMaintenanceApp();
    try {
      const cls = app.get(ClsService);
      await work((organizationId, fn) =>
        cls.run(async () => {
          cls.set('organizationId', organizationId);
          // The tenant providers (e.g. its database) resolve from the context.
          await cls.resolveProxyProviders();
          const service = await app.resolve(
            RefundJournalsRepairService,
            undefined,
            { strict: false },
          );
          await fn(service);
        }),
      );
    } finally {
      await app.close();
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
}
