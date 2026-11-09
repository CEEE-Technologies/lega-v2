import {
  calcLineMoney,
  multiplyMoney,
  roundMoney,
  toCents,
} from '@bigcapital/utils';
import { Knex } from 'knex';
import { ACCOUNT_TYPE } from '@/constants/accounts';
import { SALE_INVOICE_MONEY_SQL } from '@/modules/SaleInvoices/models/SaleInvoice';
import { BILL_MONEY_SQL } from '@/modules/Bills/models/Bill';
import { CREDIT_NOTE_MONEY_SQL } from '@/modules/CreditNotes/models/CreditNote';
import { VENDOR_CREDIT_MONEY_SQL } from '@/modules/VendorCredit/models/VendorCredit';
import { sqlDocumentTotal } from '@/utils/document-money-sql';
import {
  day,
  ids,
  INDENT,
  isSettingOn,
  label,
  money,
  num,
  pick,
  qty,
  QUANTITY_NOISE,
  roundQuantity,
  section,
} from './DataHealthCheck.shared';

/**
 * Round 3 sections of the data health check (`tenants:money-health-check`),
 * H9–H16. The round 3 fixes stop new damage of these kinds; these list the
 * records the old code already left behind, for someone to decide what to
 * correct:
 * - H9 company memberships with no user record in the company (S6),
 * - H10 write-off ledger entries whose invoice no longer exists (B1),
 * - H11 landed costs whose source expense or bill (or its line) is gone or
 *   smaller than what was allocated from it (B2), and landed costs taken
 *   from an inventory bill line (Q9: counted in stock twice),
 * - H12 bank lines categorized or matched to a record that no longer
 *   exists (B3, B4, E1), and, listed only, bank lines that may be counted
 *   twice next to a payment left by an unmatch (B4),
 * - H13 published documents with no ledger entries, or whose entries don't
 *   add up to the document (E1, PR 14),
 * - H14 invoices and bills whose tax rows don't match their taxed lines
 *   (E8),
 * - H15 payments created by bank matching for a foreign currency document
 *   at exchange rate 1 (B5),
 * - H16 duplicate stock rows per item and warehouse (Q3), with what the Q3
 *   migration would merge them into.
 *
 * Plain SELECT queries on the given connections (snake case mappers, like
 * the rest of the check). Nothing is written.
 */

export interface IDataHealthMembershipWithoutUser {
  userId: number;
  email: string | null;
  role: string;
  /** The login itself is deleted (it can't sign in). */
  loginDeleted: boolean;
}

export interface IDataHealthOrphanWriteOff {
  invoiceId: number;
  customerName: string | null;
  date: string | null;
  amount: number;
  rows: number;
}

export interface IDataHealthLandedCostSourceGone {
  landedCostId: number;
  amount: number;
  currencyCode: string | null;
  fromType: string;
  fromId: number;
  /** null: the source document no longer exists. */
  fromNo: string | null;
  /** null: no source line was recorded. */
  fromEntryId: number | null;
  missing: 'document' | 'line';
  billId: number;
  billNo: string;
}

export interface IDataHealthLandedCostOverAllocated {
  fromType: string;
  fromId: number;
  fromNo: string;
  fromEntryId: number;
  /** The line amount landed costs can use (bill lines: after discount, before tax). */
  lineAmount: number;
  allocated: number;
  landedCostIds: number[];
}

export interface IDataHealthLandedCostFromInventory {
  landedCostId: number;
  amount: number;
  fromBillId: number;
  fromBillNo: string;
  fromEntryId: number;
  itemId: number;
  itemName: string;
  billId: number;
  billNo: string;
}

export interface IDataHealthBankLineLink {
  lineId: number;
  date: string | null;
  amount: number;
  accountId: number;
  accountName: string | null;
  link: 'categorized' | 'matched';
  referenceType: string;
  referenceId: number;
  /** The type isn't one the app links bank lines to. */
  unknownType: boolean;
}

export interface IDataHealthPossibleDoubleCount {
  lineId: number;
  date: string | null;
  amount: number;
  accountId: number;
  accountName: string | null;
  lineUse: string;
  paymentType: 'PaymentReceive' | 'BillPayment';
  paymentId: number;
  paymentNo: string;
}

export interface IDataHealthLedgerMismatch {
  documentType: string;
  documentId: number;
  documentNo: string;
  date: string | null;
  currencyCode: string | null;
  /** Document total in its own currency. */
  total: number;
  /** The total in the base currency (total x rate, to the cent). */
  expected: number;
  /** What the entries put on the document's own account; null: no entries. */
  ledger: number | null;
  problem: 'no_entries' | 'different' | 'no_cash_entries';
}

export interface IDataHealthTaxRowDifference {
  documentType: 'SaleInvoice' | 'Bill';
  documentId: number;
  /** null: the document no longer exists. */
  documentNo: string | null;
  draft: boolean;
  taxAmount: number;
  /** Tax rates on the document's lines. */
  lineRateIds: number[];
  /** Tax rates of its tax rows. */
  rowRateIds: number[];
}

export interface IDataHealthMatchedRateOnePayment {
  paymentType: 'PaymentReceive' | 'BillPayment';
  paymentId: number;
  paymentNo: string;
  date: string | null;
  currencyCode: string;
  amount: number;
  exchangeRate: number | null;
  lineIds: number[];
}

export interface IDataHealthDuplicateStockRow {
  itemId: number;
  itemName: string;
  warehouseId: number;
  warehouseName: string;
  quantities: number[];
  /** What the Q3 migration stores: the sum of the rows. */
  merged: number;
  /** Net of the item's stock movements in the warehouse. */
  fromMovements: number;
}

export interface IDataHealthRound3Result {
  /** H9 (null: run without the system database). */
  membershipsWithoutUser: IDataHealthMembershipWithoutUser[] | null;
  /** H10 */
  orphanWriteOffs: IDataHealthOrphanWriteOff[];
  /** H11 */
  landedCostSourcesGone: IDataHealthLandedCostSourceGone[];
  landedCostLinesOverAllocated: IDataHealthLandedCostOverAllocated[];
  landedCostsFromInventoryLines: IDataHealthLandedCostFromInventory[];
  /** H12 */
  bankLinesToMissingRecords: IDataHealthBankLineLink[];
  /** H12, listed only: not counted as a problem. */
  possibleDoubleCounts: IDataHealthPossibleDoubleCount[];
  /** H13 */
  accountingBasis: 'accrual' | 'cash';
  ledgerMismatches: IDataHealthLedgerMismatch[];
  /** H14 (null: sales tax is off, so no tax rows are written). */
  taxRowDifferences: IDataHealthTaxRowDifference[] | null;
  /** H15 (null: the base currency isn't known). */
  matchedRateOnePayments: IDataHealthMatchedRateOnePayment[] | null;
  /** H16 */
  duplicateStockRows: IDataHealthDuplicateStockRow[];
}

