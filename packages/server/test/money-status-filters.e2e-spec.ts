import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';

/**
 * The Paid / Partially paid / Due filters compare the paid amount with the
 * document TOTAL (tax, discount and adjustment included) in whole cents,
 * not with the pre-tax subtotal.
 */
describe('Invoice and bill status filters (e2e)', () => {
  let customerId: number;
  let vendorId: number;
  let itemId: number;

  const headers = () => ({
    'organization-id': orgainzationId,
    Authorization: AuthorizationHeader,
  });

  beforeAll(async () => {
    await request(app.getHttpServer())
      .put('/transactions-locking/cancel-lock')
      .set(headers())
      .send({ reason: 'Cancel lock for e2e test' });

    const customer = await request(app.getHttpServer())
      .post('/customers')
      .set(headers())
      .send({
        displayName: `Status filters ${faker.string.alphanumeric(6)}`,
        customerType: 'business',
        currencyCode: 'USD',
      })
      .expect(201);
    customerId = customer.body.id;

    const vendor = await request(app.getHttpServer())
      .post('/vendors')
      .set(headers())
      .send({
        displayName: `Status filters ${faker.string.alphanumeric(6)}`,
        currencyCode: 'USD',
      })
      .expect(201);
    vendorId = vendor.body.id;

    const item = await request(app.getHttpServer())
      .post('/items')
      .set(headers())
      .send({
        name: `Status filters ${Date.now()}-${faker.string.alphanumeric(4)}`,
        type: 'service',
        sellable: true,
        purchasable: true,
        sellAccountId: 1026,
        costAccountId: 1019,
        costPrice: 100,
        sellPrice: 100,
      })
      .expect(201);
    itemId = item.body.id;
  });

  const listIds = async (path: string, status: string, keyword: string) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .query({
        searchKeyword: keyword,
        stringifiedFilterRoles: JSON.stringify([
          { index: 1, fieldKey: 'status', comparator: 'equals', value: status },
        ]),
      })
      .set(headers())
      .expect(200);
    const rows =
      res.body.sales_invoices ??
      res.body.salesInvoices ??
      res.body.bills ??
      res.body.data ??
      [];
    return rows.map((row) => row.id);
  };

  it('keeps an invoice with an unpaid adjustment out of "paid" and in "due"', async () => {
    const invoiceNo = `SF-${faker.string.alphanumeric(10)}`;
    const invoice = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(headers())
      .send({
        customerId,
        invoiceDate: '2023-01-01',
        dueDate: '2099-02-01',
        invoiceNo,
        delivered: true,
        adjustment: 150,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 1000 }],
      })
      .expect(201);
    const invoiceId = invoice.body.id;

    // Pays the subtotal only: 150 of the 1,150 total is still owed.
    await request(app.getHttpServer())
      .post('/payments-received')
      .set(headers())
      .send({
        customerId,
        paymentDate: '2023-01-02',
        exchangeRate: 1,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount: 1000,
        entries: [{ index: 1, invoiceId, paymentAmount: 1000 }],
        branchId: 1,
      })
      .expect(201);

    expect(await listIds('/sale-invoices', 'paid', invoiceNo)).not.toContain(
      invoiceId,
    );
    expect(
      await listIds('/sale-invoices', 'partially-paid', invoiceNo),
    ).toContain(invoiceId);

    const receivable = await request(app.getHttpServer())
      .get('/sale-invoices/receivable')
      .query({ customerId })
      .set(headers())
      .expect(200);
    const receivableRows = Array.isArray(receivable.body)
      ? receivable.body
      : (receivable.body.salesInvoices ?? receivable.body.data ?? []);
    expect(receivableRows.map((row) => row.id)).toContain(invoiceId);

    // Paying the rest makes it fully paid.
    await request(app.getHttpServer())
      .post('/payments-received')
      .set(headers())
      .send({
        customerId,
        paymentDate: '2023-01-03',
        exchangeRate: 1,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount: 150,
        entries: [{ index: 1, invoiceId, paymentAmount: 150 }],
        branchId: 1,
      })
      .expect(201);

    expect(await listIds('/sale-invoices', 'paid', invoiceNo)).toContain(
      invoiceId,
    );
    expect(
      await listIds('/sale-invoices', 'partially-paid', invoiceNo),
    ).not.toContain(invoiceId);
  });

  it('keeps a bill with an unpaid adjustment out of "paid"', async () => {
    const billNumber = `SF-${faker.string.alphanumeric(10)}`;
    const bill = await request(app.getHttpServer())
      .post('/bills')
      .set(headers())
      .send({
        vendorId,
        billDate: '2023-01-01',
        dueDate: '2099-02-01',
        billNumber,
        open: true,
        adjustment: 150,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 1000 }],
      })
      .expect(201);
    const billId = bill.body.id;

    await request(app.getHttpServer())
      .post('/bill-payments')
      .set(headers())
      .send({
        vendorId,
        paymentDate: '2023-01-02',
        exchangeRate: 1,
        paymentAccountId: 1000,
        paymentNumber: faker.string.alphanumeric(10),
        amount: 1000,
        entries: [{ index: 1, billId, paymentAmount: 1000 }],
        branchId: 1,
      })
      .expect(201);

    expect(await listIds('/bills', 'paid', billNumber)).not.toContain(billId);
    expect(await listIds('/bills', 'partially-paid', billNumber)).toContain(
      billId,
    );
  });
});
