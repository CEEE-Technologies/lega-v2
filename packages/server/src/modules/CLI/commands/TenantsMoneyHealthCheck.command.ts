import { Command, Option } from 'nest-commander';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseCommand } from './BaseCommand';
import {
  checkMoneyHealth,
  formatMoneyHealth,
  isMoneyHealthClean,
} from '@/modules/AccountingBasis/MoneyHealthCheck';

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
    'invoices/bills whose cash basis lines differ from the document. Nothing is changed.',
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
    try {
      const tenants = await this.getTenants(options.organization);
      let failed = 0;
      let skipped = 0;

      for (const tenant of tenants) {
        const knex = this.initTenantKnex(tenant.organizationId);
        try {
          const result = await checkMoneyHealth(knex, tenant.baseCurrency);
          const clean = isMoneyHealthClean(result);

          if (options.json) {
            this.log(
              JSON.stringify({
                organizationId: tenant.organizationId,
                clean,
                ...result,
              }),
            );
          } else {
            this.log(
              `[${tenant.organizationId}] (${tenant.baseCurrency}) Money health check: ${clean ? 'clean' : 'PROBLEMS'}`,
            );
            formatMoneyHealth(result).forEach((line) => this.log(line));
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
      if (failed > 0) {
        this.exit(
          `${failed} of ${tenants.length} organizations have problems.`,
        );
      }
      this.success(
        `${tenants.length - skipped} organizations checked: clean.` +
          (skipped ? ` ${skipped} skipped (database not set up).` : ''),
      );
    } catch (error) {
      this.exit(error);
    }
  }

  /**
   * Retrieves the organizations to check with their base currency.
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
