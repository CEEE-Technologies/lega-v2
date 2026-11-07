import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import { authHeaders, cancelTransactionsLock } from './_utils/gl';

const http = () => request(app.getHttpServer());

/** First array in a list response (`data`, `warehouses_transfers`…). */
const rowsOf = (body: any): any[] => {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  const found = Object.values(body || {}).find((value) => Array.isArray(value));
  return (found as any[]) || [];
};

const idsInOrder = (rows: any[], ids: number[]) =>
  rows.map((row) => row.id).filter((id) => ids.includes(id));

const createInventoryItem = async () => {
  const res = await http()
    .post('/items')
    .set(authHeaders())
    .send({
      name: `List options item ${Date.now()}-${faker.string.alphanumeric(4)}`,
      type: 'inventory',
      sellable: true,
      purchasable: true,
      sellAccountId: 1026,
      costAccountId: 1019,
      inventoryAccountId: 1007,
      costPrice: 10,
      sellPrice: 20,
    })
    .expect(201);
  return parseInt(res.body.id, 10);
};

const createWarehouse = async () => {
  const res = await http()
    .post('/warehouses')
    .set(authHeaders())
    .send({
      name: `WH ${faker.string.alphanumeric(8)}`,
      code: faker.string.alphanumeric(6).toUpperCase(),
    })
    .expect(201);
  return res.body.id as number;
};

describe('F8: warehouse transfer tabs and sorting (e2e)', () => {
  const ids: Record<'draft' | 'inTransit' | 'transferred', number> = {
    draft: 0,
    inTransit: 0,
    transferred: 0,
  };

  beforeAll(async () => {
    await cancelTransactionsLock();
    const itemId = await createInventoryItem();
    const fromWarehouseId = await createWarehouse();
    const toWarehouseId = await createWarehouse();

    const create = async (date: string) => {
      const res = await http()
        .post('/warehouse-transfers')
        .set(authHeaders())
        .send({
          fromWarehouseId,
          toWarehouseId,
          date,
          transactionNumber: `WT-${faker.string.alphanumeric(10)}`,
          entries: [{ index: 1, itemId, quantity: 1 }],
        })
        .expect(201);
      return res.body.id as number;
    };
    // Created in this order, so the default (newest first) order differs
    // from the date order.
    ids.inTransit = await create('2026-01-01');
    ids.transferred = await create('2026-01-02');
    ids.draft = await create('2026-01-03');

    await http()
      .put(`/warehouse-transfers/${ids.inTransit}/initiate`)
      .set(authHeaders())
      .expect(200);
    await http()
      .put(`/warehouse-transfers/${ids.transferred}/initiate`)
      .set(authHeaders())
      .expect(200);
    await http()
      .put(`/warehouse-transfers/${ids.transferred}/transferred`)
      .set(authHeaders())
      .expect(200);
  });

  it('lists the Draft, In transit and Transferred tabs', async () => {
    const res = await http()
      .get('/views/resource/warehouse_transfer')
      .set(authHeaders())
      .expect(200);
    const slugs = rowsOf(res.body).map((view) => view.slug);
    expect(slugs).toEqual(['draft', 'in-transit', 'transferred']);
  });

  it.each([
    ['draft', 'draft'],
    ['in-transit', 'inTransit'],
    ['transferred', 'transferred'],
  ] as const)('the %s tab shows only those transfers', async (slug, key) => {
    const res = await http()
      .get('/warehouse-transfers')
      .query({ viewSlug: slug, pageSize: 1000 })
      .set(authHeaders())
      .expect(200);
    const listed = rowsOf(res.body).map((row) => row.id);
    const mine = Object.values(ids);

    expect(listed.filter((id) => mine.includes(id))).toEqual([ids[key]]);
  });

  it('sorts by date', async () => {
    const asc = await http()
      .get('/warehouse-transfers')
      .query({ columnSortBy: 'date', sortOrder: 'asc', pageSize: 1000 })
      .set(authHeaders())
      .expect(200);
    const mine = [ids.draft, ids.inTransit, ids.transferred];

    expect(idsInOrder(rowsOf(asc.body), mine)).toEqual([
      ids.inTransit,
      ids.transferred,
      ids.draft,
    ]);
  });

  it('defaults to newest date first', async () => {
    const res = await http()
      .get('/warehouse-transfers')
      .query({ pageSize: 1000 })
      .set(authHeaders())
      .expect(200);
    const mine = [ids.draft, ids.inTransit, ids.transferred];

    expect(idsInOrder(rowsOf(res.body), mine)).toEqual([
      ids.draft,
      ids.transferred,
      ids.inTransit,
    ]);
  });
});

