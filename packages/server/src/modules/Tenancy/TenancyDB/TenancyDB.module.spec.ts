import { getTenantDatabaseName } from './TenancyDB.module';

/** F25: the company database name follows the configured prefix. */
describe('getTenantDatabaseName', () => {
  const config = (prefix?: string) => ({
    get: (key: string) =>
      key === 'tenantDatabase.dbNamePrefix' ? prefix : undefined,
  });

  it('uses the configured prefix', () => {
    expect(getTenantDatabaseName(config('lega_tenant_') as any, 'abc')).toBe(
      'lega_tenant_abc',
    );
  });

  it('falls back to the default prefix', () => {
    expect(getTenantDatabaseName(config(undefined) as any, 'abc')).toBe(
      'bigcapital_tenant_abc',
    );
  });
});
