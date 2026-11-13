import knex from 'knex';
import { Global, Module } from '@nestjs/common';
import { knexSnakeCaseMappers } from 'objection';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ConfigService } from '@nestjs/config';
import { DATE_ONLY_COLUMNS_OPTIONS } from '@/common/constants/database.constants';
import { TENANCY_DB_CONNECTION } from './TenancyDB.constants';
import { UnitOfWork } from './UnitOfWork.service';
import { KnexPoolCache } from './KnexPoolCache';

const tenantPools = new KnexPoolCache();

/**
 * The company database's name: the configured prefix (TENANT_DB_NAME_PERFIX,
 * as the migrations and the CLI use) and the organization id. It used to be
 * hard-coded as `bigcapital_tenant_`.
 */
export const getTenantDatabaseName = (
  configService: Pick<ConfigService, 'get'>,
  organizationId: string,
): string =>
  `${configService.get('tenantDatabase.dbNamePrefix') ?? 'bigcapital_tenant_'}${organizationId}`;

export const TenancyDatabaseProxyProvider = ClsModule.forFeatureAsync({
  provide: TENANCY_DB_CONNECTION,
  global: true,
  strict: true,
  inject: [ConfigService, ClsService],
  useFactory: async (configService: ConfigService, cls: ClsService) => () => {
    const organizationId = cls.get('organizationId');
    const database = getTenantDatabaseName(configService, organizationId);
    const cachedInstance = tenantPools.get(database);

    if (cachedInstance) {
      return cachedInstance;
    }
    const knexInstance = knex({
      client: configService.get('tenantDatabase.client'),
      connection: {
        host: configService.get('tenantDatabase.host'),
        port: configService.get('tenantDatabase.port'),
        user: configService.get('tenantDatabase.user'),
        password: configService.get('tenantDatabase.password'),
        database,
        charset: 'utf8',
        ...DATE_ONLY_COLUMNS_OPTIONS,
      },
      migrations: {
        directory: configService.get('tenantDatabase.migrationsDir'),
        loadExtensions: ['.js'],
      },
      seeds: {
        directory: configService.get('tenantDatabase.seedsDir'),
      },
      pool: { min: 0, max: 7 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    tenantPools.set(database, knexInstance);

    return knexInstance;
  },
  type: 'function',
});

@Global()
@Module({
  imports: [TenancyDatabaseProxyProvider],
  providers: [UnitOfWork],
  exports: [UnitOfWork],
})
export class TenancyDatabaseModule {}
