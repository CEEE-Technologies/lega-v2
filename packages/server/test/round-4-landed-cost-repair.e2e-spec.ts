import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';
import { LandedCostsFromInventoryRepairService } from '../src/modules/EE/BillLandedCosts/commands/LandedCostsFromInventoryRepair.service';
import { checkRound3DataHealth } from '../src/modules/AccountingBasis/DataHealthCheckRound3';

/**
 * F3: `tenants:repair-landed-costs-from-inventory` lists the landed costs
 * allocated from an inventory bill line (health check H11 (c)), and with
 * --apply removes each allocation with the app's own undo: the allocation,
 * its stock and ledger rows go, and the source line's allocated amount is
 * reset. Allocations on a bill in a locked period are skipped.
 *
 * Q9 refuses such allocations now, so the old data is made the way it
 * looked: a real allocation from a service line, whose item is then changed
 * to an inventory item in the database.
 */
jest.retryTimes(0);

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F3: repair landed costs from an inventory line (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let accounts: Record<string, number>;
  let vendorId: number;
  let freightItemId: number;
  let stockItemId: number;

  /** Runs the work with the repair service, in the company's context. */
  const withService = async <T>(
    work: (service: LandedCostsFromInventoryRepairService) => Promise<T>,
  ) => {
    const cls = app.get(ClsService);
    return cls.run(async () => {
      cls.set('organizationId', company.organizationId);
      cls.set('userId', company.owner.systemUserId);
      await cls.resolveProxyProviders();
      const service = await app.resolve(
        LandedCostsFromInventoryRepairService,
        undefined,
        { strict: false },
      );
      return work(service);
    });
  };

  const postBill = async (date: string, entries: any[]) =>
    ok(
      await api()
        .post('/bills')
        .send({
          vendorId,
          billDate: date,
          dueDate: date,
          billNumber: `F3-${faker.string.alphanumeric(8)}`,
          open: true,
          entries,
        }),
    ).body.id as number;

  /**
   * A 200 freight bill allocated onto a goods bill, then its line's item
   * switched to an inventory item: what an allocation made before Q9 looks
   * like.
   */
  const plantFromInventory = async (goodsDate: string) => {
    const freightBill = await postBill('2026-04-01', [
      {
        index: 1,
        itemId: freightItemId,
        quantity: 1,
        rate: 200,
        landedCost: true,
      },
    ]);
    const goodsBill = await postBill(goodsDate, [
      { index: 1, itemId: stockItemId, quantity: 10, rate: 100 },
    ]);
    const freightEntry = await db('items_entries')
      .where({ referenceType: 'Bill', referenceId: freightBill })
      .first();
    const goodsEntry = await db('items_entries')
      .where({ referenceType: 'Bill', referenceId: goodsBill })
      .first();
    const landedCostId = ok(
      await api()
        .post(`/landed-cost/bills/${goodsBill}/allocate`)
        .send({
          transactionId: freightBill,
          transactionType: 'Bill',
          transactionEntryId: freightEntry.id,
          allocationMethod: 'value',
          description: 'Freight',
          items: [{ entryId: goodsEntry.id, cost: 200 }],
        }),
    ).body.id as number;
    await db('items_entries')
      .where({ id: freightEntry.id })
      .update({ itemId: stockItemId });
    return {
      freightBill,
      freightEntryId: freightEntry.id,
      goodsBill,
      landedCostId,
    };
  };

  const rowsOf = async (landedCostId: number) => ({
    allocation: await db('bill_located_costs').where({ id: landedCostId }),
    entries: await db('bill_located_cost_entries').where({
      billLocatedCostId: landedCostId,
    }),
    stock: await db('inventory_transactions').where({
      transactionType: 'LandedCost',
      transactionId: landedCostId,
    }),
    ledger: await db('accounts_transactions').where({
      referenceType: 'LandedCost',
      referenceId: landedCostId,
    }),
  });

  let open: Awaited<ReturnType<typeof plantFromInventory>>;
  let locked: Awaited<ReturnType<typeof plantFromInventory>>;

  beforeAll(async () => {
    company = await createCompany(app, 'r4lc');
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
        dateStrings: ['DATE'] as unknown as boolean,
      },
      pool: { min: 0, max: 2 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      income: await byType('income'),
      cogs: await byType('cost-of-goods-sold'),
      inventory: await byType('inventory'),
      expense: await byType('expense'),
    };
    ok(
      await api()
        .put('/settings')
        .send({
          options: [{ group: 'features', key: 'landed_cost', value: 1 }],
        }),
    );
    vendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `F3 vendor ${tag}`, currencyCode: 'USD' }),
    ).body.id;
    const createItem = async (type: 'service' | 'inventory') =>
      ok(
        await api()
          .post('/items')
          .send({
            name: `F3 ${type} ${tag}`,
            type,
            sellable: true,
            purchasable: true,
            sellAccountId: accounts.income,
            costAccountId:
              type === 'inventory' ? accounts.cogs : accounts.expense,
            ...(type === 'inventory' && {
              inventoryAccountId: accounts.inventory,
            }),
            sellPrice: 50,
            costPrice: 20,
          }),
      ).body.id as number;
    freightItemId = await createItem('service');
    stockItemId = await createItem('inventory');

    open = await plantFromInventory('2026-04-01');
    locked = await plantFromInventory('2025-02-01');
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('the dry run lists both (one in a locked period) and changes nothing', async () => {
    ok(
      await api().put('/transactions-locking/lock').send({
        module: 'all',
        lockToDate: '2025-12-31',
        reason: 'F3 repair test',
      }),
    );
    const before = await rowsOf(open.landedCostId);
    expect(before.allocation).toHaveLength(1);
    expect(before.stock.length).toBeGreaterThan(0);
    expect(before.ledger.length).toBeGreaterThan(0);

    const found = await withService((s) => s.scan());
    expect(
      found
        .map((f) => [f.landedCostId, f.locked])
        .sort((a, b) => +a[0] - +b[0]),
    ).toEqual(
      [
        [open.landedCostId, false],
        [locked.landedCostId, true],
      ].sort((a, b) => +a[0] - +b[0]),
    );
    expect(await rowsOf(open.landedCostId)).toEqual(before);
  });

  it('--apply removes the open one with its stock and ledger rows, and skips the locked one', async () => {
    let result: Awaited<
      ReturnType<LandedCostsFromInventoryRepairService['repair']>
    >;
    try {
      result = await withService((s) => s.repair());
    } finally {
      ok(
        await api()
          .put('/transactions-locking/cancel-lock')
          .send({ module: 'all', reason: 'F3 repair test' }),
      );
    }
    expect(result.failed).toEqual([]);
    expect(result.removed.map((r) => r.landedCostId)).toEqual([
      open.landedCostId,
    ]);
    expect(result.skipped.map((r) => r.landedCostId)).toEqual([
      locked.landedCostId,
    ]);

    expect(await rowsOf(open.landedCostId)).toEqual({
      allocation: [],
      entries: [],
      stock: [],
      ledger: [],
    });
    const sourceLine = await db('items_entries')
      .where({ id: open.freightEntryId })
      .first();
    expect(Number(sourceLine.allocatedCostAmount)).toBe(0);
    const sourceBill = await db('bills')
      .where({ id: open.freightBill })
      .first();
    expect(Number(sourceBill.allocatedCostAmount)).toBe(0);

    // The locked one is untouched.
    expect((await rowsOf(locked.landedCostId)).allocation).toHaveLength(1);
  });

  it('a second dry run lists only the locked one, and H11 (c) agrees', async () => {
    const found = await withService((s) => s.scan());
    expect(found.map((f) => f.landedCostId)).toEqual([locked.landedCostId]);

    const health = await checkRound3DataHealth(db, 'USD');
    expect(
      health.landedCostsFromInventoryLines.map((f) => f.landedCostId),
    ).toEqual([locked.landedCostId]);
  });
});
