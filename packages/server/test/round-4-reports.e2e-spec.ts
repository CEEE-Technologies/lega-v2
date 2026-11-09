import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';
import { findNode } from './_utils/balance-sheet';

/**
 * Sweep (round 4, Part 6): report figures.
 * - R1: balance sheet date-period columns counted the entries dated on the
 *   start date twice (the opening closed on it and the first period
 *   started on it).
 */
jest.retryTimes(0);

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('Round 4 sweep: reports (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  const byType = async (type: string) =>
    (await db('accounts').where('accountType', type).first('id')).id;

  beforeAll(async () => {
    company = await createCompany(app, 'r4rep');
    const config = app.get(ConfigService).get('tenantDatabase');
    db = knexFactory({
      client: config.client,
      connection: {
        host: config.host,
        port: Number(config.port),
        user: config.user,
        password: config.password,
        database: `${config.dbNamePrefix}${company.organizationId}`,
        charset: 'utf8',
      },
      pool: { min: 0, max: 2 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('R1: balance sheet monthly columns count an entry on the start date once', async () => {
    const bankId = await byType('bank');
    ok(
      await api()
        .post('/manual-journals')
        .send({
          date: '2026-01-01',
          journalNumber: `R1-${Date.now()}`,
          publish: true,
          entries: [
            { index: 1, accountId: bankId, debit: 5000, credit: 0 },
            {
              index: 2,
              accountId: await byType('equity'),
              debit: 0,
              credit: 5000,
            },
          ],
        }),
    );
    const res = ok(
      await api().get('/reports/balance-sheet').query({
        fromDate: '2026-01-01',
        toDate: '2026-03-31',
        displayColumnsType: 'date_periods',
        displayColumnsBy: 'month',
      }),
    );
    const data = res.body.data ?? res.body;
    const bank = findNode(data, bankId);
    expect(bank).toBeDefined();
    expect(bank.total.amount).toBe(5000);
    const periods = bank.horizontal_totals ?? bank.horizontalTotals;
    expect(periods.map((p: any) => p.total?.amount ?? p.amount)).toEqual([
      5000, 5000, 5000,
    ]);
  });
});
