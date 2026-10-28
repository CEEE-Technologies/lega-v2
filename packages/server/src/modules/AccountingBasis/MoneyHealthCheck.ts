import { moneyGt, moneyGte, toCents } from '@bigcapital/utils';
import { Knex } from 'knex';
import * as moment from 'moment';
import {
  ACCOUNT_NORMAL,
  ACCOUNT_TYPE,
  ACCOUNT_TYPES,
} from '@/constants/accounts';
import {
  SaleInvoice,
  SALE_INVOICE_MONEY_SQL,
} from '@/modules/SaleInvoices/models/SaleInvoice';
import { Bill, BILL_MONEY_SQL } from '@/modules/Bills/models/Bill';
import {
  CreditNote,
  CREDIT_NOTE_MONEY_SQL,
} from '@/modules/CreditNotes/models/CreditNote';
import {
  VendorCredit,
  VENDOR_CREDIT_MONEY_SQL,
} from '@/modules/VendorCredit/models/VendorCredit';

/**
 * Read-only money health check of one tenant database. It reports:
 * - (a) entry sets (reference + basis) whose debits differ from the credits,
 * - (b) ledger rows that are not whole cents,
 * - (c) stored account and contact balances that differ from the sum of
 *   their ledger rows,
 * - (d) fully paid invoices and bills whose cash basis lines don't add up to
 *   the document's accrual lines,
 * - (e) documents whose total or amount left (due / credit remaining) is
 *   not the same in the SQL the lists, due lists and aging reports use and
 *   in the app getters (the "one answer" parity of the money SQL).
 *
 * Plain queries on the given tenant connection (snake case mappers), so the
 * CLI can run it without the application context. Nothing is written.
 */

export interface IMoneyHealthUnbalancedSet {
  referenceType: string;
  referenceId: number;
  basis: string | null;
  debit: number;
  credit: number;
  difference: number;
  locked: boolean;
}

export interface IMoneyHealthNonCentRow {
  id: number;
  referenceType: string;
  referenceId: number;
  basis: string | null;
  accountId: number;
  date: string;
  debit: number;
  credit: number;
  locked: boolean;
}

export interface IMoneyHealthBalanceDifference {
  kind: 'account' | 'contact';
  id: number;
  name: string;
  stored: number;
  fromLedger: number;
  difference: number;
}

export interface IMoneyHealthCashDocumentDifference {
  documentType: 'SaleInvoice' | 'Bill';
  documentId: number;
  documentNo: string;
  accountId: number;
  accrual: number;
  cash: number;
  difference: number;
  locked: boolean;
}

export interface IMoneyHealthDocumentDifference {
  documentType: 'SaleInvoice' | 'Bill' | 'CreditNote' | 'VendorCredit';
  documentId: number;
  documentNo: string;
  field: 'total' | 'left';
  sql: number;
  app: number;
}

export interface IMoneyHealthResult {
  unbalancedSets: IMoneyHealthUnbalancedSet[];
  nonCentRows: IMoneyHealthNonCentRow[];
  balanceDifferences: IMoneyHealthBalanceDifference[];
  cashDocumentDifferences: IMoneyHealthCashDocumentDifference[];
  /** Fully paid documents skipped from (d): paid at another exchange rate. */
  cashDocumentsSkipped: number;
  /** Fully paid documents checked by (d). */
  cashDocumentsChecked: number;
  /** (e) Documents whose SQL and app money differ. */
  documentDifferences: IMoneyHealthDocumentDifference[];
  /** Documents checked by (e). */
  documentsChecked: number;
}

/**
 * The documents whose money is also computed in SQL (list tabs, due lists,
 * credit apply lists, aging reports), with that SQL and the getter of the
 * amount left.
 */
