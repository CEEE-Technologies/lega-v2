import { faker } from '@faker-js/faker';
import { Knex } from 'knex';
import { app } from './init-app-test';
import { as, Company, createCompany, tenantKnex } from './_utils/security';

/**
 * F8: deleting a customer or vendor that has transactions is refused with
 * CUSTOMER_HAS_TRANSACTIONS / VENDOR_HAS_TRANSACTIONS (400, with the kinds
 * of records), instead of the database refusing it with a raw 500. Once the
 * records are deleted, the contact can be.
 */
jest.retryTimes(0);

const DATE = '2026-05-01';

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F8: deleting a contact with transactions (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let bankId: number;
  let itemId: number;
  const uid = () => faker.string.alphanumeric(8);
  const entries = () => [{ index: 1, itemId, quantity: 1, rate: 100 }];

  const hasTransactions = (res: any, type: string, kinds: string[]) => {
    expect({ status: res.status, type: res.body?.errors?.[0]?.type }).toEqual({
      status: 400,
      type,
    });
    expect(res.body.errors[0].payload?.transactions ?? []).toEqual(kinds);
  };

  const vendor = async () =>
    ok(
      await api()
        .post('/vendors')
        .send({ displayName: `F8 vendor ${uid()}`, currencyCode: 'USD' }),
    ).body.id as number;
  const customer = async () =>
    ok(
      await api()
        .post('/customers')
        .send({
          displayName: `F8 customer ${uid()}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id as number;

  const exists = async (id: number) =>
    (await db('contacts').where({ id })).length === 1;

  beforeAll(async () => {
    company = await createCompany(app, 'r4contact');
    db = tenantKnex(app, company);
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    bankId = await byType('bank');
    itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `F8 service ${uid()}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: await byType('income'),
          costAccountId: await byType('cost-of-goods-sold'),
          sellPrice: 100,
          costPrice: 100,
        }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  describe('vendor', () => {
    it('with only a vendor credit: refused with a clear reason, then deleted once the credit is', async () => {
      const vendorId = await vendor();
      const creditId = ok(
        await api()
          .post('/vendor-credits')
          .send({
            vendorId,
            vendorCreditDate: DATE,
            vendorCreditNumber: `F8-VC-${uid()}`,
            open: true,
            entries: entries(),
          }),
      ).body.id;

      hasTransactions(
        await api().delete(`/vendors/${vendorId}`),
        'VENDOR_HAS_TRANSACTIONS',
        ['vendor_credits'],
      );
      expect(await exists(vendorId)).toBe(true);

      ok(await api().delete(`/vendor-credits/${creditId}`));
      ok(await api().delete(`/vendors/${vendorId}`));
      expect(await exists(vendorId)).toBe(false);
    });

    it('with a bill and its payment: refused, then deleted once both are', async () => {
      const vendorId = await vendor();
      const billId = ok(
        await api()
          .post('/bills')
          .send({
            vendorId,
            billDate: DATE,
            dueDate: DATE,
            billNumber: `F8-B-${uid()}`,
            open: true,
            entries: entries(),
          }),
      ).body.id;
      const paymentId = ok(
        await api()
          .post('/bill-payments')
          .send({
            vendorId,
            paymentDate: DATE,
            amount: 100,
            exchangeRate: 1,
            paymentAccountId: bankId,
            paymentNumber: `F8-BP-${uid()}`,
            entries: [{ index: 1, billId, paymentAmount: 100 }],
          }),
      ).body.id;

      hasTransactions(
        await api().delete(`/vendors/${vendorId}`),
        'VENDOR_HAS_TRANSACTIONS',
        ['bills', 'payments'],
      );
      ok(await api().delete(`/bill-payments/${paymentId}`));
      hasTransactions(
        await api().delete(`/vendors/${vendorId}`),
        'VENDOR_HAS_TRANSACTIONS',
        ['bills'],
      );
      ok(await api().delete(`/bills/${billId}`));
      ok(await api().delete(`/vendors/${vendorId}`));
      expect(await exists(vendorId)).toBe(false);
    });

    it('bulk delete lists it as not deletable, and deletes the one without transactions', async () => {
      const busy = await vendor();
      const free = await vendor();
      ok(
        await api()
          .post('/vendor-credits')
          .send({
            vendorId: busy,
            vendorCreditDate: DATE,
            vendorCreditNumber: `F8-VC-${uid()}`,
            open: true,
            entries: entries(),
          }),
      );
      const check = ok(
        await api()
          .post('/vendors/validate-bulk-delete')
          .send({ ids: [busy, free] }),
      ).body;
      expect(check.nonDeletableIds ?? check.non_deletable_ids).toEqual([busy]);
      expect(check.deletableIds ?? check.deletable_ids).toEqual([free]);
      expect(await exists(busy)).toBe(true);
      expect(await exists(free)).toBe(true);
    });
  });

  describe('customer', () => {
    it('with an invoice, a payment, a receipt and an estimate: refused, then deleted once they are', async () => {
      const customerId = await customer();
      const invoiceId = ok(
        await api()
          .post('/sale-invoices')
          .send({
            customerId,
            invoiceDate: DATE,
            dueDate: DATE,
            invoiceNo: `F8-INV-${uid()}`,
            delivered: true,
            entries: entries(),
          }),
      ).body.id;
      const paymentId = ok(
        await api()
          .post('/payments-received')
          .send({
            customerId,
            paymentDate: DATE,
            exchangeRate: 1,
            depositAccountId: bankId,
            paymentReceiveNo: `F8-PR-${uid()}`,
            amount: 100,
            entries: [{ index: 1, invoiceId, paymentAmount: 100 }],
          }),
      ).body.id;
      const receiptId = ok(
        await api()
          .post('/sale-receipts')
          .send({
            customerId,
            depositAccountId: bankId,
            receiptDate: DATE,
            receiptNumber: `F8-SR-${uid()}`,
            closed: true,
            entries: entries(),
          }),
      ).body.id;
      const estimateId = ok(
        await api()
          .post('/sale-estimates')
          .send({
            customerId,
            estimateDate: DATE,
            expirationDate: DATE,
            estimateNumber: `F8-EST-${uid()}`,
            entries: entries(),
          }),
      ).body.id;

      hasTransactions(
        await api().delete(`/customers/${customerId}`),
        'CUSTOMER_HAS_TRANSACTIONS',
        ['invoices', 'receipts', 'estimates', 'payments'],
      );
      expect(await exists(customerId)).toBe(true);

      ok(await api().delete(`/payments-received/${paymentId}`));
      ok(await api().delete(`/sale-invoices/${invoiceId}`));
      ok(await api().delete(`/sale-receipts/${receiptId}`));
      hasTransactions(
        await api().delete(`/customers/${customerId}`),
        'CUSTOMER_HAS_TRANSACTIONS',
        ['estimates'],
      );
      ok(await api().delete(`/sale-estimates/${estimateId}`));
      ok(await api().delete(`/customers/${customerId}`));
      expect(await exists(customerId)).toBe(false);
    });

    it('a customer on a manual journal line is refused (that line has no foreign key)', async () => {
      const customerId = await customer();
      const receivable = (
        await db('accounts')
          .where('accountType', 'accounts-receivable')
          .first('id')
      ).id;
      const income = (
        await db('accounts').where('accountType', 'income').first('id')
      ).id;
      ok(
        await api()
          .post('/manual-journals')
          .send({
            date: DATE,
            journalNumber: `F8-MJ-${uid()}`,
            publish: true,
            entries: [
              {
                index: 1,
                accountId: receivable,
                contactId: customerId,
                debit: 50,
                credit: 0,
              },
              { index: 2, accountId: income, debit: 0, credit: 50 },
            ],
          }),
      );
      hasTransactions(
        await api().delete(`/customers/${customerId}`),
        'CUSTOMER_HAS_TRANSACTIONS',
        ['manual_journals'],
      );
      expect(await exists(customerId)).toBe(true);
    });

    it('a customer with only an opening balance can still be deleted', async () => {
      const customerId = ok(
        await api()
          .post('/customers')
          .send({
            displayName: `F8 opening ${uid()}`,
            customerType: 'business',
            currencyCode: 'USD',
            openingBalance: 75,
            openingBalanceAt: DATE,
          }),
      ).body.id;
      ok(await api().delete(`/customers/${customerId}`));
      expect(await exists(customerId)).toBe(false);
      expect(
        await db('accounts_transactions').where({ contactId: customerId }),
      ).toEqual([]);
    });
  });
});
