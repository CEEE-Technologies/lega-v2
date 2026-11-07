import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import type {
  IStaleJournal,
  IStaleJournalsRepairResult,
} from '@/modules/AccountingBasis/StaleJournalsRepair.service';

interface TenantsRepairStaleJournalsOptions {
  organization?: string;
  apply?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:repair-stale-journals',
  description:
    'Lists the journals that older fixes only correct when the record is saved again: credit notes edited before ' +
    'PR 14 (old journal kept) and foreign opening-balance payments saved before PR 17 (no exchange gain/loss line). ' +
    'Dry run by default: nothing is changed. --apply (with --organization, after a database backup) rewrites them ' +
    'the way saving them again would; records in a locked period are listed and skipped.',
})
export class TenantsRepairStaleJournalsCommand extends BaseCommand {
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
      'Rewrite the listed journals (take a database backup first). Without it nothing is changed.',
  })
  parseApply(): boolean {
    return true;
  }

  // `--dry-run` is the default; the flag is accepted so it can be said out loud.
  @Option({
    flags: '--dry-run',
    description: 'Only list the stale journals (the default).',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsRepairStaleJournalsOptions & { dryRun?: boolean },
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
      await this.withApp(async (runInTenant) => {
        for (const organizationId of organizationIds) {
          await runInTenant(organizationId, async (service) => {
            if (options.apply) {
              this.report(organizationId, await service.repair());
            } else {
              this.list(organizationId, await service.scan());
            }
          });
        }
      });
      this.success(
        options.apply
          ? 'Repair applied.'
          : 'Dry run done: nothing was changed.',
      );
    } catch (error) {
      this.exit(error);
    }
  }

  private describe(item: IStaleJournal): string {
    const differences = item.differences
      .map(
        (d) => `account ${d.accountId}: ${d.stored} (should be ${d.expected})`,
      )
      .join('; ');
    return `${item.referenceType} ${item.number || `#${item.referenceId}`} (${item.date})${item.locked ? ' [locked period: skipped]' : ''}: ${differences}`;
  }

  private list(organizationId: string, found: IStaleJournal[]) {
    this.log(
      `[${organizationId}] Stale journals — dry run (nothing changed): ${found.length}`,
    );
    found.forEach((item) => this.log(`  ${this.describe(item)}`));
  }

  private report(organizationId: string, result: IStaleJournalsRepairResult) {
    this.log(
      `[${organizationId}] Rewrote ${result.repaired.length} journals; skipped ${result.skipped.length} (locked); failed ${result.failed.length}.`,
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
    const { NestFactory } = await import('@nestjs/core');
    const { ClsService } = await import('nestjs-cls');
    const { AppModule } = await import('../../App/App.module');
    const { StaleJournalsRepairService } = await import(
      '../../AccountingBasis/StaleJournalsRepair.service'
    );
    const app = await NestFactory.create(AppModule, {
      logger: ['error', 'warn'],
    });
    await app.init();
    try {
      const cls = app.get(ClsService);
      await work((organizationId, fn) =>
        cls.run(async () => {
          cls.set('organizationId', organizationId);
          // The tenant providers (e.g. its database) resolve from the context.
          await cls.resolveProxyProviders();
          const service = await app.resolve(
            StaleJournalsRepairService,
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
