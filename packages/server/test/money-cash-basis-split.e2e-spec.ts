import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createTaxRate,
  fetchLegs,
  getBaseCurrency,
  GLTestLeg,
} from './_utils/gl';

/**
 * Cash basis running-total split (P5): however an invoice is paid (several
 * payments, a deleted or back-dated one), once it is fully paid its cash
 * basis lines add up exactly to the invoice, account by account.
 *
 * Invoice: 3 lines of 100 with 10% tax = income 300.00 + tax 30.00 = 330.00.
 * Paid 100 / 100 / 130: each 100 is 100/330 of the invoice (90.909.. income
 * and 9.0909.. tax), which per-payment rounding can't end exact.
 */
describe('Money — cash basis running-total split (e2e)', () => {
  let customerId: number;
  let itemId: number;
  let taxRate10: number;

  const INCOME_CODE = '50002';
  const TAX_CODE = '20006';

  beforeAll(async () => {
    await cancelTransactionsLock();
    const baseCurrency = await getBaseCurrency();
    customerId = await createCustomer(baseCurrency);
    itemId = await createServiceItem();
    taxRate10 = await createTaxRate(10);
  });

  const createInvoice = async () => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate: '2025-01-01',
        dueDate: '2025-02-01',
        invoiceNo: faker.string.uuid(),
        delivered: true,
        isInclusiveTax: false,
        branchId: 1,
        warehouseId: 1,
        entries: [1, 2, 3].map((index) => ({
          index,
          itemId,
          quantity: 1,
          rate: 100,
          taxRateId: taxRate10,
        })),
      })
      .expect(201);
    return res.body.id;
  };

  const pay = async (
    invoiceId: number,
    amount: number,
    paymentDate: string,
  ) => {
    const res = await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate,
        exchangeRate: 1,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount,
        entries: [{ index: 1, invoiceId, paymentAmount: amount }],
        branchId: 1,
      })
      .expect(201);
    return res.body.id;
  };

  const cashLegsOf = async (paymentIds: number[]) =>
    (
      await Promise.all(
        paymentIds.map((id) => fetchLegs('PaymentReceive', id, 'cash')),
      )
    )
      .flat()
      .filter((leg) => leg.basis === 'cash');

  const creditsOn = (legs: GLTestLeg[], code: string) =>
    Math.round(
      legs
        .filter((leg) => leg.accountCode === code)
        .reduce((sum, leg) => sum + leg.credit.amount - leg.debit.amount, 0) *
        100,
    ) / 100;

  const expectEndsExact = async (paymentIds: number[]) => {
    const legs = await cashLegsOf(paymentIds);
    expect(creditsOn(legs, INCOME_CODE)).toBe(300);
    expect(creditsOn(legs, TAX_CODE)).toBe(30);
    legs.forEach((leg) => {
      expect(Math.round(leg.debit.amount * 100) / 100).toBe(leg.debit.amount);
      expect(Math.round(leg.credit.amount * 100) / 100).toBe(leg.credit.amount);
    });
  };

  it('ends income and tax exact after three payments of 100 / 100 / 130', async () => {
    const invoiceId = await createInvoice();
    const payments = [
      await pay(invoiceId, 100, '2025-01-05'),
      await pay(invoiceId, 100, '2025-01-06'),
      await pay(invoiceId, 130, '2025-01-07'),
    ];
    await expectEndsExact(payments);
  });

  it('still ends exact when the middle payment is deleted and paid again', async () => {
    const invoiceId = await createInvoice();
    const first = await pay(invoiceId, 100, '2025-01-05');
    const middle = await pay(invoiceId, 100, '2025-01-06');
    const last = await pay(invoiceId, 130, '2025-01-07');

    await request(app.getHttpServer())
      .delete(`/payments-received/${middle}`)
      .set(authHeaders())
      .expect(200);
    const again = await pay(invoiceId, 100, '2025-01-08');

    await expectEndsExact([first, last, again]);
  });

  it('still ends exact when a payment is back-dated before the others', async () => {
    const invoiceId = await createInvoice();
    const first = await pay(invoiceId, 100, '2025-01-10');
    const second = await pay(invoiceId, 100, '2025-01-11');
    // Dated before both: the later payments' splits are rebuilt in order.
    const backDated = await pay(invoiceId, 130, '2025-01-02');

    await expectEndsExact([first, second, backDated]);
  });
});
