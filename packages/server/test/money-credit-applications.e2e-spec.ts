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
 * Codex: applying a credit (credit note / vendor credit) to a document
 * posted nothing. The credit relieved A/R (A/P) at its own rate when it was
 * posted, the document needs its own rate:
 * - same rate, rounding: EUR 100.02 at 1.5 (150.03), credit 50.01 (75.02),
 *   pay the other 50.01 (75.02) -> A/R -0.01;
 * - rates differ: invoice EUR 50.01 at 1.5 (75.02), credit EUR 50.01 at 1.6
 *   (80.02) applied -> A/R -5.00, no exchange gain/loss.
 * Each application now posts the difference, A/R (A/P) <-> exchange gain or
 * loss, so a fully settled document's A/R (A/P) ends at exactly 0 whatever
 * the order of payments and credits.
 */
const DATE = '2035-12-01';
const PAST = '2025-01-15';

const SIDES = [
  {
    label: 'credit notes on invoices',
    contactKind: 'customers' as const,
    arapType: 'accounts-receivable',
    documentType: 'SaleInvoice' as const,
    applicationsTable: 'credit_note_applied_invoice',
    creditIdColumn: 'creditNoteId',
    referenceType: 'CreditNoteApplyInvoice',
    canWriteOff: true,
    createDocument: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) =>
      request(app.getHttpServer())
        .post('/sale-invoices')
        .set(authHeaders())
        .send({
          customerId: contactId,
          invoiceDate: PAST,
          dueDate: PAST,
          invoiceNo: faker.string.uuid(),
          exchangeRate: rate,
          delivered: true,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    createCredit: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) =>
      request(app.getHttpServer())
        .post('/credit-notes')
        .set(authHeaders())
        .send({
          customerId: contactId,
          creditNoteDate: PAST,
          creditNoteNumber: faker.string.alphanumeric(12),
          open: true,
          exchangeRate: rate,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    apply: (creditId: number, documentId: number, amount: number) =>
      request(app.getHttpServer())
        .post(`/credit-notes/${creditId}/apply-invoices`)
        .set(authHeaders())
        .send({ entries: [{ invoiceId: documentId, amount }] }),
    unapply: (applicationId: number) =>
      request(app.getHttpServer())
        .delete(`/credit-notes/applied-invoices/${applicationId}`)
        .set(authHeaders()),
    deleteCredit: (creditId: number) =>
      request(app.getHttpServer())
        .delete(`/credit-notes/${creditId}`)
        .set(authHeaders()),
    pay: (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
      date: string,
    ) =>
      request(app.getHttpServer())
        .post('/payments-received')
        .set(authHeaders())
        .send({
          customerId: contactId,
          paymentDate: date,
          amount,
          exchangeRate: rate,
          depositAccountId: 1000,
          paymentReceiveNo: faker.string.uuid(),
          entries: [{ index: 1, invoiceId: documentId, paymentAmount: amount }],
          branchId: 1,
        }),
    deletePayment: (paymentId: number) =>
      request(app.getHttpServer())
        .delete(`/payments-received/${paymentId}`)
        .set(authHeaders()),
  },
  {
    label: 'vendor credits on bills',
    contactKind: 'vendors' as const,
    arapType: 'accounts-payable',
    documentType: 'Bill' as const,
    applicationsTable: 'vendor_credit_applied_bill',
    creditIdColumn: 'vendorCreditId',
    referenceType: 'VendorCreditApplyBill',
    canWriteOff: false,
    createDocument: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) =>
      request(app.getHttpServer())
        .post('/bills')
        .set(authHeaders())
        .send({
          vendorId: contactId,
          billDate: PAST,
          dueDate: PAST,
          billNumber: faker.string.uuid(),
          exchangeRate: rate,
          open: true,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    createCredit: (
      contactId: number,
      itemId: number,
      amount: number,
      rate: number,
    ) =>
      request(app.getHttpServer())
        .post('/vendor-credits')
        .set(authHeaders())
        .send({
          vendorId: contactId,
          vendorCreditDate: PAST,
          vendorCreditNumber: faker.string.alphanumeric(12),
          open: true,
          exchangeRate: rate,
          branchId: 1,
          warehouseId: 1,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    apply: (creditId: number, documentId: number, amount: number) =>
      request(app.getHttpServer())
        .post(`/vendor-credits/${creditId}/apply-to-bills`)
        .set(authHeaders())
        .send({ entries: [{ billId: documentId, amount }] }),
    unapply: (applicationId: number) =>
      request(app.getHttpServer())
        .delete(`/vendor-credits/applied-bills/${applicationId}`)
        .set(authHeaders()),
    deleteCredit: (creditId: number) =>
      request(app.getHttpServer())
        .delete(`/vendor-credits/${creditId}`)
        .set(authHeaders()),
    pay: (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
      date: string,
    ) =>
      request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send({
          vendorId: contactId,
          paymentDate: date,
          amount,
          exchangeRate: rate,
          paymentAccountId: 1000,
          paymentNumber: faker.string.uuid(),
          entries: [{ index: 1, billId: documentId, paymentAmount: amount }],
          branchId: 1,
        }),
    deletePayment: (paymentId: number) =>
      request(app.getHttpServer())
        .delete(`/bill-payments/${paymentId}`)
        .set(authHeaders()),
  },
];

const ok = async (response: request.Test, status = [200, 201]) => {
  const res = await response;
  if (!status.includes(res.status))
    throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
  return res;
};

describe.each(SIDES)(
  'Money — credits applied in a foreign currency: $label (e2e)',
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

    const createContact = async (currencyCode = 'EUR') => {
      const res = await request(app.getHttpServer())
        .post(`/${side.contactKind}`)
        .set(authHeaders())
        .send({
          displayName: `Credit FX ${side.contactKind} ${faker.string.alphanumeric(10)}`,
          currencyCode,
          ...(side.contactKind === 'customers'
            ? { customerType: 'business' }
            : {}),
        })
        .expect(201);
      return res.body.id as number;
    };

    const documentOf = async (
      contactId: number,
      amount: number,
      rate: number,
    ) =>
      (await ok(side.createDocument(contactId, itemId, amount, rate))).body
        .id as number;
    const creditOf = async (contactId: number, amount: number, rate: number) =>
      (await ok(side.createCredit(contactId, itemId, amount, rate))).body
        .id as number;
    const apply = async (
      creditId: number,
      documentId: number,
      amount: number,
    ) => {
      await ok(side.apply(creditId, documentId, amount));
      const row = await getTenantKnex()(side.applicationsTable)
        .where({ [side.creditIdColumn]: creditId })
        .orderBy('id', 'desc')
        .first();
      return row.id as number;
    };
    const pay = async (
      contactId: number,
      documentId: number,
      amount: number,
      rate: number,
      date = DATE,
    ) =>
      (await ok(side.pay(contactId, documentId, amount, rate, date))).body
        .id as number;

    /** The contact's A/R (A/P) in the ledger, base cents (accrual). */
    const arapCents = async (contactId: number) => {
      const rows = await getTenantKnex()('accounts_transactions as t')
        .join('accounts as a', 'a.id', 't.accountId')
        .where('t.contactId', contactId)
        .where('a.accountType', side.arapType)
        .where((b) => b.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'))
        .select('t.debit', 't.credit');
      return rows.reduce(
        (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
        0,
      );
    };

    /** The exchange gain/loss lines of the application (debit - credit cents). */
    const exchangeCents = async (applicationId: number) => {
      const rows = await getTenantKnex()('accounts_transactions as t')
        .join('accounts as a', 'a.id', 't.accountId')
        .where({
          't.referenceType': side.referenceType,
          't.referenceId': applicationId,
        })
        .whereNot('a.accountType', side.arapType)
        .select('t.debit', 't.credit');
      return rows.reduce(
        (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
        0,
      );
    };

    const expectSettled = async (contactId: number, documentId: number) => {
      expect(await arapCents(contactId)).toBe(0);
      const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
      expect(
        (health.settledDocumentDifferences ?? []).filter(
          (row) =>
            row.documentType === side.documentType &&
            row.documentId === documentId,
        ),
      ).toEqual([]);
      expect(
        health.unbalancedSets.filter(
          (row) => row.referenceType === side.referenceType,
        ),
      ).toEqual([]);
    };

    it("Codex's case, credit then payment: EUR 100.02 at 1.5 ends at 0", async () => {
      const contactId = await createContact();
      const documentId = await documentOf(contactId, 100.02, 1.5);
      const creditId = await creditOf(contactId, 50.01, 1.5);
      await apply(creditId, documentId, 50.01);
      await pay(contactId, documentId, 50.01, 1.5);
      await expectSettled(contactId, documentId);
    });

    it("Codex's case, payment then credit: EUR 100.02 at 1.5 ends at 0", async () => {
      const contactId = await createContact();
      const documentId = await documentOf(contactId, 100.02, 1.5);
      await pay(contactId, documentId, 50.01, 1.5, PAST);
      const creditId = await creditOf(contactId, 50.01, 1.5);
      await apply(creditId, documentId, 50.01);
      await expectSettled(contactId, documentId);
    });

    it.each([
      ['gain', 1.6, 500],
      ['loss', 1.4, -501],
    ])(
      'posts the rate difference as exchange %s (credit at %s)',
      async (_label, rate, arapCentsMoved) => {
        const contactId = await createContact();
        const documentId = await documentOf(contactId, 50.01, 1.5);
        const creditId = await creditOf(contactId, 50.01, rate);
        const applicationId = await apply(creditId, documentId, 50.01);
        await expectSettled(contactId, documentId);
        // Receivable: the credit took 80.02 off A/R for a 75.02 invoice, so A/R
        // is debited back 5.00 and exchange gain/loss credited (and mirrored
        // for payables).
        const sign = side.arapType === 'accounts-receivable' ? 1 : -1;
        expect(await exchangeCents(applicationId)).toBe(-sign * arapCentsMoved);
      },
    );

    it('unapplies, re-applies and deletes the credit to the cent', async () => {
      const contactId = await createContact();
      const documentId = await documentOf(contactId, 50.01, 1.5);
      const creditId = await creditOf(contactId, 50.01, 1.6);
      const applicationId = await apply(creditId, documentId, 50.01);
      await expectSettled(contactId, documentId);

      await ok(side.unapply(applicationId));
      // Both stand on their own again: 75.02 owed, 80.02 credited.
      const sign = side.arapType === 'accounts-receivable' ? 1 : -1;
      expect(await arapCents(contactId)).toBe(sign * (7502 - 8002));
      expect(await exchangeCents(applicationId)).toBe(0);

      await apply(creditId, documentId, 50.01);
      await expectSettled(contactId, documentId);

      const reapplied = await getTenantKnex()(side.applicationsTable)
        .where({ [side.creditIdColumn]: creditId })
        .first();
      await ok(side.unapply(reapplied.id));
      await ok(side.deleteCredit(creditId));
      expect(await arapCents(contactId)).toBe(sign * 7502);
    });

    it('follows a deleted payment to the cent', async () => {
      const contactId = await createContact();
      const documentId = await documentOf(contactId, 100.02, 1.5);
      const creditId = await creditOf(contactId, 50.01, 1.5);
      await apply(creditId, documentId, 50.01);
      const paymentId = await pay(contactId, documentId, 50.01, 1.5);
      await expectSettled(contactId, documentId);

      await ok(side.deletePayment(paymentId));
      // What is left is the unpaid EUR 50.01 at the invoice rate: 150.03 less
      // the credit's 75.02 as the first settlement.
      const sign = side.arapType === 'accounts-receivable' ? 1 : -1;
      expect(await arapCents(contactId)).toBe(sign * 7501);
      await pay(contactId, documentId, 50.01, 1.5);
      await expectSettled(contactId, documentId);
    });

    it('writes off what a credit leaves to the cent', async () => {
      if (!side.canWriteOff) return;
      const contactId = await createContact();
      const documentId = await documentOf(contactId, 100.02, 1.5);
      const creditId = await creditOf(contactId, 50.01, 1.6);
      await apply(creditId, documentId, 50.01);
      await ok(
        request(app.getHttpServer())
          .post(`/sale-invoices/${documentId}/writeoff`)
          .set(authHeaders())
          .send({ expenseAccountId: 1024, date: DATE, reason: 'Bad debt' }),
      );
      await expectSettled(contactId, documentId);
    });

    it('posts nothing for a base currency contact (rate 1)', async () => {
      const contactId = await createContact(baseCurrency);
      const documentId = await documentOf(contactId, 100.02, 1);
      const creditId = await creditOf(contactId, 50.01, 1);
      const applicationId = await apply(creditId, documentId, 50.01);
      await pay(contactId, documentId, 50.01, 1);
      await expectSettled(contactId, documentId);
      const rows = await getTenantKnex()('accounts_transactions').where({
        referenceType: side.referenceType,
        referenceId: applicationId,
      });
      expect(rows).toEqual([]);
    });
  },
);
