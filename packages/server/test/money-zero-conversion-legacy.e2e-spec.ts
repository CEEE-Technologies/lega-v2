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
 * Codex (cash basis): a payment that converts to 0.00 was not recognized.
 * A EUR 0.03 document at 0.4 (USD 0.01 accrued) paid as 3 x EUR 0.01 (each
 * 0.004 -> 0.00) never had its income / expense in cash basis. The cent is
 * now recognized on the payment where the running total crosses it,
 * balanced by exchange gain/loss.
 *
 * Codex (migration): a row in another currency at rate 1 is not base
 * currency. Its legacy amount (0.333) has no stored foreign amount and is
 * read as base / rate, so deleting it takes off exactly what it added.
 */
const BANK_ACCOUNT_ID = 1000;
const DATE = '2035-09-01';

const SIDES = [
  {
    label: 'received payments',
    contactKind: 'customers' as const,
    documentPath: '/sale-invoices',
    documentType: 'SaleInvoice',
    paymentPath: '/payments-received',
    paymentType: 'PaymentReceive',
    documentKey: 'invoiceId',
    arapType: 'accounts-receivable',
    // The service item's income account (credit) / cost account (debit).
    lineAccountId: 1026,
    lineSign: -1,
    documentBody: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) => ({
      customerId: contactId,
      invoiceDate: DATE,
      dueDate: DATE,
      invoiceNo: faker.string.uuid(),
      exchangeRate: rate,
      delivered: true,
      branchId: 1,
      warehouseId: 1,
      entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
    }),
    paymentBody: (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
    ) => ({
      customerId: contactId,
      paymentDate: DATE,
      amount,
      exchangeRate: rate,
      depositAccountId: BANK_ACCOUNT_ID,
      paymentReceiveNo: faker.string.uuid(),
      entries: [{ index: 1, invoiceId: documentId, paymentAmount: amount }],
      branchId: 1,
    }),
  },
  {
    label: 'bill payments',
    contactKind: 'vendors' as const,
    documentPath: '/bills',
    documentType: 'Bill',
    paymentPath: '/bill-payments',
    paymentType: 'BillPayment',
    documentKey: 'billId',
    arapType: 'accounts-payable',
    lineAccountId: 1019,
    lineSign: 1,
    documentBody: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) => ({
      vendorId: contactId,
      billDate: DATE,
      dueDate: DATE,
      billNumber: faker.string.uuid(),
      exchangeRate: rate,
      open: true,
      branchId: 1,
      warehouseId: 1,
      entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
    }),
    paymentBody: (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
    ) => ({
      vendorId: contactId,
      paymentDate: DATE,
      amount,
      exchangeRate: rate,
      paymentAccountId: BANK_ACCOUNT_ID,
      paymentNumber: faker.string.uuid(),
      entries: [{ index: 1, billId: documentId, paymentAmount: amount }],
      branchId: 1,
    }),
  },
];

