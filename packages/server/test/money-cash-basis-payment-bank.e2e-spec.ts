import request = require('supertest');
import { faker } from '@faker-js/faker';
import {
  allocateMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  toCents,
} from '@bigcapital/utils';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createServiceItem,
  getBaseCurrency,
} from './_utils/gl';
import {
  FOREIGN_CURRENCY,
  closeTenantKnex,
  getTenantKnex,
} from './_utils/money-matrix';
import { checkMoneyHealth } from '../src/modules/AccountingBasis/MoneyHealthCheck';

/**
 * Codex: the cash basis bank lines of a foreign currency payment over several
 * documents must add up to the accrual bank line, round(amount x rate).
 * Each document's share used to be converted on its own: USD 0.02 at 1.5 paid
 * over two documents of 0.01 put 0.02 + 0.02 = 0.04 in the bank instead of
 * 0.03; USD 100.02 at 300.005 over three of 33.34 put 30,006.51 instead of
 * 30,006.50. Too much overstated the bank, too little left a fake 0.01
 * excess in unearned revenue / prepaid expenses.
 *
 * For received payments and bill payments, each case asserts:
 * - cash bank = accrual bank = round(amount x rate),
 * - the excess (unearned revenue / prepaid expenses) is the excess' share,
 * - the cash set balances,
 * - once the documents are fully paid, cash income / expense per account
 *   equals accrual (health check part d), and part f is clean.
 */
const BANK_ACCOUNT_ID = 1000;
const DATE = '2035-03-01';

