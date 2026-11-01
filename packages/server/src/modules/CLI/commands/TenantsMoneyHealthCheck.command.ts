import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import {
  checkMoneyHealth,
  formatMoneyHealth,
  isMoneyHealthClean,
} from '@/modules/AccountingBasis/MoneyHealthCheck';
import {
  checkDataHealth,
  checkSystemDataHealth,
  formatDataHealth,
  formatSystemDataHealth,
  isDataHealthClean,
  isSystemDataHealthClean,
} from '@/modules/AccountingBasis/DataHealthCheck';

interface TenantsMoneyHealthCheckOptions {
  organization?: string;
  json?: boolean;
}

@Injectable()
@Command({
  name: 'tenants:money-health-check',
  description:
    'Read-only money check of all the initialized tenants (or one with --organization): unbalanced entry sets, ' +
    'ledger rows not in whole cents, stored balances different from their ledger rows, and fully paid ' +
    'invoices/bills whose cash basis lines differ from the document. Also lists records saved by old code ' +
    '(H1-H8): foreign documents at rate 1, published documents in locked periods, stock left by adjustments ' +
    'and stock totals, unposted write-offs, duplicate document numbers and login emails, owners who did not ' +
    'create the company, and landed costs and stock costs from before the inventory fix. Nothing is changed.',
})
export class TenantsMoneyHealthCheckCommand extends BaseCommand {
  constructor(configService: ConfigService) {
    super(configService);
  }

  @Option({
    flags: '-o, --organization <organizationId>',
    description: 'Check a specific organization only.',
  })
  parseOrganization(val: string): string {
    return val;
  }

  @Option({
    flags: '--json',
    description: 'Print the full result of each organization as JSON.',
  })
  parseJson(): boolean {
    return true;
  }

  async run(
    _passedParams: string[],
    options: TenantsMoneyHealthCheckOptions,
  ): Promise<void> {
    const sysKnex = this.initSystemKnex();
    try {
      const tenants = await this.getTenants(sysKnex, options.organization);
      let failed = 0;
      let skipped = 0;

      // H6 reads the logins of all companies, once.
      const system = await checkSystemDataHealth(sysKnex);
      const systemClean = isSystemDataHealthClean(system);
      if (options.json) {
        this.log(
          JSON.stringify({ system: true, clean: systemClean, ...system }),
        );
      } else {
        this.log(
          `[system] Data health check: ${systemClean ? 'clean' : 'PROBLEMS'}`,
        );
        formatSystemDataHealth(system).forEach((line) => this.log(line));
      }

      for (const tenant of tenants) {
        const knex = this.initTenantKnex(tenant.organizationId);
        try {
          const result = await checkMoneyHealth(knex, tenant.baseCurrency);
          const moneyClean = isMoneyHealthClean(result);
          const data = await checkDataHealth(knex, tenant.baseCurrency, {
            systemKnex: sysKnex,
            tenantId: tenant.tenantId,
          });
          const dataClean = isDataHealthClean(data);
          const clean = moneyClean && dataClean;

          if (options.json) {
            this.log(
              JSON.stringify({
                organizationId: tenant.organizationId,
                clean,
                moneyClean,
                dataClean,
                ...result,
                data,
              }),
            );
          } else {
            this.log(
              `[${tenant.organizationId}] (${tenant.baseCurrency}) Money health check: ${moneyClean ? 'clean' : 'PROBLEMS'}`,
            );
            formatMoneyHealth(result).forEach((line) => this.log(line));
            this.log(
              `[${tenant.organizationId}] Data health check: ${dataClean ? 'clean' : 'PROBLEMS'}`,
            );
            formatDataHealth(data, tenant.baseCurrency).forEach((line) =>
              this.log(line),
            );
          }
          if (!clean) failed += 1;
        } catch (error) {
          // A tenant whose database was never built (e.g. an organization
          // left half set up by a test) has no money to check.
          if (['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE'].includes(error?.code)) {
            skipped += 1;
            this.log(
              `[${tenant.organizationId}] Skipped: the tenant database is not set up (${error.code}).`,
            );
          } else {
            failed += 1;
            this.log(
              `[${tenant.organizationId}] Check failed: ${error.message}`,
            );
          }
        } finally {
          await knex.destroy();
        }
      }
      await sysKnex.destroy();

      if (failed > 0 || !systemClean) {
        this.exit(
          `${failed} of ${tenants.length} organizations have problems.` +
            (systemClean ? '' : ' The logins (H6) have problems.'),
        );
      }
      this.success(
        `${tenants.length - skipped} organizations checked: clean.` +
          (skipped ? ` ${skipped} skipped (database not set up).` : ''),
      );
    } catch (error) {
      await sysKnex.destroy().catch(() => undefined);
      this.exit(error);
    }
  }

  /**
   * Retrieves the organizations to check with their base currency.
   */
  private async getTenants(sysKnex: any, organizationId?: string) {
    const query = this.getAllInitializedTenants(sysKnex)
      .leftJoin('tenants_metadata', 'tenants_metadata.tenant_id', 'tenants.id')
      .select(
        'tenants.id',
        'tenants.organization_id',
        'tenants_metadata.base_currency',
      );

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
      tenantId: Number(tenant.id),
      organizationId: tenant.organizationId as string,
      baseCurrency: (tenant.baseCurrency as string) || '',
    }));
  }
}
