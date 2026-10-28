import { Knex } from 'knex';
import * as moment from 'moment';
import { uniq } from 'lodash';
import { Logger } from '@nestjs/common';
import { roundMoney } from '@bigcapital/utils';
import { getLockedPeriodChecker } from './MoneyHealthCheck';

/**
 * The tables of a kind of payment that pays documents.
 */
export interface IPaidBeforeKind {
  paymentsTable: string;
  entriesTable: string;
  entryPaymentId: string;
  entryDocumentId: string;
  dateColumn: string;
  documentsTable: string;
}

export const PAYMENT_RECEIVED_PAID_BEFORE: IPaidBeforeKind = {
  paymentsTable: 'payment_receives',
  entriesTable: 'payment_receives_entries',
  entryPaymentId: 'payment_receive_id',
  entryDocumentId: 'invoice_id',
  dateColumn: 'payment_date',
  documentsTable: 'sales_invoices',
};

export const BILL_PAYMENT_PAID_BEFORE: IPaidBeforeKind = {
  paymentsTable: 'bills_payments',
  entriesTable: 'bills_payments_entries',
  entryPaymentId: 'bill_payment_id',
  entryDocumentId: 'bill_id',
  dateColumn: 'payment_date',
  documentsTable: 'bills',
};

export const CREDIT_NOTE_REFUND_PAID_BEFORE: IPaidBeforeKind = {
  // A refund is its own "entry": the refund row holds the credit note id.
  paymentsTable: 'refund_credit_note_transactions',
  entriesTable: 'refund_credit_note_transactions',
  entryPaymentId: 'id',
  entryDocumentId: 'credit_note_id',
  dateColumn: 'date',
  documentsTable: 'credit_notes',
};

export const VENDOR_CREDIT_REFUND_PAID_BEFORE: IPaidBeforeKind = {
  paymentsTable: 'refund_vendor_credit_transactions',
  entriesTable: 'refund_vendor_credit_transactions',
  entryPaymentId: 'id',
  entryDocumentId: 'vendor_credit_id',
  dateColumn: 'date',
  documentsTable: 'vendor_credits',
};

/**
 * Retrieves, per document, the amount paid by the payments that come before
 * the given one (by date, then id, so the order is always the same). The
 * running-total cash basis split starts from there.
 *
 * In a transaction the documents' rows are locked first (FOR UPDATE), so
 * two payments of the same document saved at the same time can't both read
 * the same "paid before".
 * @param {Knex} knex - Tenant knex (snake case mappers) or a transaction.
 * @param {IPaidBeforeKind} kind - The payment tables.
 * @param {{ id: number; date: any }} payment - The payment (or refund).
 * @param {number[]} documentIds - The documents it pays.
 * @param {boolean} lock - Whether to lock the documents' rows.
 * @returns {Promise<Record<number, number>>} Paid before, by document id.
 */
export const getDocumentsPaidBefore = async (
  knex: Knex | Knex.Transaction,
  kind: IPaidBeforeKind,
  payment: { id: number; date: moment.MomentInput },
  documentIds: number[],
  lock = false,
): Promise<Record<number, number>> => {
  const ids = uniq(documentIds.filter(Boolean));
  if (ids.length === 0) return {};

  if (lock) {
    await knex(kind.documentsTable).whereIn('id', ids).forUpdate().select('id');
  }
  const date = moment(payment.date).format('YYYY-MM-DD');
  const sameTable = kind.paymentsTable === kind.entriesTable;

  const query = knex(`${kind.entriesTable} as e`);
  if (!sameTable) {
    query.join(
      `${kind.paymentsTable} as p`,
      'p.id',
      `e.${kind.entryPaymentId}`,
    );
  }
  const head = sameTable ? 'e' : 'p';

  const rows: Array<{ documentId: number; paidAmount: number }> = await query
    .whereIn(`e.${kind.entryDocumentId}`, ids)
    .modify((builder) => {
      if (!sameTable) {
        // Opening balance lines don't pay a document.
        builder.where((b) =>
          b
            .whereNull('e.entry_type')
            .orWhereNot('e.entry_type', 'opening_balance'),
        );
      }
    })
    .where((builder) =>
      builder
        .where(`${head}.${kind.dateColumn}`, '<', date)
        .orWhere((b) =>
          b
            .where(`${head}.${kind.dateColumn}`, date)
            .where(`${head}.id`, '<', payment.id),
        ),
    )
    .groupBy(`e.${kind.entryDocumentId}`)
    .select(`e.${kind.entryDocumentId} as documentId`)
    .sum(`e.${sameTable ? 'amount' : 'payment_amount'} as paidAmount`);

  return Object.fromEntries(
    rows.map((row) => [row.documentId, roundMoney(row.paidAmount)]),
  );
};

/**
 * A payment (or refund) with its date, in the order the running-total
 * split uses.
 */
export interface IOrderedPayment {
  id: number;
  date: string;
}