const PARITY_DOCUMENTS = [
  {
    documentType: 'SaleInvoice' as const,
    table: 'sales_invoices',
    numberColumn: 'invoice_no',
    model: SaleInvoice,
    totalSql: SALE_INVOICE_MONEY_SQL.total,
    leftSql: SALE_INVOICE_MONEY_SQL.due,
    left: (doc: any) => doc.dueAmount,
  },
  {
    documentType: 'Bill' as const,
    table: 'bills',
    numberColumn: 'bill_number',
    model: Bill,
    totalSql: BILL_MONEY_SQL.total,
    leftSql: BILL_MONEY_SQL.due,
    left: (doc: any) => doc.dueAmount,
  },
  {
    documentType: 'CreditNote' as const,
    table: 'credit_notes',
    numberColumn: 'credit_note_number',
    model: CreditNote,
    totalSql: CREDIT_NOTE_MONEY_SQL.total,
    leftSql: CREDIT_NOTE_MONEY_SQL.remaining,
    left: (doc: any) => doc.creditsRemaining,
  },
  {
    documentType: 'VendorCredit' as const,
    table: 'vendor_credits',
    numberColumn: 'vendor_credit_number',
    model: VendorCredit,
    totalSql: VENDOR_CREDIT_MONEY_SQL.total,
    leftSql: VENDOR_CREDIT_MONEY_SQL.remaining,
    left: (doc: any) => doc.creditsRemaining,
  },
];

/**
 * (e) Selects each stored document's total and amount left with the SQL
 * the lists use and compares them with the model getters on the same row.
 * Any difference means a list, due list or aging report gives another
 * answer than the document itself (Codex P2 was one: 0.01 "due" on a paid
 * invoice).
 */
const getDocumentParityDifferences = async (
  knex: Knex,
): Promise<{
  differences: IMoneyHealthDocumentDifference[];
  checked: number;
}> => {
  const differences: IMoneyHealthDocumentDifference[] = [];
  let checked = 0;

  for (const kind of PARITY_DOCUMENTS) {
    const rows: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .select('*')
      .select(knex.raw(`${kind.totalSql} as parity_sql_total`))
      .select(knex.raw(`${kind.leftSql} as parity_sql_left`));

    rows.forEach((row) => {
      checked += 1;
      const doc: any = (kind.model as any).fromJson(row, {
        skipValidation: true,
      });
      const compare = (field: 'total' | 'left', sql: number, app: number) => {
        if (toCents(sql) !== toCents(app)) {
          differences.push({
            documentType: kind.documentType,
            documentId: row.id,
            documentNo: row[camel(kind.numberColumn)] ?? `#${row.id}`,
            field,
            sql: Number(sql),
            app: Number(app),
          });
        }
      };
      compare('total', Number(row.paritySqlTotal), doc.total);
      // The getters clamp what is left at 0 (an over-settled document).
      compare('left', Math.max(Number(row.paritySqlLeft), 0), kind.left(doc));
    });
  }
  return { differences, checked };
};

const camel = (column: string) =>
  column.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

/** Float noise allowed when comparing sums read back as JS numbers. */
const NOISE = 0.000001;

const r = (value: any, precision = 5) =>
  Math.round(Number(value || 0) * 10 ** precision) / 10 ** precision || 0;

/**
 * Transaction types locked by the sales and purchases locking groups; any
 * other type belongs to the financial group.
 */
const SALES_TYPES = [
  'SaleInvoice',
  'SaleReceipt',
  'SaleEstimate',
  'PaymentReceive',
  'CreditNote',
  'RefundCreditNote',
  'CustomerOpeningBalance',
  'InvoiceWriteOff',
];
const PURCHASES_TYPES = [
  'Bill',
  'BillPayment',
  'VendorCredit',
  'RefundVendorCredit',
  'VendorOpeningBalance',
  'LandedCost',
];

const lockingGroupOf = (referenceType: string) =>
  SALES_TYPES.includes(referenceType)
    ? 'sales'
    : PURCHASES_TYPES.includes(referenceType)
      ? 'purchases'
      : 'financial';

export type IsLockedFn = (date: any, referenceType: string) => boolean;

/**
 * Reads the transactions locking settings of the tenant and returns a
 * function telling whether a transaction of the given type and date is in a
 * locked period (same rules as TransactionsLockingGuard).
 * @param {Knex} knex
 * @returns {Promise<IsLockedFn>}
 */
