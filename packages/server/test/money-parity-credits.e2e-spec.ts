import request = require('supertest');
import { faker } from '@faker-js/faker';
import { roundMoney, subtractMoney, sumMoneyBy } from '@bigcapital/utils';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createServiceItem,
  expectBalanced,
  fetchLegs,
  getBaseCurrency,
  GLTestLeg,
} from './_utils/gl';
import {
  FOREIGN_CURRENCY,
  MatrixCase,
  buildMatrix,
  caseDocumentFields,
  caseEntries,
  closeTenantKnex,
  createContact,
  expectedOf,
  firstPartOf,
  listIdsByStatus,
  num,
  selectColumns,
  selectMoneySql,
  webappFiguresOf,
} from './_utils/money-matrix';
import { CREDIT_NOTE_MONEY_SQL } from '../src/modules/CreditNotes/models/CreditNote';
import { VENDOR_CREDIT_MONEY_SQL } from '../src/modules/VendorCredit/models/VendorCredit';

/**
 * Money parity matrix on credit notes, vendor credits, estimates and
 * receipts (no document tax on these): every discount x subtotal x line or
 * document discount, cycling adjustment and currency.
 *
 * Credits: the credit that can still be used (getter, SQL, open/closed
 * tab, refund and apply checks) is the TOTAL the ledger posted, after the
 * discount and adjustment. It used to be the subtotal, so a credit note of
 * 101.00 with 10% off moved 90.90 in the ledger but 101.00 could be applied
 * or refunded.
 */
