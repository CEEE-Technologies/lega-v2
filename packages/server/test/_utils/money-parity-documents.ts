import request = require('supertest');
import { faker } from '@faker-js/faker';
import {
  allocateMoney,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  sumMoneyBy,
  toCents,
} from '@bigcapital/utils';
import { app } from '../init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createServiceItem,
  createTaxRate,
  expectBalanced,
  fetchLegs,
  getBaseCurrency,
  GLTestLeg,
} from './gl';
import {
  FOREIGN_CURRENCY,
  MatrixCase,
  agingTotalOf,
  buildMatrix,
  caseDocumentFields,
  caseEntries,
  closeTenantKnex,
  createContact,
  expectedOf,
  field,
  firstPartOf,
  getTenantKnex,
  listIdsByStatus,
  num,
  restOf,
  rowsOf,
  selectColumns,
  webappFiguresOf,
  selectMoneySql,
} from './money-matrix';
import { checkMoneyHealth } from '../../src/modules/AccountingBasis/MoneyHealthCheck';

/**
 * One side of the money parity matrix: invoices (sales) or bills
 * (purchases). Everything else of the test is the same for both.
 */
export interface ParitySide {
  label: string;
  contactKind: 'customers' | 'vendors';
  documentType: 'SaleInvoice' | 'Bill';
  paymentType: 'PaymentReceive' | 'BillPayment';
  path: string;
  table: string;
  subtotalColumn: string;
  moneySql: Record<string, string>;
  /** Body of a new document (without the matrix money fields). */
  documentBody: (contactId: number, number: string) => Record<string, any>;
  /** Creates a payment, returns its id. */
  pay: (
    contactId: number,
    documentId: number,
    amount: number,
    rate: number,
  ) => Promise<number>;
  /**
   * Creates one payment over several documents, `amount` may be more than
   * the applied amounts (the excess); returns its id.
   */
  payMany: (
    contactId: number,
    entries: { documentId: number; amount: number }[],
    amount: number,
    rate: number,
  ) => Promise<number>;
  /** Due amount of the document in the payment form, or null. */
  dueInPaymentForm: (
    contactId: number,
    documentId: number,
  ) => Promise<number | null>;
  /** Creates an open credit (credit note / vendor credit), returns its id. */
  createCredit: (
    contactId: number,
    rate: number,
    itemId: number,
  ) => Promise<number>;
  /** Due amount of the document in the credit apply dialog, or null. */
  dueInCreditApply: (
    creditId: number,
    documentId: number,
  ) => Promise<number | null>;
  agingPath: string;
  /** A/R is a debit balance, A/P a credit balance. */
  contactSign: 1 | -1;
}

const DOCUMENT_DATE = '2025-03-01';
const DUE_DATE = '2025-03-31';
const AS_DATE = '2025-04-15';

/**
 * Money parity on real documents: for every case of the matrix (discount x
 * subtotal x line/document discount, cycling tax, adjustment, currency and
 * payment in one or two parts), the document has ONE answer everywhere:
 * - the getter (API) total and due = the shared helpers (webapp maths),
 * - the stored subtotal and tax columns,
 * - the SQL the lists use (selected directly),
 * - the list tab (partially paid / paid),
 * - the payment form due list and the credit apply dialog,
 * - the aging summary = what the A/R or A/P ledger still holds,
 * - the ledger contact line, and the cash basis lines once fully paid.
 */
