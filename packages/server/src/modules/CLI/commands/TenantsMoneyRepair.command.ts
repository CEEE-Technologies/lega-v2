import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import {
  applyLedgerRepair,
  formatMoneyRepairPlan,
  planMoneyRepair,
  recalculateStoredBalances,
} from '@/modules/AccountingBasis/MoneyRepair';
import {
  checkMoneyHealth,
  formatMoneyHealth,
  isMoneyHealthClean,
} from '@/modules/AccountingBasis/MoneyHealthCheck';

interface TenantsMoneyRepairOptions {
  organization?: string;
  apply?: boolean;
  check?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:money-repair',
  description:
    'Repairs the money stored before the rounding fixes. Dry run by default: lists, per tenant, the ledger sets to ' +
    're-post (rows not in whole cents, unbalanced sets), the documents whose stored totals change with the new line ' +
    'maths, the transactions in locked periods (skipped) and the stored balances to recalculate. ' +
    '--apply (with --organization, after a database backup) re-posts them, rebuilds the cash basis set in date order, ' +
    'the exchange lines of the applied credits and the write-offs, ' +
    'and recalculates the stored balances. --check runs the money health check.',
})
export class TenantsMoneyRepairCommand extends BaseCommand {
  constructor(configService: ConfigService) {
    super(configService);
  }

  @Option({
    flags: '-o, --organization <organizationId>',
    description: 'The organization to repair (required with --apply).',
  })
  parseOrganization(val: string): string {
    return val;
  }

  @Option({
    flags: '--apply',
    description:
      'Apply the repair (take a database backup first). Without it nothing is changed.',
  })
  parseApply(): boolean {
    return true;
  }

  @Option({
    flags: '--check',
    description: 'Only run the money health check.',
  })
  parseCheck(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsMoneyRepairOptions,
  ): Promise<void> {
    try {
      if (options.apply && !options.organization) {
        this.exit('--apply needs --organization: repair one tenant at a time.');
      }
      const tenants = await this.getTenants(options.organization);

      for (const tenant of tenants) {
        if (options.check) {
          await this.check(tenant);
        } else if (options.apply) {
          await this.apply(tenant);
        } else {
          await this.dryRun(tenant);
        }
      }
      this.success(
        options.apply
          ? 'Repair applied.'
          : options.check
            ? 'Check done.'
            : 'Dry run done: nothing was changed.',
      );
    } catch (error) {
      this.exit(error);
    }
  }

  private async withTenantKnex<T>(
    organizationId: string,
    callback: (knex: any) => Promise<T>,
  ): Promise<T | undefined> {
    const knex = this.initTenantKnex(organizationId);
    try {
      return await callback(knex);
    } catch (error) {
      if (['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE'].includes(error?.code)) {
        this.log(
          `[${organizationId}] Skipped: the tenant database is not set up (${error.code}).`,
        );
        return undefined;
      }
      throw error;
    } finally {
      await knex.destroy();
    }
  }

  private async dryRun(tenant: {
    organizationId: string;
    baseCurrency: string;
  }) {
    await this.withTenantKnex(tenant.organizationId, async (knex) => {
      const plan = await planMoneyRepair(knex, tenant.baseCurrency);
      this.log(
        `[${tenant.organizationId}] (${tenant.baseCurrency}) Money repair — dry run (nothing changed):`,
      );
      formatMoneyRepairPlan(plan).forEach((line) => this.log(line));
    });
  }

  private async check(tenant: {
    organizationId: string;
    baseCurrency: string;
  }) {
    await this.withTenantKnex(tenant.organizationId, async (knex) => {
      const result = await checkMoneyHealth(knex, tenant.baseCurrency);
      this.log(
        `[${tenant.organizationId}] Money health check: ${isMoneyHealthClean(result) ? 'clean' : 'PROBLEMS'}`,
      );
      formatMoneyHealth(result).forEach((line) => this.log(line));
    });
  }

