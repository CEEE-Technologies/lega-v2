import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';
import { StockQuantitiesRepairService } from '../src/modules/AccountingBasis/StockQuantitiesRepair.service';
import { checkDataHealth } from '../src/modules/AccountingBasis/DataHealthCheck';

/**
 * F4: `tenants:repair-stock-quantities` sets the stored stock on hand from
 * the stock movements, per item and per item and warehouse (health check
 * H3 (b)). Round 3's duplicate-row merge added the rows together, so a
 * warehouse figure could be double.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F4: repair stock quantities (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let itemId: number;
  let warehouseId: number;

  const withService = async <T>(
    work: (service: StockQuantitiesRepairService) => Promise<T>,
  ) => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('organizationId', company.organizationId);
      cls.set('userId', company.owner.systemUserId);
      await cls.resolveProxyProviders();
      return work(
        await app.resolve(StockQuantitiesRepairService, undefined, {
          strict: false,
        }),
      );
    });
  };

  const stored = async () => ({
    item: Number(
      (await db('items').where({ id: itemId }).first()).quantityOnHand,
    ),
    warehouse: Number(
      (
        await db('items_warehouses_quantity')
          .where({ itemId, warehouseId })
          .first()
      )?.quantityOnHand,
    ),
  });

  beforeAll(async () => {
    company = await createCompany(app, 'r4stock');
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
          name: `F4 chair ${tag}`,
          type: 'inventory',
          sellable: true,
          purchasable: true,
          sellAccountId: await byType('income'),
          costAccountId: await byType('cost-of-goods-sold'),
          inventoryAccountId: await byType('inventory'),
          sellPrice: 50,
          costPrice: 20,
        }),
    ).body.id;
    const vendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `F4 vendor ${tag}`, currencyCode: 'USD' }),
    ).body.id;
    const customerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `F4 customer ${tag}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id;

    ok(await api().post('/warehouses/activate').send({}));
    warehouseId = (await db('warehouses').orderBy('id').first('id')).id;

    // 8 bought, 3 sold: 5 in the warehouse.
    ok(
      await api()
        .post('/bills')
        .send({
          vendorId,
          billDate: '2026-04-01',
          dueDate: '2026-04-30',
          billNumber: `F4-${faker.string.alphanumeric(8)}`,
          open: true,
          warehouseId,
          entries: [{ index: 1, itemId, quantity: 8, rate: 20, warehouseId }],
        }),
    );
    ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: '2026-04-02',
          dueDate: '2026-04-30',
          invoiceNo: `F4-${faker.string.alphanumeric(8)}`,
          delivered: true,
          warehouseId,
          entries: [{ index: 1, itemId, quantity: 3, rate: 50, warehouseId }],
        }),
    );
    await sleep(1000);
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('starts right: 5 on the item and in the warehouse', async () => {
    expect(await stored()).toEqual({ item: 5, warehouse: 5 });
  });

  it('the dry run lists a doubled warehouse row and a wrong item total, and changes nothing', async () => {
    // What round 3's duplicate-row merge could leave: the warehouse doubled.
    await db('items_warehouses_quantity')
      .where({ itemId, warehouseId })
      .update({ quantityOnHand: 10 });
    await db('items').where({ id: itemId }).update({ quantityOnHand: 7 });

    const scan = await withService((s) => s.scan());
    expect(scan.warehousesChecked).toBe(true);
    const mine = scan.differences.filter((d) => d.itemId === itemId);
    expect(
      mine.map((d) => [d.level, d.warehouseId, d.stored, d.fromMovements]),
    ).toEqual([
      ['item', null, 7, 5],
      ['warehouse', warehouseId, 10, 5],
    ]);
    expect(await stored()).toEqual({ item: 7, warehouse: 10 });
  });

  it('--apply sets both from the movements; H3 (b) is clean and a second run lists nothing', async () => {
    const result = await withService((s) => s.repair());
    expect(result.differences.filter((d) => d.itemId === itemId)).toHaveLength(
      2,
    );
    expect(await stored()).toEqual({ item: 5, warehouse: 5 });

    expect((await withService((s) => s.scan())).differences).toEqual([]);
    const health = await checkDataHealth(db, 'USD');
    expect(health.stockTotalDifferences).toEqual([]);
  });

  it('a missing warehouse row is added back', async () => {
    await db('items_warehouses_quantity')
      .where({ itemId, warehouseId })
      .delete();
    await withService((s) => s.repair());
    expect(await stored()).toEqual({ item: 5, warehouse: 5 });
  });

  it('later stock changes still add up after the repair', async () => {
    const vendorId = (
      await db('contacts').where('contactService', 'vendor').first('id')
    ).id;
    ok(
      await api()
        .post('/bills')
        .send({
          vendorId,
          billDate: '2026-04-03',
          dueDate: '2026-04-30',
          billNumber: `F4-${faker.string.alphanumeric(8)}`,
          open: true,
          warehouseId,
          entries: [{ index: 1, itemId, quantity: 2, rate: 20, warehouseId }],
        }),
    );
    await sleep(500);
    expect(await stored()).toEqual({ item: 7, warehouse: 7 });
  });
});
