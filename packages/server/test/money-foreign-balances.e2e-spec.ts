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
 * Codex P1: a foreign contact's balance (and the foreign A/R or A/P
 * account's) was each ledger row's cent-rounded base amount divided by the
 * rate. A EUR 0.02 invoice at 1.5 (0.03 base) paid as 2 x EUR 0.01 (0.02
 * base each) left the paid-up customer at -0.0067 EUR. The ledger rows now
 * keep the document currency amounts and the balances add those up.
 *
 * Codex P2: a payment listing the same document twice relieved it twice from
 * the same point (0.02 + 0.02 instead of 0.03). It is now rejected.
 */
const BANK_ACCOUNT_ID = 1000;
const DATE = '2035-06-01';

interface Side {
  label: string;
  contactKind: 'customers' | 'vendors';
  documentPath: string;
  paymentPath: string;
  documentKey: 'invoiceId' | 'billId';
  arapType: string;
  duplicateError: string;
  entriesTable: string;
  paymentIdColumn: string;
  documentIdColumn: string;
  documentBody: (
    contactId: number,
    itemId: number,
    amount: number,
    rate: number,
  ) => any;
  paymentBody: (
    contactId: number,
    amount: number,
    rate: number,
    entries: any[],
  ) => any;
}

const SIDES: Side[] = [
  {
    label: 'received payments',
    contactKind: 'customers',
    documentPath: '/sale-invoices',
    paymentPath: '/payments-received',
    documentKey: 'invoiceId',
    arapType: 'accounts-receivable',
    duplicateError: 'PAYMENT_DUPLICATE_INVOICE_ENTRIES',
    entriesTable: 'payment_receives_entries',
    paymentIdColumn: 'paymentReceiveId',
    documentIdColumn: 'invoiceId',
    documentBody: (customerId, itemId, amount, rate) => ({
      customerId,
      invoiceDate: DATE,
      dueDate: DATE,
      invoiceNo: `FXB-${faker.string.alphanumeric(10)}`,
      exchangeRate: rate,
      delivered: true,
      branchId: 1,
      warehouseId: 1,
      entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
    }),
    paymentBody: (customerId, amount, rate, entries) => ({
      customerId,
      paymentDate: DATE,
      amount,
      exchangeRate: rate,
      depositAccountId: BANK_ACCOUNT_ID,
      paymentReceiveNo: faker.string.uuid(),
      entries,
      branchId: 1,
    }),
  },
  {
    label: 'bill payments',
    contactKind: 'vendors',
    documentPath: '/bills',
    paymentPath: '/bill-payments',
    documentKey: 'billId',
    arapType: 'accounts-payable',
    duplicateError: 'PAYMENT_DUPLICATE_BILL_ENTRIES',
    entriesTable: 'bills_payments_entries',
    paymentIdColumn: 'billPaymentId',
    documentIdColumn: 'billId',
    documentBody: (vendorId, itemId, amount, rate) => ({
      vendorId,
      billDate: DATE,
      dueDate: DATE,
      billNumber: `FXB-${faker.string.alphanumeric(10)}`,
      exchangeRate: rate,
      open: true,
      branchId: 1,
      warehouseId: 1,
      entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
    }),
    paymentBody: (vendorId, amount, rate, entries) => ({
      vendorId,
      paymentDate: DATE,
      amount,
      exchangeRate: rate,
      paymentAccountId: BANK_ACCOUNT_ID,
      paymentNumber: faker.string.uuid(),
      entries,
      branchId: 1,
    }),
  },
];

const ensureCurrency = async (currencyCode: string) => {
  const res = await request(app.getHttpServer())
    .get(`/currencies/${currencyCode}`)
    .set(authHeaders());
  if (res.status === 200 && res.body) return;
  await request(app.getHttpServer())
    .post('/currencies')
    .set(authHeaders())
    .send({
      currencyCode,
      currencyName: currencyCode,
      currencySign: currencyCode,
    });
};

