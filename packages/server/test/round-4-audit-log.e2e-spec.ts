import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * F2: the audit row is written after the save commits, not with the save's
 * transaction (a deadlock on it used to undo the save while the save carried
 * on). A committed save logs one row, with the user who made it; a save that
 * is undone (here the bulk-delete dry run) logs nothing.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F2: audit log written after commit (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  let itemId: number;
  let vendorId: number;
  const api = () => as(app, company.owner, company.organizationId);

  const auditRows = (subjectId: number) =>
    db('audit_logs').where({ subject: 'Bill', subjectId }).select();

  /** The after-commit insert runs just after the response; wait for it. */
  const waitForAuditRows = async (subjectId: number, count: number) => {
    for (let i = 0; i < 20; i++) {
      const rows = await auditRows(subjectId);
      if (rows.length >= count) return rows;
      await sleep(100);
    }
    return auditRows(subjectId);
  };

  beforeAll(async () => {
    company = await createCompany(app, 'r4audit');
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
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `F2 service ${tag}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: await byType('income'),
          costAccountId: await byType('cost-of-goods-sold'),
          sellPrice: 100,
          costPrice: 100,
        }),
    ).body.id;
    vendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `F2 vendor ${tag}` }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  const createBill = async () =>
    ok(
      await api()
        .post('/bills')
        .send({
          vendorId,
          billDate: '2026-05-01',
          dueDate: '2026-05-31',
          billNumber: `F2-${faker.string.alphanumeric(8)}`,
          open: true,
          entries: [{ index: 1, itemId, quantity: 1, rate: 500 }],
        }),
    ).body.id as number;

  it('a saved bill writes one audit row, with the user who saved it', async () => {
    const billId = await createBill();
    const rows = await waitForAuditRows(billId, 1);
    expect(rows.map((r) => r.action)).toEqual(['created']);
    expect(rows[0].userId).toBe(company.owner.systemUserId);
  });

  it('the bulk-delete dry run (undone) writes no "deleted" row, and a real delete does', async () => {
    const billId = await createBill();
    await waitForAuditRows(billId, 1);

    const check = ok(
      await api()
        .post('/bills/validate-bulk-delete')
        .send({ ids: [billId] }),
    );
    expect(check.body.deletableIds ?? check.body.deletable_ids).toContain(
      billId,
    );
    await sleep(1000);
    expect((await auditRows(billId)).map((r) => r.action)).toEqual(['created']);
    // The bill and its ledger rows are still there after the dry run.
    expect(await db('bills').where({ id: billId }).first()).toBeTruthy();

    ok(await api().delete(`/bills/${billId}`));
    const rows = await waitForAuditRows(billId, 2);
    expect(rows.map((r) => r.action).sort()).toEqual(['created', 'deleted']);
  });
});