/** One cent: old rows were not always rounded to whole cents. */
const CENT_NOISE = 1;

const nameOr = (value: any, id: number) => value || `#${id}`;

const getSetting = async (knex: Knex, group: string, key: string) => {
  const row = await knex
    .queryBuilder()
    .from('settings')
    .where({ group, key })
    .first('value');
  return row ? row.value : undefined;
};

// ---------------------------------------------------------------------------
// H9. Memberships with no user record in the company (S6).
// ---------------------------------------------------------------------------

/**
 * H9. `user_tenants` rows of this company whose login has no user record
 * in it. The old invite flow recorded the invite against the inviter's
 * sign-up company, and accepting it added a membership there, with no user
 * record: the member can sign in and read the company, but isn't on its
 * Users page, so nobody can remove them. Owners listed here are in H7 too.
 */
export const getMembershipsWithoutUser = async (
  knex: Knex,
  systemKnex: Knex,
  tenantId: number,
): Promise<IDataHealthMembershipWithoutUser[]> => {
  const memberships: any[] = await systemKnex
    .queryBuilder()
    .from('user_tenants as ut')
    .leftJoin('users as u', 'u.id', 'ut.user_id')
    .where('ut.tenant_id', tenantId)
    .select(
      'ut.user_id as userId',
      'ut.role as role',
      'u.email as email',
      'u.deleted_at as deletedAt',
    )
    .orderBy('ut.user_id');
  if (memberships.length === 0) return [];

  const users: any[] = await knex
    .queryBuilder()
    .from('users')
    .whereIn(
      'system_user_id',
      memberships.map((row) => row.userId),
    )
    .select('system_user_id as systemUserId');
  const hasUser = new Set(users.map((row) => Number(row.systemUserId)));

  return memberships
    .filter((row) => !hasUser.has(Number(row.userId)))
    .map((row) => ({
      userId: row.userId,
      email: row.email ?? null,
      role: row.role,
      loginDeleted: !!row.deletedAt,
    }));
};

// ---------------------------------------------------------------------------
// H10. Write-offs of invoices that no longer exist (B1).
// ---------------------------------------------------------------------------

/**
 * H10. `InvoiceWriteOff` ledger entries whose invoice is gone: deleting a
 * written-off invoice undid the sale but kept the write-off (Dr bad debt /
 * Cr receivables), so the customer shows a credit and the bad debt stays
 * in profit and loss with no document behind it.
 */
const getOrphanWriteOffs = async (
  knex: Knex,
): Promise<IDataHealthOrphanWriteOff[]> => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('accounts_transactions as t')
    .leftJoin('sales_invoices as i', 'i.id', 't.reference_id')
    .leftJoin('contacts as c', 'c.id', 't.contact_id')
    .where('t.reference_type', 'InvoiceWriteOff')
    .whereNull('i.id')
    .where((builder) =>
      builder.whereNull('t.basis').orWhereNot('t.basis', 'cash'),
    )
    .groupBy('t.reference_id')
    .select('t.reference_id as invoiceId')
    .max('t.date as date')
    .max('c.display_name as customerName')
    .sum('t.debit as debit')
    .count('* as rowCount')
    .orderBy('t.reference_id');

  return rows.map((row) => ({
    invoiceId: row.invoiceId,
    customerName: row.customerName ?? null,
    date: day(row.date),
    amount: roundMoney(num(row.debit)),
    rows: num(row.rowCount),
  }));
};

// ---------------------------------------------------------------------------
// H11. Landed costs whose source is gone or smaller (B2, Q9).
// ---------------------------------------------------------------------------

/**
 * H11. Landed costs read with their source expense or bill and its line:
 * (a) the source document or the line is gone (deleting the expense or
 *     bill, or editing an expense, which re-wrote its lines with new ids,
 *     left the cost in stock with nothing behind it);
 * (b) the landed costs taken from a line add up to more than the line
 *     (a bill line: after its discount, before tax), so stock carries cost
 *     that was never spent;
 * (c) landed costs taken from an inventory bill line (refused since Q9):
 *     that line's cost went into stock with the bill, and again through
 *     the landed cost.
 */
