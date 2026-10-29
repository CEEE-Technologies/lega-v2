import { Knex } from 'knex';
import * as moment from 'moment';
import { groupBy } from 'lodash';
import {
  calcLineMoney,
  moneyEq,
  roundMoney,
  sumMoneyBy,
} from '@bigcapital/utils';
import {
  ACCOUNT_NORMAL,
  ACCOUNT_TYPE,
  ACCOUNT_TYPES,
} from '@/constants/accounts';
import { normalizeLedgerEntries } from '@/modules/Ledger/LedgerNormalizer';
import {
  getLockedPeriodChecker,
  hasForeignAmountColumns,
} from './MoneyHealthCheck';

/**
 * Repair of the money stored before the rounding fixes (plan P8), on one
 * tenant database. Plain queries (snake case mappers), so the dry run needs
 * no application context.
 *
 * - Ledger sets with rows that are not whole cents are re-posted in place:
 *   every row rounded to cents and a rounding leftover put on the largest
 *   income/expense row, as the ledger storage now does for new sets.
 * - Documents whose stored subtotal or tax differ from the line maths are
 *   updated to it (only when their ledger then still agrees with them).
 * - The cash basis set is rebuilt in date order (in the application).
 * - The stored account and contact balances are recalculated from their
 *   ledger rows.
 * Transactions in a locked period are never changed: they are listed.
 */

export interface IRepairSet {
  referenceType: string;
  referenceId: number;
  basis: string | null;
  date: string;
  reason: string;
  locked: boolean;
}

export interface IRepairDocument {
  documentType: string;
  documentId: number;
  documentNo: string;
  date: string;
  storedSubtotal: number;
  newSubtotal: number;
  storedTax: number | null;
  newTax: number | null;
  locked: boolean;
  /** Set when the document can't be repaired automatically. */
  needsReview?: string;
}

export interface IRepairBalance {
  kind: 'account' | 'contact';
  id: number;
  name: string;
  stored: number;
  fromLedger: number;
}

export interface IMoneyRepairPlan {
  /** The tenant base currency the plan was made with. */
  baseCurrency?: string;
  sets: IRepairSet[];
  documents: IRepairDocument[];
  balances: IRepairBalance[];
}

const NOISE = 0.000001;

/**
 * The ledger sets (reference + basis) with rows that are not whole cents or
 * whose debits differ from their credits.
 */