describe.each(SIDES)(
  'Money — foreign balances and duplicate lines: $label (e2e)',
  (side) => {
    let itemId: number;
    let baseCurrency: string;

    beforeAll(async () => {
      await cancelTransactionsLock();
      baseCurrency = await getBaseCurrency();
      itemId = await createServiceItem();
      await ensureCurrency('EUR');
      await ensureCurrency('LKR');
    });

    afterAll(async () => {
      await closeTenantKnex();
    });

    const createContact = async (currencyCode: string) => {
      const res = await request(app.getHttpServer())
        .post(`/${side.contactKind}`)
        .set(authHeaders())
        .send({
          displayName: `FX balance ${side.contactKind} ${faker.string.alphanumeric(10)}`,
          currencyCode,
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

    const lines = (entries: [number, number][]) =>
      entries.map(([documentId, paymentAmount], index) => ({
        index: index + 1,
        [side.documentKey]: documentId,
        paymentAmount,
      }));

    const pay = async (
      contactId: number,
      amount: number,
      rate: number,
      entries: [number, number][],
    ) => {
      const res = await request(app.getHttpServer())
        .post(side.paymentPath)
        .set(authHeaders())
        .send(side.paymentBody(contactId, amount, rate, lines(entries)));
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
      return res.body.id as number;
    };

    const editPayment = async (
      paymentId: number,
      contactId: number,
      amount: number,
      rate: number,
      entries: [number, number][],
    ) => {
      const body = side.paymentBody(contactId, amount, rate, lines(entries));
      delete body.paymentReceiveNo;
      delete body.paymentNumber;
      const res = await request(app.getHttpServer())
        .put(`${side.paymentPath}/${paymentId}`)
        .set(authHeaders())
        .send(body);
      if (res.status !== 200 && res.status !== 201)
        throw new Error(JSON.stringify(res.body));
    };

    const deletePayment = (paymentId: number) =>
      request(app.getHttpServer())
        .delete(`${side.paymentPath}/${paymentId}`)
        .set(authHeaders())
        .expect(200);

    /** The stored contact balance, in its currency. */
    const contactBalance = async (contactId: number) => {
      const row = await getTenantKnex()('contacts')
        .where({ id: contactId })
        .first();
      return Number(row.balance || 0);
    };

    /** The stored balances of the A/R or A/P accounts in the currency. */
    const arapBalances = async (currencyCode: string) => {
      const rows = await getTenantKnex()('accounts')
        .where({ accountType: side.arapType, currencyCode })
        .select('id', 'amount');
      return Object.fromEntries(
        rows.map((row) => [row.id, Number(row.amount || 0)]),
      );
    };

    const expectSameBalances = (
      before: Record<string, number>,
      after: Record<string, number>,
      change = 0,
    ) => {
      const total = (balances: Record<string, number>) =>
        Object.values(balances).reduce((sum, value) => sum + value, 0);
      // The stored balance moves by exactly the document amounts.
      expect(Math.round((total(after) - total(before)) * 100000) / 100000).toBe(
        change,
      );
    };

    /** Part (c) of the health check, on this contact. */
    const expectContactHealthy = async (contactId: number) => {
      const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
      expect(
        health.balanceDifferences.filter(
          (row) => row.kind === 'contact' && row.id === contactId,
        ),
      ).toEqual([]);
    };

    it("Codex's case: EUR 0.02 at 1.5 paid as 2 x 0.01 closes the contact and the account at 0", async () => {
      const before = await arapBalances('EUR');
      const contactId = await createContact('EUR');
      const documentId = await createDocument(contactId, 0.02, 1.5);
      expect(await contactBalance(contactId)).toBe(0.02);

      await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);
      expect(await contactBalance(contactId)).toBe(0.01);
      await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);

      // Before the fix: -0.0067 (stored -0.007).
      expect(await contactBalance(contactId)).toBe(0);
      expectSameBalances(before, await arapBalances('EUR'));
      await expectContactHealthy(contactId);
    });

    it('keeps a rate below 1 exact (LKR contact, USD base, rate 0.0033)', async () => {
      const contactId = await createContact('LKR');
      // LKR 1,000.01 is USD 3.30; LKR 0.01 is USD 0.00 but still LKR 0.01.
      const documentId = await createDocument(contactId, 1000.01, 0.0033);
      expect(await contactBalance(contactId)).toBe(1000.01);

      await pay(contactId, 1000, 0.0033, [[documentId, 1000]]);
      expect(await contactBalance(contactId)).toBe(0.01);
      await pay(contactId, 0.01, 0.0033, [[documentId, 0.01]]);
      expect(await contactBalance(contactId)).toBe(0);
      await expectContactHealthy(contactId);
    });

    it('closes several documents paid by one payment', async () => {
      const before = await arapBalances('EUR');
      const contactId = await createContact('EUR');
      const docs = [
        await createDocument(contactId, 0.01, 1.5),
        await createDocument(contactId, 0.01, 1.5),
        await createDocument(contactId, 33.34, 300.005),
      ];
      expect(await contactBalance(contactId)).toBe(33.36);
      await pay(contactId, 33.36, 1.5, [
        [docs[0], 0.01],
        [docs[1], 0.01],
        [docs[2], 33.34],
      ]);
      expect(await contactBalance(contactId)).toBe(0);
      expectSameBalances(before, await arapBalances('EUR'));
      await expectContactHealthy(contactId);
    });

    it('follows an edited and a deleted payment to the cent', async () => {
      const contactId = await createContact('EUR');
      const documentId = await createDocument(contactId, 0.05, 1.5);
      const first = await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);
      const second = await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);
      expect(await contactBalance(contactId)).toBe(0.03);

      await editPayment(first, contactId, 0.03, 1.5, [[documentId, 0.03]]);
      expect(await contactBalance(contactId)).toBe(0.01);

      await deletePayment(second);
      expect(await contactBalance(contactId)).toBe(0.02);
      await pay(contactId, 0.02, 1.5, [[documentId, 0.02]]);
      expect(await contactBalance(contactId)).toBe(0);
      await expectContactHealthy(contactId);
    });

    it('stores the document currency amounts on the ledger rows', async () => {
      const contactId = await createContact('EUR');
      const documentId = await createDocument(contactId, 0.02, 1.5);
      const paymentId = await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);

      const rows = await getTenantKnex()('accounts_transactions')
        .where({ contactId })
        .whereNot('basis', 'cash')
        .select(
          'referenceType',
          'referenceId',
          'debit',
          'credit',
          'foreignDebit',
          'foreignCredit',
          'currencyCode',
        );
      const paymentRows = rows.filter(
        (row) => row.referenceId === paymentId && row.currencyCode === 'EUR',
      );
      expect(paymentRows.length).toBeGreaterThan(0);
      paymentRows.forEach((row) => {
        expect(
          toCents(Number(row.foreignDebit) + Number(row.foreignCredit)),
        ).toBe(1);
        expect(toCents(Number(row.debit) + Number(row.credit))).toBe(2);
      });
      // The exchange gain/loss line has no amount in EUR.
      rows
        .filter(
          (row) => row.referenceId === paymentId && row.currencyCode !== 'EUR',
        )
        .forEach((row) => {
          expect(Number(row.foreignDebit)).toBe(0);
          expect(Number(row.foreignCredit)).toBe(0);
        });
    });

    it('rejects a payment listing the same document twice, naming it', async () => {
      const contactId = await createContact('EUR');
      const documentId = await createDocument(contactId, 0.02, 1.5);
      const res = await request(app.getHttpServer())
        .post(side.paymentPath)
        .set(authHeaders())
        .send(
          side.paymentBody(
            contactId,
            0.02,
            1.5,
            lines([
              [documentId, 0.01],
              [documentId, 0.01],
            ]),
          ),
        )
        .expect(400);
      const error = res.body.errors[0];
      expect(error.type).toBe(side.duplicateError);
      expect(error.message).toMatch(
        / is listed twice in this payment\. Combine the amounts into one line\.$/,
      );
      expect(error.message.startsWith('FXB-')).toBe(true);

      // Editing a payment into two lines on one document is rejected too.
      const paymentId = await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);
      const body = side.paymentBody(
        contactId,
        0.02,
        1.5,
        lines([
          [documentId, 0.01],
          [documentId, 0.01],
        ]),
      );
      delete body.paymentReceiveNo;
      delete body.paymentNumber;
      const edit = await request(app.getHttpServer())
        .put(`${side.paymentPath}/${paymentId}`)
        .set(authHeaders())
        .send(body)
        .expect(400);
      expect(edit.body.errors[0].type).toBe(side.duplicateError);
    });

    it('lists an existing payment with a document on two lines in the health check', async () => {
      const contactId = await createContact('EUR');
      const documentId = await createDocument(contactId, 0.02, 1.5);
      const paymentId = await pay(contactId, 0.01, 1.5, [[documentId, 0.01]]);
      const knex = getTenantKnex();
      const [line] = await knex(side.entriesTable).where({
        [side.paymentIdColumn]: paymentId,
      });
      // A payment saved before the check (written directly, removed after).
      const { id: _id, ...copy } = line;
      const [copyId] = await knex(side.entriesTable).insert({
        ...copy,
        index: 2,
      });
      try {
        const health = await checkMoneyHealth(knex, baseCurrency);
        expect(
          (health.duplicateDocumentLines ?? []).filter(
            (row) => row.paymentId === paymentId,
          ),
        ).toEqual([expect.objectContaining({ documentId, lines: 2 })]);
      } finally {
        await knex(side.entriesTable).where({ id: copyId }).delete();
      }
    });
  },
);