/**
 * Retrieves the payments of the given documents that come after the given
 * position (date, then id), in that order. Their cash basis split depends on
 * what came before them, so they are rebuilt when an earlier payment is
 * created, edited, deleted or re-dated.
 * @param {Knex} knex - Tenant knex or a transaction.
 * @param {IPaidBeforeKind} kind - The payment tables.
 * @param {number[]} documentIds - The documents.
 * @param {{ id: number; date: any }} after - The position to start after.
 * @returns {Promise<IOrderedPayment[]>}
 */
export const getLaterPayments = async (
  knex: Knex | Knex.Transaction,
  kind: IPaidBeforeKind,
  documentIds: number[],
  after: { id: number; date: moment.MomentInput },
): Promise<IOrderedPayment[]> => {
  const ids = uniq(documentIds.filter(Boolean));
  if (ids.length === 0) return [];

  const date = moment(after.date).format('YYYY-MM-DD');
  const sameTable = kind.paymentsTable === kind.entriesTable;
  const head = sameTable ? 'e' : 'p';

  const query = knex(`${kind.entriesTable} as e`);
  if (!sameTable) {
    query.join(
      `${kind.paymentsTable} as p`,
      'p.id',
      `e.${kind.entryPaymentId}`,
    );
  }
  const rows: Array<{ id: number; date: any }> = await query
    .whereIn(`e.${kind.entryDocumentId}`, ids)
    .where((builder) =>
      builder
        .where(`${head}.${kind.dateColumn}`, '>', date)
        .orWhere((b) =>
          b
            .where(`${head}.${kind.dateColumn}`, date)
            .where(`${head}.id`, '>', after.id),
        ),
    )
    .distinct(`${head}.id as id`, `${head}.${kind.dateColumn} as date`)
    .orderBy([
      { column: `${head}.${kind.dateColumn}`, order: 'asc' },
      { column: `${head}.id`, order: 'asc' },
    ]);

  return rows.map((row) => ({
    id: row.id,
    date: moment(row.date).format('YYYY-MM-DD'),
  }));
};

/**
 * Rebuilds the given payments one at a time, in order (each one's split
 * reads what the earlier ones posted), skipping those in a locked period.
 * @param {Knex} knex - Tenant knex or a transaction.
 * @param {IOrderedPayment[]} payments - In date, then id order.
 * @param {string} referenceType - E.g. 'PaymentReceive'.
 * @param {(id: number) => Promise<void>} rewrite - Rebuilds one payment.
 * @returns {Promise<IOrderedPayment[]>} The payments skipped (locked).
 */
export const rewritePaymentsInOrder = async (
  knex: Knex | Knex.Transaction,
  payments: IOrderedPayment[],
  referenceType: string,
  rewrite: (id: number) => Promise<void>,
): Promise<IOrderedPayment[]> => {
  if (payments.length === 0) return [];

  const isLocked = await getLockedPeriodChecker(knex as Knex);
  const skipped: IOrderedPayment[] = [];

  for (const payment of payments) {
    if (isLocked(payment.date, referenceType)) {
      skipped.push(payment);
      continue;
    }
    await rewrite(payment.id);
  }
  if (skipped.length > 0) {
    logger.warn(
      `The cash basis lines of ${referenceType} ${skipped
        .map((p) => `#${p.id} (${p.date})`)
        .join(', ')} are in a locked period and were not rebuilt; ` +
        'the money health check shows any cent left behind.',
    );
  }
  return skipped;
};

/**
 * The accrual lines of the given documents in the base currency, by
 * document and account, as stored (A/R and A/P left out): credits positive
 * (sign 1, invoices) or debits positive (sign -1, bills). The cash split of
 * a payment aims at them so a fully paid document ends at them exactly.
 * @param {Knex} knex - Tenant connection or transaction.
 * @param {string} documentType - 'SaleInvoice' or 'Bill'.
 * @param {number[]} documentIds - The documents.
 * @param {1 | -1} sign - 1: credit - debit, -1: debit - credit.
 * @returns {Promise<Record<number, Record<number, number>>>}
 */
export const getDocumentsAccrualLines = async (
  knex: Knex | Knex.Transaction,
  documentType: string,
  documentIds: number[],
  sign: 1 | -1,
): Promise<Record<number, Record<number, number>>> => {
  const ids = [...new Set(documentIds.filter(Boolean))];
  if (ids.length === 0) return {};

  const rows: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .where('t.reference_type', documentType)
    .whereIn('t.reference_id', ids)
    .where((builder) =>
      builder.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'),
    )
    .whereNotIn('a.account_type', ['accounts-receivable', 'accounts-payable'])
    .groupBy('t.reference_id', 't.account_id')
    .select('t.reference_id as documentId', 't.account_id as accountId')
    .select(knex.raw('SUM(?? - ??) as ??', ['t.credit', 't.debit', 'amount']));

  return rows.reduce(
    (acc, row) => {
      acc[row.documentId] = acc[row.documentId] || {};
      acc[row.documentId][row.accountId] = Number(row.amount) * sign;
      return acc;
    },
    {} as Record<number, Record<number, number>>,
  );
};

const logger = new Logger('CashBasisPaidBefore');
