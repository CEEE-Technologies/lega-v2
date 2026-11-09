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
 * - R5: Sales / Purchases by Items counted inventory adjustments (and
 *   transfers) as sales and purchases.
 * - R2: Transactions by Customer/Vendor did the same with the opening
 *   balance (start-date entries in the opening and again in the period).
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

  let customerId: number;
  let itemId: number;

  const invoice = async (date: string, rate: number, extra = {}) =>
    ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: date,
          dueDate: date,
          invoiceNo: `R-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          delivered: true,
          entries: [{ index: 1, itemId, quantity: 1, rate }],
          ...extra,
        }),
    ).body.id as number;

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
    customerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `R customer ${Date.now()}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id;
    itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `R service ${Date.now()}`,
          type: 'service',
          sellable: true,
          sellAccountId: await byType('income'),
          sellPrice: 100,
        }),
    ).body.id;
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

  it('R2: transactions by customer opens at 0 when the first invoice is on the start date', async () => {
    await invoice('2026-11-01', 1000);
    const res = ok(
      await api().get('/reports/transactions-by-customers').query({
        fromDate: '2026-11-01',
        toDate: '2026-11-30',
      }),
    );
    const [row] = res.body.data;
    expect({
      opening: row.opening_balance.amount,
      closing: row.closing_balance.amount,
    }).toEqual({ opening: 0, closing: 1000 });
  });

  it('R5: sales and purchases by items count only sales and purchases', async () => {
    const stockItemId = ok(
      await api()
        .post('/items')
        .send({
          name: `R5 stock ${Date.now()}`,
          type: 'inventory',
          sellable: true,
          purchasable: true,
          sellAccountId: await byType('income'),
          costAccountId: await byType('cost-of-goods-sold'),
          inventoryAccountId: await byType('inventory'),
          sellPrice: 20,
          costPrice: 5,
        }),
    ).body.id;
    const vendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `R5 vendor ${Date.now()}`, currencyCode: 'USD' }),
    ).body.id;
    ok(
      await api()
        .post('/bills')
        .send({
          vendorId,
          billDate: '2026-07-01',
          dueDate: '2026-07-31',
          billNumber: `R5-B-${Date.now()}`,
          open: true,
          entries: [{ index: 1, itemId: stockItemId, quantity: 10, rate: 5 }],
        }),
    );
    ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: '2026-07-02',
          dueDate: '2026-07-31',
          invoiceNo: `R5-I-${Date.now()}`,
          delivered: true,
          entries: [{ index: 1, itemId: stockItemId, quantity: 2, rate: 20 }],
        }),
    );
    for (const [type, quantity] of [
      ['decrement', 3],
      ['increment', 4],
    ] as const) {
      ok(
        await api()
          .post('/inventory-adjustments/quick')
          .send({
            date: '2026-07-03',
            type,
            adjustmentAccountId: await byType('expense'),
            reason: 'R5',
            referenceNo: `R5-${type}`,
            itemId: stockItemId,
            quantity,
            cost: 5,
            publish: true,
          }),
      );
    }
    const quantityOf = async (url: string) => {
      const res = ok(
        await api()
          .get(url)
          .query({ fromDate: '2026-07-01', toDate: '2026-07-31' }),
      );
      const rows = res.body.data?.items ?? res.body.data ?? res.body.items;
      const row = rows.find((r: any) => r.id === stockItemId);
      return row?.quantity_sold ?? row?.quantity_purchased ?? row?.quantity;
    };
    const sold = await quantityOf('/reports/sales-by-items');
    const bought = await quantityOf('/reports/purchases-by-items');
    expect({
      sold: Number(sold?.amount ?? sold),
      bought: Number(bought?.amount ?? bought),
    }).toEqual({
      sold: 2,
      bought: 10,
    });
  });
});