describe('F8: inventory adjustments sorting (e2e)', () => {
  let older: number;
  let newer: number;

  beforeAll(async () => {
    await cancelTransactionsLock();
    const itemId = await createInventoryItem();
    // Another suite may have switched on multiple warehouses in this
    // company; then an adjustment needs a warehouse (that check now blocks).
    const warehouses = rowsOf(
      (await http().get('/warehouses').set(authHeaders())).body,
    );
    const warehouse =
      warehouses.find((w) => w.primary || w.is_primary) ?? warehouses[0];
    const create = async (date: string) => {
      const res = await http()
        .post('/inventory-adjustments/quick')
        .set(authHeaders())
        .send({
          date,
          type: 'increment',
          adjustmentAccountId: 1018,
          reason: 'List options e2e',
          referenceNo: faker.string.alphanumeric(8),
          itemId,
          quantity: 1,
          cost: 10,
          publish: true,
          ...(warehouse && { warehouseId: warehouse.id }),
        })
        .expect(201);
      return res.body.id as number;
    };
    older = await create('2026-01-10');
    newer = await create('2026-01-20');
  });

  it.each([
    ['asc', 'oldest first'],
    ['desc', 'newest first'],
  ])('sorts by date %s (%s)', async (sortOrder) => {
    const res = await http()
      .get('/inventory-adjustments')
      .query({ columnSortBy: 'date', sortOrder, pageSize: 1000 })
      .set(authHeaders())
      .expect(200);
    const expected = sortOrder === 'asc' ? [older, newer] : [newer, older];

    expect(idsInOrder(rowsOf(res.body), [older, newer])).toEqual(expected);
  });
});

describe('P8: Journal report account filter and amount range (e2e)', () => {
  // A random far-future day, so only this run's two journals are listed.
  const day = `${2040 + faker.number.int({ min: 0, max: 59 })}-${String(
    faker.number.int({ min: 1, max: 12 }),
  ).padStart(2, '0')}-${String(faker.number.int({ min: 1, max: 28 })).padStart(
    2,
    '0',
  )}`;
  const journal = (accountA: number, accountB: number, amount: number) =>
    http()
      .post('/manual-journals')
      .set(authHeaders())
      .send({
        date: day,
        journalNumber: `P8-${faker.string.alphanumeric(10)}`,
        publish: true,
        entries: [
          { index: 1, credit: amount, debit: 0, accountId: accountA },
          { index: 2, credit: 0, debit: amount, accountId: accountB },
        ],
      })
      .expect(201);

  const journalReport = (query: Record<string, unknown>) =>
    http()
      .get('/reports/journal')
      .query({ fromDate: day, toDate: day, ...query })
      .set(authHeaders())
      .set('Accept', 'application/json');

  const lines = (body: any) =>
    (body.data as any[]).flatMap((group) =>
      group.entries.map((entry) => ({
        account: entry.account_code,
        amount: Number(entry.credit) + Number(entry.debit),
      })),
    );

  beforeAll(async () => {
    await cancelTransactionsLock();
    // Petty Cash (10004) → Computer Equipment (10005), 1,500.
    await journal(1003, 1004, 1500);
    // Saving Bank Account (10002) → Computer Equipment (10005), 300.
    await journal(1001, 1004, 300);
  });

  it('without filters lists all four lines', async () => {
    const res = await journalReport({}).expect(200);
    expect(lines(res.body)).toHaveLength(4);
  });

  it('filters to one account', async () => {
    const res = await journalReport({ accountsIds: 1003 }).expect(200);
    expect(lines(res.body)).toEqual([{ account: '10004', amount: 1500 }]);
  });

  it('filters to several accounts', async () => {
    const res = await journalReport({ accountsIds: [1003, 1001] }).expect(200);
    expect(
      lines(res.body)
        .map((line) => line.account)
        .sort(),
    ).toEqual(['10002', '10004']);
  });

  it('applies "from" amount', async () => {
    const res = await journalReport({ fromRange: '1000' }).expect(200);
    const found = lines(res.body);
    expect(found).toHaveLength(2);
    expect(found.every((line) => line.amount === 1500)).toBe(true);
  });

  it('applies "to" amount', async () => {
    const res = await journalReport({ toRange: '1000' }).expect(200);
    const found = lines(res.body);
    expect(found).toHaveLength(2);
    expect(found.every((line) => line.amount === 300)).toBe(true);
  });

  it('applies the account filter and range together', async () => {
    const res = await journalReport({
      accountsIds: 1004,
      fromRange: '300',
      toRange: '300',
    }).expect(200);
    expect(lines(res.body)).toEqual([{ account: '10005', amount: 300 }]);
  });
});
