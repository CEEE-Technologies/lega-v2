import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * F26: turning branches on, in a new company, creates the first (primary)
 * branch, turns the setting on, and gives existing documents that branch,
 * all in one transaction; a second try is refused.
 */
jest.retryTimes(0);

describe('F26: turning branches on (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);

  beforeAll(async () => {
    company = await createCompany(app, 'r4br');
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

  it('creates one primary branch, turns the setting on, and refuses a second try', async () => {
    const res = await api().post('/branches/activate');
    expect([200, 201]).toContain(res.status);

    const branches = await db('branches');
    expect(branches).toHaveLength(1);
    expect(Number(branches[0].primary)).toBe(1);
    const setting = await db('settings')
      .where({ group: 'features', key: 'branches' })
      .first();
    expect(Number(setting?.value)).toBe(1);

    const again = await api().post('/branches/activate');
    expect(again.status).toBe(400);
    expect(await db('branches')).toHaveLength(1);
  });

  // Sweep S2: a journal's lines without their own branch take the journal's
  // branch, so its ledger rows show in branch reports (they had none).
  it('a journal line without a branch is posted with the journal branch', async () => {
    const [branch] = await db('branches');
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    const res = await api()
      .post('/manual-journals')
      .send({
        date: '2026-06-01',
        journalNumber: `S2-${Date.now()}`,
        publish: true,
        branchId: branch.id,
        entries: [
          { index: 1, accountId: await byType('bank'), debit: 90, credit: 0 },
          { index: 2, accountId: await byType('income'), debit: 0, credit: 90 },
        ],
      });
    expect([200, 201]).toContain(res.status);
    const rows = await db('accounts_transactions').where({
      referenceType: 'Journal',
      referenceId: res.body.id,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.branchId === branch.id)).toBe(true);
  });

  // Sweep S6: with branches on, an invoice and a money in/out need a branch
  // (their validators weren't registered, so they were saved without one).
  it('an invoice or a money-in without a branch is refused', async () => {
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    const customer = await api()
      .post('/customers')
      .send({
        displayName: `S6 customer ${Date.now()}`,
        customerType: 'business',
        currencyCode: 'USD',
      });
    const item = await api()
      .post('/items')
      .send({
        name: `S6 service ${Date.now()}`,
        type: 'service',
        sellable: true,
        sellAccountId: await byType('income'),
        sellPrice: 10,
      });
    const invoice = await api()
      .post('/sale-invoices')
      .send({
        customerId: customer.body.id,
        invoiceDate: '2026-06-01',
        dueDate: '2026-06-30',
        invoiceNo: `S6-${Date.now()}`,
        delivered: true,
        entries: [{ index: 1, itemId: item.body.id, quantity: 1, rate: 10 }],
      });
    expect(invoice.status).toBe(400);
    expect(invoice.body.errors?.[0]?.type).toBe('BRANCH_ID_REQUIRED');

    const moneyIn = await api()
      .post('/banking/transactions')
      .send({
        date: '2026-06-01',
        transactionType: 'owner_contribution',
        amount: 10,
        cashflowAccountId: await byType('bank'),
        creditAccountId: await byType('equity'),
        description: 'S6',
        publish: true,
      });
    expect(moneyIn.status).toBe(400);
    expect(moneyIn.body.errors?.[0]?.type).toBe('BRANCH_ID_REQUIRED');
  });
});