export const getLockedPeriodChecker = async (
  knex: Knex,
): Promise<IsLockedFn> => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('settings')
    .where('group', 'transactions-locking')
    .select('key', 'value');
  const settings = new Map(rows.map((row) => [row.key, row.value]));
  const lockingType = settings.get('locking-type') || 'partial';

  const isLockedInGroup = (date: any, group: string) => {
    const active = settings.get(`${group}.active`);
    if (!active || active === '0' || active === 'false') return false;

    const lockToDate = settings.get(`${group}.lock_to_date`);
    if (!lockToDate) return false;

    const unlockFrom = settings.get(`${group}.unlock_from_date`);
    const unlockTo = settings.get(`${group}.unlock_to_date`);
    const day = moment(date);
    const inLocking = day.isSameOrBefore(lockToDate, 'day');
    const inUnlock =
      unlockFrom && unlockTo
        ? day.isSameOrAfter(unlockFrom, 'day') &&
          day.isSameOrBefore(unlockTo, 'day')
        : false;
    return inLocking && !inUnlock;
  };
  return (date, referenceType) =>
    lockingType === 'all'
      ? isLockedInGroup(date, 'all')
      : isLockedInGroup(date, lockingGroupOf(referenceType));
};

/**
 * (a) Entry sets whose debits differ from the credits (exact decimal sums).
 */
const getUnbalancedSets = async (knex: Knex, isLocked: IsLockedFn) => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions')
    .groupBy('reference_type', 'reference_id', 'basis')
    .select('reference_type as referenceType', 'reference_id as referenceId')
    .select('basis')
    .min('date as date')
    .sum('debit as debit')
    .sum('credit as credit')
    .havingRaw('SUM(??) <> SUM(??)', ['debit', 'credit'])
    .orderBy(['reference_type', 'reference_id']);

  return rows.map((row) => ({
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    basis: row.basis ?? null,
    debit: r(row.debit),
    credit: r(row.credit),
    difference: r(row.debit - row.credit),
    locked: isLocked(row.date, row.referenceType),
  }));
};

/**
 * (b) Ledger rows that are not whole cents.
 */
const getNonCentRows = async (knex: Knex, isLocked: IsLockedFn) => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions')
    .whereRaw('?? <> ROUND(??, 2) OR ?? <> ROUND(??, 2)', [
      'debit',
      'debit',
      'credit',
      'credit',
    ])
    .select(
      'id',
      'reference_type as referenceType',
      'reference_id as referenceId',
      'basis',
      'account_id as accountId',
      'date',
      'debit',
      'credit',
    )
    .orderBy(['reference_type', 'reference_id', 'id']);

  return rows.map((row) => ({
    id: row.id,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    basis: row.basis ?? null,
    accountId: row.accountId,
    date: moment(row.date).format('YYYY-MM-DD'),
    debit: r(row.debit),
    credit: r(row.credit),
    locked: isLocked(row.date, row.referenceType),
  }));
};

const ACCOUNT_NORMAL_BY_TYPE = new Map(
  ACCOUNT_TYPES.map((type) => [type.key, type.normal]),
);

/**
 * (c) Stored account and contact balances versus the sum of their ledger
 * rows. The stored balances are accrual based (cash basis rows excluded); a
 * foreign currency account or contact sums its own currency's rows divided
 * by their exchange rate, as the ledger storage does.
 */