export const describeDocumentParity = (side: ParitySide) =>
  describe(`Money parity — ${side.label} (e2e)`, () => {
    let baseCurrency: string;
    let itemId: number;
    let taxRateId: number;
    const documentIds: number[] = [];
    const paymentIds: number[] = [];

    beforeAll(async () => {
      await cancelTransactionsLock();
      baseCurrency = await getBaseCurrency();
      itemId = await createServiceItem();
      taxRateId = await createTaxRate(15);
    });

    afterAll(async () => {
      await closeTenantKnex();
    });

    const getDocument = async (id: number) => {
      const res = await request(app.getHttpServer())
        .get(`${side.path}/${id}`)
        .set(authHeaders())
        .expect(200);
      return res.body.data ?? res.body;
    };

    /** The contact's balance in the ledger (A/R debit, A/P credit). */
    const ledgerContactBalance = (legs: GLTestLeg[], contactId: number) =>
      // (+ 0 turns a -0 into 0.)
      side.contactSign *
        sumMoneyBy(
          legs.filter((leg) => leg.contactId === contactId),
          (leg) => leg.debit.amount - leg.credit.amount,
        ) +
      0;

    const cases = buildMatrix(true);

    it.each(cases.map((matrixCase) => [matrixCase.name, matrixCase]))(
      '%s',
      async (_name, matrixCase: MatrixCase) => {
        const expected = expectedOf(matrixCase);
        const currency = matrixCase.foreign ? FOREIGN_CURRENCY : baseCurrency;
        const contactId = await createContact(
          side.contactKind,
          currency,
          `Parity ${faker.string.alphanumeric(10)}`,
        );
        const number = `PAR-${faker.string.alphanumeric(12)}`;

        const created = await request(app.getHttpServer())
          .post(side.path)
          .set(authHeaders())
          .send({
            ...side.documentBody(contactId, number),
            entries: caseEntries(matrixCase, itemId, taxRateId),
            ...caseDocumentFields(matrixCase),
          });
        if (created.status !== 201) {
          throw new Error(`${side.label}: ${JSON.stringify(created.body)}`);
        }
        const documentId = created.body.id;
        documentIds.push(documentId);
        const casePayments: number[] = [];
        const creditId = await side.createCredit(
          contactId,
          expected.rate,
          itemId,
        );

        /** Asserts the one answer once `settled` of the total is paid. */
        const expectSettled = async (settled: number) => {
          const due = subtractMoney(expected.total, settled);
          const doc = await getDocument(documentId);
          expect(num(doc, 'total')).toBe(expected.total);
          expect(num(doc, 'dueAmount')).toBe(due);
          expect(Boolean(field(doc, 'isFullyPaid'))).toBe(due === 0);
          expect(Boolean(field(doc, 'isPartiallyPaid'))).toBe(
            due !== 0 && settled !== 0,
          );

          // The SQL of the list filters, selected directly.
          const sql = await selectMoneySql(
            side.table,
            documentId,
            side.moneySql,
          );
          expect(sql.total).toBe(expected.total);
          expect(Math.max(sql.due, 0)).toBe(due);

          // The list tab it lands in.
          const paidIds = await listIdsByStatus(side.path, 'paid', number);
          const partIds = await listIdsByStatus(
            side.path,
            'partially-paid',
            number,
          );
          expect(paidIds.includes(documentId)).toBe(due === 0);
          expect(partIds.includes(documentId)).toBe(due !== 0 && settled !== 0);

          // The payment form and the credit apply dialog.
          expect(await side.dueInPaymentForm(contactId, documentId)).toBe(
            due === 0 ? null : due,
          );
          expect(await side.dueInCreditApply(creditId, documentId)).toBe(
            due === 0 ? null : due,
          );

          // The aging summary shows what the ledger still holds for the
          // contact, in the base currency, to the cent.
          const legs = (
            await Promise.all([
              fetchLegs(side.documentType, documentId, 'accrual'),
              ...casePayments.map((id) =>
                fetchLegs(side.paymentType, id, 'accrual'),
              ),
            ])
          ).flat();
          const ledgerDue = ledgerContactBalance(legs, contactId);
          expect(ledgerDue).toBe(
            subtractMoney(
              multiplyMoney(expected.total, expected.rate),
              multiplyMoney(settled, expected.rate),
            ),
          );
          expect(await agingTotalOf(side.agingPath, contactId, AS_DATE)).toBe(
            ledgerDue,
          );
        };

        const pay = async (amount: number) => {
          casePayments.push(
            await side.pay(contactId, documentId, amount, expected.rate),
          );
        };

        // The webapp form shows the same figures (its own formula).
        expect(webappFiguresOf(matrixCase)).toEqual({
          subtotal: expected.subtotal,
          taxAmount: expected.taxAmount,
          discountAmount: expected.discountAmount,
          total: expected.total,
        });

        // The getter, the stored columns and the webapp maths agree.
        const doc = await getDocument(documentId);
        expect(num(doc, 'subtotal')).toBe(expected.subtotal);
        expect(num(doc, 'taxAmountWithheld')).toBe(expected.taxAmount);
        expect(num(doc, 'discountAmount')).toBe(expected.discountAmount);
        const stored = await selectColumns(side.table, documentId, [
          side.subtotalColumn,
          'TAX_AMOUNT_WITHHELD',
        ]);
        expect(stored[side.subtotalColumn]).toBe(expected.subtotal);
        expect(stored.TAX_AMOUNT_WITHHELD).toBe(expected.taxAmount);

        // The ledger: the contact line gets the total in the base currency.
        const legs = await fetchLegs(side.documentType, documentId, 'accrual');
        expectBalanced(legs);
        expect(ledgerContactBalance(legs, contactId)).toBe(expected.totalLocal);

        await expectSettled(0);
        if (matrixCase.twoPayments) {
          const first = firstPartOf(expected.total);
          await pay(first);
          await expectSettled(first);
          await pay(restOf(expected.total, first));
        } else {
          await pay(expected.total);
        }
        await expectSettled(expected.total);
        paymentIds.push(...casePayments);
      },
    );

    // Codex: one foreign payment over several documents. Its cash basis bank
    // lines must add up to the accrual bank line, round(amount x rate), not
    // to the sum of each document's share converted on its own.
    it('pays every foreign matrix case with one payment: cash bank = accrual bank', async () => {
      const foreignCases = cases.filter((matrixCase) => matrixCase.foreign);
      const contactId = await createContact(
        side.contactKind,
        FOREIGN_CURRENCY,
        `Parity many ${faker.string.alphanumeric(10)}`,
      );
      const entries: { documentId: number; amount: number }[] = [];
      for (const matrixCase of foreignCases) {
        const created = await request(app.getHttpServer())
          .post(side.path)
          .set(authHeaders())
          .send({
            ...side.documentBody(
              contactId,
              `PARM-${faker.string.alphanumeric(12)}`,
            ),
            entries: caseEntries(matrixCase, itemId, taxRateId),
            ...caseDocumentFields(matrixCase),
          })
          .expect(201);
        documentIds.push(created.body.id);
        entries.push({
          documentId: created.body.id,
          amount: expectedOf(matrixCase).total,
        });
      }
      const rate = expectedOf(foreignCases[0]).rate;
      const applied = entries.map((entry) => entry.amount);
      // 0.01 more than applied: the excess (unearned / prepaid).
      const amount = sumMoney(...applied, 0.01);
      const paymentId = await side.payMany(contactId, entries, amount, rate);
      paymentIds.push(paymentId);

      const rows = await getTenantKnex()('accounts_transactions')
        .where({ referenceType: side.paymentType, referenceId: paymentId })
        .select('accountId', 'debit', 'credit', 'basis');
      const bankNet = (basis: 'cash' | 'accrual') =>
        rows
          .filter((row) => row.accountId === 1000)
          .filter((row) =>
            basis === 'cash' ? row.basis === 'cash' : row.basis !== 'cash',
          )
          .reduce(
            (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
            0,
          );
      const bank = side.contactSign * toCents(multiplyMoney(amount, rate));
      expect(bankNet('accrual')).toBe(bank);
      expect(bankNet('cash')).toBe(bank);

      const cashRows = rows.filter((row) => row.basis === 'cash');
      expect(cashRows.reduce((sum, row) => sum + toCents(row.debit), 0)).toBe(
        cashRows.reduce((sum, row) => sum + toCents(row.credit), 0),
      );

      // The excess gets its share of the bank amount.
      const split = allocateMoney(multiplyMoney(amount, rate), [
        ...applied,
        0.01,
      ]);
      const excessSlug =
        side.contactKind === 'customers'
          ? 'unearned-revenue'
          : 'prepaid-expenses';
      const excessAccount = await getTenantKnex()('accounts')
        .where({ slug: excessSlug })
        .first();
      const excessNet =
        -side.contactSign *
        cashRows
          .filter((row) => row.accountId === excessAccount.id)
          .reduce(
            (sum, row) => sum + toCents(row.debit) - toCents(row.credit),
            0,
          );
      expect(excessNet + 0).toBe(toCents(split[split.length - 1]));
    });

    it('leaves every matrix document and payment clean in the money health check', async () => {
      const health = await checkMoneyHealth(getTenantKnex(), baseCurrency);
      const ours = (type: string, id: number) =>
        (type === side.documentType && documentIds.includes(id)) ||
        (type === side.paymentType && paymentIds.includes(id));

      // (A retried case creates its documents again.)
      expect(new Set(documentIds).size).toBeGreaterThanOrEqual(cases.length);
      expect(
        health.unbalancedSets.filter((row) =>
          ours(row.referenceType, row.referenceId),
        ),
      ).toEqual([]);
      expect(
        health.nonCentRows.filter((row) =>
          ours(row.referenceType, row.referenceId),
        ),
      ).toEqual([]);
      // Once fully paid, the cash basis lines equal the document, account
      // by account.
      expect(
        health.cashDocumentDifferences.filter(
          (row) =>
            row.documentType === side.documentType &&
            documentIds.includes(row.documentId),
        ),
      ).toEqual([]);
      // Every payment's cash basis bank lines equal its accrual bank line.
      expect(
        (health.paymentBankDifferences ?? []).filter((row) =>
          ours(row.paymentType, row.paymentId),
        ),
      ).toEqual([]);
    });
  });

/** A row of a list response with the given document id. */
export const dueOfRow = (
  rows: any[],
  documentId: number,
  idKeys: string[],
): number | null => {
  const row = rows.find((entry) =>
    idKeys.some((key) => Number(field(entry, key)) === documentId),
  );
  return row ? num(row, 'dueAmount') : null;
};

export { rowsOf, DOCUMENT_DATE, DUE_DATE };
