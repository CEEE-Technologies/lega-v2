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
 * - R8: cash flow monthly columns from mid-month dropped the cash at
 *   beginning of the first column.
 * - R9: report repositories (balance sheet, P&L...) were one instance
 *   shared by every request, so concurrent reports could mix their data.
 * - R4: Inventory Item Details valued the opening stock with sales at
 *   their selling price, not their cost.
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
  let stockItemId: number;

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
    stockItemId = ok(
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

  it('R8: cash flow monthly columns from mid-month keep the opening cash', async () => {
    const bankId = await byType('bank');
    ok(
      await api()
        .post('/manual-journals')
        .send({
          date: '2026-08-10',
          journalNumber: `R8-${Date.now()}`,
          publish: true,
          entries: [
            { index: 1, accountId: bankId, debit: 200, credit: 0 },
            {
              index: 2,
              accountId: await byType('equity'),
              debit: 0,
              credit: 200,
            },
          ],
        }),
    );
    const query = { fromDate: '2026-08-15', toDate: '2026-09-30' };
    const total = ok(
      await api().get('/reports/cashflow-statement').query(query),
    ).body;
    const periods = ok(
      await api()
        .get('/reports/cashflow-statement')
        .query({
          ...query,
          displayColumnsType: 'date_periods',
          displayColumnsBy: 'month',
        }),
    ).body;
    const beginning = (body: any) =>
      (body.data ?? body).find(
        (node: any) => node.id === 'CASH_BEGINNING_PERIOD',
      );
    const totalBeginning = beginning(total)?.total?.amount;
    expect(totalBeginning).toBeGreaterThan(0);
    // The first month's opening cash is the report's opening cash.
    expect(beginning(periods)?.periods?.[0]?.total?.amount).toBe(
      totalBeginning,
    );
  });

  it('R9: concurrent balance sheets of two companies keep their own figures', async () => {
    const other = await createCompany(app, 'r4rep2');
    const otherApi = () => as(app, other.owner, other.organizationId);
    const otherBank = (
      await otherApi()
        .get('/accounts')
        .query({ accountTypes: ['bank'] })
    ).body;
    const otherAccounts = Array.isArray(otherBank)
      ? otherBank
      : (otherBank.accounts ?? otherBank.data);
    const otherBankId = otherAccounts.find(
      (a: any) => (a.accountType ?? a.account_type) === 'bank',
    ).id;
    const otherEquityId = otherAccounts.find(
      (a: any) => (a.accountType ?? a.account_type) === 'equity',
    )?.id;
    const accountsRes = (await otherApi().get('/accounts')).body;
    const allOther = Array.isArray(accountsRes)
      ? accountsRes
      : (accountsRes.accounts ?? accountsRes.data);
    const equity =
      otherEquityId ??
      allOther.find((a: any) => (a.accountType ?? a.account_type) === 'equity')
        .id;
    ok(
      await otherApi()
        .post('/manual-journals')
        .send({
          date: '2026-02-01',
          journalNumber: `R9-${Date.now()}`,
          publish: true,
          entries: [
            { index: 1, accountId: otherBankId, debit: 777, credit: 0 },
            { index: 2, accountId: equity, debit: 0, credit: 777 },
          ],
        }),
    );
    const query = { fromDate: '2026-01-01', toDate: '2026-12-31' };
    const bankTotal = async (client: () => any, bankId: number) =>
      findNode(
        ok(await client().get('/reports/balance-sheet').query(query)).body.data,
        bankId,
      ).total.amount;

    const ownBankId = await byType('bank');
    const ownExpected = await bankTotal(api, ownBankId);
    const otherExpected = await bankTotal(otherApi, otherBankId);
    expect(otherExpected).toBe(777);

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? bankTotal(api, ownBankId).then((v) => ['own', v])
          : bankTotal(otherApi, otherBankId).then((v) => ['other', v]),
      ),
    );
    for (const [who, value] of results) {
      expect(value).toBe(who === 'own' ? ownExpected : otherExpected);
    }
  }, 300000);

  it('R4: inventory item details open at cost (after R5 made the stock moves)', async () => {
    // Bought 10 @ 5, sold 2 (at 20), adjusted -3 and +4 at cost 5: 9 left,
    // worth 45 at cost. Cost lots are computed by a background job.
    for (let i = 0; i < 30; i++) {
      const lots = await db('inventory_cost_lot_tracker').where({
        itemId: stockItemId,
        direction: 'OUT',
      });
      if (lots.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const res = ok(
      await api()
        .get('/reports/inventory-item-details')
        .query({
          fromDate: '2026-07-10',
          toDate: '2026-07-31',
          itemsIds: [stockItemId, stockItemId],
        }),
    );
    const items = res.body.data ?? res.body;
    const item = items.find((node: any) => node.id === stockItemId);
    const opening = (item.children ?? []).find(
      (child: any) => (child.node_type ?? child.nodeType) === 'OPENING_ENTRY',
    );
    expect({
      quantity: opening.quantity.number,
      value: opening.value.number,
    }).toEqual({ quantity: 9, value: 45 });
  });
});
