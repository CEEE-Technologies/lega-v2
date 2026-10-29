import { Knex } from 'knex';
import * as moment from 'moment';
import { uniq } from 'lodash';
import {
  multiplyMoney,
  roundMoney,
  subtractMoney,
  sumMoney,
} from '@bigcapital/utils';

/**
 * A credit (credit note / vendor credit) applied to a document (invoice /
 * bill) writes no ledger lines of its own: the credit relieved A/R (A/P)
 * when it was posted, at the CREDIT's rate, while the document needs the
 * relief at ITS rate. Each application now posts the difference between
 * the two, A/R (A/P) <-> Exchange gain or loss, with the contact, in the
 * base currency (no foreign amount):
 *
 * - the document's relief is a running total at the document rate on top
 *   of everything that settles it: all its payments, then its earlier
 *   applications (by id), then this one; a write-off is the remainder;
 * - the credit's part is a running total at the credit rate over the
 *   credit's applications (by id).
 *
 * The order is by kind (payments, credits, write-off), not by date, so it
 * never depends on what happened first: once the document is fully settled
 * its A/R (A/P) lines add up to exactly 0. Any change (payment, application,
 * rate) rebuilds the applications of the documents and credits involved.
 *
 * EUR 50.01 invoice at 1.5 (75.02), EUR 50.01 credit at 1.6 (80.02): the
 * application debits A/R 5.00 and credits exchange gain/loss 5.00.
 */
export interface ICreditApplicationKind {
  referenceType: 'CreditNoteApplyInvoice' | 'VendorCreditApplyBill';
  applicationsTable: string;
  documentIdColumn: string;
  creditIdColumn: string;
  documentsTable: string;
  creditsTable: string;
  creditNumberColumn: string;
  contactColumn: string;
  paymentEntriesTable: string;
  paymentEntryDocumentColumn: string;
  /** A/R (sales) or A/P (purchases). */
  receivable: boolean;
}

export const CREDIT_NOTE_APPLICATIONS: ICreditApplicationKind = {
  referenceType: 'CreditNoteApplyInvoice',
  applicationsTable: 'credit_note_applied_invoice',
  documentIdColumn: 'invoice_id',
  creditIdColumn: 'credit_note_id',
  documentsTable: 'sales_invoices',
  creditsTable: 'credit_notes',
  creditNumberColumn: 'credit_note_number',
  contactColumn: 'customer_id',
  paymentEntriesTable: 'payment_receives_entries',
  paymentEntryDocumentColumn: 'invoice_id',
  receivable: true,
};

export const VENDOR_CREDIT_APPLICATIONS: ICreditApplicationKind = {
  referenceType: 'VendorCreditApplyBill',
  applicationsTable: 'vendor_credit_applied_bill',
  documentIdColumn: 'bill_id',
  creditIdColumn: 'vendor_credit_id',
  documentsTable: 'bills',
  creditsTable: 'vendor_credits',
  creditNumberColumn: 'vendor_credit_number',
  contactColumn: 'vendor_id',
  paymentEntriesTable: 'bills_payments_entries',
  paymentEntryDocumentColumn: 'bill_id',
  receivable: false,
};

export interface ICreditApplicationAmounts {
  /** The application's amount (document currency). */
  amount: number;
  documentRate: number;
  /** Paid on the document by all its payments (document currency). */
  paidOnDocument: number;
  /** Applied to the document by its earlier applications. */
  creditedBefore: number;
  creditRate: number;
  /** Applied from the credit by its earlier applications. */
  appliedBefore: number;
}

/**
 * The base currency amounts of an application: the document's relief at
 * its rate, the credit's part at its rate, and the adjustment between them
 * (positive: the credit relieved more than the document needs).
 */
export const getCreditApplicationAdjustment = (
  input: ICreditApplicationAmounts,
) => {
  const settled = sumMoney(input.paidOnDocument, input.creditedBefore);
  const documentRelief = subtractMoney(
    multiplyMoney(sumMoney(settled, input.amount), input.documentRate || 1),
    multiplyMoney(settled, input.documentRate || 1),
  );
  const creditPart = subtractMoney(
    multiplyMoney(
      sumMoney(input.appliedBefore, input.amount),
      input.creditRate || 1,
    ),
    multiplyMoney(input.appliedBefore, input.creditRate || 1),
  );
  return {
    documentRelief,
    creditPart,
    adjustment: subtractMoney(creditPart, documentRelief),
  };
};

/**
 * Reads, for each application of the kind, what its adjustment depends on.
 * Plain queries on the tenant connection (snake case mappers), so the
 * health check can use it too.
 * @returns {Promise<Map<number, ICreditApplicationRow>>} By application id.
 */
