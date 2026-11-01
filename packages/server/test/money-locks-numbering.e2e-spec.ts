import request = require('supertest');
import Axios from 'axios';
import { faker } from '@faker-js/faker';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createVendor,
  getBaseCurrency,
} from './_utils/gl';
import { closeTenantKnex, getTenantKnex } from './_utils/money-matrix';
import { events } from '../src/common/events/events';
import { checkMoneyHealth } from '../src/modules/AccountingBasis/MoneyHealthCheck';

/**
 * Package 2 of the 1 Nov 2026 plan: exchange rates (M4), locked periods
 * (L1–L4), document numbering (P3, F4), money validation (P4) and bank
 * categorizing (F10). Each case is the plan's "before" example and must fail
 * on the code before the fix.
 *
 * Locks the whole company to 31 Mar 2026, so run it in its own test company
 * (E2E_EMAIL / E2E_PASSWORD) when other runs share the database.
 */

const LOCK_TO = '2026-03-31';
const LOCKED_DATE = '2026-03-15';
const OPEN_DATE = '2026-04-10';
const BANK_ACCOUNT_ID = 1000;
const OWNERS_EQUITY_ACCOUNT_ID = 1016;
const INVENTORY_ACCOUNT_ID = 1007;

const server = () => app.getHttpServer();
const tag = () => faker.string.alphanumeric(10);

const errorTypeOf = (res: request.Response) => res.body?.errors?.[0]?.type;
const errorMessageOf = (res: request.Response) =>
  res.body?.errors?.[0]?.message;

const lockPeriod = (lockToDate = LOCK_TO) =>
  request(server())
    .put('/transactions-locking/lock')
    .set(authHeaders())
    .send({ module: 'all', lockToDate, reason: 'Package 2 e2e' })
    .expect(200);

const expectLocked = (res: request.Response) => {
  expect(res.status).toBe(400);
  expect(errorTypeOf(res)).toBe('TRANSACTIONS_DATE_LOCKED');
};

const nextNumberOf = async (group: string): Promise<string> => {
  const row = await getTenantKnex()('settings')
    .where({ group, key: 'next_number' })
    .orderBy('id')
    .first();
  return row?.value;
};

const createInventoryItem = async () => {
  const res = await request(server())
    .post('/items')
    .set(authHeaders())
    .send({
      name: `P2 stock ${tag()}`,
      type: 'inventory',
      sellable: true,
      purchasable: true,
      sellAccountId: 1026,
      costAccountId: 1019,
      inventoryAccountId: INVENTORY_ACCOUNT_ID,
      costPrice: 100,
      sellPrice: 100,
    })
    .expect(201);
  return parseInt(res.body.id, 10);
};