const getBalanceDifferences = async (knex: Knex, baseCurrency: string) => {
  const differences: IMoneyHealthBalanceDifference[] = [];

  const accounts: any[] = await knex
    .queryBuilder()
    .from('accounts')
    .select('id', 'name', 'account_type as accountType', 'amount')
    .select('currency_code as currencyCode');

  const accountSums: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .where((builder) =>
      builder.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'),
    )
    .groupBy('t.account_id')
    .select('t.account_id as accountId')
    .select(
      knex.raw('SUM(?? - ??) as ??', ['t.debit', 't.credit', 'local']),
      knex.raw(
        'SUM(CASE WHEN ?? = ?? THEN (?? - ??) / COALESCE(NULLIF(??, 0), 1) ELSE 0 END) as ??',
        [
          't.currency_code',
          'a.currency_code',
          't.debit',
          't.credit',
          't.exchange_rate',
          'foreign',
        ],
      ),
    );
  const sumsByAccount = new Map(accountSums.map((row) => [row.accountId, row]));

  accounts.forEach((account) => {
    const sums = sumsByAccount.get(account.id);
    const isForeign =
      account.currencyCode && account.currencyCode !== baseCurrency;
    const debitMinusCredit = Number(
      (isForeign ? sums?.foreign : sums?.local) || 0,
    );
    const normal = ACCOUNT_NORMAL_BY_TYPE.get(account.accountType);
    const fromLedger =
      normal === ACCOUNT_NORMAL.CREDIT ? -debitMinusCredit : debitMinusCredit;
    const stored = Number(account.amount || 0);

    // The account amount column keeps 5 decimals (a foreign currency
    // balance is local / rate, so it has more).
    if (Math.abs(stored - fromLedger) > 0.000005 + NOISE) {
      differences.push({
        kind: 'account',
        id: account.id,
        name: account.name,
        stored: r(stored),
        fromLedger: r(fromLedger),
        difference: r(stored - fromLedger),
      });
    }
  });

  const contacts: any[] = await knex
    .queryBuilder()
    .from('contacts')
    .select('id', 'display_name as name', 'balance')
    .select('currency_code as currencyCode');

  const contactSums: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .join('contacts as c', 'c.id', 't.contact_id')
    .whereIn('a.account_type', [
      ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
      ACCOUNT_TYPE.ACCOUNTS_PAYABLE,
    ])
    .where((builder) =>
      builder.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'),
    )
    .groupBy('t.contact_id')
    .select('t.contact_id as contactId')
    .select(
      knex.raw('SUM(CASE WHEN ?? = ? THEN ?? - ?? ELSE ?? - ?? END) as ??', [
        'a.account_type',
        ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
        't.debit',
        't.credit',
        't.credit',
        't.debit',
        'local',
      ]),
      knex.raw(
        'SUM(CASE WHEN ?? <> ?? THEN 0 WHEN ?? = ? THEN (?? - ??) / COALESCE(NULLIF(??, 0), 1) ELSE (?? - ??) / COALESCE(NULLIF(??, 0), 1) END) as ??',
        [
          't.currency_code',
          'c.currency_code',
          'a.account_type',
          ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
          't.debit',
          't.credit',
          't.exchange_rate',
          't.credit',
          't.debit',
          't.exchange_rate',
          'foreign',
        ],
      ),
    );
  const sumsByContact = new Map(contactSums.map((row) => [row.contactId, row]));

  contacts.forEach((contact) => {
    const sums = sumsByContact.get(contact.id);
    const isForeign =
      contact.currencyCode && contact.currencyCode !== baseCurrency;
    const fromLedger = Number((isForeign ? sums?.foreign : sums?.local) || 0);
    const stored = Number(contact.balance || 0);

    // The contact balance column keeps 3 decimals. A foreign currency
    // contact's balance is its ledger rows converted back to its currency
    // (base amount / rate), each rounded to 3 decimals as it is saved, so
    // it can drift below half a cent; a real difference is a cent or more.
    const tolerance = isForeign ? 0.005 : 0.0005;
    if (Math.abs(stored - fromLedger) > tolerance + NOISE) {
      differences.push({
        kind: 'contact',
        id: contact.id,
        name: contact.name,
        stored: r(stored),
        fromLedger: r(fromLedger),
        difference: r(stored - fromLedger),
      });
    }
  });
  return differences;
};

