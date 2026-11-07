import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import {
  as,
  Company,
  createCompany,
  createRole,
  getTenantUserId,
  inviteAndAccept,
  uniqueEmail,
} from './_utils/security';
import { events } from '../src/common/events/events';
import { InvoicesActivateWarehousesSubscriber } from '../src/modules/Warehouses/subscribers/Activate/InvoiceWarehousesActivateSubscriber';
import { WarehousesItemsQuantitySync } from '../src/modules/Warehouses/Integrations/WarehousesItemsQuantitySync';
import { UnitOfWork } from '../src/modules/Tenancy/TenancyDB/UnitOfWork.service';

/**
 * Package 4 (round 3): warehouses and smaller fixes.
 * - Q1: turning on multiple warehouses is one save: a failed step changes
 *   nothing and can be retried.
 * - Q2: an unknown warehouse is refused with a 400.
 * - Q3: one stock row per item and warehouse, also when two first stock
 *   movements happen at once; the migration merges old duplicates.
 * - Q4: a failed customer or vendor edit changes nothing.
 * - Q5: activating an account writes its audit-log entry.
 * - Q7: a warehouse transfer accepts a numeric cost.
 * - Q8: the credit note import sample has a row, and it imports.
 * - Q9: bill landed cost from a service line can be saved and allocated,
 *   and freight is counted in stock once.
 * - Q11: the workspace list marks companies where the user is deactivated.
 * - Q12: the stale-journals repair lists and rewrites old credit note and
 *   opening-balance payment journals.
 * Runs in two new companies (one with warehouses on), so nothing shared is
 * touched.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n: number) => Math.round(n * 100) / 100;

const openDb = (organizationId: string): Knex => {
  const config = app.get(ConfigService).get('tenantDatabase');
  return knexFactory({
    client: config.client,
    connection: {
      host: config.host,
      port: Number(config.port),
      user: config.user,
      password: config.password,
      database: `${config.dbNamePrefix}${organizationId}`,
      charset: 'utf8',
      dateStrings: ['DATE'] as unknown as boolean,
    },
    pool: { min: 0, max: 2 },
    ...knexSnakeCaseMappers({ upperCase: true }),
  });
};

/** Runs the work inside the company's tenant context (as the CLI does). */
const inTenant = async <T>(company: Company, work: () => Promise<T>) => {
  const cls = app.get(ClsService);
  return cls.run(async () => {
    cls.set('organizationId', company.organizationId);
    cls.set('userId', company.owner.systemUserId);
    await cls.resolveProxyProviders();
    return work();
  });
};

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

const errorTypes = (res: any): string[] =>
  (res.body?.errors || []).map((e: any) => e.type);

/** Net (debit - credit) of the rows, by account. */
const netByAccount = (rows: any[]) =>
  rows.reduce(
    (acc, row) => {
      acc[row.accountId] = round(
        (acc[row.accountId] || 0) + Number(row.debit) - Number(row.credit),
      );
      return acc;
    },
    {} as Record<number, number>,
  );