export interface ICreditApplicationRow extends ICreditApplicationAmounts {
  id: number;
  documentId: number;
  creditId: number;
  contactId: number;
  currencyCode: string;
  creditNumber: string;
  branchId: number | null;
  date: string;
}

export const getCreditApplicationRows = async (
  knex: Knex | Knex.Transaction,
  kind: ICreditApplicationKind,
  filter: { documentIds?: number[]; creditIds?: number[] } | 'all',
): Promise<ICreditApplicationRow[]> => {
  const documentIds = filter === 'all' ? [] : uniq(filter.documentIds || []);
  const creditIds = filter === 'all' ? [] : uniq(filter.creditIds || []);
  if (filter !== 'all' && documentIds.length + creditIds.length === 0) {
    return [];
  }
  const applications: any[] = await knex
    .queryBuilder()
    .from(`${kind.applicationsTable} as x`)
    .modify((builder) => {
      if (filter === 'all') return;
      builder.where((b) => {
        if (documentIds.length) {
          b.orWhereIn(`x.${kind.documentIdColumn}`, documentIds);
        }
        if (creditIds.length) {
          b.orWhereIn(`x.${kind.creditIdColumn}`, creditIds);
        }
      });
    })
    .select(
      'x.id as id',
      'x.amount as amount',
      `x.${kind.documentIdColumn} as documentId`,
      `x.${kind.creditIdColumn} as creditId`,
      'x.created_at as createdAt',
    )
    .orderBy('x.id');
  if (applications.length === 0) return [];

  const allDocumentIds = uniq(applications.map((a) => a.documentId));
  const allCreditIds = uniq(applications.map((a) => a.creditId));

  const documents: any[] = await knex
    .queryBuilder()
    .from(kind.documentsTable)
    .whereIn('id', allDocumentIds)
    .select(
      'id',
      'exchange_rate as exchangeRate',
      'currency_code as currencyCode',
      `${kind.contactColumn} as contactId`,
      'branch_id as branchId',
    );
  const credits: any[] = await knex
    .queryBuilder()
    .from(kind.creditsTable)
    .whereIn('id', allCreditIds)
    .select(
      'id',
      'exchange_rate as exchangeRate',
      `${kind.creditNumberColumn} as creditNumber`,
    );
  const paid: any[] = await knex
    .queryBuilder()
    .from(kind.paymentEntriesTable)
    .whereIn(kind.paymentEntryDocumentColumn, allDocumentIds)
    .where((b) =>
      b.whereNull('entry_type').orWhereNot('entry_type', 'opening_balance'),
    )
    .groupBy(kind.paymentEntryDocumentColumn)
    .select(`${kind.paymentEntryDocumentColumn} as documentId`)
    .sum('payment_amount as paid');
  // Every application of these documents and credits, for the "before"
  // sums (the filter may have left some out).
  const related: any[] = await knex
    .queryBuilder()
    .from(kind.applicationsTable)
    .where((b) =>
      b
        .whereIn(kind.documentIdColumn, allDocumentIds)
        .orWhereIn(kind.creditIdColumn, allCreditIds),
    )
    .select(
      'id',
      'amount',
      `${kind.documentIdColumn} as documentId`,
      `${kind.creditIdColumn} as creditId`,
    );

  const documentsById = new Map(documents.map((d) => [d.id, d]));
  const creditsById = new Map(credits.map((c) => [c.id, c]));
  const paidByDocument = new Map(
    paid.map((p) => [p.documentId, roundMoney(Number(p.paid || 0))]),
  );
  const sumBefore = (
    key: 'documentId' | 'creditId',
    id: number,
    before: number,
  ) =>
    sumMoney(
      ...related
        .filter((r) => r[key] === id && r.id < before)
        .map((r) => Number(r.amount || 0)),
    );

  return applications.map((application) => {
    const document = documentsById.get(application.documentId) || {};
    const credit = creditsById.get(application.creditId) || {};
    return {
      id: application.id,
      documentId: application.documentId,
      creditId: application.creditId,
      contactId: document.contactId,
      currencyCode: document.currencyCode,
      creditNumber: credit.creditNumber,
      branchId: document.branchId ?? null,
      date: moment(application.createdAt).format('YYYY-MM-DD'),
      amount: roundMoney(Number(application.amount || 0)),
      documentRate: Number(document.exchangeRate || 1),
      paidOnDocument: paidByDocument.get(application.documentId) || 0,
      creditedBefore: sumBefore(
        'documentId',
        application.documentId,
        application.id,
      ),
      creditRate: Number(credit.exchangeRate || 1),
      appliedBefore: sumBefore(
        'creditId',
        application.creditId,
        application.id,
      ),
    };
  });
};