const DOCUMENT_KINDS = [
  {
    documentType: 'SaleInvoice' as const,
    documentsTable: 'sales_invoices',
    numberColumn: 'invoice_no',
    dateColumn: 'invoice_date',
    paymentType: 'PaymentReceive',
    paymentsTable: 'payment_receives',
    entriesTable: 'payment_receives_entries',
    entryPaymentId: 'payment_receive_id',
    entryDocumentId: 'invoice_id',
    // Income is credited by the invoice and by the payment cash lines.
    sign: 1,
  },
  {
    documentType: 'Bill' as const,
    documentsTable: 'bills',
    numberColumn: 'bill_number',
    dateColumn: 'bill_date',
    paymentType: 'BillPayment',
    paymentsTable: 'bills_payments',
    entriesTable: 'bills_payments_entries',
    entryPaymentId: 'bill_payment_id',
    entryDocumentId: 'bill_id',
    sign: -1,
  },
];

/**
 * (d) Fully paid invoices and bills whose cash basis lines don't add up to
 * the document. A payment's cash lines are not tagged with the document they
 * pay, so payments and documents are grouped into connected sets (a payment
 * joins every document it pays); a set is checked when all its documents are
 * fully paid by payments. Per account of the documents' accrual lines (all
 * but A/R and A/P), the documents' accrual amount must equal the payments'
 * cash amount.
 */