  private async apply(tenant: {
    organizationId: string;
    baseCurrency: string;
  }) {
    const { organizationId, baseCurrency } = tenant;

    // 1. Re-post the ledger sets and update the documents' totals.
    const applied = await this.withTenantKnex(organizationId, async (knex) => {
      const plan = await planMoneyRepair(knex, baseCurrency);
      return applyLedgerRepair(knex, plan);
    });
    if (!applied) return;

    this.log(
      `[${organizationId}] Re-posted ${applied.setsReposted.length} ledger sets, updated ${applied.documentsUpdated.length} documents.`,
    );
    applied.setsSkipped.forEach((set) =>
      this.log(
        `  Skipped ${set.referenceType} #${set.referenceId} [${set.basis ?? 'general'}]: ${set.why}`,
      ),
    );
    applied.documentsSkipped.forEach((doc) =>
      this.log(
        `  Skipped ${doc.documentType} ${doc.documentNo || `#${doc.documentId}`}: ${doc.why}`,
      ),
    );

    // 2. Rebuild the cash basis set in date order, in this application
    //    (the GL builders and the tenant context are needed).
    const {
      cash: rebuild,
      credits,
      writeoffs,
    } = await this.rebuildCashBasis(organizationId);
    this.log(
      `[${organizationId}] Cash basis rebuilt: ${Object.entries(rebuild.rebuilt)
        .map(([type, count]) => `${type} ${count}`)
        .join(
          ', ',
        )}; orphans removed ${rebuild.orphansRemoved}; locked skipped ${(rebuild.lockedSkipped || []).length}; failures ${rebuild.failures.length}.`,
    );
    rebuild.failures.forEach((failure) =>
      this.log(
        `  Failed ${failure.referenceType} #${failure.referenceId}: ${failure.error}`,
      ),
    );
    this.log(
      `[${organizationId}] Credit applications' exchange lines rebuilt: ${credits.rebuilt}; orphans removed ${credits.orphansRemoved}; locked skipped ${credits.skipped}. Write-offs rebuilt: ${writeoffs}.`,
    );

    // 3. Recalculate the stored balances from their ledger rows.
    const balances = await this.withTenantKnex(organizationId, (knex) =>
      recalculateStoredBalances(knex, baseCurrency),
    );
    this.log(
      `[${organizationId}] Recalculated ${balances?.length ?? 0} stored balances.`,
    );

    // 4. The health check.
    await this.check(tenant);
  }

  /**
   * Boots the application (this code, not a running server) and rebuilds
   * the organization's cash basis set inside the tenant context.
   */
  private async rebuildCashBasis(organizationId: string) {
    const { NestFactory } = await import('@nestjs/core');
    const { ClsService } = await import('nestjs-cls');
    const { AppModule } = await import('@/modules/App/App.module');
    const { CashBasisRebuildService } = await import(
      '@/modules/AccountingBasis/CashBasisRebuild.service'
    );
    const { CreditApplicationsGLService } = await import(
      '@/modules/AccountingBasis/CreditApplicationsGL.service'
    );
    const { SaleInvoiceWriteoffGLStorage } = await import(
      '@/modules/SaleInvoices/commands/writeoff/SaleInvoiceWriteoffGLStorage'
    );
    const app = await NestFactory.create(AppModule, {
      logger: ['error', 'warn'],
    });
    await app.init();
    try {
      const cls = app.get(ClsService);
      return await cls.run(async () => {
        cls.set('organizationId', organizationId);
        // The tenant providers (e.g. its database) resolve from the context.
        await cls.resolveProxyProviders();
        const service = await app.resolve(CashBasisRebuildService);
        const cash = await service.rebuild(organizationId);

        // The exchange lines of the applied credits, then the write-offs
        // (what the payments and credits leave), locked periods skipped.
        const creditsService = await app.resolve(CreditApplicationsGLService);
        const credits = await creditsService.rebuildAll();

        const writeoffStorage = await app.resolve(
          SaleInvoiceWriteoffGLStorage,
          undefined,
          { strict: false },
        );
        const writeoffs =
          await writeoffStorage.rewriteAllWrittenoffInvoicesEntries();
        return { cash, credits, writeoffs };
      });
    } finally {
      await app.close();
    }
  }

  /**
   * Retrieves the organizations with their base currency.
   */
  private async getTenants(organizationId?: string) {
    const sysKnex = this.initSystemKnex();
    try {
      const query = this.getAllInitializedTenants(sysKnex)
        .leftJoin(
          'tenants_metadata',
          'tenants_metadata.tenant_id',
          'tenants.id',
        )
        .select('tenants.organization_id', 'tenants_metadata.base_currency');

      if (organizationId) {
        query.where('tenants.organizationId', organizationId);
      }
      const tenants = await query;

      if (organizationId && tenants.length === 0) {
        throw new Error(
          `Organization ${organizationId} is not found or not initialized.`,
        );
      }
      return tenants.map((tenant: any) => ({
        organizationId: tenant.organizationId as string,
        baseCurrency: (tenant.baseCurrency as string) || '',
      }));
    } finally {
      await sysKnex.destroy();
    }
  }
}