export const getLandedCostSources = async (knex: Knex) => {
  const sourcesGone: IDataHealthLandedCostSourceGone[] = [];
  const overAllocated: IDataHealthLandedCostOverAllocated[] = [];
  const fromInventory: IDataHealthLandedCostFromInventory[] = [];

  const landedCosts: any[] = await knex
    .queryBuilder()
    .from('bill_located_costs as lc')
    .leftJoin('bills as b', 'b.id', 'lc.bill_id')
    .select(
      'lc.id as id',
      'lc.amount as amount',
      'lc.currency_code as currencyCode',
      'lc.from_transaction_type as fromType',
      'lc.from_transaction_id as fromId',
      'lc.from_transaction_entry_id as fromEntryId',
      'lc.bill_id as billId',
      'b.bill_number as billNo',
    )
    .orderBy('lc.id');
  if (landedCosts.length === 0) {
    return { sourcesGone, overAllocated, fromInventory };
  }
  const idsOf = (type: string, key: 'fromId' | 'fromEntryId') => [
    ...new Set(
      landedCosts
        .filter((lc) => lc.fromType === type)
        .map((lc) => Number(lc[key])),
    ),
  ];

  // Source documents.
  const expenses: any[] = await knex
    .queryBuilder()
    .from('expenses_transactions')
    .whereIn('id', idsOf('Expense', 'fromId'))
    .select('id', 'reference_no as documentNo');
  const bills: any[] = await knex
    .queryBuilder()
    .from('bills')
    .whereIn('id', idsOf('Bill', 'fromId'))
    .select('id', 'bill_number as documentNo');
  const documents = new Map<string, any>([
    ...expenses.map((row) => [`Expense-${row.id}`, row] as [string, any]),
    ...bills.map((row) => [`Bill-${row.id}`, row] as [string, any]),
  ]);

  // Source lines, with the amount landed costs can use.
  const expenseLines: any[] = await knex
    .queryBuilder()
    .from('expense_transaction_categories')
    .whereIn('id', idsOf('Expense', 'fromEntryId'))
    .select('id', 'expense_id as documentId', 'amount');
  const billLines: any[] = await knex
    .queryBuilder()
    .from('items_entries as e')
    .leftJoin('items as i', 'i.id', 'e.item_id')
    .where('e.reference_type', 'Bill')
    .whereIn('e.id', idsOf('Bill', 'fromEntryId'))
    .select(
      'e.id as id',
      'e.reference_id as documentId',
      'e.item_id as itemId',
      'i.name as itemName',
      'i.type as itemType',
      'e.quantity as quantity',
      'e.rate as rate',
      'e.discount as discount',
      'e.discount_type as discountType',
      'e.tax_rate as taxRate',
      'e.is_inclusive_tax as isInclusiveTax',
    );
  const lines = new Map<string, any>();
  expenseLines.forEach((row) =>
    lines.set(`Expense-${row.id}`, {
      ...row,
      usable: roundMoney(num(row.amount)),
    }),
  );
  billLines.forEach((row) =>
    lines.set(`Bill-${row.id}`, {
      ...row,
      usable: calcLineMoney({
        quantity: num(row.quantity),
        rate: num(row.rate),
        discount: num(row.discount),
        discountType: row.discountType || 'percentage',
        taxRate: num(row.taxRate),
        isInclusiveTax: !!Number(row.isInclusiveTax),
      }).totalExcludingTax,
    }),
  );

  const allocatedByLine = new Map<
    string,
    { landedCost: any; line: any; amount: number; ids: number[] }
  >();

  landedCosts.forEach((lc) => {
    const document = documents.get(`${lc.fromType}-${lc.fromId}`);
    const line = lines.get(`${lc.fromType}-${lc.fromEntryId}`);
    const lineOfDocument =
      !!line && Number(line.documentId) === Number(lc.fromId);
    const base = {
      landedCostId: lc.id,
      amount: roundMoney(num(lc.amount)),
      billId: lc.billId,
      billNo: nameOr(lc.billNo, lc.billId),
    };
    if (!document || !lineOfDocument) {
      sourcesGone.push({
        ...base,
        currencyCode: lc.currencyCode ?? null,
        fromType: lc.fromType,
        fromId: lc.fromId,
        fromNo: document ? nameOr(document.documentNo, lc.fromId) : null,
        fromEntryId: lc.fromEntryId,
        missing: document ? 'line' : 'document',
      });
      return;
    }
    const key = `${lc.fromType}-${lc.fromEntryId}`;
    const entry = allocatedByLine.get(key) || {
      landedCost: lc,
      line,
      amount: 0,
      ids: [],
    };
    entry.amount = roundMoney(entry.amount + num(lc.amount));
    entry.ids.push(lc.id);
    allocatedByLine.set(key, entry);

    if (lc.fromType === 'Bill' && line.itemType === 'inventory') {
      fromInventory.push({
        ...base,
        fromBillId: lc.fromId,
        fromBillNo: nameOr(document.documentNo, lc.fromId),
        fromEntryId: lc.fromEntryId,
        itemId: line.itemId,
        itemName: nameOr(line.itemName, line.itemId),
      });
    }
  });

  allocatedByLine.forEach(({ landedCost, line, amount, ids: lcIds }) => {
    if (toCents(amount) - toCents(line.usable) <= CENT_NOISE) return;
    const document = documents.get(
      `${landedCost.fromType}-${landedCost.fromId}`,
    );
    overAllocated.push({
      fromType: landedCost.fromType,
      fromId: landedCost.fromId,
      fromNo: nameOr(document?.documentNo, landedCost.fromId),
      fromEntryId: landedCost.fromEntryId,
      lineAmount: roundMoney(line.usable),
      allocated: amount,
      landedCostIds: lcIds,
    });
  });
  overAllocated.sort((a, b) => a.landedCostIds[0] - b.landedCostIds[0]);
  return { sourcesGone, overAllocated, fromInventory };
};

// ---------------------------------------------------------------------------
// H12. Bank lines linked to records that no longer exist (B3, B4, E1).
// ---------------------------------------------------------------------------

/** The records a bank line is categorized or matched to, by link type. */
const BANK_LINK_TABLES: Record<string, string> = {
  CashflowTransaction: 'cashflow_transactions',
  Expense: 'expenses_transactions',
  ManualJournal: 'manual_journals',
  SaleInvoice: 'sales_invoices',
  Bill: 'bills',
  PaymentReceive: 'payment_receives',
  BillPayment: 'bills_payments',
};

/**
 * H12 (a). Bank lines categorized (`categorize_ref_type/_id`) or matched
 * (`matched_bank_transactions`) to a record that is gone. Deleting the
 * deposit or expense made from a line, or a matched record, wasn't stopped
 * (B3, E1): the line still shows as categorized or matched, its money is
 * gone from the bank, and it can't be uncategorized or unmatched.
 */
const getBankLinesToMissingRecords = async (
  knex: Knex,
): Promise<IDataHealthBankLineLink[]> => {
  const categorized: any[] = await knex
    .queryBuilder()
    .from('uncategorized_cashflow_transactions as l')
    .leftJoin('accounts as a', 'a.id', 'l.account_id')
    .whereNotNull('l.categorize_ref_type')
    .select(
      'l.id as lineId',
      'l.date as date',
      'l.amount as amount',
      'l.account_id as accountId',
      'a.name as accountName',
      'l.categorize_ref_type as referenceType',
      'l.categorize_ref_id as referenceId',
    );
  const matched: any[] = await knex
    .queryBuilder()
    .from('matched_bank_transactions as m')
    .join(
      'uncategorized_cashflow_transactions as l',
      'l.id',
      'm.uncategorized_transaction_id',
    )
    .leftJoin('accounts as a', 'a.id', 'l.account_id')
    .select(
      'l.id as lineId',
      'l.date as date',
      'l.amount as amount',
      'l.account_id as accountId',
      'a.name as accountName',
      'm.reference_type as referenceType',
      'm.reference_id as referenceId',
    );
  const links = [
    ...categorized.map((row) => ({ ...row, link: 'categorized' as const })),
    ...matched.map((row) => ({ ...row, link: 'matched' as const })),
  ];

  // Which of the linked records exist, per type.
  const existing = new Set<string>();
  for (const [type, table] of Object.entries(BANK_LINK_TABLES)) {
    const wanted = [
      ...new Set(
        links
          .filter((row) => row.referenceType === type)
          .map((row) => Number(row.referenceId)),
      ),
    ];
    if (wanted.length === 0) continue;
    const found: any[] = await knex
      .queryBuilder()
      .from(table)
      .whereIn('id', wanted)
      .select('id');
    found.forEach((row) => existing.add(`${type}-${row.id}`));
  }

  return links
    .filter((row) => !existing.has(`${row.referenceType}-${row.referenceId}`))
    .map((row) => ({
      lineId: row.lineId,
      date: day(row.date),
      amount: roundMoney(num(row.amount)),
      accountId: row.accountId,
      accountName: row.accountName ?? null,
      link: row.link,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      unknownType: !BANK_LINK_TABLES[row.referenceType],
    }))
    .sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) || a.lineId - b.lineId,
    );
};