describe('Warehouses and smaller fixes (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();

  // Company A: warehouses get turned on here.
  let whCompany: Company;
  let whDb: Knex;
  const wh = () => as(app, whCompany.owner, whCompany.organizationId);

  // Company B: no warehouses (the other items).
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);

  const accountsOf = async (knex: Knex) => {
    const byType = async (type: string) =>
      (await knex('accounts').where('accountType', type).first('id')).id;
    const bySlug = async (slug: string) =>
      (await knex('accounts').where({ slug }).first('id')).id;
    return {
      bank: await byType('bank'),
      income: await byType('income'),
      expense: await byType('expense'),
      cogs: await byType('cost-of-goods-sold'),
      inventory: await byType('inventory'),
      exchange: await bySlug('exchange-grain-loss'),
    };
  };
  let whAccounts: Awaited<ReturnType<typeof accountsOf>>;
  let accounts: Awaited<ReturnType<typeof accountsOf>>;

  const createItem = async (
    client: () => ReturnType<typeof api>,
    accs: Awaited<ReturnType<typeof accountsOf>>,
    type: 'inventory' | 'service' | 'non-inventory',
    extra: Record<string, any> = {},
  ) =>
    ok(
      await client()
        .post('/items')
        .send({
          name: `P4 ${type} ${tag} ${faker.string.alphanumeric(6)}`,
          type,
          sellable: true,
          purchasable: true,
          sellAccountId: accs.income,
          costAccountId: type === 'inventory' ? accs.cogs : accs.expense,
          ...(type === 'inventory' && { inventoryAccountId: accs.inventory }),
          sellPrice: 50,
          costPrice: 20,
          ...extra,
        }),
    ).body.id as number;

  const createVendor = async (
    client: () => ReturnType<typeof api>,
    extra: Record<string, any> = {},
  ) =>
    ok(
      await client()
        .post('/vendors')
        .send({
          displayName: `P4 vendor ${tag} ${faker.string.alphanumeric(6)}`,
          currencyCode: 'USD',
          ...extra,
        }),
    ).body.id as number;

  const createCustomer = async (
    client: () => ReturnType<typeof api>,
    extra: Record<string, any> = {},
  ) =>
    ok(
      await client()
        .post('/customers')
        .send({
          displayName: `P4 customer ${tag} ${faker.string.alphanumeric(6)}`,
          customerType: 'business',
          currencyCode: 'USD',
          ...extra,
        }),
    ).body.id as number;

  beforeAll(async () => {
    // The import files are stored under the static folder main.ts sets.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lega-p4-import-'));
    fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
    (global as any).__static_dirname = dir;

    whCompany = await createCompany(app, 'p4wh');
    whDb = openDb(whCompany.organizationId);
    whAccounts = await accountsOf(whDb);

    company = await createCompany(app, 'p4small');
    db = openDb(company.organizationId);
    accounts = await accountsOf(db);
  }, 600000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await whDb?.destroy();
    await db?.destroy();
  });

  // -------------------------------------------------------------------------
  // Q1, Q2, Q3, Q7: warehouses (company A).
  // -------------------------------------------------------------------------
  describe('warehouses', () => {
    let vendorId: number;
    let customerId: number;
    let stockItemId: number;
    let primaryWarehouseId: number;

    /** The primary warehouse (read, so a test doesn't depend on Q1). */
    const primaryWarehouse = async () =>
      (await whDb('warehouses').orderBy('id').first('id'))?.id as number;

    const warehousesFeature = async () => {
      const row = await whDb('settings')
        .where({ group: 'features', key: 'warehouses' })
        .first();
      return row ? String(row.value) : null;
    };

    beforeAll(async () => {
      vendorId = await createVendor(wh);
      customerId = await createCustomer(wh);
      stockItemId = await createItem(wh, whAccounts, 'inventory');

      // 10 bought, 3 sold: 7 in stock before warehouses are turned on.
      ok(
        await wh()
          .post('/bills')
          .send({
            vendorId,
            billDate: '2026-03-01',
            dueDate: '2026-03-31',
            billNumber: `P4-B-${faker.string.alphanumeric(8)}`,
            open: true,
            entries: [
              { index: 1, itemId: stockItemId, quantity: 10, rate: 20 },
            ],
          }),
      );
      ok(
        await wh()
          .post('/sale-invoices')
          .send({
            customerId,
            invoiceDate: '2026-03-05',
            dueDate: '2026-03-31',
            invoiceNo: `P4-I-${faker.string.alphanumeric(8)}`,
            delivered: true,
            entries: [{ index: 1, itemId: stockItemId, quantity: 3, rate: 50 }],
          }),
      );
    });

    it('Q1: a failed step leaves warehouses off with nothing changed', async () => {
      const spy = jest
        .spyOn(
          InvoicesActivateWarehousesSubscriber.prototype,
          'updateInvoicesWithWarehouseOnActivated',
        )
        .mockRejectedValueOnce(new Error('linking invoices failed'));
      try {
        const res = await wh().post('/warehouses/activate').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      // Let anything that was not awaited finish before looking.
      await sleep(500);

      expect([null, '0', 'false']).toContain(await warehousesFeature());
      expect(await whDb('warehouses').select('id')).toEqual([]);
      expect(await whDb('items_warehouses_quantity').select('*')).toEqual([]);
      const linked = await whDb('bills').whereNotNull('warehouseId');
      expect(linked).toEqual([]);
    });

    it('Q1: turning warehouses on again links every record', async () => {
      ok(await wh().post('/warehouses/activate').send({}));
      expect(['1', 'true']).toContain(await warehousesFeature());

      const warehouses = await whDb('warehouses').select('*');
      expect(warehouses).toHaveLength(1);
      primaryWarehouseId = warehouses[0].id;
      expect(Boolean(warehouses[0].primary)).toBe(true);

      for (const table of [
        'bills',
        'sales_invoices',
        'inventory_transactions',
      ]) {
        const unlinked = await whDb(table).whereNull('warehouseId');
        expect({ table, unlinked }).toEqual({ table, unlinked: [] });
      }
      const item = await whDb('items').where({ id: stockItemId }).first();
      const rows = await whDb('items_warehouses_quantity').where({
        itemId: stockItemId,
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].quantityOnHand)).toBe(7);
      expect(Number(item.quantityOnHand)).toBe(7);
    });

    it('Q2: saving with an unknown warehouse is a 400 "warehouse not found"', async () => {
      const res = await wh()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: '2026-03-10',
          dueDate: '2026-03-31',
          invoiceNo: `P4-I-${faker.string.alphanumeric(8)}`,
          delivered: true,
          warehouseId: 999999,
          entries: [{ index: 1, itemId: stockItemId, quantity: 1, rate: 50 }],
        });
      expect(res.status).toBe(400);
      expect(errorTypes(res)).toContain('WAREHOUSE_ID_NOT_FOUND');
    });

    it('Q3: two first stock movements at once give one row with both quantities', async () => {
      const newItemId = await createItem(wh, whAccounts, 'inventory');
      primaryWarehouseId = await primaryWarehouse();

      await inTenant(whCompany, async () => {
        const sync = await app.resolve(WarehousesItemsQuantitySync, undefined, {
          strict: false,
        });
        const uow = await app.resolve(UnitOfWork, undefined, { strict: false });
        const change = (amount: number) => ({
          itemId: newItemId,
          warehouseId: primaryWarehouseId,
          amount,
        });
        // Two movements in two transactions at the same moment.
        await Promise.all([
          uow.withTransaction((trx) =>
            sync.mutateWarehouseItemQuantity(change(2), trx),
          ),
          uow.withTransaction((trx) =>
            sync.mutateWarehouseItemQuantity(change(3), trx),
          ),
        ]);
        // And two in one transaction, sent together.
        await uow.withTransaction((trx) =>
          sync.mutateWarehousesItemsQuantity([change(4), change(1)], trx),
        );
      });
      const rows = await whDb('items_warehouses_quantity').where({
        itemId: newItemId,
        warehouseId: primaryWarehouseId,
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].quantityOnHand)).toBe(10);
    });

    it('Q3: the migration merges existing duplicates and adds the unique rule (down, up)', async () => {
      const migration = require('../src/database/tenant/migrations/20261107130000_unique_items_warehouses_quantity');
      const itemId = await createItem(wh, whAccounts, 'inventory');
      primaryWarehouseId = await primaryWarehouse();

      // Undo the migration, then make duplicates the old way.
      await migration.down(whDb);
      await whDb('items_warehouses_quantity').insert([
        { itemId, warehouseId: primaryWarehouseId, quantityOnHand: 4 },
        { itemId, warehouseId: primaryWarehouseId, quantityOnHand: 6.5 },
      ]);
      await migration.up(whDb);

      const rows = await whDb('items_warehouses_quantity').where({
        itemId,
        warehouseId: primaryWarehouseId,
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].quantityOnHand)).toBe(10.5);

      // A second row for the same item and warehouse is refused now.
      await expect(
        whDb('items_warehouses_quantity').insert({
          itemId,
          warehouseId: primaryWarehouseId,
          quantityOnHand: 1,
        }),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    });

    it('Q7: a warehouse transfer with a numeric cost is accepted', async () => {
      const second = ok(
        await wh()
          .post('/warehouses')
          .send({ name: `P4 second ${tag}`, code: `P4${tag}` }),
      ).body;
      const secondId = second.id ?? second.data?.id;
      expect(secondId).toBeTruthy();
      primaryWarehouseId = await primaryWarehouse();

      const res = await wh()
        .post('/warehouse-transfers')
        .send({
          fromWarehouseId: primaryWarehouseId,
          toWarehouseId: secondId,
          date: '2026-03-20',
          transactionNumber: `P4-T-${faker.string.alphanumeric(6)}`,
          entries: [{ index: 1, itemId: stockItemId, quantity: 1, cost: 12.5 }],
        });
      expect([200, 201]).toContain(res.status);
    });
  });

  // -------------------------------------------------------------------------
  // Q4, Q5: edits and activation are saved together (company B).
  // -------------------------------------------------------------------------
  describe('edits inside the save', () => {
    /** Makes the given "...edited" notice fail once. */
    const failNotice = (eventName: string) => {
      const original = EventEmitter2.prototype.emitAsync;
      return jest
        .spyOn(EventEmitter2.prototype, 'emitAsync')
        .mockImplementation(function (this: EventEmitter2, event, ...args) {
          if (event === eventName) {
            return Promise.reject(new Error(`${eventName} failed`));
          }
          return original.call(this, event, ...args);
        });
    };

    it('Q4: a failed customer edit leaves the customer unchanged', async () => {
      const customerId = await createCustomer(api);
      const before = await db('contacts').where({ id: customerId }).first();

      const spy = failNotice(events.customers.onEdited);
      try {
        const res = await api()
          .put(`/customers/${customerId}`)
          .send({ customerType: 'business', displayName: `Renamed ${tag}` });
        expect(res.status).toBeGreaterThanOrEqual(500);
      } finally {
        spy.mockRestore();
      }
      const after = await db('contacts').where({ id: customerId }).first();
      expect(after.displayName).toBe(before.displayName);
    });

    it('Q4: a failed vendor edit leaves the vendor unchanged', async () => {
      const vendorId = await createVendor(api);
      const before = await db('contacts').where({ id: vendorId }).first();

      const spy = failNotice(events.vendors.onEdited);
      try {
        const res = await api()
          .put(`/vendors/${vendorId}`)
          .send({ displayName: `Renamed ${tag}` });
        expect(res.status).toBeGreaterThanOrEqual(500);
      } finally {
        spy.mockRestore();
      }
      const after = await db('contacts').where({ id: vendorId }).first();
      expect(after.displayName).toBe(before.displayName);
    });

    it('Q5: activating and inactivating an account writes the audit-log entries', async () => {
      const accountId = ok(
        await api()
          .post('/accounts')
          .send({
            name: `P4 account ${tag}`,
            code: `P4${faker.string.numeric(4)}`,
            accountType: 'expense',
          }),
      ).body.id;

      ok(await api().post(`/accounts/${accountId}/inactivate`).send({}));
      ok(await api().post(`/accounts/${accountId}/activate`).send({}));
      await sleep(500);

      const logs = await db('audit_logs')
        .where({ subject: 'Account', subjectId: accountId })
        .whereIn('action', ['activated', 'inactivated'])
        .select('action');
      expect(logs.map((l) => l.action).sort()).toEqual([
        'activated',
        'inactivated',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Q8: the credit note import sample (company B).
  // -------------------------------------------------------------------------
  describe('Q8: credit note import sample', () => {
    it('has a header and a row, and imports one credit note', async () => {
      const res = ok(
        await api()
          .get('/import/sample')
          .query({ resource: 'credit_note', format: 'csv' }),
      );
      const csv: string = res.text;
      const lines = csv.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const header = lines[0].split(',');
      for (const column of ['Customer', 'Credit Note Date', 'Item', 'Rate']) {
        expect(header).toContain(column);
      }
      // The sample names a customer and an item: create them, then import.
      const sample = lines[1].split(',');
      const valueOf = (column: string) =>
        sample[header.indexOf(column)].replace(/^"|"$/g, '');
      await createCustomer(api, { displayName: valueOf('Customer') });
      await createItem(api, accounts, 'service', { name: valueOf('Item') });

      const upload = ok(
        await api()
          .post('/import/file')
          .field('resource', 'credit_note')
          .attach('file', Buffer.from(csv), 'credit_note.csv'),
      );
      const importId =
        upload.body.import?.import_id ??
        upload.body.import?.importId ??
        upload.body.import_id ??
        upload.body.importId;
      const mapping = [
        { from: 'Customer', to: 'customerId' },
        { from: 'Exchange Rate', to: 'exchangeRate' },
        { from: 'Credit Note Date', to: 'creditNoteDate' },
        { from: 'Reference No.', to: 'referenceNo' },
        { from: 'Note', to: 'note' },
        { from: 'Terms & Conditions', to: 'termsConditions' },
        { from: 'Credit Note Number', to: 'creditNoteNumber' },
        { from: 'Open', to: 'open' },
        { from: 'Item', to: 'itemId', group: 'entries' },
        { from: 'Rate', to: 'rate', group: 'entries' },
        { from: 'Quantity', to: 'quantity', group: 'entries' },
        { from: 'Description', to: 'description', group: 'entries' },
      ].filter((m) => header.includes(m.from));
      ok(await api().post(`/import/${importId}/mapping`).send({ mapping }));

      const before = await db('credit_notes').count({ n: '*' }).first();
      const result = ok(await api().post(`/import/${importId}/import`));
      const after = await db('credit_notes').count({ n: '*' }).first();
      expect(Number((after as any).n) - Number((before as any).n)).toBe(1);
      expect(
        result.body.success_count ?? result.body.successCount ?? 1,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // Q9: bill landed cost (company B).
  // -------------------------------------------------------------------------
  describe('Q9: bill landed cost', () => {
    let vendorId: number;
    let freightAccountId: number;
    let freightItemId: number;
    let stockItemId: number;

    const postBill = (entries: any[]) =>
      api()
        .post('/bills')
        .send({
          vendorId,
          billDate: '2026-04-01',
          dueDate: '2026-04-30',
          billNumber: `P4-LC-${faker.string.alphanumeric(8)}`,
          open: true,
          entries,
        });

    beforeAll(async () => {
      ok(
        await api()
          .put('/settings')
          .send({
            options: [{ group: 'features', key: 'landed_cost', value: 1 }],
          }),
      );
      vendorId = await createVendor(api);
      freightAccountId = ok(
        await api()
          .post('/accounts')
          .send({
            name: `P4 freight ${tag}`,
            code: `F${faker.string.numeric(5)}`,
            accountType: 'cost-of-goods-sold',
          }),
      ).body.id;
      freightItemId = await createItem(api, accounts, 'service', {
        costAccountId: freightAccountId,
      });
      stockItemId = await createItem(api, accounts, 'inventory');
    });

    it('allocates a 200 freight bill on a service line: stock +200 once, freight ends at 0', async () => {
      const freightBill = ok(
        await postBill([
          {
            index: 1,
            itemId: freightItemId,
            quantity: 1,
            rate: 200,
            landedCost: true,
          },
        ]),
      ).body.id;
      const targetBill = ok(
        await postBill([
          { index: 1, itemId: stockItemId, quantity: 10, rate: 100 },
        ]),
      ).body.id;

      // The freight bill is offered for allocation (the screens' list).
      const list = ok(
        await api()
          .get('/landed-cost/transactions')
          .query({ transactionType: 'Bill' }),
      ).body;
      const offered = list.find((t: any) => t.id === freightBill);
      expect(offered).toBeTruthy();
      expect(Number(offered.amount)).toBe(200);

      const freightEntry = await db('items_entries')
        .where({ referenceType: 'Bill', referenceId: freightBill })
        .first();
      const targetEntry = await db('items_entries')
        .where({ referenceType: 'Bill', referenceId: targetBill })
        .first();
      const allocated = ok(
        await api()
          .post(`/landed-cost/bills/${targetBill}/allocate`)
          .send({
            transactionId: freightBill,
            transactionType: 'Bill',
            transactionEntryId: freightEntry.id,
            allocationMethod: 'value',
            description: 'Ocean freight',
            items: [{ entryId: targetEntry.id, cost: 200 }],
          }),
      ).body.id;

      const rows = await db('accounts_transactions')
        .where((b) =>
          b
            .where((w) =>
              w
                .where('referenceType', 'Bill')
                .whereIn('referenceId', [freightBill, targetBill]),
            )
            .orWhere((w) =>
              w.where({ referenceType: 'LandedCost', referenceId: allocated }),
            ),
        )
        .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'));
      const net = netByAccount(rows);
      expect(net[accounts.inventory]).toBe(1200);
      expect(net[freightAccountId] ?? 0).toBe(0);
      expect(net[accounts.cogs] ?? 0).toBe(0);

      // The freight line is no stock of its own.
      const freightStock = await db('inventory_transactions').where({
        itemId: freightItemId,
      });
      expect(freightStock).toEqual([]);
      const bill = await db('bills').where({ id: freightBill }).first();
      expect(Number(bill.allocatedCostAmount)).toBe(200);
    });

    it('a non-inventory line can carry landed cost too', async () => {
      const nonInventoryId = await createItem(api, accounts, 'non-inventory', {
        costAccountId: freightAccountId,
      });
      ok(
        await postBill([
          {
            index: 1,
            itemId: nonInventoryId,
            quantity: 2,
            rate: 25,
            landedCost: true,
          },
        ]),
      );
    });

    it('an inventory line with landed cost is refused with a clear message', async () => {
      const res = await postBill([
        {
          index: 1,
          itemId: stockItemId,
          quantity: 1,
          rate: 200,
          landedCost: true,
        },
      ]);
      expect(res.status).toBe(400);
      expect(errorTypes(res)).toContain(
        'LANDED_COST_ENTRIES_SHOULD_NOT_BE_INVENTORY_ITEMS',
      );
      expect(res.body.errors[0].message).toMatch(/service or non-inventory/i);
    });

    it('editing a bill to put landed cost on an inventory line is refused', async () => {
      const billId = ok(
        await postBill([
          { index: 1, itemId: stockItemId, quantity: 1, rate: 10 },
        ]),
      ).body.id;
      const bill = ok(await api().get(`/bills/${billId}`)).body;
      const res = await api()
        .put(`/bills/${billId}`)
        .send({
          vendorId,
          billDate: '2026-04-01',
          dueDate: '2026-04-30',
          billNumber: bill.bill_number ?? bill.billNumber,
          open: true,
          entries: [
            {
              index: 1,
              id: bill.entries[0].id,
              itemId: stockItemId,
              quantity: 1,
              rate: 10,
              landedCost: true,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(errorTypes(res)).toContain(
        'LANDED_COST_ENTRIES_SHOULD_NOT_BE_INVENTORY_ITEMS',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Q11: deactivated companies in the workspace list (company B).
  // -------------------------------------------------------------------------
  describe('Q11: workspace list', () => {
    it('marks a company where the user is deactivated, and only that one', async () => {
      const roleId = await createRole(app, company, `P4 viewer ${tag}`, [
        { subject: 'Item', ability: 'View' },
      ]);
      const member = await inviteAndAccept(
        app,
        company,
        company.owner,
        uniqueEmail('p4member'),
        roleId,
      );
      // The member also belongs to company A, where they stay active.
      const whRoleId = await createRole(app, whCompany, `P4 viewer ${tag}`, [
        { subject: 'Item', ability: 'View' },
      ]);
      await inviteAndAccept(
        app,
        whCompany,
        whCompany.owner,
        member.email,
        whRoleId,
      );

      const tenantUserId = await getTenantUserId(
        app,
        company,
        member.systemUserId,
      );
      ok(await api().put(`/users/${tenantUserId}/inactivate`).send({}));

      const list = ok(
        await as(app, member, whCompany.organizationId).get('/workspaces'),
      ).body;
      const inB = list.find(
        (w: any) =>
          (w.organizationId ?? w.organization_id) === company.organizationId,
      );
      const inA = list.find(
        (w: any) =>
          (w.organizationId ?? w.organization_id) === whCompany.organizationId,
      );
      expect(inB).toBeTruthy();
      expect(inA).toBeTruthy();
      expect(inB.isUserInactive ?? inB.is_user_inactive).toBe(true);
      expect(inA.isUserInactive ?? inA.is_user_inactive).toBe(false);

      // The owner isn't deactivated anywhere.
      const ownerList = ok(
        await as(app, company.owner, company.organizationId).get('/workspaces'),
      ).body;
      for (const w of ownerList) {
        expect(w.isUserInactive ?? w.is_user_inactive).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Q12: stale journals left by PRs 14 and 17 (company B).
  // -------------------------------------------------------------------------
  describe('Q12: stale-journals repair', () => {
    let creditNoteId: number;
    let paymentId: number;
    let billPaymentId: number;
    let arAccountId: number;

    const ledgerOf = (referenceType: string, referenceId: number) =>
      db('accounts_transactions')
        .where({ referenceType, referenceId })
        .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'))
        .select('accountId', 'debit', 'credit', 'indexGroup');

    // Loaded lazily, so the other tests run on a branch without it.
    const repairService = () =>
      require('../src/modules/AccountingBasis/StaleJournalsRepair.service')
        .StaleJournalsRepairService;

    const scan = (): Promise<any[]> =>
      inTenant(company, async () => {
        const service = await app.resolve(repairService(), undefined, {
          strict: false,
        });
        return service.scan();
      });

    const repair = (): Promise<{
      repaired: any[];
      skipped: any[];
      failed: any[];
    }> =>
      inTenant(company, async () => {
        const service = await app.resolve(repairService(), undefined, {
          strict: false,
        });
        return service.repair();
      });

    beforeAll(async () => {
      await api()
        .post('/currencies')
        .send({ currencyCode: 'EUR', currencyName: 'Euro', currencySign: '€' });

      // A published credit note of 100, edited to 80 the old way: before
      // PR 14 the edit changed the credit note but kept the 100 journal.
      const customerId = await createCustomer(api);
      const serviceId = await createItem(api, accounts, 'service');
      creditNoteId = ok(
        await api()
          .post('/credit-notes')
          .send({
            customerId,
            creditNoteDate: '2026-05-01',
            creditNoteNumber: `P4-CN-${faker.string.alphanumeric(8)}`,
            open: true,
            entries: [{ index: 1, itemId: serviceId, quantity: 1, rate: 100 }],
          }),
      ).body.id;
      await db('items_entries')
        .where({ referenceType: 'CreditNote', referenceId: creditNoteId })
        .update({ rate: 80 });
      await db('credit_notes')
        .where({ id: creditNoteId })
        .update({ amount: 80 });

      // A EUR opening balance of 100 at 1.2, paid at 1.3, saved the old way
      // (before PR 17): A/R relieved at the payment rate, no gain line.
      const eurCustomerId = await createCustomer(api, {
        currencyCode: 'EUR',
        openingBalance: 100,
        openingBalanceAt: '2026-01-01',
        openingBalanceExchangeRate: 1.2,
      });
      paymentId = ok(
        await api()
          .post('/payments-received')
          .send({
            customerId: eurCustomerId,
            paymentDate: '2026-06-01',
            amount: 100,
            exchangeRate: 1.3,
            depositAccountId: accounts.bank,
            paymentReceiveNo: `P4-PR-${faker.string.alphanumeric(8)}`,
            entries: [
              { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
            ],
          }),
      ).body.id;
      arAccountId = (
        await db('accounts')
          .where({ accountType: 'accounts-receivable', currencyCode: 'EUR' })
          .first('id')
      ).id;
      await db('accounts_transactions')
        .where({ referenceType: 'PaymentReceive', referenceId: paymentId })
        .where('accountId', accounts.exchange)
        .delete();
      await db('accounts_transactions')
        .where({ referenceType: 'PaymentReceive', referenceId: paymentId })
        .where('accountId', arAccountId)
        .where('credit', '>', 0)
        .update({ credit: 130 });

      // The same for a vendor: A/P relieved at 1.3, no loss line.
      const eurVendorId = await createVendor(api, {
        currencyCode: 'EUR',
        openingBalance: 100,
        openingBalanceAt: '2026-01-01',
        openingBalanceExchangeRate: 1.2,
      });
      billPaymentId = ok(
        await api()
          .post('/bill-payments')
          .send({
            vendorId: eurVendorId,
            paymentDate: '2026-06-01',
            amount: 100,
            exchangeRate: 1.3,
            paymentAccountId: accounts.bank,
            paymentNumber: `P4-BP-${faker.string.alphanumeric(8)}`,
            entries: [
              { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
            ],
          }),
      ).body.id;
      const apAccountId = (
        await db('accounts')
          .where({ accountType: 'accounts-payable', currencyCode: 'EUR' })
          .first('id')
      ).id;
      await db('accounts_transactions')
        .where({ referenceType: 'BillPayment', referenceId: billPaymentId })
        .where('accountId', accounts.exchange)
        .delete();
      await db('accounts_transactions')
        .where({ referenceType: 'BillPayment', referenceId: billPaymentId })
        .where('accountId', apAccountId)
        .where('debit', '>', 0)
        .update({ debit: 130 });
    }, 300000);

    it('the dry run lists them and changes nothing', async () => {
      const before = await db('accounts_transactions')
        .count({ n: '*' })
        .first();
      const found = await scan();
      const keys = found.map((f) => `${f.referenceType}#${f.referenceId}`);
      expect(keys).toEqual(
        expect.arrayContaining([
          `CreditNote#${creditNoteId}`,
          `PaymentReceive#${paymentId}`,
          `BillPayment#${billPaymentId}`,
        ]),
      );
      expect(found.every((f) => !f.locked)).toBe(true);
      const after = await db('accounts_transactions').count({ n: '*' }).first();
      expect(after).toEqual(before);
    });

    it('a locked period is listed and skipped', async () => {
      ok(
        await api().put('/transactions-locking/lock').send({
          module: 'all',
          lockToDate: '2026-05-15',
          reason: 'p4 lock',
        }),
      );
      try {
        const found = await scan();
        const credit = found.find(
          (f) =>
            f.referenceType === 'CreditNote' && f.referenceId === creditNoteId,
        );
        expect(credit?.locked).toBe(true);

        const result = await repair();
        expect(
          result.skipped.map((f) => `${f.referenceType}#${f.referenceId}`),
        ).toContain(`CreditNote#${creditNoteId}`);
        // The payments are dated after the lock: they are rewritten.
        expect(
          result.repaired.map((f) => `${f.referenceType}#${f.referenceId}`),
        ).toEqual(
          expect.arrayContaining([
            `PaymentReceive#${paymentId}`,
            `BillPayment#${billPaymentId}`,
          ]),
        );
        // Still the old 100 journal.
        const net = netByAccount(await ledgerOf('CreditNote', creditNoteId));
        expect(net[accounts.income]).toBe(100);
      } finally {
        await api()
          .put('/transactions-locking/cancel-lock')
          .send({ module: 'all', reason: 'p4 unlock' });
      }
    });

    it('a real run rewrites them, and a second scan finds nothing', async () => {
      // The payments were rewritten by the run above (outside the lock);
      // the credit note is rewritten once the period is open again.
      const result = await repair();
      const keys = result.repaired.map(
        (f) => `${f.referenceType}#${f.referenceId}`,
      );
      expect(keys).toContain(`CreditNote#${creditNoteId}`);
      expect(result.failed).toEqual([]);

      const credit = netByAccount(await ledgerOf('CreditNote', creditNoteId));
      expect(credit[accounts.income]).toBe(80);

      const payment = netByAccount(await ledgerOf('PaymentReceive', paymentId));
      expect(payment[accounts.bank]).toBe(130);
      expect(payment[arAccountId]).toBe(-120);
      expect(payment[accounts.exchange]).toBe(-10);

      const billPayment = netByAccount(
        await ledgerOf('BillPayment', billPaymentId),
      );
      expect(billPayment[accounts.bank]).toBe(-130);
      expect(billPayment[accounts.exchange]).toBe(10);

      const again = await scan();
      expect(
        again.filter((f) =>
          [creditNoteId, paymentId, billPaymentId].includes(f.referenceId),
        ),
      ).toEqual([]);
    });
  });
});