describe('Money parity — credits, estimates and receipts (e2e)', () => {
  const DATE = '2025-03-01';
  let baseCurrency: string;
  let itemId: number;

  beforeAll(async () => {
    await cancelTransactionsLock();
    baseCurrency = await getBaseCurrency();
    itemId = await createServiceItem();
  });

  afterAll(async () => {
    await closeTenantKnex();
  });

  const get = async (path: string) => {
    const res = await request(app.getHttpServer())
      .get(path)
      .set(authHeaders())
      .expect(200);
    return res.body.data ?? res.body;
  };

  const contactBalance = (legs: GLTestLeg[], contactId: number) =>
    sumMoneyBy(
      legs.filter((leg) => leg.contactId === contactId),
      (leg) => leg.debit.amount - leg.credit.amount,
    );

  const cases = buildMatrix(false);

  interface CreditSide {
    label: string;
    contactKind: 'customers' | 'vendors';
    path: string;
    table: string;
    moneySql: Record<string, string>;
    referenceType: string;
    /** + for a debit balance on the contact, - for credit. */
    sign: 1 | -1;
    createBody: (contactId: number, number: string) => Record<string, any>;
    /** A document of the same contact to apply the credit to. */
    createTarget: (contactId: number, rate: number) => Promise<number>;
    apply: (creditId: number, targetId: number, amount: number) => request.Test;
    refund: (creditId: number, amount: number, rate: number) => request.Test;
  }

  const CREDIT_SIDES: CreditSide[] = [
    {
      label: 'credit note',
      contactKind: 'customers',
      path: '/credit-notes',
      table: 'CREDIT_NOTES',
      moneySql: CREDIT_NOTE_MONEY_SQL,
      referenceType: 'CreditNote',
      sign: -1,
      createBody: (customerId, creditNoteNumber) => ({
        customerId,
        creditNoteDate: DATE,
        creditNoteNumber,
        open: true,
        branchId: 1,
        warehouseId: 1,
      }),
      createTarget: async (customerId, exchangeRate) => {
        const res = await request(app.getHttpServer())
          .post('/sale-invoices')
          .set(authHeaders())
          .send({
            customerId,
            exchangeRate,
            invoiceDate: DATE,
            dueDate: '2025-04-01',
            invoiceNo: faker.string.uuid(),
            delivered: true,
            branchId: 1,
            warehouseId: 1,
            entries: [{ index: 1, itemId, quantity: 1, rate: 5000 }],
          })
          .expect(201);
        return res.body.id;
      },
      apply: (creditNoteId, invoiceId, amount) =>
        request(app.getHttpServer())
          .post(`/credit-notes/${creditNoteId}/apply-invoices`)
          .set(authHeaders())
          .send({ entries: [{ invoiceId, amount }] }),
      refund: (creditNoteId, amount, exchangeRate) =>
        request(app.getHttpServer())
          .post(`/credit-notes/${creditNoteId}/refunds`)
          .set(authHeaders())
          .send({
            fromAccountId: 1000,
            amount,
            exchangeRate,
            referenceNo: faker.string.uuid(),
            date: '2025-03-10',
          }),
    },
    {
      label: 'vendor credit',
      contactKind: 'vendors',
      path: '/vendor-credits',
      table: 'VENDOR_CREDITS',
      moneySql: VENDOR_CREDIT_MONEY_SQL,
      referenceType: 'VendorCredit',
      sign: 1,
      createBody: (vendorId, vendorCreditNumber) => ({
        vendorId,
        vendorCreditDate: DATE,
        vendorCreditNumber,
        open: true,
        branchId: 1,
        warehouseId: 1,
      }),
      createTarget: async (vendorId, exchangeRate) => {
        const res = await request(app.getHttpServer())
          .post('/bills')
          .set(authHeaders())
          .send({
            vendorId,
            exchangeRate,
            billDate: DATE,
            dueDate: '2025-04-01',
            billNumber: faker.string.alphanumeric(12),
            open: true,
            branchId: 1,
            warehouseId: 1,
            entries: [{ index: 1, itemId, quantity: 1, rate: 5000 }],
          })
          .expect(201);
        return res.body.id;
      },
      apply: (vendorCreditId, billId, amount) =>
        request(app.getHttpServer())
          .post(`/vendor-credits/${vendorCreditId}/apply-to-bills`)
          .set(authHeaders())
          .send({ entries: [{ billId, amount }] }),
      refund: (vendorCreditId, amount, exchangeRate) =>
        request(app.getHttpServer())
          .post(`/vendor-credits/${vendorCreditId}/refund`)
          .set(authHeaders())
          .send({
            depositAccountId: 1000,
            amount,
            exchangeRate,
            referenceNo: faker.string.uuid(),
            date: '2025-03-10',
          }),
    },
  ];

  describe.each(CREDIT_SIDES.map((side) => [side.label, side]))(
    '%s',
    (_label, side: CreditSide) => {
      it.each(cases.map((matrixCase) => [matrixCase.name, matrixCase]))(
        '%s',
        async (_name, matrixCase: MatrixCase) => {
          const expected = expectedOf(matrixCase);
          const contactId = await createContact(
            side.contactKind,
            matrixCase.foreign ? FOREIGN_CURRENCY : baseCurrency,
            `Parity ${faker.string.alphanumeric(10)}`,
          );
          const number = `PAR-${faker.string.alphanumeric(12)}`;
          const created = await request(app.getHttpServer())
            .post(side.path)
            .set(authHeaders())
            .send({
              ...side.createBody(contactId, number),
              entries: caseEntries(matrixCase, itemId),
              ...caseDocumentFields(matrixCase),
            });
          if (created.status !== 201) {
            throw new Error(`${side.label}: ${JSON.stringify(created.body)}`);
          }
          const creditId = created.body.id;

          /** The one answer for the credit still left. */
          const expectRemaining = async (remaining: number) => {
            const credit = await get(`${side.path}/${creditId}`);
            expect(num(credit, 'total')).toBe(expected.total);
            expect(num(credit, 'creditsRemaining')).toBe(remaining);

            const sql = await selectMoneySql(
              side.table,
              creditId,
              side.moneySql,
            );
            expect(sql.total).toBe(expected.total);
            expect(Math.max(sql.remaining, 0)).toBe(remaining);

            const open = await listIdsByStatus(side.path, 'open', number);
            const closed = await listIdsByStatus(side.path, 'closed', number);
            expect(open.includes(creditId)).toBe(remaining > 0);
            expect(closed.includes(creditId)).toBe(remaining === 0);
          };

          // The webapp form shows the same total (its own formula).
          expect(webappFiguresOf(matrixCase).total).toBe(expected.total);

          const credit = await get(`${side.path}/${creditId}`);
          // (The vendor credit API has no `subtotal`: its `amount` is it.)
          expect(num(credit, 'subtotal') || num(credit, 'amount')).toBe(
            expected.subtotal,
          );
          expect(num(credit, 'discountAmount')).toBe(expected.discountAmount);
          const stored = await selectColumns(side.table, creditId, ['AMOUNT']);
          expect(stored.AMOUNT).toBe(expected.subtotal);

          // The ledger moves the total off the contact, to the cent.
          const legs = await fetchLegs(side.referenceType, creditId, 'accrual');
          expectBalanced(legs);
          expect(side.sign * contactBalance(legs, contactId)).toBe(
            expected.totalLocal,
          );
          await expectRemaining(expected.total);

          // Applying a cent more than the total is refused (it used to be
          // allowed up to the subtotal).
          const targetId = await side.createTarget(contactId, expected.rate);
          await side
            .apply(creditId, targetId, roundMoney(expected.total + 0.01))
            .expect(400);

          // Part applied, the rest refunded: closed, nothing more can go.
          const part = firstPartOf(expected.total);
          await side.apply(creditId, targetId, part).expect(201);
          await expectRemaining(subtractMoney(expected.total, part));

          const rest = subtractMoney(expected.total, part);
          if (rest > 0) {
            await side.refund(creditId, rest, expected.rate).expect(201);
          }
          await expectRemaining(0);
          await side.refund(creditId, 0.01, expected.rate).expect(400);
        },
      );
    },
  );

  describe('estimate', () => {
    it.each(cases.map((matrixCase) => [matrixCase.name, matrixCase]))(
      '%s',
      async (_name, matrixCase: MatrixCase) => {
        const expected = expectedOf(matrixCase);
        const customerId = await createContact(
          'customers',
          matrixCase.foreign ? FOREIGN_CURRENCY : baseCurrency,
          `Parity ${faker.string.alphanumeric(10)}`,
        );
        const created = await request(app.getHttpServer())
          .post('/sale-estimates')
          .set(authHeaders())
          .send({
            customerId,
            estimateDate: DATE,
            expirationDate: '2025-04-01',
            estimateNumber: faker.string.alphanumeric(12),
            branchId: 1,
            warehouseId: 1,
            entries: caseEntries(matrixCase, itemId),
            ...caseDocumentFields(matrixCase),
          });
        if (created.status !== 201) {
          throw new Error(`estimate: ${JSON.stringify(created.body)}`);
        }
        const estimate = await get(`/sale-estimates/${created.body.id}`);
        expect(num(estimate, 'subtotal')).toBe(expected.subtotal);
        expect(num(estimate, 'discountAmount')).toBe(expected.discountAmount);
        expect(num(estimate, 'total')).toBe(expected.total);
        const stored = await selectColumns('SALES_ESTIMATES', created.body.id, [
          'AMOUNT',
        ]);
        expect(stored.AMOUNT).toBe(expected.subtotal);
      },
    );
  });

  describe('receipt', () => {
    it.each(cases.map((matrixCase) => [matrixCase.name, matrixCase]))(
      '%s',
      async (_name, matrixCase: MatrixCase) => {
        const expected = expectedOf(matrixCase);
        const customerId = await createContact(
          'customers',
          matrixCase.foreign ? FOREIGN_CURRENCY : baseCurrency,
          `Parity ${faker.string.alphanumeric(10)}`,
        );
        const created = await request(app.getHttpServer())
          .post('/sale-receipts')
          .set(authHeaders())
          .send({
            customerId,
            depositAccountId: 1000,
            receiptDate: DATE,
            receiptNumber: faker.string.alphanumeric(12),
            closed: true,
            branchId: 1,
            warehouseId: 1,
            entries: caseEntries(matrixCase, itemId),
            ...caseDocumentFields(matrixCase),
          });
        if (created.status !== 201) {
          throw new Error(`receipt: ${JSON.stringify(created.body)}`);
        }
        const receipt = await get(`/sale-receipts/${created.body.id}`);
        expect(num(receipt, 'subtotal')).toBe(expected.subtotal);
        expect(num(receipt, 'discountAmount')).toBe(expected.discountAmount);
        expect(num(receipt, 'total')).toBe(expected.total);
        const stored = await selectColumns('SALES_RECEIPTS', created.body.id, [
          'AMOUNT',
        ]);
        expect(stored.AMOUNT).toBe(expected.subtotal);

        // The deposit account gets the total in the base currency.
        const legs = await fetchLegs('SaleReceipt', created.body.id, 'accrual');
        expectBalanced(legs);
        const deposit = legs.filter((leg) => leg.accountId === 1000);
        expect(
          sumMoneyBy(deposit, (leg) => leg.debit.amount - leg.credit.amount),
        ).toBe(expected.totalLocal);
      },
    );
  });
});