/**
 * H12 (b), listed only. Bank lines in use (categorized or matched) with a
 * payment on the same account, day and amount that no bank line is matched
 * to. Unmatching a line used to leave the payment the match created (B4);
 * once the line is used again, the money is in the bank twice. Such a
 * payment looks like any other, so this can't tell a leftover from a
 * second real payment of the same amount: check each one.
 */
const getPossibleDoubleCounts = async (
  knex: Knex,
): Promise<IDataHealthPossibleDoubleCount[]> => {
  const result: IDataHealthPossibleDoubleCount[] = [];
  const kinds = [
    {
      paymentType: 'PaymentReceive' as const,
      table: 'payment_receives',
      numberColumn: 'payment_receive_no',
      accountColumn: 'deposit_account_id',
      sign: 1,
    },
    {
      paymentType: 'BillPayment' as const,
      table: 'bills_payments',
      numberColumn: 'payment_number',
      accountColumn: 'payment_account_id',
      sign: -1,
    },
  ];
  for (const kind of kinds) {
    const rows: any[] = await knex
      .queryBuilder()
      .from('uncategorized_cashflow_transactions as l')
      .join(`${kind.table} as p`, (join) =>
        join
          .on(`p.${kind.accountColumn}`, '=', 'l.account_id')
          .andOn('p.payment_date', '=', 'l.date'),
      )
      .leftJoin('accounts as a', 'a.id', 'l.account_id')
      .whereRaw('ROUND(??, 2) = ROUND(?? * ?, 2)', [
        'p.amount',
        'l.amount',
        kind.sign,
      ])
      .where((builder) =>
        builder
          .whereNotNull('l.categorize_ref_type')
          .orWhereExists((sub) =>
            sub
              .select(knex.raw('1'))
              .from('matched_bank_transactions as m')
              .whereRaw('?? = ??', ['m.uncategorized_transaction_id', 'l.id']),
          ),
      )
      .whereNotExists((sub) =>
        sub
          .select(knex.raw('1'))
          .from('matched_bank_transactions as pm')
          .where('pm.reference_type', kind.paymentType)
          .whereRaw('?? = ??', ['pm.reference_id', 'p.id']),
      )
      .select(
        'l.id as lineId',
        'l.date as date',
        'l.amount as amount',
        'l.account_id as accountId',
        'a.name as accountName',
        'l.categorize_ref_type as categorizeRefType',
        'l.categorize_ref_id as categorizeRefId',
        'p.id as paymentId',
        `p.${kind.numberColumn} as paymentNo`,
      )
      .orderBy(['l.date', 'l.id']);
    rows.forEach((row) =>
      result.push({
        lineId: row.lineId,
        date: day(row.date),
        amount: roundMoney(num(row.amount)),
        accountId: row.accountId,
        accountName: row.accountName ?? null,
        lineUse: row.categorizeRefType
          ? `categorized to ${label(row.categorizeRefType)} #${row.categorizeRefId}`
          : 'matched',
        paymentType: kind.paymentType,
        paymentId: row.paymentId,
        paymentNo: nameOr(row.paymentNo, row.paymentId),
      }),
    );
  }
  return result;
};

// ---------------------------------------------------------------------------
// H13. Published documents whose ledger entries are missing or off (E1).
// ---------------------------------------------------------------------------

interface ILedgerDocumentKind {
  /** The ledger reference type. */
  referenceType: string;
  table: string;
  numberColumn: string;
  dateColumn: string;
  /** Set once the document is published; none: never a draft. */
  publishedColumn?: string;
  totalSql: string;
  /** The document's own account: by account type, or a column on it. */
  accountTypes?: string[];
  accountColumn?: string;
  /** +1: the account is debited by the total; -1: credited; 0: either way. */
  sign: 1 | -1 | 0;
  /** Writes a cash basis set next to the accrual set. */
  cashSet?: boolean;
  /** Whole set: the journal's debits. */
  allDebits?: boolean;
  /**
   * The document's own basis (a journal can be cash only, accrual only, or
   * both when null): its entries are compared on that basis.
   */
  basisColumn?: string;
}

const LEDGER_DOCUMENTS: ILedgerDocumentKind[] = [
  {
    referenceType: 'SaleInvoice',
    table: 'sales_invoices',
    numberColumn: 'invoice_no',
    dateColumn: 'invoice_date',
    publishedColumn: 'delivered_at',
    totalSql: SALE_INVOICE_MONEY_SQL.total,
    accountTypes: [ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE],
    sign: 1,
  },
  {
    referenceType: 'CreditNote',
    table: 'credit_notes',
    numberColumn: 'credit_note_number',
    dateColumn: 'credit_note_date',
    publishedColumn: 'opened_at',
    totalSql: CREDIT_NOTE_MONEY_SQL.total,
    accountTypes: [ACCOUNT_TYPE.ACCOUNTS_RECEIVABLE],
    sign: -1,
  },
  {
    referenceType: 'SaleReceipt',
    table: 'sales_receipts',
    numberColumn: 'receipt_number',
    dateColumn: 'receipt_date',
    publishedColumn: 'closed_at',
    totalSql: sqlDocumentTotal('AMOUNT', false),
    accountColumn: 'deposit_account_id',
    sign: 1,
  },
  {
    referenceType: 'PaymentReceive',
    table: 'payment_receives',
    numberColumn: 'payment_receive_no',
    dateColumn: 'payment_date',
    totalSql: 'AMOUNT',
    accountColumn: 'deposit_account_id',
    sign: 1,
    cashSet: true,
  },
  {
    referenceType: 'RefundCreditNote',
    table: 'refund_credit_note_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'date',
    totalSql: 'AMOUNT',
    accountColumn: 'from_account_id',
    sign: -1,
    cashSet: true,
  },
  {
    referenceType: 'Bill',
    table: 'bills',
    numberColumn: 'bill_number',
    dateColumn: 'bill_date',
    publishedColumn: 'opened_at',
    totalSql: BILL_MONEY_SQL.total,
    accountTypes: [ACCOUNT_TYPE.ACCOUNTS_PAYABLE],
    sign: -1,
  },
  {
    referenceType: 'VendorCredit',
    table: 'vendor_credits',
    numberColumn: 'vendor_credit_number',
    dateColumn: 'vendor_credit_date',
    publishedColumn: 'opened_at',
    totalSql: VENDOR_CREDIT_MONEY_SQL.total,
    accountTypes: [ACCOUNT_TYPE.ACCOUNTS_PAYABLE],
    sign: 1,
  },
  {
    referenceType: 'BillPayment',
    table: 'bills_payments',
    numberColumn: 'payment_number',
    dateColumn: 'payment_date',
    totalSql: 'AMOUNT',
    accountColumn: 'payment_account_id',
    sign: -1,
    cashSet: true,
  },
  {
    referenceType: 'RefundVendorCredit',
    table: 'refund_vendor_credit_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'date',
    totalSql: 'AMOUNT',
    accountColumn: 'deposit_account_id',
    sign: 1,
    cashSet: true,
  },
  {
    referenceType: 'Expense',
    table: 'expenses_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'payment_date',
    publishedColumn: 'published_at',
    totalSql: 'TOTAL_AMOUNT',
    accountColumn: 'payment_account_id',
    sign: -1,
  },
  {
    referenceType: 'Journal',
    table: 'manual_journals',
    numberColumn: 'journal_number',
    dateColumn: 'date',
    publishedColumn: 'published_at',
    totalSql: 'AMOUNT',
    sign: 1,
    allDebits: true,
    basisColumn: 'basis',
  },
  {
    referenceType: 'CashflowTransaction',
    table: 'cashflow_transactions',
    numberColumn: 'transaction_number',
    dateColumn: 'date',
    publishedColumn: 'published_at',
    totalSql: 'AMOUNT',
    accountColumn: 'cashflow_account_id',
    sign: 0,
  },
];