interface Side {
  label: string;
  contactKind: 'customers' | 'vendors';
  documentPath: string;
  documentType: 'SaleInvoice' | 'Bill';
  paymentPath: string;
  paymentType: 'PaymentReceive' | 'BillPayment';
  documentKey: 'invoiceId' | 'billId';
  excessSlug: string;
  /** +1 when the bank is debited (money in), -1 when credited. */
  bankSign: 1 | -1;
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
    documentType: 'SaleInvoice',
    paymentPath: '/payments-received',
    paymentType: 'PaymentReceive',
    documentKey: 'invoiceId',
    excessSlug: 'unearned-revenue',
    bankSign: 1,
    documentBody: (customerId, itemId, amount, rate) => ({
      customerId,
      invoiceDate: DATE,
      dueDate: DATE,
      invoiceNo: faker.string.uuid(),
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
    documentType: 'Bill',
    paymentPath: '/bill-payments',
    paymentType: 'BillPayment',
    documentKey: 'billId',
    excessSlug: 'prepaid-expenses',
    bankSign: -1,
    documentBody: (vendorId, itemId, amount, rate) => ({
      vendorId,
      billDate: DATE,
      dueDate: DATE,
      billNumber: faker.string.uuid(),
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

const cents = (value: any) => toCents(Number(value || 0));

describe.each(SIDES)(
  'Money — cash bank lines of a foreign payment: $label (e2e)',
  (side) => {
    let itemId: number;
    let excessAccountId: number | null = null;
    let baseCurrency: string;

    beforeAll(async () => {
      await cancelTransactionsLock();
      baseCurrency = await getBaseCurrency();
      itemId = await createServiceItem();
    });

    afterAll(async () => {
      await closeTenantKnex();
    });

    const createContact = async (openingBalance?: {
      amount: number;
      rate: number;
    }) => {
      const res = await request(app.getHttpServer())
        .post(`/${side.contactKind}`)
        .set(authHeaders())
        .send({
          displayName: `Cash bank ${side.contactKind} ${faker.string.alphanumeric(10)}`,
          currencyCode: FOREIGN_CURRENCY,
          ...(side.contactKind === 'customers'
            ? { customerType: 'business' }
            : {}),
          ...(openingBalance
            ? {
                openingBalance: openingBalance.amount,
                openingBalanceAt: '2035-01-01',
                openingBalanceExchangeRate: openingBalance.rate,
                openingBalanceBranchId: 1,
              }
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
      if (res.status !== 201) {
        throw new Error(`${side.documentType}: ${JSON.stringify(res.body)}`);
      }
      return res.body.id as number;
    };

    const documentEntry = (documentId: number, paymentAmount: number) => ({
      [side.documentKey]: documentId,
      paymentAmount,
    });
    const openingBalanceEntry = (paymentAmount: number) => ({
      entryType: 'opening_balance',
      paymentAmount,
    });
    const withIndexes = (entries: any[]) =>
      entries.map((entry, index) => ({ index: index + 1, ...entry }));

    const createPayment = async (
      contactId: number,
      amount: number,
      rate: number,
      entries: any[],
    ) => {
      const res = await request(app.getHttpServer())
        .post(side.paymentPath)
        .set(authHeaders())
        .send(side.paymentBody(contactId, amount, rate, withIndexes(entries)));
      if (res.status !== 201) {
        throw new Error(`${side.paymentType}: ${JSON.stringify(res.body)}`);
      }
      return res.body.id as number;
    };

    const editPayment = async (
      paymentId: number,
      contactId: number,
      amount: number,
      rate: number,
      entries: any[],
    ) => {
      const body = side.paymentBody(
        contactId,
        amount,
        rate,
        withIndexes(entries),
      );
      // Keep the payment number of the payment being edited.
      delete body.paymentReceiveNo;
      delete body.paymentNumber;
      const res = await request(app.getHttpServer())
        .put(`${side.paymentPath}/${paymentId}`)
        .set(authHeaders())
        .send(body);
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `edit ${side.paymentType}: ${JSON.stringify(res.body)}`,
        );
      }
    };

    const ledgerOf = async (referenceType: string, referenceId: number) =>
      getTenantKnex()('accounts_transactions')
        .where({ referenceType, referenceId })
        .select('accountId', 'debit', 'credit', 'basis');

    const netCents = (
      rows: any[],
      accountId: number,
      basis: 'cash' | 'accrual',
    ) =>
      rows
        .filter((row) => row.accountId === accountId)
        .filter((row) =>
          basis === 'cash' ? row.basis === 'cash' : row.basis !== 'cash',
        )
        .reduce((sum, row) => sum + cents(row.debit) - cents(row.credit), 0);

    const getExcessAccountId = async () => {
      if (excessAccountId) return excessAccountId;
      const row = await getTenantKnex()('accounts')
        .where({ slug: side.excessSlug })
        .first();
      excessAccountId = row?.id ?? null;
      return excessAccountId;
    };

    /**
     * The expected excess: its share of round(amount x rate), split over the
     * applied parts and the excess by their payment currency amounts.
     */
    const expectedExcessCents = (
      amount: number,
      rate: number,
      applied: number[],
    ) => {
      const excess = subtractMoney(amount, sumMoney(...applied));
      const split = allocateMoney(multiplyMoney(amount, rate), [
        ...applied,
        excess,
      ]);
      return cents(split[split.length - 1]);
    };

    const expectPaymentBank = async (
      paymentId: number,
      amount: number,
      rate: number,
      applied: number[],
    ) => {
      const rows = await ledgerOf(side.paymentType, paymentId);
      const bank = cents(multiplyMoney(amount, rate)) * side.bankSign;

      expect(netCents(rows, BANK_ACCOUNT_ID, 'accrual')).toBe(bank);
      expect(netCents(rows, BANK_ACCOUNT_ID, 'cash')).toBe(bank);

      const cashRows = rows.filter((row) => row.basis === 'cash');
      const debits = cashRows.reduce((sum, row) => sum + cents(row.debit), 0);
      const credits = cashRows.reduce((sum, row) => sum + cents(row.credit), 0);
      expect(debits).toBe(credits);

      const excess = expectedExcessCents(amount, rate, applied);
      const excessAccount = await getExcessAccountId();
      const excessNet = excessAccount
        ? -netCents(rows, excessAccount, 'cash') * side.bankSign
        : 0;
      expect(excessNet + 0).toBe(excess);
    };

    /** Health check parts d (cash = accrual per account) and f, on these documents and payments. */
    const expectHealthy = async (
      documentIds: number[],
      paymentIds: number[],
    ) => {
      const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
      const documentProblems = health.cashDocumentDifferences.filter(
        (row) =>
          row.documentType === side.documentType &&
          documentIds.includes(row.documentId),
      );
      expect(documentProblems).toEqual([]);
      const paymentProblems = (health.paymentBankDifferences ?? []).filter(
        (row) =>
          row.paymentType === side.paymentType &&
          paymentIds.includes(row.paymentId),
      );
      expect(paymentProblems).toEqual([]);
    };

    it("Codex's case: 0.02 at 1.5 over two documents of 0.01 is 0.03 in the bank", async () => {
      const contactId = await createContact();
      const a = await createDocument(contactId, 0.01, 1.5);
      const b = await createDocument(contactId, 0.01, 1.5);
      const paymentId = await createPayment(contactId, 0.02, 1.5, [
        documentEntry(a, 0.01),
        documentEntry(b, 0.01),
      ]);
      await expectPaymentBank(paymentId, 0.02, 1.5, [0.01, 0.01]);
      await expectHealthy([a, b], [paymentId]);
    });

    it('100.02 at 300.005 over three documents of 33.34 is 30,006.50 in the bank', async () => {
      const contactId = await createContact();
      const docs = [];
      for (let i = 0; i < 3; i += 1)
        docs.push(await createDocument(contactId, 33.34, 300.005));
      const paymentId = await createPayment(
        contactId,
        100.02,
        300.005,
        docs.map((id) => documentEntry(id, 33.34)),
      );
      await expectPaymentBank(
        paymentId,
        100.02,
        300.005,
        [33.34, 33.34, 33.34],
      );
      await expectHealthy(docs, [paymentId]);
    });

    it('pays two documents and the opening balance, at another rate than the documents', async () => {
      const contactId = await createContact({ amount: 0.03, rate: 300 });
      const a = await createDocument(contactId, 33.34, 300);
      const b = await createDocument(contactId, 33.33, 300);
      const paymentId = await createPayment(contactId, 66.7, 300.005, [
        documentEntry(a, 33.34),
        documentEntry(b, 33.33),
        openingBalanceEntry(0.03),
      ]);
      await expectPaymentBank(paymentId, 66.7, 300.005, [33.34, 33.33, 0.03]);
      await expectHealthy([a, b], [paymentId]);
    });

    it('keeps the excess at its share of the bank amount (overpayment)', async () => {
      const contactId = await createContact();
      const a = await createDocument(contactId, 33.34, 300.005);
      const b = await createDocument(contactId, 0.01, 300.005);
      const paymentId = await createPayment(contactId, 50.02, 300.005, [
        documentEntry(a, 33.34),
        documentEntry(b, 0.01),
      ]);
      await expectPaymentBank(paymentId, 50.02, 300.005, [33.34, 0.01]);
      await expectHealthy([a, b], [paymentId]);
    });

    it('stays exact after editing the payment and removing the middle document', async () => {
      const contactId = await createContact();
      const docs = [];
      for (let i = 0; i < 3; i += 1)
        docs.push(await createDocument(contactId, 33.34, 300.005));
      const paymentId = await createPayment(
        contactId,
        100.02,
        300.005,
        docs.map((id) => documentEntry(id, 33.34)),
      );
      await editPayment(paymentId, contactId, 66.69, 300.005, [
        documentEntry(docs[0], 33.34),
        documentEntry(docs[2], 33.34),
      ]);
      await expectPaymentBank(paymentId, 66.69, 300.005, [33.34, 33.34]);
      await expectHealthy([docs[0], docs[2]], [paymentId]);
    });

    it('stays exact over partial payments when an earlier payment is edited', async () => {
      const contactId = await createContact();
      const docs = [];
      for (let i = 0; i < 3; i += 1)
        docs.push(await createDocument(contactId, 33.34, 300.005));
      const first = await createPayment(
        contactId,
        30.03,
        300.005,
        docs.map((id) => documentEntry(id, 10.01)),
      );
      const second = await createPayment(
        contactId,
        69.99,
        300.005,
        docs.map((id) => documentEntry(id, 23.33)),
      );
      await expectPaymentBank(first, 30.03, 300.005, [10.01, 10.01, 10.01]);
      await expectPaymentBank(second, 69.99, 300.005, [23.33, 23.33, 23.33]);
      // The edit rewrites the later payment (its paid-before changes).
      await editPayment(first, contactId, 30.06, 300.005, [
        ...docs.map((id) => documentEntry(id, 10.01)),
      ]);
      await expectPaymentBank(first, 30.06, 300.005, [10.01, 10.01, 10.01]);
      await expectPaymentBank(second, 69.99, 300.005, [23.33, 23.33, 23.33]);
      await expectHealthy(docs, [first, second]);
    });
  },
);
