import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createTaxRate,
  createVendor,
  expectBalanced,
  fetchLegs,
  getBaseCurrency,
} from './_utils/gl';
import {
  agingTotalOf,
  closeTenantKnex,
  listIdsByStatus,
  num,
  rowsOf,
  selectColumns,
} from './_utils/money-matrix';

/**
 * The other "same money, two answers" bugs found by the audit after the
 * Codex review of PR #7, each tested where a user meets it.
 */
describe('Money — audit fixes (e2e)', () => {
  let baseCurrency: string;
  let customerId: number;
  let vendorId: number;
  let itemId: number;
  let taxRateId: number;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    customerId = await createCustomer(baseCurrency);
    vendorId = await createVendor(baseCurrency);
    itemId = await createServiceItem();
    taxRateId = await createTaxRate(15);
  });

  afterAll(async () => {
    await closeTenantKnex();
  });

  const invoiceBody = (extra: Record<string, any> = {}) => ({
    customerId,
    invoiceDate: '2025-03-01',
    dueDate: '2025-03-31',
    invoiceNo: `AUD-${faker.string.alphanumeric(12)}`,
    delivered: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
    ...extra,
  });

  const createInvoice = async (extra: Record<string, any> = {}) => {
    const body = invoiceBody(extra);
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send(body)
      .expect(201);
    return { id: res.body.id as number, invoiceNo: body.invoiceNo, body };
  };

  const createCreditNote = async (contactId: number, rate: number) => {
    const res = await request(app.getHttpServer())
      .post('/credit-notes')
      .set(authHeaders())
      .send({
        customerId: contactId,
        creditNoteDate: '2025-03-01',
        open: true,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate }],
      })
      .expect(201);
    return res.body.id as number;
  };

  const applyCredit = (
    creditNoteId: number,
    invoiceId: number,
    amount: number,
  ) =>
    request(app.getHttpServer())
      .post(`/credit-notes/${creditNoteId}/apply-invoices`)
      .set(authHeaders())
      .send({ entries: [{ invoiceId, amount }] })
      .expect(201);

  const payInvoice = (invoiceId: number, amount: number) =>
    request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate: '2025-03-05',
        exchangeRate: 1,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount,
        entries: [{ index: 1, invoiceId, paymentAmount: amount }],
        branchId: 1,
      })
      .expect(201);

  it('stores 0 tax when an edit removes every tax (the old tax was kept)', async () => {
    const invoice = await createInvoice({
      entries: [{ index: 1, itemId, quantity: 1, rate: 100, taxRateId }],
    });
    expect(
      (
        await selectColumns('SALES_INVOICES', invoice.id, [
          'TAX_AMOUNT_WITHHELD',
        ])
      ).TAX_AMOUNT_WITHHELD,
    ).toBe(15);

    await request(app.getHttpServer())
      .put(`/sale-invoices/${invoice.id}`)
      .set(authHeaders())
      .send({
        ...invoice.body,
        entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
      })
      .expect(200);

    const stored = await selectColumns('SALES_INVOICES', invoice.id, [
      'TAX_AMOUNT_WITHHELD',
    ]);
    expect(stored.TAX_AMOUNT_WITHHELD).toBe(0);
    const res = await request(app.getHttpServer())
      .get(`/sale-invoices/${invoice.id}`)
      .set(authHeaders())
      .expect(200);
    // Was 115: A/R got the old tax and the ledger did not balance.
    expect(num(res.body.data ?? res.body, 'total')).toBe(100);
    const legs = await fetchLegs('SaleInvoice', invoice.id, 'accrual');
    expectBalanced(legs);
  });

  it('refuses an edit that makes the total smaller than paid + credited', async () => {
    const invoice = await createInvoice();
    await payInvoice(invoice.id, 60);
    const creditNoteId = await createCreditNote(customerId, 30);
    await applyCredit(creditNoteId, invoice.id, 30);

    // 70 >= 60 paid, but 90 is settled: was accepted, leaving 20 over.
    await request(app.getHttpServer())
      .put(`/sale-invoices/${invoice.id}`)
      .set(authHeaders())
      .send({
        ...invoice.body,
        entries: [{ index: 1, itemId, quantity: 1, rate: 70 }],
      })
      .expect(400);
    await request(app.getHttpServer())
      .put(`/sale-invoices/${invoice.id}`)
      .set(authHeaders())
      .send({
        ...invoice.body,
        entries: [{ index: 1, itemId, quantity: 1, rate: 90 }],
      })
      .expect(200);
  });

  it('keeps a fully credited invoice out of the "unpaid" tab', async () => {
    const credited = await createInvoice();
    const creditNoteId = await createCreditNote(customerId, 100);
    await applyCredit(creditNoteId, credited.id, 100);
    const untouched = await createInvoice();

    expect(
      await listIdsByStatus('/sale-invoices', 'unpaid', credited.invoiceNo),
    ).not.toContain(credited.id);
    expect(
      await listIdsByStatus('/sale-invoices', 'unpaid', untouched.invoiceNo),
    ).toContain(untouched.id);
  });

  it('keeps a customer whose opening balance is paid out of "unpaid"', async () => {
    const displayName = `Opening paid ${faker.string.alphanumeric(8)}`;
    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(authHeaders())
      .send({
        displayName,
        customerType: 'business',
        currencyCode: baseCurrency,
        openingBalance: 100,
        openingBalanceAt: '2025-01-01',
        openingBalanceBranchId: 1,
      })
      .expect(201);
    const id = customer.body.id;
    const unpaidIds = async () => {
      const res = await request(app.getHttpServer())
        .get('/customers')
        .query({
          searchKeyword: displayName,
          stringifiedFilterRoles: JSON.stringify([
            {
              index: 1,
              fieldKey: 'status',
              comparator: 'equals',
              value: 'unpaid',
            },
          ]),
        })
        .set(authHeaders())
        .expect(200);
      return rowsOf(res.body).map((row) => row.id);
    };
    expect(await unpaidIds()).toContain(id);

    await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId: id,
        paymentDate: '2025-01-05',
        exchangeRate: 1,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount: 100,
        entries: [
          { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
        ],
        branchId: 1,
      })
      .expect(201);
    // The balance (0) already held the opening balance; adding it again
    // (0 + 100) kept the customer "unpaid".
    expect(await unpaidIds()).not.toContain(id);
  });

  it('leaves drafts out of the aging summaries (they are not in the ledger)', async () => {
    const draftCustomer = await createCustomer(baseCurrency);
    await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({ ...invoiceBody(), customerId: draftCustomer, delivered: false })
      .expect(201);
    expect(
      await agingTotalOf(
        '/reports/receivable-aging-summary',
        draftCustomer,
        '2025-04-15',
      ),
    ).toBe(0);

    const draftVendor = await createVendor(baseCurrency);
    await request(app.getHttpServer())
      .post('/bills')
      .set(authHeaders())
      .send({
        vendorId: draftVendor,
        billDate: '2025-03-01',
        dueDate: '2025-03-31',
        billNumber: faker.string.alphanumeric(12),
        open: false,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
      })
      .expect(201);
    expect(
      await agingTotalOf(
        '/reports/payable-aging-summary',
        draftVendor,
        '2025-04-15',
      ),
    ).toBe(0);
  });

  it('splits current and overdue bills by the "as of" date, like invoices', async () => {
    const res = await request(app.getHttpServer())
      .post('/bills')
      .set(authHeaders())
      .send({
        vendorId,
        billDate: '2025-03-01',
        dueDate: '2025-04-15',
        billNumber: faker.string.alphanumeric(12),
        open: true,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
      })
      .expect(201);
    // As of 2025-03-31 the bill (due 2025-04-15) is current, not overdue
    // as "today" made it.
    const aging = await request(app.getHttpServer())
      .get('/reports/payable-aging-summary')
      .query(
        `asDate=2025-03-31&agingDaysBefore=30&agingPeriods=3&vendorsIds[]=${vendorId}`,
      )
      .set(authHeaders())
      .expect(200);
    const data = aging.body.data ?? aging.body;
    const vendors = data.vendors ?? [];
    const current = vendors.reduce(
      (sum, row) => sum + Number(row.current?.amount ?? 0),
      0,
    );
    expect(current).toBeGreaterThanOrEqual(100);
    expect(res.body.id).toBeTruthy();
  });

  it('lists open bills on the "Opened" tab (it showed overdue bills)', async () => {
    const billNumber = `AUD-${faker.string.alphanumeric(10)}`;
    const res = await request(app.getHttpServer())
      .post('/bills')
      .set(authHeaders())
      .send({
        vendorId,
        billDate: '2025-03-01',
        dueDate: '2099-01-01',
        billNumber,
        open: true,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 100 }],
      })
      .expect(201);
    expect(await listIdsByStatus('/bills', 'opened', billNumber)).toContain(
      res.body.id,
    );
  });

  it('sorts invoices by due amount (the query failed on a missing column)', async () => {
    await request(app.getHttpServer())
      .get('/sale-invoices')
      .query({ columnSortBy: 'due_amount', sortOrder: 'desc' })
      .set(authHeaders())
      .expect(200);
  });
});