/**
 * H13. Published documents compared with their ledger entries: none at all
 * (a failed ledger write was hidden, E1), or what the entries put on the
 * document's own account (A/R, A/P, the bank, or a journal's debits)
 * isn't the document total x its rate, to the cent. Drafts are left out.
 *
 * The accrual entries are compared (untagged or `accrual`): every document
 * has them, and the cash basis is built from them. Payments and refunds
 * also write a cash basis copy, which is left out of the sum; the money
 * check (f) compares it. On a company that reports on the cash basis
 * (`organization.accounting_basis`), a payment or refund with no cash
 * basis entries at all is listed too: its cash reports miss it.
 */
const getLedgerMismatches = async (
  knex: Knex,
  accountingBasis: 'accrual' | 'cash',
): Promise<IDataHealthLedgerMismatch[]> => {
  const result: IDataHealthLedgerMismatch[] = [];
  const accounts: any[] = await knex
    .queryBuilder()
    .from('accounts')
    .select('id', 'account_type as accountType');
  const accountTypeById = new Map(
    accounts.map((row) => [Number(row.id), row.accountType]),
  );

  for (const kind of LEDGER_DOCUMENTS) {
    const query = knex
      .queryBuilder()
      .from(kind.table)
      .select(
        'id',
        `${kind.numberColumn} as documentNo`,
        `${kind.dateColumn} as date`,
        'currency_code as currencyCode',
        'exchange_rate as exchangeRate',
      )
      .select(knex.raw(`${kind.totalSql} as health_total`))
      .orderBy('id');
    if (kind.accountColumn) {
      query.select(`${kind.accountColumn} as documentAccountId`);
    }
    if (kind.basisColumn) {
      query.select(`${kind.basisColumn} as documentBasis`);
    }
    if (kind.publishedColumn) query.whereNotNull(kind.publishedColumn);
    const documents: any[] = await query;
    if (documents.length === 0) continue;

    const ledgerRows: any[] = await knex
      .queryBuilder()
      .from('accounts_transactions')
      .where('reference_type', kind.referenceType)
      .groupBy('reference_id', 'account_id', 'basis')
      .select('reference_id as documentId', 'account_id as accountId', 'basis')
      .count('* as rowCount')
      .sum('debit as debit')
      .sum('credit as credit');

    const byDocument = new Map<number, any[]>();
    ledgerRows.forEach((row) => {
      const list = byDocument.get(Number(row.documentId)) || [];
      list.push(row);
      byDocument.set(Number(row.documentId), list);
    });

    documents.forEach((document) => {
      const total = roundMoney(num(pick(document, 'health_total')));
      const expected = multiplyMoney(total, num(document.exchangeRate || 1));
      const rows = byDocument.get(Number(document.id)) || [];
      // A cash-only journal has only cash basis entries: compare those.
      const cashOnly = !!kind.basisColumn && document.documentBasis === 'cash';
      const accrual = rows.filter((row) =>
        cashOnly ? row.basis === 'cash' : row.basis !== 'cash',
      );
      const base = {
        documentType: kind.referenceType,
        documentId: document.id,
        documentNo: nameOr(document.documentNo, document.id),
        date: day(document.date),
        currencyCode: document.currencyCode ?? null,
        total,
        expected,
      };
      if (accrual.length === 0) {
        // A document of 0 has nothing to post.
        if (toCents(expected) !== 0) {
          result.push({ ...base, ledger: null, problem: 'no_entries' });
        }
        return;
      }
      const onOwnAccount = (row: any) =>
        kind.allDebits
          ? true
          : kind.accountColumn
            ? Number(row.accountId) === Number(document.documentAccountId)
            : (kind.accountTypes || []).includes(
                accountTypeById.get(Number(row.accountId)),
              );
      const net = accrual
        .filter(onOwnAccount)
        .reduce(
          (sum, row) =>
            sum +
            (kind.allDebits
              ? num(row.debit)
              : num(row.debit) - num(row.credit)),
          0,
        );
      const ledger = roundMoney(
        kind.sign === 0 ? Math.abs(net) : net * kind.sign,
      );
      if (Math.abs(toCents(ledger) - toCents(expected)) > CENT_NOISE) {
        result.push({ ...base, ledger, problem: 'different' });
        return;
      }
      if (
        accountingBasis === 'cash' &&
        kind.cashSet &&
        toCents(expected) !== 0 &&
        !rows.some((row) => row.basis === 'cash')
      ) {
        result.push({ ...base, ledger, problem: 'no_cash_entries' });
      }
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// H14. Tax rows that don't match the taxed lines (E8).
// ---------------------------------------------------------------------------

const TAX_DOCUMENTS = [
  {
    documentType: 'SaleInvoice' as const,
    table: 'sales_invoices',
    numberColumn: 'invoice_no',
    publishedColumn: 'delivered_at',
  },
  {
    documentType: 'Bill' as const,
    table: 'bills',
    numberColumn: 'bill_number',
    publishedColumn: 'opened_at',
  },
];

/**
 * H14. Invoices (and bills) whose tax rows (`tax_rate_transactions`, one
 * per tax rate, what tax reports and the document view read) don't match
 * the tax rates on their lines. Deleting an invoice removed its tax rows
 * outside the save, so a cancelled bulk delete or a refused delete lost
 * them while the totals and ledger kept the tax (E8). Tax rows of a
 * document that is gone are listed too. Not checked when sales tax is off:
 * no tax rows are written then.
 */
const getTaxRowDifferences = async (
  knex: Knex,
): Promise<IDataHealthTaxRowDifference[] | null> => {
  const salesTax = await getSetting(knex, 'features', 'sales_tax');
  if (salesTax !== undefined && !isSettingOn(salesTax)) return null;

  const result: IDataHealthTaxRowDifference[] = [];
  for (const kind of TAX_DOCUMENTS) {
    const lineRates: any[] = await knex
      .queryBuilder()
      .from('items_entries')
      .where('reference_type', kind.documentType)
      .whereNotNull('tax_rate_id')
      .distinct('reference_id as documentId', 'tax_rate_id as taxRateId');
    const rowRates: any[] = await knex
      .queryBuilder()
      .from('tax_rate_transactions')
      .where('reference_type', kind.documentType)
      .distinct('reference_id as documentId', 'tax_rate_id as taxRateId');

    const collect = (rows: any[]) => {
      const map = new Map<number, Set<number>>();
      rows.forEach((row) => {
        const set = map.get(Number(row.documentId)) || new Set<number>();
        if (row.taxRateId !== null) set.add(Number(row.taxRateId));
        map.set(Number(row.documentId), set);
      });
      return map;
    };
    const byLines = collect(lineRates);
    const byRows = collect(rowRates);
    const documentIds = [...new Set([...byLines.keys(), ...byRows.keys()])]
      .filter((id) => {
        const a = [...(byLines.get(id) || [])].sort();
        const b = [...(byRows.get(id) || [])].sort();
        return a.join(',') !== b.join(',');
      })
      .sort((a, b) => a - b);
    if (documentIds.length === 0) continue;

    const documents: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .whereIn('id', documentIds)
      .select(
        'id',
        `${kind.numberColumn} as documentNo`,
        `${kind.publishedColumn} as publishedAt`,
        'tax_amount_withheld as taxAmount',
      );
    const documentsById = new Map(documents.map((row) => [row.id, row]));

    documentIds.forEach((id) => {
      const document = documentsById.get(id);
      result.push({
        documentType: kind.documentType,
        documentId: id,
        documentNo: document ? nameOr(document.documentNo, id) : null,
        draft: !!document && !document.publishedAt,
        taxAmount: roundMoney(num(document?.taxAmount)),
        lineRateIds: [...(byLines.get(id) || [])].sort((a, b) => a - b),
        rowRateIds: [...(byRows.get(id) || [])].sort((a, b) => a - b),
      });
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// H15. Payments made by bank matching at rate 1 (B5).
// ---------------------------------------------------------------------------

/**
 * H15. Payments a bank match created (`matched_bank_transactions` of type
 * `PaymentReceive` / `BillPayment`) in another currency than the base one
 * at rate 1 (or empty). The match passed no rate, so the bank got the
 * foreign amount unconverted and a false exchange gain or loss was posted.
 * These are in H1 too; this tells which came from matching.
 */
const getMatchedRateOnePayments = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IDataHealthMatchedRateOnePayment[] | null> => {
  if (!baseCurrency) return null;
  const result: IDataHealthMatchedRateOnePayment[] = [];
  const kinds = [
    {
      paymentType: 'PaymentReceive' as const,
      table: 'payment_receives',
      numberColumn: 'payment_receive_no',
    },
    {
      paymentType: 'BillPayment' as const,
      table: 'bills_payments',
      numberColumn: 'payment_number',
    },
  ];
  for (const kind of kinds) {
    const rows: any[] = await knex
      .queryBuilder()
      .from('matched_bank_transactions as m')
      .join(`${kind.table} as p`, 'p.id', 'm.reference_id')
      .where('m.reference_type', kind.paymentType)
      .whereNotNull('p.currency_code')
      .whereNot('p.currency_code', '')
      .whereNot('p.currency_code', baseCurrency)
      .where((builder) =>
        builder.where('p.exchange_rate', 1).orWhereNull('p.exchange_rate'),
      )
      .groupBy('p.id')
      .select('p.id as paymentId')
      .max(`p.${kind.numberColumn} as paymentNo`)
      .max('p.payment_date as date')
      .max('p.currency_code as currencyCode')
      .max('p.amount as amount')
      .max('p.exchange_rate as exchangeRate')
      .select(
        knex.raw('GROUP_CONCAT(?? ORDER BY ?? SEPARATOR ?) as ??', [
          'm.uncategorized_transaction_id',
          'm.uncategorized_transaction_id',
          ',',
          'line_ids',
        ]),
      )
      .orderBy('p.id');
    rows.forEach((row) =>
      result.push({
        paymentType: kind.paymentType,
        paymentId: row.paymentId,
        paymentNo: nameOr(row.paymentNo, row.paymentId),
        date: day(row.date),
        currencyCode: row.currencyCode,
        amount: roundMoney(num(row.amount)),
        exchangeRate: row.exchangeRate === null ? null : num(row.exchangeRate),
        lineIds: String(pick(row, 'line_ids') ?? '')
          .split(',')
          .filter(Boolean)
          .map(Number),
      }),
    );
  }
  return result;
};

// ---------------------------------------------------------------------------
// H16. Duplicate stock rows per item and warehouse (Q3).
// ---------------------------------------------------------------------------

/**
 * H16. Items with more than one `items_warehouses_quantity` row for the
 * same warehouse. Two first stock movements at the same moment both
 * inserted a row, and every later change updated both. The Q3 migration
 * merges them into one row of their sum; when both rows took every later
 * change, that sum is more than the real stock, so the stock movements'
 * total is shown next to it. After the migration, H3 shows whether a
 * merged row is off.
 */
const getDuplicateStockRows = async (
  knex: Knex,
): Promise<IDataHealthDuplicateStockRow[]> => {
  const groups: any[] = await knex
    .queryBuilder()
    .from('items_warehouses_quantity')
    .whereNotNull('item_id')
    .whereNotNull('warehouse_id')
    .groupBy('item_id', 'warehouse_id')
    .havingRaw('COUNT(*) > 1')
    .select('item_id as itemId', 'warehouse_id as warehouseId')
    .sum('quantity_on_hand as merged')
    .select(
      knex.raw('GROUP_CONCAT(?? ORDER BY ?? SEPARATOR ?) as ??', [
        'quantity_on_hand',
        'quantity_on_hand',
        ',',
        'quantities',
      ]),
    )
    .orderBy(['item_id', 'warehouse_id']);
  if (groups.length === 0) return [];

  const itemIds = [...new Set(groups.map((row) => row.itemId))];
  const warehouseIds = [...new Set(groups.map((row) => row.warehouseId))];
  const items: any[] = await knex
    .queryBuilder()
    .from('items')
    .whereIn('id', itemIds)
    .select('id', 'name');
  const warehouses: any[] = await knex
    .queryBuilder()
    .from('warehouses')
    .whereIn('id', warehouseIds)
    .select('id', 'name');
  const movements: any[] = await knex
    .queryBuilder()
    .from('inventory_transactions')
    .whereIn('item_id', itemIds)
    .whereIn('warehouse_id', warehouseIds)
    .groupBy('item_id', 'warehouse_id')
    .select('item_id as itemId', 'warehouse_id as warehouseId')
    .select(
      knex.raw('SUM(CASE WHEN ?? = ? THEN ?? ELSE -?? END) as ??', [
        'direction',
        'IN',
        'quantity',
        'quantity',
        'net',
      ]),
    );
  const itemNames = new Map(items.map((row) => [row.id, row.name]));
  const warehouseNames = new Map(warehouses.map((row) => [row.id, row.name]));
  const moved = new Map(
    movements.map((row) => [`${row.itemId}-${row.warehouseId}`, num(row.net)]),
  );

  return groups.map((row) => ({
    itemId: row.itemId,
    itemName: nameOr(itemNames.get(row.itemId), row.itemId),
    warehouseId: row.warehouseId,
    warehouseName: nameOr(warehouseNames.get(row.warehouseId), row.warehouseId),
    quantities: String(pick(row, 'quantities') ?? '')
      .split(',')
      .filter((value) => value !== '')
      .map((value) => roundQuantity(Number(value))),
    merged: roundQuantity(num(row.merged)),
    fromMovements: roundQuantity(
      moved.get(`${row.itemId}-${row.warehouseId}`) || 0,
    ),
  }));
};

// ---------------------------------------------------------------------------
// Run, verdict, output.
// ---------------------------------------------------------------------------

/**
 * Runs the round 3 sections (H9–H16) on the given tenant database.
 * @param {Knex} knex - Tenant database connection.
 * @param {string} baseCurrency - The tenant base currency.
 * @param {object} system - The system database and the tenant id, for H9.
 * @returns {Promise<IDataHealthRound3Result>}
 */
export const checkRound3DataHealth = async (
  knex: Knex,
  baseCurrency: string,
  system?: { systemKnex: Knex; tenantId: number },
): Promise<IDataHealthRound3Result> => {
  const membershipsWithoutUser = system
    ? await getMembershipsWithoutUser(knex, system.systemKnex, system.tenantId)
    : null;
  const orphanWriteOffs = await getOrphanWriteOffs(knex);
  const landedCosts = await getLandedCostSources(knex);
  const bankLinesToMissingRecords = await getBankLinesToMissingRecords(knex);
  const possibleDoubleCounts = await getPossibleDoubleCounts(knex);
  const accountingBasis =
    (await getSetting(knex, 'organization', 'accounting_basis')) === 'cash'
      ? 'cash'
      : 'accrual';
  const ledgerMismatches = await getLedgerMismatches(knex, accountingBasis);
  const taxRowDifferences = await getTaxRowDifferences(knex);
  const matchedRateOnePayments = await getMatchedRateOnePayments(
    knex,
    baseCurrency,
  );
  const duplicateStockRows = await getDuplicateStockRows(knex);

  return {
    membershipsWithoutUser,
    orphanWriteOffs,
    landedCostSourcesGone: landedCosts.sourcesGone,
    landedCostLinesOverAllocated: landedCosts.overAllocated,
    landedCostsFromInventoryLines: landedCosts.fromInventory,
    bankLinesToMissingRecords,
    possibleDoubleCounts,
    accountingBasis,
    ledgerMismatches,
    taxRowDifferences,
    matchedRateOnePayments,
    duplicateStockRows,
  };
};

/**
 * Whether the round 3 sections are clean. The H12 list of bank lines that
 * may be counted twice is a list to look at, not a problem.
 * @param {IDataHealthRound3Result} result
 * @returns {boolean}
 */
export const isRound3DataHealthClean = (result: IDataHealthRound3Result) =>
  (result.membershipsWithoutUser ?? []).length === 0 &&
  result.orphanWriteOffs.length === 0 &&
  result.landedCostSourcesGone.length === 0 &&
  result.landedCostLinesOverAllocated.length === 0 &&
  result.landedCostsFromInventoryLines.length === 0 &&
  result.bankLinesToMissingRecords.length === 0 &&
  result.ledgerMismatches.length === 0 &&
  (result.taxRowDifferences ?? []).length === 0 &&
  (result.matchedRateOnePayments ?? []).length === 0 &&
  result.duplicateStockRows.length === 0;

const rateIds = (list: number[]) =>
  list.length === 0 ? 'none' : list.map((id) => `#${id}`).join(', ');

const bankLine = (row: {
  lineId: number;
  date: string | null;
  amount: number;
  accountId: number;
  accountName: string | null;
}) =>
  `Bank line #${row.lineId}, ${row.date ?? 'no date'}, ${money(row.amount)} in ${row.accountName ?? 'account'} (#${row.accountId})`;

/**
 * Formats the round 3 sections as printable lines (H9–H16).
 * @param {IDataHealthRound3Result} result
 * @param {string} baseCurrency
 * @returns {string[]}
 */
export const formatRound3DataHealth = (
  result: IDataHealthRound3Result,
  baseCurrency: string,
): string[] => {
  const lines: string[] = [];

  if (result.membershipsWithoutUser === null) {
    lines.push(
      '  H9 Members with no user record in the company: not checked (no system database)',
    );
  } else {
    section(
      lines,
      'H9 Members with no user record in the company (not on the Users page, so they cannot be removed there)',
      result.membershipsWithoutUser.map(
        (row) =>
          `${row.email ?? 'no email'} (login #${row.userId}) is a member (${row.role}) but not a user here` +
          (row.loginDeleted ? ' [login deleted]' : ''),
      ),
    );
  }

  section(
    lines,
    'H10 Write-off entries whose invoice no longer exists',
    result.orphanWriteOffs.map(
      (row) =>
        `Write-off of ${money(row.amount)} for deleted invoice #${row.invoiceId}` +
        (row.customerName ? ` (customer ${row.customerName})` : '') +
        `, ${row.date ?? 'no date'}: ${row.rows} ledger rows`,
    ),
  );

  section(
    lines,
    'H11 Landed costs whose source expense or bill (or its line) no longer exists',
    result.landedCostSourcesGone.map(
      (row) =>
        `Landed cost #${row.landedCostId}: ${row.currencyCode ? `${row.currencyCode} ` : ''}${money(row.amount)} onto bill ${row.billNo} (#${row.billId}) from ` +
        (row.missing === 'document'
          ? `${label(row.fromType).toLowerCase()} #${row.fromId}, which no longer exists`
          : row.fromEntryId === null
            ? `${label(row.fromType).toLowerCase()} ${row.fromNo} (#${row.fromId}), with no source line recorded`
            : `${label(row.fromType).toLowerCase()} ${row.fromNo} (#${row.fromId}) line #${row.fromEntryId}, which no longer exists (the ${label(row.fromType).toLowerCase()} is still there)`),
    ),
  );
  section(
    lines,
    'H11 Source lines with more landed cost allocated than the line',
    result.landedCostLinesOverAllocated.map(
      (row) =>
        `${label(row.fromType)} ${row.fromNo} (#${row.fromId}) line #${row.fromEntryId}: line ${money(row.lineAmount)}${row.fromType === 'Bill' ? ' (after discount, before tax)' : ''}, ${money(row.allocated)} allocated by landed cost ${ids(row.landedCostIds)}`,
    ),
  );
  section(
    lines,
    'H11 Landed costs taken from an inventory bill line (that cost went into stock twice)',
    result.landedCostsFromInventoryLines.map(
      (row) =>
        `Landed cost #${row.landedCostId}: ${money(row.amount)} from bill ${row.fromBillNo} (#${row.fromBillId}) line #${row.fromEntryId}, inventory item ${row.itemName} (#${row.itemId}), onto bill ${row.billNo} (#${row.billId})`,
    ),
  );

  section(
    lines,
    'H12 Bank lines categorized or matched to a record that no longer exists',
    result.bankLinesToMissingRecords.map(
      (row) =>
        `${bankLine(row)}: ${row.link} to ${label(row.referenceType).toLowerCase()} #${row.referenceId}, ` +
        (row.unknownType
          ? `an unknown type (${row.referenceType})`
          : 'which no longer exists'),
    ),
  );
  lines.push(
    `  H12 Bank lines that may be counted twice (listed only, not counted as problems): ${result.possibleDoubleCounts.length}`,
  );
  lines.push(
    `${INDENT}A bank line in use, and a payment on the same account, day and amount that no bank line is matched to. Unmatching used to leave the payment the match created (B4); a leftover payment looks like any other, so check each one.`,
  );
  if (result.possibleDoubleCounts.length === 0) lines.push(`${INDENT}none`);
  result.possibleDoubleCounts.forEach((row) =>
    lines.push(
      `${INDENT}${bankLine(row)} (${row.lineUse}) and ${label(row.paymentType).toLowerCase()} ${row.paymentNo} (#${row.paymentId})`,
    ),
  );

  section(
    lines,
    `H13 Published documents with no ledger entries, or entries that don't add up to the document (accrual entries; company reports on the ${result.accountingBasis} basis)`,
    result.ledgerMismatches.map((row) => {
      const foreign =
        row.currencyCode && baseCurrency && row.currencyCode !== baseCurrency
          ? `${row.currencyCode} ${money(row.total)} = ${money(row.expected)} ${baseCurrency}`
          : money(row.total);
      const head = `${label(row.documentType)} ${row.documentNo} (#${row.documentId}), ${row.date ?? 'no date'}, ${foreign}`;
      if (row.problem === 'no_entries') return `${head}: no ledger entries`;
      if (row.problem === 'no_cash_entries') {
        return `${head}: no cash basis entries (missing from the cash basis reports)`;
      }
      return `${head}: entries put ${money(row.ledger as number)} on its account`;
    }),
  );

  if (result.taxRowDifferences === null) {
    lines.push(
      '  H14 Invoices and bills whose tax rows do not match their taxed lines: not checked (sales tax is off)',
    );
  } else {
    section(
      lines,
      'H14 Invoices and bills whose tax rows do not match their taxed lines',
      result.taxRowDifferences.map((row) =>
        row.documentNo === null
          ? `${label(row.documentType)} #${row.documentId}, which no longer exists: tax rows for rates ${rateIds(row.rowRateIds)}`
          : `${label(row.documentType)} ${row.documentNo} (#${row.documentId})${row.draft ? ' (draft)' : ''}: tax ${money(row.taxAmount)}, lines use rates ${rateIds(row.lineRateIds)}, tax rows ${row.rowRateIds.length === 0 ? '0' : `for rates ${rateIds(row.rowRateIds)}`}`,
      ),
    );
  }

  if (result.matchedRateOnePayments === null) {
    lines.push(
      '  H15 Payments made by bank matching for a foreign document at rate 1: not checked (no base currency)',
    );
  } else {
    section(
      lines,
      'H15 Payments made by bank matching for a foreign document at rate 1',
      result.matchedRateOnePayments.map(
        (row) =>
          `${label(row.paymentType)} ${row.paymentNo} (#${row.paymentId}), ${row.date ?? 'no date'}: ${row.currencyCode} ${money(row.amount)} at rate ${row.exchangeRate ?? '1 (empty)'} (base ${baseCurrency}), matched to bank line ${ids(row.lineIds)}`,
      ),
    );
  }

  section(
    lines,
    'H16 Duplicate stock rows per item and warehouse',
    result.duplicateStockRows.map(
      (row) =>
        `Item ${row.itemName} (#${row.itemId}) / warehouse ${row.warehouseName} (#${row.warehouseId}): ${row.quantities.length} rows (${row.quantities.map(qty).join(', ')}); the Q3 migration would store ${qty(row.merged)}, the stock movements add up to ${qty(row.fromMovements)}` +
        (Math.abs(row.merged - row.fromMovements) > QUANTITY_NOISE
          ? ' (check after merging: H3)'
          : ''),
    ),
  );
  const rowsToMerge = result.duplicateStockRows.reduce(
    (sum, row) => sum + row.quantities.length,
    0,
  );
  const itemsToMerge = new Set(result.duplicateStockRows.map((r) => r.itemId))
    .size;
  lines.push(
    `${INDENT}Q3 migration (one stock row per item and warehouse): ` +
      (result.duplicateStockRows.length === 0
        ? 'nothing to merge'
        : `would merge ${rowsToMerge} rows into ${result.duplicateStockRows.length} (${itemsToMerge} items), summing their quantities`),
  );
  return lines;
};