describe.each(SIDES)(
  'Money — zero conversions and legacy foreign rows: $label (e2e)',
  (side) => {
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

    const createContact = async () => {
      const res = await request(app.getHttpServer())
        .post(`/${side.contactKind}`)
        .set(authHeaders())
        .send({
          displayName: `Zero conv ${side.contactKind} ${faker.string.alphanumeric(10)}`,
          currencyCode: 'EUR',
          ...(side.contactKind === 'customers'
            ? { customerType: 'business' }
            : {}),
        })
        .expect(201);
      return res.body.id as number;
    };

    const createDocument = async (
      contactId: number,
      amount: number,
      rate: number,
    ) => {
      const res = await request(app.getHttpServer())
        .post(side.documentPath)
        .set(authHeaders())
        .send(side.documentBody(contactId, itemId, amount, rate));
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
      return res.body.id as number;
    };

    const pay = async (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
    ) => {
      const res = await request(app.getHttpServer())
        .post(side.paymentPath)
        .set(authHeaders())
        .send(side.paymentBody(contactId, documentId, amount, rate));
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
      return res.body.id as number;
    };

    /** Net cents (debit - credit) of the rows of the references on the account. */
    const netCents = async (
      referenceType: string,
      referenceIds: number[],
      accountId: number,
      basis: 'cash' | 'accrual',
    ) => {
      const rows = await getTenantKnex()('accounts_transactions')
        .where({ referenceType, accountId })
        .whereIn('referenceId', referenceIds)
        .select('debit', 'credit', 'basis');
      return rows
        .filter((row) =>
          basis === 'cash' ? row.basis === 'cash' : row.basis !== 'cash',
        )
        .reduce(
          (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
          0,
        );
    };

    it("Codex's case: EUR 0.03 at 0.4 paid as 3 x 0.01 recognizes the cent in cash basis", async () => {
      const contactId = await createContact();
      const documentId = await createDocument(contactId, 0.03, 0.4);
      const payments = [];
      for (let i = 0; i < 3; i += 1)
        payments.push(await pay(contactId, documentId, 0.01, 0.4));

      // Accrual: USD 0.01 of income / expense on the document.
      const accrual = await netCents(
        side.documentType,
        [documentId],
        side.lineAccountId,
        'accrual',
      );
      expect(accrual * side.lineSign).toBe(1);
      // Cash: the same cent, over the three payments.
      const cash = await netCents(
        side.paymentType,
        payments,
        side.lineAccountId,
        'cash',
      );
      expect(cash).toBe(accrual);

      // Nothing left as unearned revenue / prepaid, and parts d and f clean.
      const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
      expect(
        health.cashDocumentDifferences.filter(
          (row) =>
            row.documentType === side.documentType &&
            row.documentId === documentId,
        ),
      ).toEqual([]);
      expect(
        (health.paymentBankDifferences ?? []).filter(
          (row) =>
            row.paymentType === side.paymentType &&
            payments.includes(row.paymentId),
        ),
      ).toEqual([]);
      for (const slug of ['unearned-revenue', 'prepaid-expenses']) {
        const account = await getTenantKnex()('accounts')
          .where({ slug })
          .first();
        if (!account) continue;
        expect(
          await netCents(side.paymentType, payments, account.id, 'cash'),
        ).toBe(0);
      }
    });

    it('takes a legacy EUR row at rate 1 (0.333) off exactly when its document is deleted', async () => {
      const knex = getTenantKnex();
      const contactId = await createContact();
      const documentId = await createDocument(contactId, 1, 1);
      const arapAccounts = await knex('accounts')
        .where({ accountType: side.arapType, currencyCode: 'EUR' })
        .select('id', 'amount');
      const accountsBefore = arapAccounts.reduce(
        (sum, a) => sum + Number(a.amount || 0),
        0,
      );

      // Make the document's rows legacy: 0.333 (3 decimals, as stored before
      // the rounding fixes) and no foreign amounts. The stored balances are
      // what the old code would have saved for them.
      const rows = await knex('accounts_transactions')
        .where({ referenceType: side.documentType, referenceId: documentId })
        .select('id', 'debit', 'credit', 'accountId');
      for (const row of rows) {
        await knex('accounts_transactions')
          .where({ id: row.id })
          .update({
            debit: Number(row.debit) > 0 ? 0.333 : 0,
            credit: Number(row.credit) > 0 ? 0.333 : 0,
            foreignDebit: null,
            foreignCredit: null,
          });
      }
      await knex('contacts')
        .where({ id: contactId })
        .update({ balance: 0.333 });
      // Each row was 1.00 on its account's normal side, now 0.333.
      for (const row of rows) {
        await knex('accounts')
          .where({ id: row.accountId })
          .update({ amount: knex.raw('?? - ?', ['amount', 1 - 0.333]) });
      }

      await request(app.getHttpServer())
        .delete(`${side.documentPath}/${documentId}`)
        .set(authHeaders())
        .expect(200);

      // Rounded to 0.33 on the way out, 0.003 was left behind.
      const contact = await knex('contacts').where({ id: contactId }).first();
      expect(Number(contact.balance)).toBe(0);
      const accountsAfter = (
        await knex('accounts')
          .where({ accountType: side.arapType, currencyCode: 'EUR' })
          .select('amount')
      ).reduce((sum, a) => sum + Number(a.amount || 0), 0);
      expect(
        Math.round((accountsAfter - (accountsBefore - 1)) * 100000) / 100000,
      ).toBe(0);
    });
  },
);
