import request = require('supertest');
import { faker } from '@faker-js/faker';
import { toCents } from '@bigcapital/utils';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createServiceItem,
  getBaseCurrency,
} from './_utils/gl';
import { closeTenantKnex, getTenantKnex } from './_utils/money-matrix';
import { checkMoneyHealth } from '../src/modules/AccountingBasis/MoneyHealthCheck';

/**
 * Codex: the write-off's base amount was round(written off x rate) on its
 * own, while payments relieve A/R with a running total at the invoice rate.
 * A written-off foreign invoice left A/R a cent off:
 * - EUR 0.02 at 1.5 (0.03), paid 0.01 (0.02), written off 0.01 as 0.02 -> -0.01,
 * - EUR 101.00 at 300.005 (30,300.51), paid 50.50 (15,150.25), written off
 *   50.50 as 15,150.25 -> +0.01.
 * The write-off now takes what is left at the invoice rate, so A/R ends at 0,
 * and cancelling it reverses exactly what it posted.
 */
const DATE = '2035-11-01';
const BAD_DEBT_ACCOUNT_ID = 1024;

describe('Money — invoice write-off clears A/R to the cent (e2e)', () => {
  let itemId: number;
  let baseCurrency: string;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    itemId = await createServiceItem();
  });

  afterAll(async () => {
    await closeTenantKnex();
  });

  const createCustomer = async () => {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(authHeaders())
      .send({
        displayName: `Write-off ${faker.string.alphanumeric(10)}`,
        customerType: 'business',
        currencyCode: 'EUR',
      })
      .expect(201);
    return res.body.id as number;
  };

  const createInvoice = async (
    customerId: number,
    amount: number,
    rate: number,
  ) => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate: DATE,
        dueDate: DATE,
        invoiceNo: faker.string.uuid(),
        exchangeRate: rate,
        delivered: true,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
      })
      .expect(201);
    return res.body.id as number;
  };

  const pay = (
    customerId: number,
    invoiceId: number,
    amount: number,
    rate: number,
  ) =>
    request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate: DATE,
        amount,
        exchangeRate: rate,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        entries: [{ index: 1, invoiceId, paymentAmount: amount }],
        branchId: 1,
      })
      .expect(201);

  const writeOff = (invoiceId: number) =>
    request(app.getHttpServer())
      .post(`/sale-invoices/${invoiceId}/writeoff`)
      .set(authHeaders())
      .send({
        expenseAccountId: BAD_DEBT_ACCOUNT_ID,
        date: DATE,
        reason: 'Bad debt',
      })
      .expect(200);

  const cancelWriteOff = (invoiceId: number) =>
    request(app.getHttpServer())
      .post(`/sale-invoices/${invoiceId}/cancel-writeoff`)
      .set(authHeaders())
      .expect(200);

  /** The customer's A/R in the ledger, base currency cents (accrual). */
  const receivableCents = async (customerId: number) => {
    const rows = await getTenantKnex()('accounts_transactions as t')
      .join('accounts as a', 'a.id', 't.accountId')
      .where('t.contactId', customerId)
      .where('a.accountType', 'accounts-receivable')
      .where((b) => b.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'))
      .select('t.debit', 't.credit');
    return rows.reduce(
      (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
      0,
    );
  };

  const writeoffCreditCents = async (invoiceId: number) => {
    const rows = await getTenantKnex()('accounts_transactions')
      .where({ referenceType: 'InvoiceWriteOff', referenceId: invoiceId })
      .whereNotNull('contactId')
      .select('credit');
    return rows.reduce((sum, row) => sum + toCents(row.credit), 0);
  };

  const contactBalance = async (customerId: number) =>
    Number(
      (await getTenantKnex()('contacts').where({ id: customerId }).first())
        .balance || 0,
    );

  const expectContactHealthy = async (customerId: number) => {
    const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
    expect(
      health.balanceDifferences.filter(
        (row) => row.kind === 'contact' && row.id === customerId,
      ),
    ).toEqual([]);
  };

  it.each([
    // [label, amount, rate, paid, expected write-off (base), A/R before]
    ['EUR 0.02 at 1.5 paid 0.01 (A/R was -0.01)', 0.02, 1.5, 0.01, 1, 1],
    [
      'EUR 101.00 at 300.005 paid 50.50 (A/R was +0.01)',
      101,
      300.005,
      50.5,
      1515026,
      1515026,
    ],
    [
      'EUR 101.00 at 300.005 with no payment',
      101,
      300.005,
      0,
      3030051,
      3030051,
    ],
  ])(
    '%s: writes off what is left and A/R ends at 0',
    async (_label, amount, rate, paid, writeoff, before) => {
      const customerId = await createCustomer();
      const invoiceId = await createInvoice(customerId, amount, rate);
      if (paid) await pay(customerId, invoiceId, paid, rate);
      expect(await receivableCents(customerId)).toBe(before);

      await writeOff(invoiceId);
      expect(await writeoffCreditCents(invoiceId)).toBe(writeoff);
      expect(await receivableCents(customerId)).toBe(0);
      expect(await contactBalance(customerId)).toBe(0);
      await expectContactHealthy(customerId);

      // Cancelling reverses exactly what the write-off posted.
      await cancelWriteOff(invoiceId);
      expect(await writeoffCreditCents(invoiceId)).toBe(0);
      expect(await receivableCents(customerId)).toBe(before);
      expect(await contactBalance(customerId)).toBe(
        Math.round((amount - paid) * 100) / 100,
      );
      await expectContactHealthy(customerId);

      // Writing it off again ends at 0 again.
      await writeOff(invoiceId);
      expect(await receivableCents(customerId)).toBe(0);
    },
  );
});