const getSetsToRepost = async (
  knex: Knex,
  isLocked: (date: any, referenceType: string) => boolean,
): Promise<IRepairSet[]> => {
  const nonCent: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions')
    .whereRaw('?? <> ROUND(??, 2) OR ?? <> ROUND(??, 2)', [
      'debit',
      'debit',
      'credit',
      'credit',
    ])
    .groupBy('reference_type', 'reference_id', 'basis')
    .select('reference_type as referenceType', 'reference_id as referenceId')
    .select('basis')
    .min('date as date');

  const unbalanced: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions')
    .groupBy('reference_type', 'reference_id', 'basis')
    .select('reference_type as referenceType', 'reference_id as referenceId')
    .select('basis')
    .min('date as date')
    .havingRaw('SUM(??) <> SUM(??)', ['debit', 'credit']);

  const byKey = new Map<string, IRepairSet>();
  const add = (row: any, reason: string) => {
    const key = `${row.referenceType}|${row.referenceId}|${row.basis ?? ''}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.reason = `${existing.reason}; ${reason}`;
      return;
    }
    byKey.set(key, {
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      basis: row.basis ?? null,
      date: moment(row.date).format('YYYY-MM-DD'),
      reason,
      locked: isLocked(row.date, row.referenceType),
    });
  };
  nonCent.forEach((row) => add(row, 'rows not in whole cents'));
  unbalanced.forEach((row) => add(row, 'debits differ from credits'));

  return [...byKey.values()].sort(
    (a, b) =>
      a.referenceType.localeCompare(b.referenceType) ||
      a.referenceId - b.referenceId ||
      String(a.basis).localeCompare(String(b.basis)),
  );
};

const DOCUMENT_KINDS = [
  {
    documentType: 'SaleInvoice',
    table: 'sales_invoices',
    subtotalColumn: 'balance',
    taxColumn: 'tax_amount_withheld',
    numberColumn: 'invoice_no',
    dateColumn: 'invoice_date',
  },
  {
    documentType: 'Bill',
    table: 'bills',
    subtotalColumn: 'amount',
    taxColumn: 'tax_amount_withheld',
    numberColumn: 'bill_number',
    dateColumn: 'bill_date',
  },
  {
    documentType: 'SaleReceipt',
    table: 'sales_receipts',
    subtotalColumn: 'amount',
    taxColumn: null,
    numberColumn: 'receipt_number',
    dateColumn: 'receipt_date',
  },
  {
    documentType: 'CreditNote',
    table: 'credit_notes',
    subtotalColumn: 'amount',
    taxColumn: null,
    numberColumn: 'credit_note_number',
    dateColumn: 'credit_note_date',
  },
  {
    documentType: 'VendorCredit',
    table: 'vendor_credits',
    subtotalColumn: 'amount',
    taxColumn: null,
    numberColumn: 'vendor_credit_number',
    dateColumn: 'vendor_credit_date',
  },
];

/**
 * The documents whose stored subtotal (or tax) differ from their line
 * maths (each line rounded to cents, tax after the line discount).
 */
const getDocumentsToUpdate = async (
  knex: Knex,
  isLocked: (date: any, referenceType: string) => boolean,
): Promise<IRepairDocument[]> => {
  const documents: IRepairDocument[] = [];

  for (const kind of DOCUMENT_KINDS) {
    const hasInclusive = await knex.schema.hasColumn(
      kind.table,
      'is_inclusive_tax',
    );
    const rows: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .select(
        'id',
        `${kind.subtotalColumn} as subtotal`,
        `${kind.numberColumn} as documentNo`,
        `${kind.dateColumn} as date`,
        ...(kind.taxColumn ? [`${kind.taxColumn} as tax`] : []),
        ...(hasInclusive ? ['is_inclusive_tax as isInclusiveTax'] : []),
      );
    if (rows.length === 0) continue;

    const entries: any[] = await knex
      .queryBuilder()
      .from('items_entries')
      .where('reference_type', kind.documentType)
      .select(
        'reference_id as referenceId',
        'quantity',
        'rate',
        'discount',
        'discount_type as discountType',
        'tax_rate as taxRate',
      );
    const entriesByDocument = groupBy(entries, (entry) =>
      String(entry.referenceId),
    );

    rows.forEach((row) => {
      const lines = (entriesByDocument[String(row.id)] || []).map((entry) =>
        calcLineMoney({
          quantity: entry.quantity,
          rate: entry.rate,
          discount: entry.discount,
          discountType: entry.discountType || 'percentage',
          taxRate: entry.taxRate,
          isInclusiveTax: !!row.isInclusiveTax,
        }),
      );
      if (lines.length === 0) return;

      const newSubtotal = sumMoneyBy(lines, 'taxableAmount');
      const newTax = kind.taxColumn ? sumMoneyBy(lines, 'taxAmount') : null;
      const storedSubtotal = Number(row.subtotal || 0);
      const storedTax = kind.taxColumn ? Number(row.tax || 0) : null;

      const subtotalChanged = Math.abs(storedSubtotal - newSubtotal) > NOISE;
      const taxChanged =
        kind.taxColumn && Math.abs((storedTax || 0) - (newTax || 0)) > NOISE;

      if (subtotalChanged || taxChanged) {
        const moreThanRounding =
          !moneyEq(roundMoney(storedSubtotal), newSubtotal) ||
          (kind.taxColumn && !moneyEq(roundMoney(storedTax), newTax));

        documents.push({
          documentType: kind.documentType,
          documentId: row.id,
          documentNo: row.documentNo,
          date: moment(row.date).format('YYYY-MM-DD'),
          storedSubtotal,
          newSubtotal,
          storedTax,
          newTax,
          locked: isLocked(row.date, kind.documentType),
          // A change bigger than rounding (e.g. the tax now after the line
          // discount) changes the document itself: left for a person.
          ...(moreThanRounding
            ? {
                needsReview:
                  'the new line maths change the document by more than rounding',
              }
            : {}),
        });
      }
    });
  }
  return documents;
};

const ACCOUNT_NORMAL_BY_TYPE = new Map(
  ACCOUNT_TYPES.map((type) => [type.key, type.normal]),
);

/**
 * The stored account and contact balances as they should be from their
 * ledger rows (accrual based: cash basis rows excluded). A foreign currency
 * account/contact sums its own currency's rows over their exchange rate.
 */
const getBalancesFromLedger = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IRepairBalance[]> => {
  // The foreign amounts (before the tenant migration: base / rate). Raw
  // SQL, so the names are written as the tenant mapper stores them.
  const hasForeign = await hasForeignAmountColumns(knex);
  const col = (alias: string, column: string) =>
    `${alias}.${column}`.toUpperCase();
  const foreignNet = (alias: string, plus: string, minus: string) => {
    const byRate = `(${col(alias, plus)} - ${col(alias, minus)}) / COALESCE(NULLIF(${col(alias, 'exchange_rate')}, 0), 1)`;
    return hasForeign
      ? `COALESCE(${col(alias, `foreign_${plus}`)} - ${col(alias, `foreign_${minus}`)}, ${byRate})`
      : byRate;
  };

  const balances: IRepairBalance[] = [];

  const accounts: any[] = await knex
    .queryBuilder()
    .from('accounts')
    .select('id', 'name', 'account_type as accountType', 'amount')
    .select('currency_code as currencyCode');
  const accountSums: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions as t')
    .join('accounts as a', 'a.id', 't.account_id')
    .where((b) => b.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'))
    .groupBy('t.account_id')
    .select('t.account_id as accountId')
    .select(
      knex.raw('SUM(?? - ??) as ??', ['t.debit', 't.credit', 'local']),
      // The stored foreign amounts (a row posted before them: base / rate).
      knex.raw(
        `SUM(CASE WHEN ?? = ?? THEN ${foreignNet('t', 'debit', 'credit')} ELSE 0 END) as ??`,
        ['t.currency_code', 'a.currency_code', 'foreign'],
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
    const fromLedger =
      ACCOUNT_NORMAL_BY_TYPE.get(account.accountType) === ACCOUNT_NORMAL.CREDIT
        ? -debitMinusCredit
        : debitMinusCredit;
    const stored = Number(account.amount || 0);

    // The account amount column keeps 5 decimals.
    if (Math.abs(stored - fromLedger) > 0.000005 + NOISE) {
      balances.push({
        kind: 'account',
        id: account.id,
        name: account.name,
        stored,
        fromLedger,
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
    .where((b) => b.whereNull('t.basis').orWhere('t.basis', '<>', 'cash'))
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
        `SUM(CASE WHEN ?? <> ?? THEN 0 WHEN ?? = ? THEN ${foreignNet('t', 'debit', 'credit')} ELSE ${foreignNet('t', 'credit', 'debit')} END) as ??`,
        [
          't.currency_code',
          'c.currency_code',
          'a.account_type',
          ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE,
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

    // The contact balance column keeps 3 decimals.
    if (Math.abs(stored - fromLedger) > 0.0005 + NOISE) {
      balances.push({
        kind: 'contact',
        id: contact.id,
        name: contact.name,
        stored,
        fromLedger,
      });
    }
  });
  return balances;
};

/**
 * Builds the repair plan of the tenant (the dry run). Nothing is changed.
 * @param {Knex} knex - Tenant knex.
 * @param {string} baseCurrency
 * @returns {Promise<IMoneyRepairPlan>}
 */
export const planMoneyRepair = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IMoneyRepairPlan> => {
  const isLocked = await getLockedPeriodChecker(knex);

  return {
    sets: await getSetsToRepost(knex, isLocked),
    documents: await getDocumentsToUpdate(knex, isLocked),
    balances: await getBalancesFromLedger(knex, baseCurrency),
    baseCurrency,
  };
};

export interface IMoneyRepairApplyResult {
  setsReposted: IRepairSet[];
  setsSkipped: Array<IRepairSet & { why: string }>;
  documentsUpdated: IRepairDocument[];
  documentsSkipped: Array<IRepairDocument & { why: string }>;
}

/**
 * Re-posts the given sets in place and updates the documents' stored
 * totals, in one transaction. Locked sets/documents and documents needing
 * review are skipped. The cash basis rebuild and the balances follow
 * (`recalculateStoredBalances`).
 * @param {Knex} knex - Tenant knex.
 * @param {IMoneyRepairPlan} plan
 * @returns {Promise<IMoneyRepairApplyResult>}
 */
export const applyLedgerRepair = async (
  knex: Knex,
  plan: IMoneyRepairPlan,
): Promise<IMoneyRepairApplyResult> => {
  const result: IMoneyRepairApplyResult = {
    setsReposted: [],
    setsSkipped: [],
    documentsUpdated: [],
    documentsSkipped: [],
  };

  const hasForeign = await hasForeignAmountColumns(knex);

  await knex.transaction(async (trx) => {
    // 1. The documents' stored totals.
    for (const document of plan.documents) {
      if (document.locked) {
        result.documentsSkipped.push({ ...document, why: 'locked period' });
        continue;
      }
      if (document.needsReview) {
        result.documentsSkipped.push({
          ...document,
          why: document.needsReview,
        });
        continue;
      }
      const kind = DOCUMENT_KINDS.find(
        (k) => k.documentType === document.documentType,
      );
      await trx(kind.table)
        .where('id', document.documentId)
        .update({
          [kind.subtotalColumn]: document.newSubtotal,
          ...(kind.taxColumn ? { [kind.taxColumn]: document.newTax } : {}),
        });
      result.documentsUpdated.push(document);
    }

    // 2. The ledger sets, in place.
    const accounts: any[] = await trx
      .queryBuilder()
      .from('accounts')
      .select('id', 'account_type as accountType');
    const accountTypes = new Map(accounts.map((a) => [a.id, a.accountType]));

    for (const set of plan.sets) {
      if (set.locked) {
        result.setsSkipped.push({ ...set, why: 'locked period' });
        continue;
      }
      const rows: any[] = await trx
        .queryBuilder()
        .from('accounts_transactions')
        .where('reference_type', set.referenceType)
        .where('reference_id', set.referenceId)
        .modify((b) =>
          set.basis === null
            ? b.whereNull('basis')
            : b.where('basis', set.basis),
        )
        .select('id', 'debit', 'credit', 'account_id as accountId')
        .select(
          'exchange_rate as exchangeRate',
          'currency_code as currencyCode',
        )
        .forUpdate();

      const { entries, unbalanced } = normalizeLedgerEntries(
        rows.map((row) => ({
          debit: Number(row.debit),
          credit: Number(row.credit),
          accountId: row.accountId,
          transactionType: set.referenceType,
          transactionId: set.referenceId,
          basis: set.basis as any,
          accountNormal: '',
          currencyCode: '',
          exchangeRate: 1,
          date: set.date,
          index: 0,
        })),
        accountTypes,
      );
      if (unbalanced.length > 0) {
        result.setsSkipped.push({
          ...set,
          why: `off by ${unbalanced[0].leftoverCents / 100} after rounding: needs review`,
        });
        continue;
      }
      for (let i = 0; i < rows.length; i += 1) {
        const before = rows[i];
        const after = entries[i];
        if (
          Number(before.debit) !== after.debit ||
          Number(before.credit) !== after.credit
        ) {
          // A base currency row's foreign amounts are its base amounts (a
          // row in another currency at rate 1 is not base).
          const isBase =
            hasForeign &&
            !!plan.baseCurrency &&
            Number(before.exchangeRate || 1) === 1 &&
            (!before.currencyCode || before.currencyCode === plan.baseCurrency);
          await trx('accounts_transactions')
            .where('id', before.id)
            .update({
              debit: after.debit,
              credit: after.credit,
              ...(isBase
                ? { foreignDebit: after.debit, foreignCredit: after.credit }
                : {}),
            });
        }
      }
      result.setsReposted.push(set);
    }
  });
  return result;
};

/**
 * Recalculates the stored account and contact balances from their ledger
 * rows (in one transaction).
 * @param {Knex} knex - Tenant knex.
 * @param {string} baseCurrency
 * @returns {Promise<IRepairBalance[]>} The balances changed.
 */
export const recalculateStoredBalances = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IRepairBalance[]> => {
  const balances = await getBalancesFromLedger(knex, baseCurrency);

  await knex.transaction(async (trx) => {
    for (const balance of balances) {
      if (balance.kind === 'account') {
        await trx('accounts')
          .where('id', balance.id)
          .update({ amount: balance.fromLedger });
      } else {
        await trx('contacts')
          .where('id', balance.id)
          .update({ balance: balance.fromLedger });
      }
    }
  });
  return balances;
};

/**
 * Formats the plan as printable lines.
 * @param {IMoneyRepairPlan} plan
 * @returns {string[]}
 */
export const formatMoneyRepairPlan = (plan: IMoneyRepairPlan): string[] => {
  const lines: string[] = [];
  const toRepost = plan.sets.filter((s) => !s.locked);
  const locked = plan.sets.filter((s) => s.locked);

  lines.push(`  Ledger sets to re-post: ${toRepost.length}`);
  toRepost.forEach((s) =>
    lines.push(
      `      ${s.referenceType} #${s.referenceId} [${s.basis ?? 'general'}] ${s.date}: ${s.reason}`,
    ),
  );
  lines.push(`  Ledger sets in a locked period (skipped): ${locked.length}`);
  locked.forEach((s) =>
    lines.push(
      `      ${s.referenceType} #${s.referenceId} [${s.basis ?? 'general'}] ${s.date}: ${s.reason}`,
    ),
  );
  lines.push(
    `  Documents whose stored totals change with the new line maths: ${plan.documents.length}`,
  );
  plan.documents.forEach((d) =>
    lines.push(
      `      ${d.documentType} ${d.documentNo || `#${d.documentId}`} ${d.date}: subtotal ${d.storedSubtotal} -> ${d.newSubtotal}` +
        (d.newTax !== null ? `, tax ${d.storedTax} -> ${d.newTax}` : '') +
        (d.locked ? ' [locked period: skipped]' : '') +
        (d.needsReview ? ` [needs review: ${d.needsReview}]` : ''),
    ),
  );
  lines.push(
    `  Stored balances to recalculate from their ledger rows: ${plan.balances.length}`,
  );
  plan.balances.forEach((b) =>
    lines.push(
      `      ${b.kind} #${b.id} ${b.name}: stored ${b.stored} -> ${Math.round(b.fromLedger * 100000) / 100000}`,
    ),
  );
  lines.push(
    '  The cash basis set of every payment and refund is rebuilt in date order (locked periods skipped).',
  );
  return lines;
};
