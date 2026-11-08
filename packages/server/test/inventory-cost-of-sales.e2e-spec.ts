import request = require('supertest');
import * as moment from 'moment';
import { faker } from '@faker-js/faker';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { app, orgainzationId, useCompany } from './init-app-test';
import { createCompany } from './_utils/security';
import {
  authHeaders,
  createCustomer,
  createTaxRate,
  createVendor,
} from './_utils/gl';
import { closeTenantKnex, getTenantKnex } from './_utils/money-matrix';
import { ComputeItemCostQueue } from '../src/modules/InventoryCost/types/InventoryCost.types';
import { CashBasisAutoRebuildService } from '../src/modules/AccountingBasis/CashBasisAutoRebuild.service';
import { CASH_BASIS_REBUILD_QUEUE } from '../src/modules/AccountingBasis/AccountingBasis.constants';
import {
  checkMoneyHealth,
  isMoneyHealthClean,
} from '../src/modules/AccountingBasis/MoneyHealthCheck';

/**
 * Package 3: inventory quantities and cost of sales (I1-I7, P6, P7, P11).
 *
 * Each case uses its own item with its own inventory and cost of sales
 * accounts, so an account balance is that item's stock value or cost of
 * sales. The cost of sales is worked out by a background job (debounced
 * about 10 seconds); `settleCostJobs` waits until no job is left.
 *
 * Run it against a test company of its own, with a queue prefix of its own
 * so other servers on the same Redis don't take its jobs:
 *   E2E_EMAIL=... E2E_PASSWORD=... QUEUE_PREFIX=... pnpm test:e2e -- inventory-cost-of-sales
 */
// The cases build on each other's documents, so a retry would only repeat
// a failure on dirtier data.
jest.retryTimes(0);

const YEAR = 2042;
const day = (monthDay: string) => `${YEAR}-${monthDay}`;

const api = () => request(app.getHttpServer());
const post = (url: string, body: any) =>
  api().post(url).set(authHeaders()).send(body);
const put = (url: string, body: any = {}) =>
  api().put(url).set(authHeaders()).send(body);
