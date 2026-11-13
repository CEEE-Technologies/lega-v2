import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import type {
  ILandedCostFromInventory,
  ILandedCostsFromInventoryRepairResult,
} from '../../EE/BillLandedCosts/commands/LandedCostsFromInventoryRepair.service';

interface TenantsRepairLandedCostsFromInventoryOptions {
  organization?: string;
  apply?: boolean;
  dryRun?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:repair-landed-costs-from-inventory',
  description:
    'Lists the landed costs allocated from an inventory bill line before Q9 (health check H11 (c)): that cost ' +
    'went into stock twice. Dry run by default: nothing is changed. --apply (with --organization, after a ' +
    'database backup) removes each allocation, so the cost stays once, in the source item; allocations on a ' +
    'bill in a locked period are listed and skipped.',
})
export class TenantsRepairLandedCostsFromInventoryCommand extends BaseCommand {
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
      'Remove the listed allocations (take a database backup first). Without it nothing is changed.',
  })
  parseApply(): boolean {
    return true;
  }

  // `--dry-run` is the default; the flag is accepted so it can be said out loud.
  @Option({
    flags: '--dry-run',
    description: 'Only list the allocations (the default).',
  })
  parseDryRun(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsRepairLandedCostsFromInventoryOptions,
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
      let removed = 0;
      await this.withApp(async (runInTenant) => {
        for (const organizationId of organizationIds) {
          await runInTenant(organizationId, async (service) => {
            if (options.apply) {
              const result = await service.repair();
              this.report(organizationId, result);
              failed += result.failed.length;
              removed += result.removed.length;
            } else {
              this.list(organizationId, await service.scan());
            }
          });
        }
      });
      if (removed > 0) {
        this.log(
          'The freight now stays once, in its own item. To add it to the goods, enter it again as a ' +
            'service (non-inventory) line and allocate it. The cost recompute is queued: a running server ' +
            'picks it up.',
        );
      }
      // Exits unsuccessfully, so maintenance scripts see the failures.
      if (failed > 0) {
        this.exit(
          `The repair failed for ${failed} allocations (listed above); the rest were removed.`,
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

  private describe(item: ILandedCostFromInventory): string {
    return (
      `landed cost #${item.landedCostId}: ${item.amount} from bill ${item.fromBillNo} ` +
      `(line ${item.fromEntryId}, inventory item ${item.itemName}) onto bill ${item.billNo} ` +
      `(${item.billDate ?? 'no date'})${item.locked ? ' [locked period: skipped]' : ''}`
    );
  }

  private list(organizationId: string, found: ILandedCostFromInventory[]) {
    this.log(
      `[${organizationId}] Landed costs from an inventory line — dry run (nothing changed): ${found.length}`,
    );
    found.forEach((item) => this.log(`  ${this.describe(item)}`));
  }

  private report(
    organizationId: string,
    result: ILandedCostsFromInventoryRepairResult,
  ) {
    this.log(
      `[${organizationId}] Removed ${result.removed.length} allocations; skipped ${result.skipped.length} (locked); failed ${result.failed.length}.`,
    );
    result.removed.forEach((item) =>
      this.log(`  Removed ${this.describe(item)}`),
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
    const { ClsService } = await import('nestjs-cls');
    const { LandedCostsFromInventoryRepairService } = await import(
      '../../EE/BillLandedCosts/commands/LandedCostsFromInventoryRepair.service'
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
            LandedCostsFromInventoryRepairService,
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
