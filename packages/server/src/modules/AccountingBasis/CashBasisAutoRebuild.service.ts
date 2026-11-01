import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Knex, { Knex as KnexType } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { DATE_ONLY_COLUMNS_OPTIONS } from '@/common/constants/database.constants';
import {
  CASH_BASIS_REBUILD_JOB,
  CASH_BASIS_REBUILD_QUEUE,
  ICashBasisRebuildJobPayload,
} from './AccountingBasis.constants';

/** The tenant setting set by 20261101120100_flag_cash_basis_rebuild. */
export const CASH_REBUILD_FLAG = {
  group: 'accounting_basis',
  key: 'cash_rebuild_needed',
};

/**
 * Runs the cash basis rebuild by itself after a deploy: the migration flags
 * the companies that need it, and on startup the server queues the rebuild
 * of each flagged company. The rebuild job clears the flag once it checks
 * clean (CashBasisRebuild.processor), so running it again changes nothing
 * and a company with problems is retried on the next startup.
 *
 * Off when `CASH_BASIS_AUTO_REBUILD=false`, and in the test environment.
 */
@Injectable()
export class CashBasisAutoRebuildService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CashBasisAutoRebuildService.name);

  constructor(
    private readonly configService: ConfigService,

    @InjectQueue(CASH_BASIS_REBUILD_QUEUE)
    private readonly cashBasisRebuildQueue: Queue,
  ) {}

  /**
   * Whether the startup rebuild is on.
   * @returns {boolean}
   */
  private get isEnabled(): boolean {
    const setting = String(
      process.env.CASH_BASIS_AUTO_REBUILD ?? '',
    ).toLowerCase();

    if (setting === 'false' || setting === '0') return false;
    if (setting === 'true' || setting === '1') return true;

    return process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap() {
    if (!this.isEnabled) return;

    // Doesn't hold up the startup: the scan opens each company database.
    setImmediate(() => {
      this.queueFlaggedRebuilds().catch((error) =>
        this.logger.error(
          `Could not queue the cash basis rebuilds: ${error?.message}`,
        ),
      );
    });
  }

  /**
   * Queues the cash basis rebuild of every flagged company.
   * @returns {Promise<string[]>} The organizations queued.
   */
  public async queueFlaggedRebuilds(): Promise<string[]> {
    const organizationIds = await this.getFlaggedOrganizations();

    for (const organizationId of organizationIds) {
      await this.queueRebuild(organizationId);
    }
    if (organizationIds.length > 0) {
      this.logger.log(
        `Queued the cash basis rebuild of ${organizationIds.length} organization(s): ${organizationIds.join(', ')}`,
      );
    }
    return organizationIds;
  }

  /**
   * Queues the rebuild of the given company. One job per company at a
   * time: the job id is the company's, so restarts and several server
   * instances don't queue it twice.
   * @param {string} organizationId
   */
  public async queueRebuild(organizationId: string) {
    const payload: ICashBasisRebuildJobPayload = {
      organizationId,
      clearRebuildFlag: true,
    };
    await this.cashBasisRebuildQueue.add(CASH_BASIS_REBUILD_JOB, payload, {
      jobId: `cash-basis-auto-rebuild-${organizationId}`,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /**
   * Retrieves the initialized companies that have the rebuild flag.
   * @returns {Promise<string[]>}
   */
  public async getFlaggedOrganizations(): Promise<string[]> {
    const systemKnex = this.initSystemKnex();
    let organizationIds: string[] = [];

    try {
      const tenants = await systemKnex('tenants')
        .whereNotNull('initializedAt')
        .select('organizationId');
      organizationIds = tenants.map((tenant: any) => tenant.organizationId);
    } finally {
      await systemKnex.destroy();
    }
    const flagged: string[] = [];

    for (const organizationId of organizationIds) {
      try {
        if (await this.isFlagged(organizationId)) flagged.push(organizationId);
      } catch (error) {
        // A company whose database was never built has nothing to rebuild.
        if (['ER_NO_SUCH_TABLE', 'ER_BAD_DB_ERROR'].includes(error?.code)) {
          continue;
        }
        this.logger.warn(
          `[${organizationId}] Could not read the cash rebuild flag: ${error?.message}`,
        );
      }
    }
    return flagged;
  }

  /**
   * Whether the given company has the rebuild flag.
   * @param {string} organizationId
   * @returns {Promise<boolean>}
   */
  public async isFlagged(organizationId: string): Promise<boolean> {
    return this.withTenantKnex(organizationId, async (knex) => {
      const row = await knex('settings')
        .where(CASH_REBUILD_FLAG)
        .first('value');
      return row?.value === 'true' || row?.value === true;
    });
  }

  /**
   * Clears the rebuild flag of the given company.
   * @param {string} organizationId
   */
  public async clearFlag(organizationId: string): Promise<void> {
    await this.withTenantKnex(organizationId, (knex) =>
      knex('settings').where(CASH_REBUILD_FLAG).delete(),
    );
  }

  private async withTenantKnex<T>(
    organizationId: string,
    callback: (knex: KnexType) => Promise<T>,
  ): Promise<T> {
    const knex = this.initTenantKnex(organizationId);
    try {
      return await callback(knex);
    } finally {
      await knex.destroy();
    }
  }

  private initSystemKnex(): KnexType {
    return Knex({
      client: this.configService.get('systemDatabase.client'),
      connection: {
        host: this.configService.get('systemDatabase.host'),
        port: this.configService.get('systemDatabase.port'),
        user: this.configService.get('systemDatabase.user'),
        password: this.configService.get('systemDatabase.password'),
        database: this.configService.get('systemDatabase.databaseName'),
        charset: 'utf8',
        ...DATE_ONLY_COLUMNS_OPTIONS,
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
  }

  private initTenantKnex(organizationId: string): KnexType {
    return Knex({
      client: this.configService.get('tenantDatabase.client'),
      connection: {
        host: this.configService.get('tenantDatabase.host'),
        port: this.configService.get('tenantDatabase.port'),
        user: this.configService.get('tenantDatabase.user'),
        password: this.configService.get('tenantDatabase.password'),
        database: `${this.configService.get('tenantDatabase.dbNamePrefix')}${organizationId}`,
        charset: 'utf8',
        ...DATE_ONLY_COLUMNS_OPTIONS,
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
  }
}