const del = (url: string) => api().delete(url).set(authHeaders());

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Waits until the cost compute queue has no job left (twice in a row). */
const settleCostJobs = async (timeoutMs = 120000) => {
  const queue = app.get<Queue>(getQueueToken(ComputeItemCostQueue));
  const started = Date.now();
  let idleChecks = 0;

  // Let the jobs scheduled after the transaction commit be added first.
  await new Promise((resolve) => setTimeout(resolve, 500));

  while (Date.now() - started < timeoutMs) {
    const counts = await queue.getJobCounts(
      'waiting',
      'delayed',
      'active',
      'prioritized',
      'waiting-children',
    );
    const pending = Object.values(counts).reduce((a, b) => a + b, 0);
    idleChecks = pending === 0 ? idleChecks + 1 : 0;
    if (idleChecks >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('The cost compute jobs did not finish in time.');
};

const createAccount = async (accountType: string, name: string) => {
  const res = await post('/accounts', {
    name: `${name} ${faker.string.alphanumeric(8)}`,
    code: faker.string.numeric(6),
    accountType,
  }).expect(201);
  return res.body.id as number;
};

interface TestItem {
  id: number;
  inventoryAccountId: number;
  costAccountId: number;
}

/** An inventory item with its own stock and cost of sales accounts. */
const createInventoryItem = async (): Promise<TestItem> => {
  const inventoryAccountId = await createAccount('inventory', 'Stock');
  const costAccountId = await createAccount('cost-of-goods-sold', 'COGS');
  const res = await post('/items', {
    name: `Inventory ${Date.now()}-${faker.string.alphanumeric(6)}`,
    type: 'inventory',
    sellable: true,
    purchasable: true,
    sellAccountId: 1026,
    costAccountId,
    inventoryAccountId,
    costPrice: 10,
    sellPrice: 20,
  }).expect(201);
  return { id: parseInt(res.body.id, 10), inventoryAccountId, costAccountId };
};

const createServiceItem = async () => {
  const res = await post('/items', {
    name: `Service ${Date.now()}-${faker.string.alphanumeric(6)}`,
    type: 'service',
    sellable: true,
    purchasable: true,
    sellAccountId: 1026,
    costAccountId: 1021,
    costPrice: 10,
    sellPrice: 20,
  }).expect(201);
  return parseInt(res.body.id, 10);
};

/** The balance (debit - credit) of an account on the given basis. */
const accountBalance = async (
  accountId: number,
  basis: 'accrual' | 'cash' = 'accrual',
) => {
  const row: any = await getTenantKnex()('accounts_transactions')
    .where('account_id', accountId)
    .where((builder) => builder.whereNull('basis').orWhere('basis', basis))
    .select(getTenantKnex().raw('COALESCE(SUM(debit - credit), 0) as balance'))
    .first();
  return round(Number(row.balance));
};

const itemQuantity = async (itemId: number) => {
  const row: any = await getTenantKnex()('items')
    .where('id', itemId)
    .first('quantity_on_hand');
  return round(Number(row.quantityOnHand));
};

const warehouseQuantities = async (itemId: number) => {
  const rows: any[] = await getTenantKnex()('items_warehouses_quantity')
    .where('item_id', itemId)
    .select('warehouse_id', 'quantity_on_hand');
  return Object.fromEntries(
    rows.map((row) => [row.warehouseId, round(Number(row.quantityOnHand))]),
  );
};

const costLots = (itemId: number) =>
  getTenantKnex()('inventory_cost_lot_tracker')
    .where('item_id', itemId)
    .orderBy(['date', 'id']);

/** Every entry set of the company balances (debits equal credits). */
const expectLedgerBalanced = async () => {
  const rows: any[] = await getTenantKnex()('accounts_transactions')
    .groupBy('reference_type', 'reference_id', 'basis')
    .select('reference_type', 'reference_id', 'basis')
    .select(getTenantKnex().raw('SUM(debit) as debit, SUM(credit) as credit'));
  const unbalanced = rows.filter(
    (row) => Math.abs(Number(row.debit) - Number(row.credit)) > 0.004,
  );
  expect(unbalanced).toEqual([]);
};

let vendorId: number;
let customerId: number;
// Multi-warehouses are on for the whole suite (the transfers need them).
let mainId: number;
let branchId: number;
let bankAccountId: number;

const billBody = (entries: any[], extra: any = {}) => ({
  vendorId,
  billDate: day('01-01'),
  dueDate: day('12-31'),
  billNumber: `B-${faker.string.alphanumeric(10)}`,
  open: true,
  entries: entries.map((entry, index) => ({ index: index + 1, ...entry })),
  warehouseId: mainId,
  ...extra,
});

const invoiceBody = (entries: any[], extra: any = {}) => ({
  customerId,
  invoiceDate: day('06-01'),
  dueDate: day('12-31'),
  invoiceNo: `I-${faker.string.alphanumeric(10)}`,
  delivered: true,
  entries: entries.map((entry, index) => ({ index: index + 1, ...entry })),
  warehouseId: mainId,
  ...extra,
});

const createBill = async (entries: any[], extra: any = {}) => {
  const body = billBody(entries, extra);
  const res = await post('/bills', body).expect(201);
  return { id: res.body.id as number, body };
};

const createInvoice = async (entries: any[], extra: any = {}) => {
  const body = invoiceBody(entries, extra);
  const res = await post('/sale-invoices', body).expect(201);
  return { id: res.body.id as number, body };
};

// Its own company: it turns multi-warehouse on, which would break the files
// that run after it in the shared test company (WAREHOUSE_ID_NOT_FOUND).
beforeAll(async () => {
  const company = await createCompany(app, 'invcos');
  useCompany(
    company.organizationId,
    company.owner.token,
    company.owner.systemUserId,
  );
}, 300000);

describe('Inventory quantities and cost of sales (e2e)', () => {
  beforeAll(async () => {
    vendorId = await createVendor('USD');
    customerId = await createCustomer('USD');

    await post('/warehouses/activate', {});
    const warehouses = await api()
      .get('/warehouses')
      .set(authHeaders())
      .expect(200);
    const list = warehouses.body.data || warehouses.body;
    mainId = (list.find((w: any) => w.primary) || list[0]).id;
    const other =
      list.find((w: any) => w.id !== mainId) ||
      (
        await post('/warehouses', {
          name: `Branch ${faker.string.alphanumeric(6)}`,
          code: faker.string.alphanumeric(5).toUpperCase(),
        }).expect(201)
      ).body;
    branchId = other.id;
    bankAccountId = (
      await getTenantKnex()('accounts')
        .where('accountType', 'bank')
        .orderBy('id')
        .first('id')
    ).id;
  });

  afterAll(async () => {
    await closeTenantKnex();
  });

  describe('I3: stock cost excludes VAT and includes discounts', () => {
    let tax10: number;

    beforeAll(async () => {
      tax10 = await createTaxRate(10);
    });

    const buyAndSellAll = async (
      entry: any,
      billExtra: any,
      expectedStock: number,
    ) => {
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, ...entry }], billExtra);
      await settleCostJobs();

      expect(await accountBalance(item.inventoryAccountId)).toBe(expectedStock);
      const lots = await costLots(item.id);
      expect(round(Number(lots[0].cost))).toBe(expectedStock);

      await createInvoice([
        { itemId: item.id, quantity: entry.quantity, rate: 999 },
      ]);
      await settleCostJobs();

      expect(await accountBalance(item.costAccountId)).toBe(expectedStock);
      expect(await accountBalance(item.inventoryAccountId)).toBe(0);
    };

    it('tax inclusive: 10 x 110 incl. 10% puts 1,000 into stock and ends at 0', () =>
      buyAndSellAll(
        { quantity: 10, rate: 110, taxRateId: tax10 },
        { isInclusiveTax: true },
        1000,
      ));

    it('tax exclusive: 10 x 100 + 10% puts 1,000 into stock and ends at 0', () =>
      buyAndSellAll(
        { quantity: 10, rate: 100, taxRateId: tax10 },
        { isInclusiveTax: false },
        1000,
      ));

    it('10% line discount: 10 x 100 puts 900 into stock and ends at 0', () =>
      buyAndSellAll(
        { quantity: 10, rate: 100, discount: 10, discountType: 'percentage' },
        {},
        900,
      ));

    it('fixed line discount: 10 x 100 less 50 puts 950 into stock and ends at 0', () =>
      buyAndSellAll(
        { quantity: 10, rate: 100, discount: 50, discountType: 'amount' },
        {},
        950,
      ));

    it('3 x 33.333 (99.999 -> 100.00) matches the ledger to the cent', () =>
      buyAndSellAll({ quantity: 3, rate: 33.333 }, {}, 100));

    it('30 units for 100.00 (3.3333... each): stock ends at 0.00, cost of sales 100.00', () =>
      buyAndSellAll({ quantity: 30, rate: 3.333333 }, {}, 100));

    it('every ledger row is in whole cents', async () => {
      const rows: any[] = await getTenantKnex()('accounts_transactions')
        .whereRaw('ROUND(debit, 2) <> debit OR ROUND(credit, 2) <> credit')
        .select('id');
      expect(rows).toEqual([]);
    });

    it('a foreign currency bill: lot cost equals the ledger stock amount', async () => {
      const eurVendor = await createVendor('EUR');
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, quantity: 3, rate: 33.33 }], {
        vendorId: eurVendor,
        exchangeRate: 1.2345678,
      });
      await settleCostJobs();

      // EUR 99.99 x 1.2345678 = 123.4444... -> 123.44.
      expect(await accountBalance(item.inventoryAccountId)).toBe(123.44);
      const lots = await costLots(item.id);
      expect(round(Number(lots[0].cost))).toBe(123.44);

      await createInvoice([{ itemId: item.id, quantity: 3, rate: 50 }]);
      await settleCostJobs();
      expect(await accountBalance(item.inventoryAccountId)).toBe(0);
    });
  });

  describe('I2: re-saving a document leaves stock unchanged', () => {
    it.each([1, 2, 5])(
      'a re-saved %i-line invoice and bill keep the stock',
      async (linesCount) => {
        const items = await Promise.all(
          Array.from({ length: linesCount }, () => createInventoryItem()),
        );
        const bill = await createBill(
          items.map((item) => ({ itemId: item.id, quantity: 30, rate: 10 })),
        );
        const invoice = await createInvoice(
          items.map((item, i) => ({
            itemId: item.id,
            quantity: i + 1.5,
            rate: 20,
          })),
        );
        const before = await Promise.all(items.map((i) => itemQuantity(i.id)));
        expect(before).toEqual(items.map((_, i) => round(30 - (i + 1.5))));

        await put(`/sale-invoices/${invoice.id}`, invoice.body).expect(200);
        await put(`/sale-invoices/${invoice.id}`, invoice.body).expect(200);
        await put(`/bills/${bill.id}`, bill.body).expect(200);

        const after = await Promise.all(items.map((i) => itemQuantity(i.id)));
        expect(after).toEqual(before);
      },
    );

    it('an edit that removes every stock line puts the items back once', async () => {
      const chair = await createInventoryItem();
      const table = await createInventoryItem();
      const serviceId = await createServiceItem();
      await createBill([
        { itemId: chair.id, quantity: 25, rate: 10 },
        { itemId: table.id, quantity: 13, rate: 10 },
      ]);
      const invoice = await createInvoice([
        { itemId: chair.id, quantity: 5, rate: 20 },
        { itemId: table.id, quantity: 3, rate: 20 },
      ]);
      expect(await itemQuantity(chair.id)).toBe(20);
      expect(await itemQuantity(table.id)).toBe(10);

      await put(`/sale-invoices/${invoice.id}`, {
        ...invoice.body,
        entries: [{ index: 1, itemId: serviceId, quantity: 1, rate: 100 }],
      }).expect(200);

      expect(await itemQuantity(chair.id)).toBe(25);
      expect(await itemQuantity(table.id)).toBe(13);
      await settleCostJobs();
      expect(await accountBalance(chair.costAccountId)).toBe(0);
    });
  });

  describe('I1: back-dated cost recalculation is kept', () => {
    it('an invoice moved from June to January is costed from January', async () => {
      const item = await createInventoryItem();
      // 10 at 10 in January, 10 at 30 in March.
      await createBill([{ itemId: item.id, quantity: 10, rate: 10 }], {
        billDate: day('01-01'),
      });
      await createBill([{ itemId: item.id, quantity: 10, rate: 30 }], {
        billDate: day('03-01'),
      });
      const invoice = await createInvoice(
        [{ itemId: item.id, quantity: 4, rate: 50 }],
        { invoiceDate: day('06-01') },
      );
      await settleCostJobs();
      // June: average of 20 units worth 400 -> 4 x 20.
      expect(await accountBalance(item.costAccountId)).toBe(80);

      await put(`/sale-invoices/${invoice.id}`, {
        ...invoice.body,
        invoiceDate: day('01-15'),
      }).expect(200);
      await settleCostJobs();

      // January: only the 10 at 10 -> 4 x 10, dated January.
      const rows: any[] = await getTenantKnex()('accounts_transactions')
        .where('account_id', item.costAccountId)
        .select('date', 'debit', 'credit');
      expect(rows).toHaveLength(1);
      expect(moment(rows[0].date).format('YYYY-MM-DD')).toBe(day('01-15'));
      expect(await accountBalance(item.costAccountId)).toBe(40);
      expect(await accountBalance(item.inventoryAccountId)).toBe(360);
    });
  });

  describe('I4: customer returns go back into stock at cost', () => {
    const setup = async () => {
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, quantity: 10, rate: 50 }], {
        billDate: day('01-01'),
      });
      await createInvoice([{ itemId: item.id, quantity: 2, rate: 100 }], {
        invoiceDate: day('02-01'),
      });
      return item;
    };
    const creditNoteBody = (itemId: number, quantity: number) => ({
      customerId,
      creditNoteDate: day('03-01'),
      creditNoteNumber: `CN-${faker.string.alphanumeric(10)}`,
      open: true,
      warehouseId: mainId,
      entries: [{ index: 1, itemId, quantity, rate: 100 }],
    });

    it('a full, a partial and an edited return, then delete', async () => {
      const item = await setup();
      const body = creditNoteBody(item.id, 2);
      const res = await post('/credit-notes', body).expect(201);
      await settleCostJobs();

      expect(await itemQuantity(item.id)).toBe(10);
      expect(await accountBalance(item.inventoryAccountId)).toBe(500);
      expect(await accountBalance(item.costAccountId)).toBe(0);
      const [ret] = (await costLots(item.id)).filter(
        (l: any) => l.transactionType === 'CreditNote',
      );
      expect(round(Number(ret.cost))).toBe(100);

      // Edit to a partial return of 0.5.
      await put(
        `/credit-notes/${res.body.id}`,
        creditNoteBody(item.id, 0.5),
      ).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(8.5);
      expect(await accountBalance(item.inventoryAccountId)).toBe(425);
      expect(await accountBalance(item.costAccountId)).toBe(75);

      await del(`/credit-notes/${res.body.id}`).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(8);
      expect(await accountBalance(item.inventoryAccountId)).toBe(400);
      expect(await accountBalance(item.costAccountId)).toBe(100);
      await expectLedgerBalanced();
    });
  });

  describe('I5, I6, P11: stock adjustments', () => {
    const adjustmentBody = (itemId: number, extra: any) => ({
      date: day('04-01'),
      type: 'decrement',
      adjustmentAccountId: lossAccountId,
      reason: 'Damaged',
      referenceNo: `ADJ-${faker.string.alphanumeric(8)}`,
      itemId,
      quantity: 5,
      publish: true,
      warehouseId: mainId,
      ...extra,
    });
    let lossAccountId: number;

    beforeAll(async () => {
      lossAccountId = await createAccount('expense', 'Stock loss');
    });

    const setup = async () => {
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, quantity: 100, rate: 50 }], {
        billDate: day('01-01'),
      });
      return item;
    };

    it('a published decrease writes off its cost; deleting reverses it', async () => {
      const item = await setup();
      const before = await accountBalance(lossAccountId);
      const res = await post(
        '/inventory-adjustments/quick',
        adjustmentBody(item.id, {}),
      ).expect(201);
      await settleCostJobs();

      expect(await itemQuantity(item.id)).toBe(95);
      expect(await accountBalance(item.inventoryAccountId)).toBe(4750);
      expect(await accountBalance(lossAccountId)).toBe(round(before + 250));

      // Edit: write off 2.5 instead (decimal quantity, P11).
      await put(
        `/inventory-adjustments/${res.body.id}`,
        adjustmentBody(item.id, { quantity: 2.5 }),
      ).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(97.5);
      const entry: any = await getTenantKnex()('inventory_adjustments_entries')
        .where('adjustment_id', res.body.id)
        .first();
      expect(Number(entry.quantity)).toBe(2.5);
      expect(await accountBalance(item.inventoryAccountId)).toBe(4875);
      expect(await accountBalance(lossAccountId)).toBe(round(before + 125));

      await del(`/inventory-adjustments/${res.body.id}`).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(100);
      expect(await accountBalance(item.inventoryAccountId)).toBe(5000);
      expect(await accountBalance(lossAccountId)).toBe(before);
      await expectLedgerBalanced();
    });

    it('a draft moves no stock; publishing it does; deleting it restores', async () => {
      const item = await setup();
      const before = await accountBalance(lossAccountId);
      const res = await post(
        '/inventory-adjustments/quick',
        adjustmentBody(item.id, { publish: false }),
      ).expect(201);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(100);
      expect(await accountBalance(lossAccountId)).toBe(before);

      await put(`/inventory-adjustments/${res.body.id}/publish`).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(95);
      expect(await accountBalance(item.inventoryAccountId)).toBe(4750);
      expect(await accountBalance(lossAccountId)).toBe(round(before + 250));

      await del(`/inventory-adjustments/${res.body.id}`).expect(200);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(100);
      expect(await accountBalance(lossAccountId)).toBe(before);
    });

    it('deleting a draft leaves stock unchanged', async () => {
      const item = await setup();
      const res = await post(
        '/inventory-adjustments/quick',
        adjustmentBody(item.id, { publish: false }),
      ).expect(201);
      await del(`/inventory-adjustments/${res.body.id}`).expect(200);
      expect(await itemQuantity(item.id)).toBe(100);
    });

    it('an increase is unchanged (2.5 units at 40)', async () => {
      const item = await setup();
      await post(
        '/inventory-adjustments/quick',
        adjustmentBody(item.id, { type: 'increment', quantity: 2.5, cost: 40 }),
      ).expect(201);
      await settleCostJobs();
      expect(await itemQuantity(item.id)).toBe(102.5);
      expect(await accountBalance(item.inventoryAccountId)).toBe(5100);
    });
  });

  describe('I7, P11: moving stock between warehouses keeps its value', () => {
    const transferBody = (itemId: number, quantity: number, cost?: number) => ({
      fromWarehouseId: mainId,
      toWarehouseId: branchId,
      date: day('05-01'),
      transactionNumber: `WT-${faker.string.alphanumeric(10)}`,
      transferInitiated: true,
      transferDelivered: true,
      entries: [
        {
          index: 1,
          itemId,
          quantity,
          // The DTO takes the cost as a decimal string.
          ...(cost !== undefined ? { cost: String(cost) } : {}),
        },
      ],
    });

    it.each([
      ['no cost', undefined],
      ['a wrong cost', 250],
    ])('a transfer with %s keeps the stock value', async (_label, cost) => {
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, quantity: 10, rate: 100 }], {
        billDate: day('01-01'),
        warehouseId: mainId,
      });
      const res = await post(
        '/warehouse-transfers',
        transferBody(item.id, 10, cost),
      ).expect(201);
      await settleCostJobs();

      const lots = (await costLots(item.id)).filter(
        (l: any) => l.transactionType === 'WarehouseTransfer',
      );
      const inLot = lots.find((l: any) => l.direction === 'IN');
      const outLot = lots.find((l: any) => l.direction === 'OUT');
      expect(round(Number(inLot.cost))).toBe(1000);
      expect(round(Number(outLot.cost))).toBe(1000);

      // Re-saving the 1-line transfer keeps the warehouses' stock (I2).
      await put(
        `/warehouse-transfers/${res.body.id}`,
        transferBody(item.id, 10, cost),
      ).expect(200);
      expect(await warehouseQuantities(item.id)).toEqual({
        [mainId]: 0,
        [branchId]: 10,
      });

      await createInvoice([{ itemId: item.id, quantity: 10, rate: 150 }], {
        invoiceDate: day('06-01'),
        warehouseId: branchId,
      });
      await settleCostJobs();
      expect(await accountBalance(item.costAccountId)).toBe(1000);
      expect(await accountBalance(item.inventoryAccountId)).toBe(0);
    });

    it('a back-dated bill re-works both sides; 2.5 units keep their decimals', async () => {
      const item = await createInventoryItem();
      await createBill([{ itemId: item.id, quantity: 10, rate: 100 }], {
        billDate: day('01-01'),
        warehouseId: mainId,
      });
      await post('/warehouse-transfers', transferBody(item.id, 2.5)).expect(
        201,
      );
      await settleCostJobs();
      expect(await warehouseQuantities(item.id)).toEqual({
        [mainId]: 7.5,
        [branchId]: 2.5,
      });

      // Back-dated: 10 more at 300 in February -> average 200.
      await createBill([{ itemId: item.id, quantity: 10, rate: 300 }], {
        billDate: day('02-01'),
        warehouseId: mainId,
      });
      await settleCostJobs();
      const lots = (await costLots(item.id)).filter(
        (l: any) => l.transactionType === 'WarehouseTransfer',
      );
      expect(lots.map((l: any) => round(Number(l.cost)))).toEqual([500, 500]);
      expect(await accountBalance(item.inventoryAccountId)).toBe(4000);
    });
  });

  describe('P7: landed cost', () => {
    let freightAccountId: number;

    beforeAll(async () => {
      await put('/settings', {
        options: [{ group: 'features', key: 'landed_cost', value: 1 }],
      });
      freightAccountId = await createAccount('cost-of-goods-sold', 'Freight');
    });

    const setup = async () => {
      const item = await createInventoryItem();
      // A landed cost line is a service line (decision D7): its cost
      // account is moved into the target's stock.
      const freightItemId = await createServiceItem();
      const target = await createBill(
        [{ itemId: item.id, quantity: 10, rate: 100 }],
        { billDate: day('07-01') },
      );
      const freight = await createBill(
        [
          {
            itemId: freightItemId,
            quantity: 1,
            rate: 2000,
            costAccountId: freightAccountId,
            landedCost: true,
          },
        ],
        { billDate: day('07-01') },
      );
      const entryOf = async (billId: number) =>
        (await api().get(`/bills/${billId}`).set(authHeaders()).expect(200))
          .body.entries[0].id;
      await post(`/landed-cost/bills/${target.id}/allocate`, {
        transactionId: freight.id,
        transactionType: 'Bill',
        transactionEntryId: await entryOf(freight.id),
        allocationMethod: 'value',
        description: 'Freight',
        items: [{ entryId: await entryOf(target.id), cost: 2000 }],
      }).expect(201);
      await settleCostJobs();
      return { item, target, freight };
    };

    it('re-saving the target bill does not count the landed cost twice', async () => {
      const { item, target } = await setup();
      expect(await accountBalance(item.inventoryAccountId)).toBe(3000);

      await put(`/bills/${target.id}`, target.body).expect(200);
      await settleCostJobs();
      expect(await accountBalance(item.inventoryAccountId)).toBe(3000);
      await expectLedgerBalanced();
    });

    it('an unpaid freight bill shows no landed cost on cash basis until paid', async () => {
      const { item, freight } = await setup();
      expect(await accountBalance(item.inventoryAccountId, 'accrual')).toBe(
        3000,
      );
      expect(await accountBalance(item.inventoryAccountId, 'cash')).toBe(0);

      const pay = (amount: number, date: string) =>
        post('/bill-payments', {
          vendorId,
          paymentAccountId: bankAccountId,
          paymentDate: date,
          paymentNumber: `P-${faker.string.alphanumeric(10)}`,
          entries: [{ billId: freight.id, paymentAmount: amount }],
        }).expect(201);

      await pay(500, day('08-01'));
      expect(await accountBalance(item.inventoryAccountId, 'cash')).toBe(500);
      const second = await pay(1500, day('09-01'));
      expect(await accountBalance(item.inventoryAccountId, 'cash')).toBe(2000);

      await del(`/bill-payments/${second.body.id}`).expect(200);
      expect(await accountBalance(item.inventoryAccountId, 'cash')).toBe(500);
      await expectLedgerBalanced();
    });
  });

  describe('P6: the cash basis rebuild runs by itself', () => {
    it('a flagged company is rebuilt and the flag cleared; a second run changes nothing', async () => {
      const knex = getTenantKnex();
      const service = app.get(CashBasisAutoRebuildService);
      const rebuildQueue = app.get<Queue>(
        getQueueToken(CASH_BASIS_REBUILD_QUEUE),
      );
      const flag = { group: 'accounting_basis', key: 'cash_rebuild_needed' };

      const cashRows = () =>
        knex('accounts_transactions')
          .where('basis', 'cash')
          .orderBy([
            'reference_type',
            'reference_id',
            'account_id',
            'debit',
            'credit',
          ])
          .select(
            'reference_type',
            'reference_id',
            'account_id',
            'debit',
            'credit',
            'date',
          );

      const runOnce = async () => {
        await knex('settings').where(flag).delete();
        await knex('settings').insert({ ...flag, value: 'true' });
        expect(await service.isFlagged(orgainzationId)).toBe(true);

        await service.queueRebuild(orgainzationId);
        const started = Date.now();
        while (await service.isFlagged(orgainzationId)) {
          if (Date.now() - started > 120000)
            throw new Error('rebuild timed out');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        const counts = await rebuildQueue.getJobCounts('failed');
        expect(counts.failed).toBe(0);
        return cashRows();
      };
      const first = await runOnce();
      const second = await runOnce();
      expect(second).toEqual(first);
    });
  });

  describe('health', () => {
    it('the ledger balances and the money health check is clean', async () => {
      await settleCostJobs();
      await expectLedgerBalanced();
      const result = await checkMoneyHealth(getTenantKnex(), 'USD');
      expect(isMoneyHealthClean(result)).toBe(true);
    });
  });
});