const getCashDocumentDifferences = async (knex: Knex, isLocked: IsLockedFn) => {
  const differences: IMoneyHealthCashDocumentDifference[] = [];
  let skipped = 0;
  let checked = 0;

  const arapAccounts: any[] = await knex
    .queryBuilder()
    .from('accounts')
    .whereIn('account_type', [
      ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
      ACCOUNT_TYPE.ACCOUNTS_PAYABLE,
    ])
    .select('id');
  const arapIds = new Set(arapAccounts.map((row) => row.id));

  for (const kind of DOCUMENT_KINDS) {
    // Payment lines of documents (opening balance lines have no document).
    const links: any[] = await knex
      .queryBuilder()
      .from(`${kind.entriesTable} as e`)
      .join(`${kind.paymentsTable} as p`, 'p.id', `e.${kind.entryPaymentId}`)
      .join(`${kind.documentsTable} as d`, 'd.id', `e.${kind.entryDocumentId}`)
      .whereNotNull(`e.${kind.entryDocumentId}`)
      .where((builder) =>
        builder
          .whereNull('e.entry_type')
          .orWhere('e.entry_type', '<>', 'opening_balance'),
      )
      .select(
        `e.${kind.entryPaymentId} as paymentId`,
        `e.${kind.entryDocumentId} as documentId`,
        'e.payment_amount as paymentAmount',
        'p.exchange_rate as paymentRate',
        'd.exchange_rate as documentRate',
      );
    if (links.length === 0) continue;

    const documentIds = [...new Set(links.map((l) => l.documentId))];

    // Accrual lines of the documents (all but A/R and A/P), signed.
    const accrualRows: any[] = await knex
      .queryBuilder()
      .from('accounts_transactions')
      .where('reference_type', kind.documentType)
      .whereIn('reference_id', documentIds)
      .where((builder) =>
        builder.whereNull('basis').orWhere('basis', '<>', 'cash'),
      )
      .groupBy('reference_id', 'account_id')
      .select('reference_id as documentId', 'account_id as accountId')
      .select(knex.raw('SUM(?? - ??) as ??', ['credit', 'debit', 'amount']));

    // A/R (A/P) amount of each document: its total in local currency.
    const totals = new Map<number, number>();
    const accrualByDocument = new Map<number, Map<number, number>>();

    accrualRows.forEach((row) => {
      const amount = Number(row.amount) * kind.sign;
      if (arapIds.has(row.accountId)) {
        totals.set(row.documentId, (totals.get(row.documentId) || 0) - amount);
        return;
      }
      const byAccount = accrualByDocument.get(row.documentId) || new Map();
      byAccount.set(
        row.accountId,
        (byAccount.get(row.accountId) || 0) + amount,
      );
      accrualByDocument.set(row.documentId, byAccount);
    });

    const documents: any[] = await knex
      .queryBuilder()
      .from(kind.documentsTable)
      .whereIn('id', documentIds)
      .select(
        'id',
        `${kind.numberColumn} as documentNo`,
        `${kind.dateColumn} as date`,
      )
      .select('exchange_rate as exchangeRate');
    const documentsById = new Map(documents.map((d) => [d.id, d]));

    // Paid by payments (document currency) and whether all rates match.
    const paid = new Map<number, number>();
    const sameRate = new Map<number, boolean>();
    links.forEach((link) => {
      paid.set(
        link.documentId,
        (paid.get(link.documentId) || 0) + Number(link.paymentAmount),
      );
      const same =
        Math.abs(
          Number(link.paymentRate || 1) - Number(link.documentRate || 1),
        ) < 1e-9;
      sameRate.set(
        link.documentId,
        (sameRate.get(link.documentId) ?? true) && same,
      );
    });
    const isFullyPaid = (documentId: number) => {
      const document = documentsById.get(documentId);
      const totalLocal = totals.get(documentId) || 0;
      const totalDoc = totalLocal / Number(document?.exchangeRate || 1);
      return (
        moneyGt(totalDoc, 0) && moneyGte(paid.get(documentId) || 0, totalDoc)
      );
    };

    // Connected sets of payments and documents (union-find on documents).
    const parent = new Map<number, number>();
    const find = (id: number): number => {
      while (parent.get(id) !== id) id = parent.get(id) as number;
      return id;
    };
    documentIds.forEach((id) => parent.set(id, id));
    const firstDocumentOfPayment = new Map<number, number>();
    links.forEach((link) => {
      const first = firstDocumentOfPayment.get(link.paymentId);
      if (first === undefined) {
        firstDocumentOfPayment.set(link.paymentId, link.documentId);
      } else {
        parent.set(find(link.documentId), find(first));
      }
    });
    const groups = new Map<
      number,
      { documents: number[]; payments: Set<number> }
    >();
    documentIds.forEach((id) => {
      const root = find(id);
      const group = groups.get(root) || { documents: [], payments: new Set() };
      group.documents.push(id);
      groups.set(root, group);
    });
    links.forEach((link) => {
      groups.get(find(link.documentId))?.payments.add(link.paymentId);
    });

    for (const group of groups.values()) {
      if (!group.documents.every(isFullyPaid)) continue;

      if (!group.documents.every((id) => sameRate.get(id))) {
        skipped += group.documents.length;
        continue;
      }
      checked += group.documents.length;

      const accrual = new Map<number, number>();
      group.documents.forEach((id) => {
        (accrualByDocument.get(id) || new Map()).forEach(
          (amount, accountId) => {
            accrual.set(accountId, (accrual.get(accountId) || 0) + amount);
          },
        );
      });
      const cashRows: any[] = await knex
        .queryBuilder()
        .from('accounts_transactions')
        .where('reference_type', kind.paymentType)
        .whereIn('reference_id', [...group.payments])
        .where('basis', 'cash')
        .whereIn('account_id', [...accrual.keys()])
        .groupBy('account_id')
        .select('account_id as accountId')
        .select(knex.raw('SUM(?? - ??) as ??', ['credit', 'debit', 'amount']));
      const cash = new Map(
        cashRows.map((row) => [row.accountId, Number(row.amount) * kind.sign]),
      );
      const label = group.documents
        .map((id) => documentsById.get(id)?.documentNo || `#${id}`)
        .join(', ');
      const locked = group.documents.some((id) =>
        isLocked(documentsById.get(id)?.date, kind.documentType),
      );
      accrual.forEach((accrualAmount, accountId) => {
        const cashAmount = cash.get(accountId) || 0;
        if (Math.abs(accrualAmount - cashAmount) > NOISE) {
          differences.push({
            documentType: kind.documentType,
            documentId: group.documents[0],
            documentNo: label,
            accountId,
            accrual: r(accrualAmount),
            cash: r(cashAmount),
            difference: r(accrualAmount - cashAmount),
            locked,
          });
        }
      });
    }
  }
  return { differences, skipped, checked };
};

