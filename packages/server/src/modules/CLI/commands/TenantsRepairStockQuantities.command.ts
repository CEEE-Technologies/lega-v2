import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import type { IStockQuantitiesScan } from '../../AccountingBasis/StockQuantitiesRepair.service';
import type { IDataHealthStockTotal } from '../../AccountingBasis/DataHealthCheck';

interface TenantsRepairStockQuantitiesOptions {
  organization?: string;
  apply?: boolean;
  dryRun?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:repair-stock-quantities',
  description:
    'Lists the items (and, with multi-warehouse on, item and warehouse pairs) whose stored stock on hand ' +
    'differs from what their stock movements add up to (health check H3 (b)). Dry run by default: nothing ' +
    'is changed. --apply (with --organization, after a database backup) sets each stored quantity from the ' +
    'movements, in one transaction.',
})
export class TenantsRepairStockQuantitiesCommand extends BaseCommand {
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
      'Set the listed quantities (take a database backup first). Without it nothing is changed.',
  })
  parseApply(): boolean {
    return true;
  }

  // `--dry-run` is the default; the flag is accepted so it can be said out loud.
  @Option({
    flags: '--dry-run',
    description: 'Only list the differences (the default).',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsRepairStockQuantitiesOptions,
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
            const scan: IStockQuantitiesScan = options.apply
              ? await service.repair()
              : await service.scan();
            this.list(organizationId, scan, !!options.apply);
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

  private describe(item: IDataHealthStockTotal): string {
    const where =
      item.level === 'warehouse' ? ` / warehouse #${item.warehouseId}` : '';
    return `${item.itemName} (#${item.itemId})${where}: stock shows ${item.stored}, movements add up to ${item.fromMovements}`;
  }

  private list(
    organizationId: string,
    scan: IStockQuantitiesScan,
    applied: boolean,
  ) {
    this.log(
      applied
        ? `[${organizationId}] Set ${scan.differences.length} stock quantities from the movements.`
        : `[${organizationId}] Stock quantities that differ from the movements — dry run (nothing changed): ${scan.differences.length}`,
    );
    if (!scan.warehousesChecked) {
      this.log('  (multi-warehouse is off: only item totals are checked)');
    }
    scan.differences.forEach((item) =>
      this.log(`  ${applied ? 'Set ' : ''}${this.describe(item)}`),
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
    const { StockQuantitiesRepairService } = await import(
      '../../AccountingBasis/StockQuantitiesRepair.service'
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
            StockQuantitiesRepairService,
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