describe('Money, locks and numbering — package 2 (e2e)', () => {
  let baseCurrency: string;
  let customerId: number;
  let vendorId: number;
  let itemId: number;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    customerId = await createCustomer(baseCurrency);
    vendorId = await createVendor(baseCurrency);
    itemId = await createServiceItem();
  });

  afterEach(async () => {
    await cancelTransactionsLock();
  });

  afterAll(async () => {
    await cancelTransactionsLock();
    await closeTenantKnex();
  });

  const invoiceBody = (extra: Record<string, any> = {}) => ({
    customerId,
    invoiceDate: OPEN_DATE,
    dueDate: OPEN_DATE,
    delivered: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
    ...extra,
  });

  const createInvoice = async (extra: Record<string, any> = {}) => {
    const res = await request(server())
      .post('/sale-invoices')
      .set(authHeaders())
      .send(invoiceBody({ invoiceNo: `P2-${tag()}`, ...extra }));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id as number;
  };

  const getInvoice = async (id: number) =>
    (
      await request(server())
        .get(`/sale-invoices/${id}`)
        .set(authHeaders())
        .expect(200)
    ).body;

  const creditNoteBody = (extra: Record<string, any> = {}) => ({
    customerId,
    creditNoteDate: OPEN_DATE,
    open: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate: 1000 }],
    ...extra,
  });

  const createCreditNote = async (extra: Record<string, any> = {}) => {
    const res = await request(server())
      .post('/credit-notes')
      .set(authHeaders())
      .send(creditNoteBody(extra));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id as number;
  };

  const billBody = (extra: Record<string, any> = {}) => ({
    vendorId,
    billDate: OPEN_DATE,
    dueDate: OPEN_DATE,
    billNumber: `P2-${tag()}`,
    open: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
    ...extra,
  });

  const createBill = async (extra: Record<string, any> = {}) => {
    const res = await request(server())
      .post('/bills')
      .set(authHeaders())
      .send(billBody(extra));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id as number;
  };

  const vendorCreditBody = (extra: Record<string, any> = {}) => ({
    vendorId,
    vendorCreditDate: OPEN_DATE,
    open: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate: 1000 }],
    ...extra,
  });

  const createVendorCredit = async (extra: Record<string, any> = {}) => {
    const res = await request(server())
      .post('/vendor-credits')
      .set(authHeaders())
      .send(vendorCreditBody(extra));
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.id as number;
  };

  /**
   * ---------------------------------------------------------------
   * M4. The automatic exchange rate.
   * ---------------------------------------------------------------
   */
  describe('M4 — latest exchange rate', () => {
    const previousAppId = process.env.OPEN_EXCHANGE_RATE_APP_ID;

    beforeEach(() => {
      process.env.OPEN_EXCHANGE_RATE_APP_ID = 'e2e-app-id';
    });
    afterEach(() => {
      process.env.OPEN_EXCHANGE_RATE_APP_ID = previousAppId;
      jest.restoreAllMocks();
    });

    it("receives the asked currency and returns the provider's rate, not 1", async () => {
      const get = jest
        .spyOn(Axios, 'get')
        .mockResolvedValue({ data: { rates: { [baseCurrency]: 300.25 } } });

      const res = await request(server())
        .get('/exchange-rates/latest')
        .query({ from_currency: 'LKR' })
        .set(authHeaders())
        .expect(200);

      expect(res.body.exchange_rate).toBe(300.25);
      expect(res.body.base_currency).toBe('LKR');
      expect(res.body.to_currency).toBe(baseCurrency);
      expect(get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          params: expect.objectContaining({
            base: 'LKR',
            symbols: baseCurrency,
          }),
        }),
      );
    });

    it('passes both currencies when to_currency is given', async () => {
      const get = jest
        .spyOn(Axios, 'get')
        .mockResolvedValue({ data: { rates: { EUR: 0.8765 } } });

      const res = await request(server())
        .get('/exchange-rates/latest')
        .query({ from_currency: 'GBP', to_currency: 'EUR' })
        .set(authHeaders())
        .expect(200);

      expect(res.body.exchange_rate).toBe(0.8765);
      expect(get.mock.calls[0][1].params).toMatchObject({
        base: 'GBP',
        symbols: 'EUR',
      });
    });

    it('answers an error, not 1, when the provider has no rate', async () => {
      jest.spyOn(Axios, 'get').mockResolvedValue({ data: { rates: {} } });

      const res = await request(server())
        .get('/exchange-rates/latest')
        .query({ from_currency: 'XYZ' })
        .set(authHeaders())
        .expect(400);

      expect(errorTypeOf(res)).toBe('EX_RATE_NOT_AVAILABLE');
      expect(errorMessageOf(res)).toContain('No exchange rate available');
    });

    it('answers 1 for the same currency without asking the provider', async () => {
      const get = jest.spyOn(Axios, 'get');

      const res = await request(server())
        .get('/exchange-rates/latest')
        .query({ from_currency: baseCurrency })
        .set(authHeaders())
        .expect(200);

      expect(res.body.exchange_rate).toBe(1);
      expect(get).not.toHaveBeenCalled();
    });

    it('rejects a currency code that is not 3 letters', async () => {
      await request(server())
        .get('/exchange-rates/latest')
        .query({ from_currency: 'US' })
        .set(authHeaders())
        .expect(400);
    });
  });

  /**
   * ---------------------------------------------------------------
   * L1. Publishing a draft into a locked month.
   * ---------------------------------------------------------------
   */
  describe('L1 — publishing a draft checks the lock', () => {
    const cases = [
      {
        label: 'invoice (Deliver)',
        create: (date: string) =>
          createInvoice({ invoiceDate: date, dueDate: date, delivered: false }),
        publish: (id: number) =>
          request(server())
            .put(`/sale-invoices/${id}/deliver`)
            .set(authHeaders()),
        isPublished: async (id: number) =>
          !!(await getInvoice(id)).is_delivered,
      },
      {
        label: 'bill (Open)',
        create: (date: string) =>
          createBill({ billDate: date, dueDate: date, open: false }),
        publish: (id: number) =>
          request(server()).patch(`/bills/${id}/open`).set(authHeaders()),
        isPublished: async (id: number) =>
          !!(await request(server()).get(`/bills/${id}`).set(authHeaders()))
            .body.opened_at,
      },
      {
        label: 'credit note (Open)',
        create: (date: string) =>
          createCreditNote({ creditNoteDate: date, open: false }),
        publish: (id: number) =>
          request(server()).put(`/credit-notes/${id}/open`).set(authHeaders()),
        isPublished: async (id: number) =>
          !!(
            await request(server())
              .get(`/credit-notes/${id}`)
              .set(authHeaders())
          ).body.opened_at,
      },
      {
        label: 'vendor credit (Open)',
        create: (date: string) =>
          createVendorCredit({ vendorCreditDate: date, open: false }),
        publish: (id: number) =>
          request(server())
            .put(`/vendor-credits/${id}/open`)
            .set(authHeaders()),
        isPublished: async (id: number) =>
          !!(
            await request(server())
              .get(`/vendor-credits/${id}`)
              .set(authHeaders())
          ).body.opened_at,
      },
    ];

    it.each(cases)(
      '$label: a draft in a locked month (and on the lock date itself) stays a draft',
      async ({ create, publish, isPublished }) => {
        const inMarch = await create(LOCKED_DATE);
        const onLockDate = await create(LOCK_TO);
        await lockPeriod();

        expectLocked(await publish(inMarch));
        expectLocked(await publish(onLockDate));

        expect(await isPublished(inMarch)).toBe(false);
        expect(await isPublished(onLockDate)).toBe(false);
      },
    );

    it.each(cases)(
      '$label: a draft dated after the lock is published',
      async ({ create, publish, isPublished }) => {
        const firstOpenDay = await create('2026-04-01');
        await lockPeriod();

        const res = await publish(firstOpenDay);
        expect(res.status).toBe(200);
        expect(await isPublished(firstOpenDay)).toBe(true);
      },
    );

    it('a draft can still be created (not published) in a locked month', async () => {
      await lockPeriod();
      await createInvoice({
        invoiceDate: LOCKED_DATE,
        dueDate: LOCKED_DATE,
        delivered: false,
      });
    });
  });

  /**
   * ---------------------------------------------------------------
   * L2. Inventory adjustments.
   * ---------------------------------------------------------------
   */
  describe('L2 — inventory adjustments check the lock', () => {
    let stockItemId: number;

    beforeAll(async () => {
      stockItemId = await createInventoryItem();
    });

    const adjustmentBody = (date: string, publish: boolean) => ({
      date,
      type: 'increment',
      adjustmentAccountId: 1001,
      reason: 'Package 2 e2e',
      referenceNo: tag(),
      itemId: stockItemId,
      quantity: 2,
      cost: 10,
      publish,
      warehouseId: 1,
      branchId: 1,
    });

    const createAdjustment = async (date: string, publish: boolean) => {
      const res = await request(server())
        .post('/inventory-adjustments/quick')
        .set(authHeaders())
        .send(adjustmentBody(date, publish));
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
      return res.body.id as number;
    };

    it('create (published), edit (old or new date), publish and delete in a locked month are refused', async () => {
      const publishedInMarch = await createAdjustment(LOCKED_DATE, true);
      const draftInMarch = await createAdjustment(LOCKED_DATE, false);
      const publishedInApril = await createAdjustment(OPEN_DATE, true);
      await lockPeriod();

      // Create, published, in March.
      expectLocked(
        await request(server())
          .post('/inventory-adjustments/quick')
          .set(authHeaders())
          .send(adjustmentBody(LOCKED_DATE, true)),
      );
      // Edit: the old date is in March.
      expectLocked(
        await request(server())
          .put(`/inventory-adjustments/${publishedInMarch}`)
          .set(authHeaders())
          .send(adjustmentBody(OPEN_DATE, true)),
      );
      // Edit: the new date is in March.
      expectLocked(
        await request(server())
          .put(`/inventory-adjustments/${publishedInApril}`)
          .set(authHeaders())
          .send(adjustmentBody(LOCKED_DATE, true)),
      );
      // Publish a March draft.
      expectLocked(
        await request(server())
          .put(`/inventory-adjustments/${draftInMarch}/publish`)
          .set(authHeaders()),
      );
      // Delete a published March adjustment.
      expectLocked(
        await request(server())
          .delete(`/inventory-adjustments/${publishedInMarch}`)
          .set(authHeaders()),
      );
    });

    it('a draft can be created, and a draft deleted, in a locked month', async () => {
      await lockPeriod();
      const draft = await createAdjustment(LOCKED_DATE, false);

      await request(server())
        .delete(`/inventory-adjustments/${draft}`)
        .set(authHeaders())
        .expect(200);
    });

    it('the same actions dated after the lock work', async () => {
      await lockPeriod();
      const published = await createAdjustment(OPEN_DATE, true);
      const draft = await createAdjustment(OPEN_DATE, false);

      await request(server())
        .put(`/inventory-adjustments/${published}`)
        .set(authHeaders())
        .send(adjustmentBody('2026-04-11', true))
        .expect(200);
      await request(server())
        .put(`/inventory-adjustments/${draft}/publish`)
        .set(authHeaders())
        .expect(200);
      await request(server())
        .delete(`/inventory-adjustments/${published}`)
        .set(authHeaders())
        .expect(200);
    });
  });

  /**
   * ---------------------------------------------------------------
   * L3. Landed cost.
   * ---------------------------------------------------------------
   */
  describe('L3 — landed cost checks the lock', () => {
    let stockItemId: number;

    const setLandedCostFeature = (value: number) =>
      request(server())
        .put('/settings')
        .set(authHeaders())
        .send({ options: [{ group: 'features', key: 'landed_cost', value }] })
        .expect(200);

    const billEntryId = async (billId: number) =>
      (await request(server()).get(`/bills/${billId}`).set(authHeaders())).body
        .entries[0].id;

    const allocate = async (targetBillId: number, costBillId: number) =>
      request(server())
        .post(`/landed-cost/bills/${targetBillId}/allocate`)
        .set(authHeaders())
        .send({
          transactionId: costBillId,
          transactionType: 'Bill',
          transactionEntryId: await billEntryId(costBillId),
          allocationMethod: 'value',
          description: 'Freight',
          items: [{ entryId: await billEntryId(targetBillId), cost: 20 }],
        });

    const stockBill = (date: string, landedCost = false) =>
      createBill({
        billDate: date,
        dueDate: date,
        entries: [
          { index: 1, itemId: stockItemId, quantity: 2, rate: 100, landedCost },
        ],
      });

    beforeAll(async () => {
      await setLandedCostFeature(1);
      stockItemId = await createInventoryItem();
    });

    it('allocating onto a bill dated in a locked month is refused', async () => {
      const februaryBill = await stockBill('2026-02-10');
      const freightBill = await stockBill(OPEN_DATE, true);
      await lockPeriod();

      expectLocked(await allocate(februaryBill, freightBill));
    });

    it('removing landed cost from a bill dated in a locked month is refused', async () => {
      const februaryBill = await stockBill('2026-02-10');
      const freightBill = await stockBill(OPEN_DATE, true);
      const allocated = await allocate(februaryBill, freightBill);
      expect(allocated.status).toBe(201);
      await lockPeriod();

      expectLocked(
        await request(server())
          .delete(`/landed-cost/${allocated.body.id}`)
          .set(authHeaders()),
      );
    });

    it('allocating and removing on a bill dated after the lock work', async () => {
      const aprilBill = await stockBill(OPEN_DATE);
      const freightBill = await stockBill(OPEN_DATE, true);
      await lockPeriod();

      const allocated = await allocate(aprilBill, freightBill);
      expect(allocated.status).toBe(201);

      await request(server())
        .delete(`/landed-cost/${allocated.body.id}`)
        .set(authHeaders())
        .expect(200);
    });
  });

  /**
   * ---------------------------------------------------------------
   * L4. Opening balance edits.
   * ---------------------------------------------------------------
   */
  describe.each([
    {
      label: 'customer',
      contactPath: '/customers',
      contactExtra: { customerType: 'business' },
      paymentPath: '/payments-received',
      paymentBody: (contactId: number, number: string, date: string) => ({
        customerId: contactId,
        paymentDate: date,
        amount: 200,
        depositAccountId: BANK_ACCOUNT_ID,
        paymentReceiveNo: number,
        branchId: 1,
        entries: [
          { index: 1, entryType: 'opening_balance', paymentAmount: 200 },
        ],
      }),
    },
    {
      label: 'supplier',
      contactPath: '/vendors',
      contactExtra: {},
      paymentPath: '/bill-payments',
      paymentBody: (contactId: number, number: string, date: string) => ({
        vendorId: contactId,
        paymentDate: date,
        amount: 200,
        paymentAccountId: BANK_ACCOUNT_ID,
        paymentNumber: number,
        branchId: 1,
        entries: [
          { index: 1, entryType: 'opening_balance', paymentAmount: 200 },
        ],
      }),
    },
  ])(
    'L4 — editing a $label opening balance checks the lock',
    ({ contactPath, contactExtra, paymentPath, paymentBody }) => {
      const createContact = async (openingBalanceAt: string) => {
        const res = await request(server())
          .post(contactPath)
          .set(authHeaders())
          .send({
            displayName: `P2 opening ${tag()}`,
            currencyCode: baseCurrency,
            openingBalance: 500,
            openingBalanceAt,
            ...contactExtra,
          })
          .expect(201);
        return res.body.id as number;
      };

      const payOpeningBalance = async (contactId: number, date: string) => {
        const number = `PAY-${tag()}`;
        const res = await request(server())
          .post(paymentPath)
          .set(authHeaders())
          .send(paymentBody(contactId, number, date));
        if (res.status !== 201) throw new Error(JSON.stringify(res.body));
        return number;
      };

      const editOpeningBalance = (
        contactId: number,
        body: Record<string, any>,
      ) =>
        request(server())
          .put(`${contactPath}/${contactId}/opening-balance`)
          .set(authHeaders())
          .send(body);

      const openingBalanceOf = async (contactId: number) =>
        Number(
          (
            await request(server())
              .get(`${contactPath}/${contactId}`)
              .set(authHeaders())
          ).body.opening_balance,
        );

      it('is refused when a payment that settled it is in a locked period, naming the payment', async () => {
        // 1 Jan is unlocked (partial unlock); the 14 Feb payment is locked.
        const contactId = await createContact('2026-01-01');
        const paymentNo = await payOpeningBalance(contactId, '2026-02-14');
        await lockPeriod();
        await request(server())
          .put('/transactions-locking/unlock-partial')
          .set(authHeaders())
          .send({
            module: 'all',
            unlockFromDate: '2026-01-01',
            unlockToDate: '2026-01-31',
            reason: 'Package 2 e2e',
          })
          .expect(200);

        const res = await editOpeningBalance(contactId, {
          openingBalance: 450,
        });

        expect(res.status).toBe(400);
        expect(errorTypeOf(res)).toBe('LINKED_TRANSACTIONS_DATE_LOCKED');
        expect(errorMessageOf(res)).toContain(
          `Payment ${paymentNo} (14 Feb 2026)`,
        );
        expect(await openingBalanceOf(contactId)).toBe(500);
      });

      it('is refused when the opening balance date is in a locked period', async () => {
        const contactId = await createContact('2026-01-01');
        await lockPeriod();

        expectLocked(
          await editOpeningBalance(contactId, { openingBalance: 450 }),
        );
        // Moving it out of the locked period still rewrites the old entries.
        expectLocked(
          await editOpeningBalance(contactId, {
            openingBalance: 450,
            openingBalanceAt: OPEN_DATE,
          }),
        );
        expect(await openingBalanceOf(contactId)).toBe(500);
      });

      it('is allowed when the opening balance and its payments are after the lock', async () => {
        const contactId = await createContact(OPEN_DATE);
        await payOpeningBalance(contactId, '2026-04-20');
        await lockPeriod();

        await editOpeningBalance(contactId, { openingBalance: 450 }).expect(
          200,
        );
        expect(await openingBalanceOf(contactId)).toBe(450);
      });
    },
  );

  /**
   * ---------------------------------------------------------------
   * P3 + F4. Document numbering.
   * ---------------------------------------------------------------
   */
  describe('P3 / F4 — numbering', () => {
    let warehouseFrom: number;
    let warehouseTo: number;
    let stockItemId: number;
    let paidInvoiceId: number;

    beforeAll(async () => {
      stockItemId = await createInventoryItem();
      paidInvoiceId = await createInvoice();
      const warehouse = async () =>
        (
          await request(server())
            .post('/warehouses')
            .set(authHeaders())
            .send({
              name: `P2 ${tag()}`,
              code: tag().slice(0, 5).toUpperCase(),
            })
            .expect(201)
        ).body.id as number;
      warehouseFrom = await warehouse();
      warehouseTo = await warehouse();
    });

    const numberCases = [
      {
        group: 'sales_invoices',
        prefix: 'INV-',
        path: '/sale-invoices',
        numberKey: 'invoice_no',
        body: () => invoiceBody(),
      },
      {
        group: 'sales_estimates',
        prefix: 'EST-',
        path: '/sale-estimates',
        numberKey: 'estimate_number',
        body: () => ({
          customerId,
          estimateDate: OPEN_DATE,
          expirationDate: OPEN_DATE,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
        }),
      },
      {
        group: 'sales_receipts',
        prefix: 'REC-',
        path: '/sale-receipts',
        numberKey: 'receipt_number',
        body: () => ({
          customerId,
          receiptDate: OPEN_DATE,
          depositAccountId: BANK_ACCOUNT_ID,
          closed: true,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
        }),
      },
      {
        group: 'credit_note',
        prefix: 'CN-',
        path: '/credit-notes',
        numberKey: 'credit_note_number',
        body: () => creditNoteBody(),
      },
      {
        group: 'vendor_credit',
        prefix: 'VC-',
        path: '/vendor-credits',
        numberKey: 'vendor_credit_number',
        body: () => vendorCreditBody(),
      },
      {
        group: 'payment_receives',
        prefix: 'PAY-',
        path: '/payments-received',
        numberKey: 'payment_receive_no',
        body: () => ({
          customerId,
          paymentDate: OPEN_DATE,
          amount: 1,
          depositAccountId: BANK_ACCOUNT_ID,
          branchId: 1,
          entries: [{ index: 1, invoiceId: paidInvoiceId, paymentAmount: 1 }],
        }),
      },
      {
        group: 'manual_journals',
        prefix: 'J-',
        path: '/manual-journals',
        numberKey: 'journal_number',
        body: () => ({
          date: OPEN_DATE,
          publish: true,
          entries: [
            { index: 1, accountId: BANK_ACCOUNT_ID, debit: 10, credit: 0 },
            {
              index: 2,
              accountId: OWNERS_EQUITY_ACCOUNT_ID,
              debit: 0,
              credit: 10,
            },
          ],
        }),
      },
      {
        group: 'cashflow',
        prefix: 'CF-',
        path: '/banking/transactions',
        numberKey: 'transaction_number',
        body: () => ({
          date: OPEN_DATE,
          transactionType: 'OwnerContribution',
          amount: 10,
          cashflowAccountId: BANK_ACCOUNT_ID,
          creditAccountId: OWNERS_EQUITY_ACCOUNT_ID,
          description: 'Package 2 e2e',
          publish: true,
          branchId: 1,
        }),
      },
      {
        group: 'warehouse_transfers',
        prefix: 'WT-',
        path: '/warehouse-transfers',
        numberKey: 'transaction_number',
        body: () => ({
          fromWarehouseId: warehouseFrom,
          toWarehouseId: warehouseTo,
          date: OPEN_DATE,
          entries: [{ index: 1, itemId: stockItemId, quantity: 1 }],
        }),
      },
    ];

    const numberOf = async (path: string, id: number, numberKey: string) =>
      (await request(server()).get(`${path}/${id}`).set(authHeaders())).body[
        numberKey
      ];

    it.each(numberCases)(
      '$group: saves at the same moment get different numbers, in sequence',
      async ({ group, prefix, path, numberKey, body }) => {
        const start = await nextNumberOf(group);
        const saves = 4;

        const responses = await Promise.all(
          Array.from({ length: saves }, () =>
            request(server()).post(path).set(authHeaders()).send(body()),
          ),
        );
        responses.forEach((res) => {
          if (res.status !== 201) throw new Error(JSON.stringify(res.body));
        });
        const numbers = await Promise.all(
          responses.map((res) => numberOf(path, res.body.id, numberKey)),
        );
        const width = start.length;
        const expected = Array.from(
          { length: saves },
          (_, i) =>
            `${prefix}${String(Number(start) + i).padStart(width, '0')}`,
        );

        // A proper number each (F4: never "[object Promise]"), all different.
        expect([...numbers].sort()).toEqual(expected);
        expect(await nextNumberOf(group)).toBe(
          String(Number(start) + saves).padStart(width, '0'),
        );
      },
    );

    it('two saves with the same typed invoice number: one is refused', async () => {
      const invoiceNo = `P2-SAME-${tag()}`;
      const responses = await Promise.all([
        request(server())
          .post('/sale-invoices')
          .set(authHeaders())
          .send(invoiceBody({ invoiceNo })),
        request(server())
          .post('/sale-invoices')
          .set(authHeaders())
          .send(invoiceBody({ invoiceNo })),
      ]);
      expect(responses.map((res) => res.status).sort()).toEqual([201, 400]);
      expect(errorTypeOf(responses.find((res) => res.status === 400))).toBe(
        'INVOICE_NUMBER_NOT_UNIQUE',
      );

      const rows = await getTenantKnex()('sales_invoices').where({ invoiceNo });
      expect(rows).toHaveLength(1);
    });

    it('a refused save leaves the counter unchanged', async () => {
      const start = await nextNumberOf('sales_invoices');
      const res = await request(server())
        .post('/sale-invoices')
        .set(authHeaders())
        .send(
          invoiceBody({
            entries: [{ index: 1, itemId: 999999, quantity: 1, rate: 1 }],
          }),
        );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await nextNumberOf('sales_invoices')).toBe(start);
    });

    it('a typed number is kept', async () => {
      const invoiceNo = `P2-TYPED-${tag()}`;
      const res = await request(server())
        .post('/sale-invoices')
        .set(authHeaders())
        .send(invoiceBody({ invoiceNo }))
        .expect(201);
      expect(await numberOf('/sale-invoices', res.body.id, 'invoice_no')).toBe(
        invoiceNo,
      );
    });
  });

  /**
   * ---------------------------------------------------------------
   * P4. Negative amounts, duplicate invoices and draft credits.
   * ---------------------------------------------------------------
   */
  describe('P4 — money validation', () => {
    it.each([
      ['quantity', { quantity: -5, rate: 1000 }],
      ['rate', { quantity: 1, rate: -1000 }],
      ['discount', { quantity: 1, rate: 1000, discount: -10 }],
    ])('refuses a negative line %s', async (_label, line) => {
      await request(server())
        .post('/sale-invoices')
        .set(authHeaders())
        .send(invoiceBody({ entries: [{ index: 1, itemId, ...line }] }))
        .expect(400);
    });

    it('accepts zero rate and zero discount lines', async () => {
      await request(server())
        .post('/sale-invoices')
        .set(authHeaders())
        .send(
          invoiceBody({
            entries: [
              { index: 1, itemId, quantity: 1, rate: 0 },
              { index: 2, itemId, quantity: 1, rate: 10, discount: 0 },
            ],
          }),
        )
        .expect(201);
    });

    it('refuses negative payment, expense and landed-cost amounts', async () => {
      const invoiceId = await createInvoice();
      await request(server())
        .post('/payments-received')
        .set(authHeaders())
        .send({
          customerId,
          paymentDate: OPEN_DATE,
          depositAccountId: BANK_ACCOUNT_ID,
          branchId: 1,
          entries: [{ index: 1, invoiceId, paymentAmount: -50 }],
        })
        .expect(400);
      await request(server())
        .post('/expenses')
        .set(authHeaders())
        .send({
          paymentDate: OPEN_DATE,
          paymentAccountId: BANK_ACCOUNT_ID,
          publish: true,
          branchId: 1,
          categories: [{ index: 1, expenseAccountId: 1021, amount: -50 }],
        })
        .expect(400);
      await request(server())
        .post(`/landed-cost/bills/1/allocate`)
        .set(authHeaders())
        .send({
          transactionId: 1,
          transactionType: 'Bill',
          transactionEntryId: 1,
          allocationMethod: 'value',
          items: [{ entryId: 1, cost: -20 }],
        })
        .expect(400);
    });

    it('refuses a zero or negative credit-apply amount', async () => {
      const creditNoteId = await createCreditNote();
      const invoiceId = await createInvoice();
      for (const amount of [0, -10]) {
        await request(server())
          .post(`/credit-notes/${creditNoteId}/apply-invoices`)
          .set(authHeaders())
          .send({ entries: [{ invoiceId, amount }] })
          .expect(400);
      }
    });

    it('refuses the same invoice twice in one credit-note application', async () => {
      const invoiceNo = `P2-DUP-${tag()}`;
      const invoiceId = await createInvoice({
        invoiceNo,
        entries: [{ index: 1, itemId, quantity: 1, rate: 600 }],
      });
      const creditNoteId = await createCreditNote();

      const res = await request(server())
        .post(`/credit-notes/${creditNoteId}/apply-invoices`)
        .set(authHeaders())
        .send({
          entries: [
            { invoiceId, amount: 600 },
            { invoiceId, amount: 600 },
          ],
        });

      expect(res.status).toBe(400);
      expect(errorTypeOf(res)).toBe('CREDIT_NOTE_APPLY_DUPLICATE_INVOICE');
      expect(errorMessageOf(res)).toContain(
        `Invoice ${invoiceNo} is listed more than once`,
      );
      expect(Number((await getInvoice(invoiceId)).due_amount)).toBe(600);
    });

    it('refuses the same bill twice in one vendor-credit application', async () => {
      const billId = await createBill({
        entries: [{ index: 1, itemId, quantity: 1, rate: 600 }],
      });
      const vendorCreditId = await createVendorCredit();

      const res = await request(server())
        .post(`/vendor-credits/${vendorCreditId}/apply-to-bills`)
        .set(authHeaders())
        .send({
          entries: [
            { billId, amount: 300 },
            { billId, amount: 300 },
          ],
        });

      expect(res.status).toBe(400);
      expect(errorTypeOf(res)).toBe('VENDOR_CREDIT_APPLY_DUPLICATE_BILL');
    });

    it('a draft credit note cannot be refunded or applied until it is opened', async () => {
      const creditNoteId = await createCreditNote({ open: false });
      const invoiceId = await createInvoice();
      const refund = () =>
        request(server())
          .post(`/credit-notes/${creditNoteId}/refunds`)
          .set(authHeaders())
          .send({
            date: OPEN_DATE,
            fromAccountId: BANK_ACCOUNT_ID,
            amount: 500,
          });

      const refused = await refund();
      expect(refused.status).toBe(400);
      expect(errorTypeOf(refused)).toBe('CREDIT_NOTE_IS_DRAFT');
      expect(errorMessageOf(refused)).toContain(
        'Publish the credit note first',
      );

      const apply = await request(server())
        .post(`/credit-notes/${creditNoteId}/apply-invoices`)
        .set(authHeaders())
        .send({ entries: [{ invoiceId, amount: 50 }] });
      expect(errorTypeOf(apply)).toBe('CREDIT_NOTE_IS_DRAFT');

      await request(server())
        .put(`/credit-notes/${creditNoteId}/open`)
        .set(authHeaders())
        .expect(200);
      expect((await refund()).status).toBe(201);
    });

    it('a draft vendor credit cannot be refunded or applied until it is opened', async () => {
      const vendorCreditId = await createVendorCredit({ open: false });
      const billId = await createBill();
      const refund = () =>
        request(server())
          .post(`/vendor-credits/${vendorCreditId}/refund`)
          .set(authHeaders())
          .send({
            date: OPEN_DATE,
            depositAccountId: BANK_ACCOUNT_ID,
            amount: 500,
            branchId: 1,
          });

      const refused = await refund();
      expect(refused.status).toBe(400);
      expect(errorTypeOf(refused)).toBe('VENDOR_CREDIT_IS_DRAFT');

      const apply = await request(server())
        .post(`/vendor-credits/${vendorCreditId}/apply-to-bills`)
        .set(authHeaders())
        .send({ entries: [{ billId, amount: 50 }] });
      expect(errorTypeOf(apply)).toBe('VENDOR_CREDIT_IS_DRAFT');

      await request(server())
        .put(`/vendor-credits/${vendorCreditId}/open`)
        .set(authHeaders())
        .expect(200);
      expect((await refund()).status).toBe(201);
    });
  });

  /**
   * ---------------------------------------------------------------
   * F10. Categorizing a bank line.
   * ---------------------------------------------------------------
   */
  describe('F10 — categorizing a bank line posts it once', () => {
    const createBankLine = async (amount: number) => {
      const [id] = await getTenantKnex()(
        'uncategorized_cashflow_transactions',
      ).insert({
        date: OPEN_DATE,
        accountId: BANK_ACCOUNT_ID,
        amount,
        currencyCode: baseCurrency,
        description: `P2 bank line ${tag()}`,
        categorized: false,
      });
      return id as number;
    };

    const categorize = (lineId: number, description: string) =>
      request(server())
        .post('/banking/categorize')
        .set(authHeaders())
        .send({
          uncategorizedTransactionIds: [lineId],
          date: OPEN_DATE,
          transactionType: 'OwnerContribution',
          creditAccountId: OWNERS_EQUITY_ACCOUNT_ID,
          description,
          branchId: 1,
        });

    const postingsOf = (description: string) =>
      getTenantKnex()('cashflow_transactions').where({ description });

    const lineOf = (lineId: number) =>
      getTenantKnex()('uncategorized_cashflow_transactions')
        .where({ id: lineId })
        .first();

    it('two requests at once give one posting; the second is refused', async () => {
      const lineId = await createBankLine(25000);
      const description = `P2 categorize ${tag()}`;

      const responses = await Promise.all([
        categorize(lineId, description),
        categorize(lineId, description),
      ]);

      const statuses = responses.map((res) => res.status).sort();
      expect(statuses[0]).toBeLessThan(300);
      expect(statuses[1]).toBe(400);
      expect(errorTypeOf(responses.find((res) => res.status === 400))).toBe(
        'TRANSACTION_ALREADY_CATEGORIZED',
      );

      const postings = await postingsOf(description);
      expect(postings).toHaveLength(1);
      expect(Number((await lineOf(lineId)).categorized)).toBe(1);

      const legs = await getTenantKnex()('accounts_transactions').where({
        referenceType: 'CashflowTransaction',
        referenceId: postings[0].id,
        accountId: BANK_ACCOUNT_ID,
      });
      expect(legs.reduce((sum, leg) => sum + Number(leg.debit), 0)).toBe(25000);
    });

    it('a failure after the posting leaves nothing posted, so trying again is safe', async () => {
      const lineId = await createBankLine(1234.56);
      const description = `P2 categorize fail ${tag()}`;
      const eventEmitter = app.get(EventEmitter2);
      const emitAsync = eventEmitter.emitAsync.bind(eventEmitter);

      const spy = jest
        .spyOn(eventEmitter, 'emitAsync')
        .mockImplementation(async (event: any, ...args: any[]) => {
          if (event === events.cashflow.onTransactionCategorized) {
            throw new Error('Forced failure after the posting');
          }
          return emitAsync(event, ...args);
        });
      const failed = await categorize(lineId, description);
      spy.mockRestore();

      expect(failed.status).toBeGreaterThanOrEqual(400);
      expect(await postingsOf(description)).toHaveLength(0);
      expect(Number((await lineOf(lineId)).categorized)).toBe(0);

      const retried = await categorize(lineId, description);
      expect(retried.status).toBeLessThan(300);
      expect(await postingsOf(description)).toHaveLength(1);
    });
  });

  /**
   * ---------------------------------------------------------------
   * The books still balance.
   * ---------------------------------------------------------------
   */
  it('the ledger of this company still balances (money health check)', async () => {
    const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
    expect(health.unbalancedSets).toEqual([]);
  });
});