/**
 * Runs the money health check on the given tenant database.
 * @param {Knex} knex - Tenant database connection.
 * @param {string} baseCurrency - The tenant base currency.
 * @returns {Promise<IMoneyHealthResult>}
 */
export const checkMoneyHealth = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IMoneyHealthResult> => {
  const isLocked = await getLockedPeriodChecker(knex);
  const unbalancedSets = await getUnbalancedSets(knex, isLocked);
  const nonCentRows = await getNonCentRows(knex, isLocked);
  const balanceDifferences = await getBalanceDifferences(knex, baseCurrency);
  const cashDocuments = await getCashDocumentDifferences(knex, isLocked);
  const documentParity = await getDocumentParityDifferences(knex);

  return {
    unbalancedSets,
    nonCentRows,
    balanceDifferences,
    cashDocumentDifferences: cashDocuments.differences,
    cashDocumentsSkipped: cashDocuments.skipped,
    cashDocumentsChecked: cashDocuments.checked,
    documentDifferences: documentParity.differences,
    documentsChecked: documentParity.checked,
  };
};

/**
 * Whether the result is clean outside locked periods.
 * @param {IMoneyHealthResult} result
 * @returns {boolean}
 */
export const isMoneyHealthClean = (result: IMoneyHealthResult) =>
  result.unbalancedSets.every((row) => row.locked) &&
  result.nonCentRows.every((row) => row.locked) &&
  result.balanceDifferences.length === 0 &&
  result.cashDocumentDifferences.every((row) => row.locked) &&
  (result.documentDifferences ?? []).length === 0;

/**
 * Formats the result as printable lines.
 * @param {IMoneyHealthResult} result
 * @returns {string[]}
 */
export const formatMoneyHealth = (result: IMoneyHealthResult): string[] => {
  const lines: string[] = [];
  const lockedTag = (locked: boolean) => (locked ? ' [locked period]' : '');

  lines.push(`  (a) Unbalanced entry sets: ${result.unbalancedSets.length}`);
  result.unbalancedSets.forEach((row) =>
    lines.push(
      `      ${row.referenceType} #${row.referenceId} [${row.basis ?? 'general'}]: debit ${row.debit}, credit ${row.credit} (diff ${row.difference})${lockedTag(row.locked)}`,
    ),
  );
  lines.push(
    `  (b) Ledger rows not in whole cents: ${result.nonCentRows.length}`,
  );
  result.nonCentRows.forEach((row) =>
    lines.push(
      `      row #${row.id} ${row.referenceType} #${row.referenceId} [${row.basis ?? 'general'}] account #${row.accountId} ${row.date}: debit ${row.debit}, credit ${row.credit}${lockedTag(row.locked)}`,
    ),
  );
  lines.push(
    `  (c) Stored balances different from their ledger rows: ${result.balanceDifferences.length}`,
  );
  result.balanceDifferences.forEach((row) =>
    lines.push(
      `      ${row.kind} #${row.id} ${row.name}: stored ${row.stored}, ledger ${row.fromLedger} (diff ${row.difference})`,
    ),
  );
  lines.push(
    `  (d) Fully paid documents whose cash lines differ from the document: ${result.cashDocumentDifferences.length} account lines` +
      ` (${result.cashDocumentsChecked} documents checked, ${result.cashDocumentsSkipped} skipped: paid at another exchange rate)`,
  );
  result.cashDocumentDifferences.forEach((row) =>
    lines.push(
      `      ${row.documentType} ${row.documentNo} account #${row.accountId}: accrual ${row.accrual}, cash ${row.cash} (diff ${row.difference})${lockedTag(row.locked)}`,
    ),
  );
  const documentDifferences = result.documentDifferences ?? [];
  lines.push(
    `  (e) Documents whose list SQL and app give another total or amount left: ${documentDifferences.length}` +
      ` (${result.documentsChecked ?? 0} documents checked)`,
  );
  documentDifferences.forEach((row) =>
    lines.push(
      `      ${row.documentType} ${row.documentNo}: ${row.field} SQL ${row.sql}, app ${row.app}`,
    ),
  );
  return lines;
};
