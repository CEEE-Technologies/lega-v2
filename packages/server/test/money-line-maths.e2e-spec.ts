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
  GLTestLeg,
} from './_utils/gl';

/**
 * Line maths: each line is rounded to cents with the tax on the amount after
 * the line discount, so the figures the form shows, the saved document and
 * its ledger are the same (P4 of the money rounding plan).
 *
 * 3 lines of 1 x 33.33, 10% line discount, 15% exclusive tax:
 *   each line 33.33 - 3.33 = 30.00, tax 4.50 -> subtotal 90.00,
 *   tax 13.50, total 103.50.
 */
describe('Money — invoice and bill line maths (e2e)', () => {
  let baseCurrency: string;
  let customerId: number;
  let foreignCustomerId: number;
  let vendorId: number;
  let itemId: number;
  let taxRate15: number;

  const lines = () =>
    [1, 2, 3].map((index) => ({
      index,
      itemId,
      quantity: 1,
      rate: 33.33,
      discount: 10,
      discountType: 'percentage',
      taxRateId: taxRate15,
    }));

  const byAccount = (legs: GLTestLeg[], code: string) =>
    legs
      .filter((leg) => leg.accountCode === code)
      .reduce((sum, leg) => sum + leg.debit.amount - leg.credit.amount, 0);

  const round2 = (value: number) => Math.round(value * 100) / 100;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    customerId = await createCustomer(baseCurrency);
    foreignCustomerId = await createCustomer('EUR');
    vendorId = await createVendor(baseCurrency);
    itemId = await createServiceItem();
    taxRate15 = await createTaxRate(15);
  });

  const getInvoice = async (id: number) => {
    const res = await request(app.getHttpServer())
      .get(`/sale-invoices/${id}`)
      .set(authHeaders())
      .expect(200);
    return res.body.data ?? res.body;
  };

  it('saves the invoice and its ledger with the per-line rounded figures', async () => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate: '2023-01-01',
        dueDate: '2023-02-01',
        invoiceNo: faker.string.uuid(),
        delivered: true,
        isInclusiveTax: false,
        branchId: 1,
        warehouseId: 1,
        entries: lines(),
      })
      .expect(201);
    const invoiceId = res.body.id;
    const invoice = await getInvoice(invoiceId);

    expect(Number(invoice.subtotal)).toBe(90);
    expect(
      Number(invoice.taxAmountWithheld ?? invoice.tax_amount_withheld),
    ).toBe(13.5);
    expect(Number(invoice.total)).toBe(103.5);
    // Each line keeps its 10% discount and is taxed after it.
    (invoice.entries || []).forEach((entry) => {
      expect(Number(entry.discount)).toBe(10);
    });

    const legs = await fetchLegs('SaleInvoice', invoiceId, 'accrual');
    expectBalanced(legs);
    expect(round2(byAccount(legs, '10007'))).toBe(103.5); // A/R
    expect(round2(byAccount(legs, '20006'))).toBe(-13.5); // tax payable
    legs.forEach((leg) => {
      expect(round2(leg.debit.amount)).toBe(leg.debit.amount);
      expect(round2(leg.credit.amount)).toBe(leg.credit.amount);
    });
  });

  it('keeps a 2.5% line discount (was saved as 2%)', async () => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate: '2023-01-01',
        dueDate: '2023-02-01',
        invoiceNo: faker.string.uuid(),
        delivered: true,
        branchId: 1,
        warehouseId: 1,
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1.5,
            rate: 33.33,
            discount: 2.5,
            discountType: 'percentage',
            taxRateId: taxRate15,
          },
        ],
      })
      .expect(201);
    const invoice = await getInvoice(res.body.id);

    expect(Number(invoice.entries[0].discount)).toBe(2.5);
    // 1.5 x 33.33 = 50.00, less 1.25 = 48.75, tax 7.31 -> 56.06
    expect(Number(invoice.subtotal)).toBe(48.75);
    expect(Number(invoice.total)).toBe(56.06);
  });

  it('converts a foreign currency invoice to exact cents in the ledger', async () => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId: foreignCustomerId,
        exchangeRate: 312.456789,
        invoiceDate: '2023-01-01',
        dueDate: '2023-02-01',
        invoiceNo: faker.string.uuid(),
        delivered: true,
        branchId: 1,
        warehouseId: 1,
        entries: lines(),
      })
      .expect(201);
    const legs = await fetchLegs('SaleInvoice', res.body.id, 'accrual');

    expectBalanced(legs);
    // 103.50 x 312.456789 = 32339.2777 -> 32339.28 on A/R, to the cent.
    const receivable = legs.find((leg) => leg.contactId === foreignCustomerId);
    expect(receivable.debit.amount).toBe(32339.28);
    legs.forEach((leg) => {
      expect(round2(leg.debit.amount)).toBe(leg.debit.amount);
      expect(round2(leg.credit.amount)).toBe(leg.credit.amount);
    });
  });

  it('saves the bill and its ledger with the per-line rounded figures', async () => {
    const res = await request(app.getHttpServer())
      .post('/bills')
      .set(authHeaders())
      .send({
        vendorId,
        billDate: '2023-01-01',
        dueDate: '2023-02-01',
        billNumber: faker.string.alphanumeric(12),
        open: true,
        isInclusiveTax: false,
        branchId: 1,
        warehouseId: 1,
        entries: lines(),
      })
      .expect(201);
    const billRes = await request(app.getHttpServer())
      .get(`/bills/${res.body.id}`)
      .set(authHeaders())
      .expect(200);
    const bill = billRes.body.data ?? billRes.body;

    expect(Number(bill.subtotal)).toBe(90);
    expect(Number(bill.total)).toBe(103.5);

    const legs = await fetchLegs('Bill', res.body.id, 'accrual');
    expectBalanced(legs);
    const payable = legs.find((leg) => leg.contactId === vendorId);
    expect(payable.credit.amount).toBe(103.5);
  });
});
