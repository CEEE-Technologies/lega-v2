import { calcLineMoney, roundMoney, toCents } from '@bigcapital/utils';
import { Knex } from 'knex';
import * as moment from 'moment';
import { SALE_INVOICE_MONEY_SQL } from '@/modules/SaleInvoices/models/SaleInvoice';
import { BILL_MONEY_SQL } from '@/modules/Bills/models/Bill';
import { CREDIT_NOTE_MONEY_SQL } from '@/modules/CreditNotes/models/CreditNote';
import { VENDOR_CREDIT_MONEY_SQL } from '@/modules/VendorCredit/models/VendorCredit';
import { getLockedPeriods } from './MoneyHealthCheck';
import {
  day,
  ids,
  INDENT,
  label,
  money,
  num,
  pick,
  qty,
  QUANTITY_NOISE,
  roundQuantity,
  section,
} from './DataHealthCheck.shared';
import {
  checkRound3DataHealth,
  formatRound3DataHealth,
  IDataHealthRound3Result,
  isRound3DataHealthClean,
} from './DataHealthCheckRound3';

/**
 * Read-only data health check of one tenant database, run with the money
 * health check (`tenants:money-health-check`). Fixing the code doesn't
 * repair records saved by the old code, so it lists them for someone to
 * decide what to correct:
 * - H1 foreign currency documents saved at exchange rate 1 (M4),
 * - H2 published documents dated in a locked period (L1–L4; listed only),
 * - H3 stock left by deleted or draft adjustments, and stock totals that
 *   differ from the stock movements (I2, I6),
 * - H4 published decrease adjustments with no ledger entry (I5),
 * - H5 duplicate document numbers (P3, F3, F4; decides the D5 index),
 * - H7 owner memberships of people who didn't create the company (the
 *   March user_tenants backfill),
 * - H8 landed costs from bills posted before the inventory fix (untagged,
 *   so on both bases), landed costs from paid bills with no cash basis
 *   entries, and bill stock costed at the raw line price (I3).
 * H6 (duplicate login emails, decides the S1 index) reads the system
 * database once for all companies: `checkSystemDataHealth`.
 * H9–H16 (round 3: memberships, write-offs, landed costs, bank lines,
 * ledger entries, tax rows, matched payments, stock rows) are in
 * DataHealthCheckRound3.ts and are part of the same result.
 *
 * Plain SELECT queries on the given connections (snake case mappers, like
 * the money check). Nothing is written.
 */

export interface IDataHealthRateOneDocument {
  documentType: string;
  documentId: number;
  documentNo: string;
  date: string | null;
  currencyCode: string;
  amount: number;
  /** As stored: 1, or null (read as 1). */
  exchangeRate: number | null;
}

export interface IDataHealthLockedDocument {
  documentType: string;
  documentId: number;
  documentNo: string;
  date: string;
  lockedTo: string;
  /** The day it was published (YYYY-MM-DD), where the app stores it. */
  publishedAt: string | null;
  /** Published on a day after the lock date (null: not stored). */
  publishedAfterLockDate: boolean | null;
}

export interface IDataHealthAdjustmentStock {
  adjustmentId: number;
  status: 'deleted' | 'draft';
  itemId: number;
  itemName: string;
  warehouseId: number | null;
  /** Stock the movements still add (negative: take away). */
  quantity: number;
}

export interface IDataHealthStockTotal {
  level: 'item' | 'warehouse';
  itemId: number;
  itemName: string;
  warehouseId: number | null;
  stored: number;
  fromMovements: number;
  difference: number;
}

export interface IDataHealthUnpostedDecrease {
  adjustmentId: number;
  referenceNo: string | null;
  date: string;
  quantity: number;
  /** Cost of the units from the cost lots; null when not worked out yet. */
  cost: number | null;
}

export interface IDataHealthDuplicateNumber {
  documentType: string;
  number: string;
  count: number;
  documentIds: number[];
}

export interface IDataHealthBlankNumbers {
  documentType: string;
  count: number;
}

export interface IDataHealthOwnerMembership {
  userId: number;
  email: string | null;
  reason: 'invited' | 'not_a_user' | 'second_owner';
}

export interface IDataHealthUntaggedLandedCost {
  landedCostId: number;
  amount: number;
  fromBillId: number;
  fromBillNo: string;
  billId: number;
  billNo: string;
  date: string | null;
  rows: number;
}

export interface IDataHealthLandedCostNoCashSet {
  landedCostId: number;
  amount: number;
  fromBillId: number;
  fromBillNo: string;
  billId: number;
  billNo: string;
  date: string | null;
}

export interface IDataHealthLotCost {
  source: 'movement' | 'lot';
  billId: number;
  billNo: string;
  entryId: number;
  itemId: number;
  itemName: string;
  quantity: number;
  stored: number;
  expected: number;
  reason: 'vat_included' | 'discount_ignored' | 'other';
}

export interface IDataHealthResult extends IDataHealthRound3Result {
  /** H1 (null: the base currency isn't known). */
  rateOneDocuments: IDataHealthRateOneDocument[] | null;
  /** H2, listed only: not counted as a problem. */
  lockedDocuments: IDataHealthLockedDocument[];
  /** H3 */
  adjustmentStockLeft: IDataHealthAdjustmentStock[];
  stockTotalDifferences: IDataHealthStockTotal[];
  /** Whether H3 also compared per warehouse (multi-warehouse is on). */
  warehousesChecked: boolean;
  /** H4 */
  unpostedDecreases: IDataHealthUnpostedDecrease[];
  /** H5 */
  duplicateNumbers: IDataHealthDuplicateNumber[];
  blankNumbers: IDataHealthBlankNumbers[];
  numberTypesChecked: string[];
  /** H7 (null: run without the system database). */
  ownerMemberships: IDataHealthOwnerMembership[] | null;
  /** H8 */
  untaggedLandedCosts: IDataHealthUntaggedLandedCost[];
  landedCostsWithoutCashSet: IDataHealthLandedCostNoCashSet[];
  lotCostDifferences: IDataHealthLotCost[];
}

export interface IDataHealthLoginEmail {
  email: string;
  users: Array<{
    id: number;
    email: string;
    tenantId: number | null;
    deleted: boolean;
  }>;
}

export interface IDataHealthSystemResult {
  /** H6 */
  duplicateLoginEmails: IDataHealthLoginEmail[];
}

// ---------------------------------------------------------------------------
// H1. Foreign currency documents saved at exchange rate 1 (M4).
// ---------------------------------------------------------------------------

const RATE_DOCUMENTS = [
  {
    documentType: 'SaleInvoice',
    table: 'sales_invoices',
    numberColumn: 'invoice_no',
    dateColumn: 'invoice_date',
    amountSql: SALE_INVOICE_MONEY_SQL.total,
  },
  {
    documentType: 'SaleEstimate',
    table: 'sales_estimates',
    numberColumn: 'estimate_number',
    dateColumn: 'estimate_date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'SaleReceipt',
    table: 'sales_receipts',
    numberColumn: 'receipt_number',
    dateColumn: 'receipt_date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'PaymentReceive',
    table: 'payment_receives',
    numberColumn: 'payment_receive_no',
    dateColumn: 'payment_date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'CreditNote',
    table: 'credit_notes',
    numberColumn: 'credit_note_number',
    dateColumn: 'credit_note_date',
    amountSql: CREDIT_NOTE_MONEY_SQL.total,
  },
  {
    documentType: 'RefundCreditNote',
    table: 'refund_credit_note_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'Bill',
    table: 'bills',
    numberColumn: 'bill_number',
    dateColumn: 'bill_date',
    amountSql: BILL_MONEY_SQL.total,
  },
  {
    documentType: 'BillPayment',
    table: 'bills_payments',
    numberColumn: 'payment_number',
    dateColumn: 'payment_date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'VendorCredit',
    table: 'vendor_credits',
    numberColumn: 'vendor_credit_number',
    dateColumn: 'vendor_credit_date',
    amountSql: VENDOR_CREDIT_MONEY_SQL.total,
  },
  {
    documentType: 'RefundVendorCredit',
    table: 'refund_vendor_credit_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'Expense',
    table: 'expenses_transactions',
    numberColumn: 'reference_no',
    dateColumn: 'payment_date',
    amountSql: 'TOTAL_AMOUNT',
  },
  {
    documentType: 'ManualJournal',
    table: 'manual_journals',
    numberColumn: 'journal_number',
    dateColumn: 'date',
    amountSql: 'AMOUNT',
  },
  {
    documentType: 'BankTransaction',
    table: 'cashflow_transactions',
    numberColumn: 'transaction_number',
    dateColumn: 'date',
    amountSql: 'AMOUNT',
  },
];

/**
 * H1. Documents in another currency than the base one whose stored rate is
 * 1 (or empty, which the app reads as 1): their base currency amounts in
 * the books are the foreign amounts, unconverted. Drafts are listed too:
 * publishing one posts it at that rate.
 */
const getRateOneDocuments = async (
  knex: Knex,
  baseCurrency: string,
): Promise<IDataHealthRateOneDocument[] | null> => {
  if (!baseCurrency) return null;
  const result: IDataHealthRateOneDocument[] = [];
  const rateIsOne = (column: string) => (builder: Knex.QueryBuilder) =>
    builder.where(column, 1).orWhereNull(column);

  for (const kind of RATE_DOCUMENTS) {
    const rows: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .whereNotNull('currency_code')
      .whereNot('currency_code', '')
      .whereNot('currency_code', baseCurrency)
      .where(rateIsOne('exchange_rate'))
      .select(
        'id',
        `${kind.numberColumn} as documentNo`,
        `${kind.dateColumn} as date`,
        'currency_code as currencyCode',
        'exchange_rate as exchangeRate',
      )
      .select(knex.raw(`${kind.amountSql} as health_amount`))
      .orderBy('id');

    rows.forEach((row) =>
      result.push({
        documentType: kind.documentType,
        documentId: row.id,
        documentNo: row.documentNo || `#${row.id}`,
        date: day(row.date),
        currencyCode: row.currencyCode,
        amount: roundMoney(num(pick(row, 'health_amount'))),
        exchangeRate: row.exchangeRate === null ? null : num(row.exchangeRate),
      }),
    );
  }
  // Opening balances of customers and suppliers in another currency.
  const contacts: any[] = await knex
    .queryBuilder()
    .from('contacts')
    .where('opening_balance', '>', 0)
    .whereNotNull('currency_code')
    .whereNot('currency_code', '')
    .whereNot('currency_code', baseCurrency)
    .where(rateIsOne('opening_balance_exchange_rate'))
    .select(
      'id',
      'contact_service as contactService',
      'display_name as name',
      'opening_balance as amount',
      'opening_balance_at as date',
      'currency_code as currencyCode',
      'opening_balance_exchange_rate as exchangeRate',
    )
    .orderBy('id');

  contacts.forEach((row) =>
    result.push({
      documentType:
        row.contactService === 'vendor'
          ? 'VendorOpeningBalance'
          : 'CustomerOpeningBalance',
      documentId: row.id,
      documentNo: row.name || `#${row.id}`,
      date: day(row.date),
      currencyCode: row.currencyCode,
      amount: roundMoney(num(row.amount)),
      exchangeRate: row.exchangeRate === null ? null : num(row.exchangeRate),
    }),
  );
  return result;
};

// ---------------------------------------------------------------------------
// H2. Published documents dated in a locked period (L1–L4).
// ---------------------------------------------------------------------------

const LOCKED_DOCUMENTS = [
  {
    documentType: 'SaleInvoice',
    table: 'sales_invoices',
    numberColumn: 'invoice_no',
    dateColumn: 'invoice_date',
    publishedColumn: 'delivered_at',
  },
  {
    documentType: 'CreditNote',
    table: 'credit_notes',
    numberColumn: 'credit_note_number',
    dateColumn: 'credit_note_date',
    publishedColumn: 'opened_at',
  },
  {
    documentType: 'Bill',
    table: 'bills',
    numberColumn: 'bill_number',
    dateColumn: 'bill_date',
    publishedColumn: 'opened_at',
  },
  {
    documentType: 'VendorCredit',
    table: 'vendor_credits',
    numberColumn: 'vendor_credit_number',
    dateColumn: 'vendor_credit_date',
    publishedColumn: 'opened_at',
  },
  {
    documentType: 'InventoryAdjustment',
    table: 'inventory_adjustments',
    numberColumn: 'reference_no',
    dateColumn: 'date',
    publishedColumn: 'published_at',
  },
];

/**
 * H2. Published invoices, bills, credit notes, vendor credits, stock
 * adjustments, landed costs and opening balances dated in a period that is
 * locked now. Before L1–L4 these could be published (or changed) after the
 * period was locked. The app doesn't store when a period was locked, so
 * this can't tell whether each was published before or after the lock: it
 * lists them all, with the publish day where the app stores one.
 */
const getLockedDocuments = async (
  knex: Knex,
): Promise<IDataHealthLockedDocument[]> => {
  const { isLocked, lockToDateOf } = await getLockedPeriods(knex);
  const result: IDataHealthLockedDocument[] = [];

  const push = (
    documentType: string,
    row: { id: number; documentNo: any; date: any; publishedAt: any },
  ) => {
    const lockedTo = lockToDateOf(documentType);
    if (!lockedTo || !isLocked(row.date, documentType)) return;
    // The publish columns keep the day only.
    const publishedAt = day(row.publishedAt);
    result.push({
      documentType,
      documentId: row.id,
      documentNo: row.documentNo || `#${row.id}`,
      date: day(row.date) as string,
      lockedTo,
      publishedAt,
      publishedAfterLockDate: publishedAt
        ? moment(row.publishedAt).isAfter(lockedTo, 'day')
        : null,
    });
  };

  for (const kind of LOCKED_DOCUMENTS) {
    const lockedTo = lockToDateOf(kind.documentType);
    if (!lockedTo) continue;
    const rows: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .whereNotNull(kind.publishedColumn)
      .where(kind.dateColumn, '<=', lockedTo)
      .select(
        'id',
        `${kind.numberColumn} as documentNo`,
        `${kind.dateColumn} as date`,
        `${kind.publishedColumn} as publishedAt`,
      )
      .orderBy([kind.dateColumn, 'id']);
    rows.forEach((row) => push(kind.documentType, row));
  }

  // Landed costs: posted on the date of the bill they are added to; the
  // allocation's own time is when it was added.
  const landedLockedTo = lockToDateOf('LandedCost');
  if (landedLockedTo) {
    const rows: any[] = await knex
      .queryBuilder()
      .from('bill_located_costs as lc')
      .join('bills as b', 'b.id', 'lc.bill_id')
      .where('b.bill_date', '<=', landedLockedTo)
      .select(
        'lc.id as id',
        'b.bill_number as documentNo',
        'b.bill_date as date',
        'lc.created_at as publishedAt',
      )
      .orderBy(['b.bill_date', 'lc.id']);
    rows.forEach((row) =>
      push('LandedCost', {
        ...row,
        documentNo: `${row.documentNo || `#${row.id}`} (landed cost #${row.id})`,
      }),
    );
  }

  // Opening balances: no publish time is stored.
  const contacts: any[] = await knex
    .queryBuilder()
    .from('contacts')
    .where('opening_balance', '>', 0)
    .whereNotNull('opening_balance_at')
    .select(
      'id',
      'contact_service as contactService',
      'display_name as documentNo',
      'opening_balance_at as date',
    )
    .orderBy(['opening_balance_at', 'id']);
  contacts.forEach((row) =>
    push(
      row.contactService === 'vendor'
        ? 'VendorOpeningBalance'
        : 'CustomerOpeningBalance',
      { ...row, publishedAt: null },
    ),
  );
  return result;
};

// ---------------------------------------------------------------------------
// H3. Stock left by deleted or draft adjustments; stock totals (I2, I6).
// ---------------------------------------------------------------------------

/**
 * H3 (a). Stock movements of adjustments that are deleted or still drafts.
 * The old code moved stock when a draft was saved and didn't undo it when
 * the draft was deleted.
 */
const getAdjustmentStockLeft = async (
  knex: Knex,
): Promise<IDataHealthAdjustmentStock[]> => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('inventory_transactions as t')
    .leftJoin('inventory_adjustments as a', 'a.id', 't.transaction_id')
    .leftJoin('items as i', 'i.id', 't.item_id')
    .where('t.transaction_type', 'InventoryAdjustment')
    .where((builder) => builder.whereNull('a.id').orWhereNull('a.published_at'))
    .groupBy('t.transaction_id', 't.item_id', 't.warehouse_id')
    .select(
      't.transaction_id as adjustmentId',
      't.item_id as itemId',
      't.warehouse_id as warehouseId',
    )
    .max('i.name as itemName')
    .max('a.id as foundId')
    .select(
      knex.raw('SUM(CASE WHEN ?? = ? THEN ?? ELSE -?? END) as ??', [
        't.direction',
        'IN',
        't.quantity',
        't.quantity',
        'net',
      ]),
    )
    .orderBy(['t.transaction_id', 't.item_id']);

  return rows.map((row) => ({
    adjustmentId: row.adjustmentId,
    status: row.foundId ? ('draft' as const) : ('deleted' as const),
    itemId: row.itemId,
    itemName: row.itemName || `#${row.itemId}`,
    warehouseId: row.warehouseId ?? null,
    quantity: num(row.net),
  }));
};

/** Net stock of the movements (in less out), by the given columns. */
const movementTotals = (knex: Knex, groupBy: string[]) =>
  knex
    .queryBuilder()
    .from('inventory_transactions')
    .groupBy(groupBy)
    .select(groupBy.map((column) => `${column}`))
    .select(
      knex.raw('SUM(CASE WHEN ?? = ? THEN ?? ELSE -?? END) as ??', [
        'direction',
        'IN',
        'quantity',
        'quantity',
        'net',
      ]),
    );

/**
 * H3 (b). Stored stock on hand that differs from what the stock movements
 * add up to: per item, and per item and warehouse when multi-warehouse is
 * on (the per-warehouse figures are only kept then). The old code undid a
 * re-saved document's movements once per line, so its stock grew.
 */
export const getStockTotalDifferences = async (knex: Knex) => {
  const differences: IDataHealthStockTotal[] = [];

  const items: any[] = await knex
    .queryBuilder()
    .from('items')
    .where('type', 'inventory')
    .select('id', 'name', 'quantity_on_hand as quantityOnHand')
    .orderBy('id');
  const itemNames = new Map(items.map((item) => [item.id, item.name]));

  const byItem: any[] = await movementTotals(knex, ['item_id']);
  const netByItem = new Map(byItem.map((row) => [row.itemId, num(row.net)]));

  items.forEach((item) => {
    const stored = num(item.quantityOnHand);
    const fromMovements = netByItem.get(item.id) || 0;
    if (Math.abs(stored - fromMovements) > QUANTITY_NOISE) {
      differences.push({
        level: 'item',
        itemId: item.id,
        itemName: item.name,
        warehouseId: null,
        stored,
        fromMovements,
        difference: roundQuantity(stored - fromMovements),
      });
    }
  });

  const feature = await knex
    .queryBuilder()
    .from('settings')
    .where({ group: 'features', key: 'warehouses' })
    .first('value');
  const warehousesChecked =
    !!feature && !['', '0', 'false'].includes(String(feature.value ?? ''));

  if (warehousesChecked) {
    const stored: any[] = await knex
      .queryBuilder()
      .from('items_warehouses_quantity')
      .whereNotNull('warehouse_id')
      .select(
        'item_id as itemId',
        'warehouse_id as warehouseId',
        'quantity_on_hand as quantityOnHand',
      );
    const moved: any[] = await movementTotals(knex, [
      'item_id',
      'warehouse_id',
    ]).whereNotNull('warehouse_id');

    const key = (itemId: number, warehouseId: number) =>
      `${itemId}-${warehouseId}`;
    const pairs = new Map<
      string,
      { itemId: number; warehouseId: number; stored: number; moved: number }
    >();
    stored.forEach((row) =>
      pairs.set(key(row.itemId, row.warehouseId), {
        itemId: row.itemId,
        warehouseId: row.warehouseId,
        stored: num(row.quantityOnHand),
        moved: 0,
      }),
    );
    moved.forEach((row) => {
      const pair = pairs.get(key(row.itemId, row.warehouseId)) || {
        itemId: row.itemId,
        warehouseId: row.warehouseId,
        stored: 0,
        moved: 0,
      };
      pair.moved = num(row.net);
      pairs.set(key(row.itemId, row.warehouseId), pair);
    });
    [...pairs.values()]
      .filter((pair) => itemNames.has(pair.itemId))
      .filter((pair) => Math.abs(pair.stored - pair.moved) > QUANTITY_NOISE)
      .sort((a, b) => a.itemId - b.itemId || a.warehouseId - b.warehouseId)
      .forEach((pair) =>
        differences.push({
          level: 'warehouse',
          itemId: pair.itemId,
          itemName: itemNames.get(pair.itemId),
          warehouseId: pair.warehouseId,
          stored: pair.stored,
          fromMovements: pair.moved,
          difference: roundQuantity(pair.stored - pair.moved),
        }),
      );
  }
  return { differences, warehousesChecked };
};

// ---------------------------------------------------------------------------
// H4. Published decrease adjustments with no ledger entry (I5).
// ---------------------------------------------------------------------------

/**
 * H4. Published decrease (write-off) adjustments without any ledger row:
 * the old code lowered the stock count but never moved its cost out of the
 * stock account. One whose units cost nothing has nothing to post and is
 * left out.
 */
const getUnpostedDecreases = async (
  knex: Knex,
): Promise<IDataHealthUnpostedDecrease[]> => {
  const adjustments: any[] = await knex
    .queryBuilder()
    .from('inventory_adjustments as a')
    .where('a.type', 'decrement')
    .whereNotNull('a.published_at')
    .whereNotExists((builder) =>
      builder
        .select(knex.raw('1'))
        .from('accounts_transactions as t')
        .where('t.reference_type', 'InventoryAdjustment')
        .whereRaw('?? = ??', ['t.reference_id', 'a.id']),
    )
    .select('a.id', 'a.reference_no as referenceNo', 'a.date')
    .orderBy(['a.date', 'a.id']);
  if (adjustments.length === 0) return [];
  const ids = adjustments.map((row) => row.id);

  const quantities: any[] = await knex
    .queryBuilder()
    .from('inventory_adjustments_entries')
    .whereIn('adjustment_id', ids)
    .groupBy('adjustment_id')
    .select('adjustment_id as adjustmentId')
    .sum('quantity as quantity');
  const quantityById = new Map(
    quantities.map((row) => [row.adjustmentId, num(row.quantity)]),
  );
  const lots: any[] = await knex
    .queryBuilder()
    .from('inventory_cost_lot_tracker')
    .where('transaction_type', 'InventoryAdjustment')
    .where('direction', 'OUT')
    .whereIn('transaction_id', ids)
    .groupBy('transaction_id')
    .select('transaction_id as adjustmentId')
    .sum('cost as cost');
  const costById = new Map(
    lots.map((row) => [row.adjustmentId, num(row.cost)]),
  );

  return adjustments
    .filter((row) => !costById.has(row.id) || toCents(costById.get(row.id)) > 0)
    .map((row) => ({
      adjustmentId: row.id,
      referenceNo: row.referenceNo || null,
      date: day(row.date) as string,
      quantity: quantityById.get(row.id) || 0,
      cost: costById.has(row.id) ? roundMoney(costById.get(row.id)) : null,
    }));
};

// ---------------------------------------------------------------------------
// H5. Duplicate document numbers (P3, F3, F4; D5).
// ---------------------------------------------------------------------------

const NUMBERED_DOCUMENTS = [
  {
    documentType: 'SaleInvoice',
    table: 'sales_invoices',
    column: 'invoice_no',
  },
  {
    documentType: 'SaleEstimate',
    table: 'sales_estimates',
    column: 'estimate_number',
  },
  {
    documentType: 'SaleReceipt',
    table: 'sales_receipts',
    column: 'receipt_number',
  },
  {
    documentType: 'PaymentReceive',
    table: 'payment_receives',
    column: 'payment_receive_no',
  },
  {
    documentType: 'CreditNote',
    table: 'credit_notes',
    column: 'credit_note_number',
  },
  { documentType: 'Bill', table: 'bills', column: 'bill_number' },
  {
    documentType: 'BillPayment',
    table: 'bills_payments',
    column: 'payment_number',
  },
  {
    documentType: 'VendorCredit',
    table: 'vendor_credits',
    column: 'vendor_credit_number',
  },
  {
    documentType: 'ManualJournal',
    table: 'manual_journals',
    column: 'journal_number',
  },
  {
    documentType: 'WarehouseTransfer',
    table: 'warehouses_transfers',
    column: 'transaction_number',
  },
  {
    documentType: 'BankTransaction',
    table: 'cashflow_transactions',
    column: 'transaction_number',
  },
];

/**
 * H5. Numbers used by more than one document of the same type. Grouped in
 * SQL, so numbers count as the same the way a unique index on the column
 * would (the column's collation: case and trailing spaces ignored). Empty
 * numbers are counted apart: they aren't damage, but a unique index fails
 * on two of them unless they are stored as NULL.
 */
const getDuplicateNumbers = async (knex: Knex) => {
  const duplicates: IDataHealthDuplicateNumber[] = [];
  const blanks: IDataHealthBlankNumbers[] = [];
  const checked: string[] = [];

  for (const kind of NUMBERED_DOCUMENTS) {
    checked.push(kind.documentType);

    const rows: any[] = await knex
      .queryBuilder()
      .from(kind.table)
      .whereNotNull(kind.column)
      .whereNot(kind.column, '')
      .groupBy(kind.column)
      .havingRaw('COUNT(*) > 1')
      .select(`${kind.column} as number`)
      .count('* as count')
      .select(
        knex.raw('GROUP_CONCAT(?? ORDER BY ?? SEPARATOR ?) as ??', [
          'id',
          'id',
          ',',
          'ids',
        ]),
      )
      .orderBy(kind.column);
    rows.forEach((row) =>
      duplicates.push({
        documentType: kind.documentType,
        number: row.number,
        count: num(row.count),
        documentIds: String(row.ids).split(',').map(Number),
      }),
    );

    const blank: any = await knex
      .queryBuilder()
      .from(kind.table)
      .where(kind.column, '')
      .count('* as count')
      .first();
    if (num(blank?.count) > 1) {
      blanks.push({ documentType: kind.documentType, count: num(blank.count) });
    }
  }
  return { duplicates, blanks, checked };
};

// ---------------------------------------------------------------------------
// H7. Owner memberships of people who didn't create the company.
// ---------------------------------------------------------------------------

/**
 * H7. `user_tenants` rows with role `owner` for logins that didn't create
 * the company. The March backfill (`20260320000002`) made every login with
 * a `tenant_id` an owner, invited members too; owners are protected from
 * being edited or removed and can delete the workspace. A login is taken as
 * invited when its user in the company has an invite time. Of the other
 * owners, the one whose user in the company came first is taken as the
 * creator; the rest are listed (an owner with no user in the company too).
 */
export const getOwnerMemberships = async (
  knex: Knex,
  systemKnex: Knex,
  tenantId: number,
): Promise<IDataHealthOwnerMembership[]> => {
  const owners: any[] = await systemKnex
    .queryBuilder()
    .from('user_tenants as ut')
    .join('users as u', 'u.id', 'ut.user_id')
    .where('ut.tenant_id', tenantId)
    .where('ut.role', 'owner')
    .select('ut.user_id as userId', 'u.email as email')
    .orderBy('ut.id');
  if (owners.length === 0) return [];

  const tenantUsers: any[] = await knex
    .queryBuilder()
    .from('users')
    .whereIn(
      'system_user_id',
      owners.map((owner) => owner.userId),
    )
    .select('id', 'system_user_id as systemUserId', 'invited_at as invitedAt');
  const tenantUserBySystemId = new Map(
    tenantUsers.map((row) => [row.systemUserId, row]),
  );

  const result: IDataHealthOwnerMembership[] = [];
  const candidates: any[] = [];
  owners.forEach((owner) => {
    // Only an invite sets the time (sign-up sets the login's
    // invite_accepted_at too, so that isn't a sign of an invite).
    if (tenantUserBySystemId.get(owner.userId)?.invitedAt) {
      result.push({
        userId: owner.userId,
        email: owner.email,
        reason: 'invited',
      });
    } else {
      candidates.push(owner);
    }
  });
  // One of the others created the company. Its user in the company is
  // written when the company is built, before anyone is invited: the lowest
  // id. (Membership and login times can be empty, so they can't tell.) An
  // owner with no user in the company comes last: it is only taken as the
  // creator when it is the only one left.
  const tenantUserId = (owner: any) =>
    Number(tenantUserBySystemId.get(owner.userId)?.id ?? Infinity);
  candidates.sort(
    (a, b) => tenantUserId(a) - tenantUserId(b) || a.userId - b.userId,
  );
  candidates.slice(1).forEach((owner) =>
    result.push({
      userId: owner.userId,
      email: owner.email,
      reason: tenantUserBySystemId.has(owner.userId)
        ? 'second_owner'
        : 'not_a_user',
    }),
  );
  return result.sort((a, b) => a.userId - b.userId);
};

// ---------------------------------------------------------------------------
// H8. Landed costs and stock costs posted before the inventory fix (I3, P7).
// ---------------------------------------------------------------------------

/**
 * H8 (a). Landed costs from a bill whose ledger rows aren't tagged with a
 * basis. Since PR 11 they are tagged accrual and the cash basis follows the
 * bill's payments; older ones count on both bases, so the cash basis shows
 * them at the bill date, paid or not. The tenant migration
 * 20261102120000_tag_old_landed_costs_accrual flags the cash basis rebuild,
 * which tags them and writes their cash set; one listed here hasn't been
 * done yet (the migration or the rebuild hasn't run, or a date of it is in
 * a locked period: unlock and run the rebuild).
 */
const getUntaggedLandedCosts = async (
  knex: Knex,
): Promise<IDataHealthUntaggedLandedCost[]> => {
  const rows: any[] = await knex
    .queryBuilder()
    .from('bill_located_costs as lc')
    .join('accounts_transactions as t', (join) =>
      join
        .on('t.reference_id', '=', 'lc.id')
        .andOn('t.reference_type', '=', knex.raw('?', ['LandedCost'])),
    )
    .leftJoin('bills as fb', 'fb.id', 'lc.from_transaction_id')
    .leftJoin('bills as b', 'b.id', 'lc.bill_id')
    .where('lc.from_transaction_type', 'Bill')
    .whereNull('t.basis')
    .groupBy('lc.id')
    .select('lc.id as landedCostId')
    .max('lc.amount as amount')
    .max('lc.from_transaction_id as fromBillId')
    .max('fb.bill_number as fromBillNo')
    .max('lc.bill_id as billId')
    .max('b.bill_number as billNo')
    .max('b.bill_date as date')
    .count('* as untaggedRows')
    .orderBy('lc.id');

  return rows.map((row) => ({
    landedCostId: row.landedCostId,
    amount: roundMoney(num(row.amount)),
    fromBillId: row.fromBillId,
    fromBillNo: row.fromBillNo || `#${row.fromBillId}`,
    billId: row.billId,
    billNo: row.billNo || `#${row.billId}`,
    date: day(row.date),
    rows: num(row.untaggedRows),
  }));
};

/**
 * H8 (c). Landed costs from a bill that is paid (in part or in full) but
 * that have no cash basis entries: the cash basis misses the cost moved
 * into stock. The cash basis rebuild writes them.
 */
const getLandedCostsWithoutCashSet = async (
  knex: Knex,
): Promise<IDataHealthLandedCostNoCashSet[]> => {
  const rowsOfBasis = (basis: string | null) =>
    function (this: Knex.QueryBuilder) {
      this.select(knex.raw('1'))
        .from('accounts_transactions as t')
        .whereRaw('?? = ??', ['t.reference_id', 'lc.id'])
        .where('t.reference_type', 'LandedCost');
      if (basis === null) this.whereNull('t.basis');
      else this.where('t.basis', basis);
    };
  const rows: any[] = await knex
    .queryBuilder()
    .from('bill_located_costs as lc')
    .leftJoin('bills as fb', 'fb.id', 'lc.from_transaction_id')
    .leftJoin('bills as b', 'b.id', 'lc.bill_id')
    .where('lc.from_transaction_type', 'Bill')
    .whereExists(function () {
      this.select(knex.raw('1'))
        .from('bills_payments_entries as e')
        .whereRaw('?? = ??', ['e.bill_id', 'lc.from_transaction_id'])
        .where('e.payment_amount', '>', 0);
    })
    .whereExists(rowsOfBasis('accrual'))
    .whereNotExists(rowsOfBasis(null))
    .whereNotExists(rowsOfBasis('cash'))
    .select(
      'lc.id as landedCostId',
      'lc.amount as amount',
      'lc.from_transaction_id as fromBillId',
      'fb.bill_number as fromBillNo',
      'lc.bill_id as billId',
      'b.bill_number as billNo',
      'b.bill_date as date',
    )
    .orderBy('lc.id');

  return rows.map((row) => ({
    landedCostId: row.landedCostId,
    amount: roundMoney(num(row.amount)),
    fromBillId: row.fromBillId,
    fromBillNo: row.fromBillNo || `#${row.fromBillId}`,
    billId: row.billId,
    billNo: row.billNo || `#${row.billId}`,
    date: day(row.date),
  }));
};

/**
 * H8 (b). Stock bought on bills (movements and cost lots) whose cost isn't
 * the line's cost in the books: the line total after its discount, without
 * tax, times the bill rate, to the cent. The old code costed it at the raw
 * unit price, VAT inside a tax-inclusive price included and the discount
 * ignored, so cost of sales came out higher than what went into stock. A
 * one cent difference is allowed (unit cost rounding of old rows).
 */
const getLotCostDifferences = async (
  knex: Knex,
): Promise<IDataHealthLotCost[]> => {
  const result: IDataHealthLotCost[] = [];
  const sources = [
    { source: 'movement' as const, table: 'inventory_transactions' },
    { source: 'lot' as const, table: 'inventory_cost_lot_tracker' },
  ];
  for (const { source, table } of sources) {
    const rows: any[] = await knex
      .queryBuilder()
      .from(`${table} as t`)
      .join('items_entries as e', 'e.id', 't.entry_id')
      .join('bills as b', 'b.id', 't.transaction_id')
      .leftJoin('items as i', 'i.id', 't.item_id')
      .where('t.transaction_type', 'Bill')
      .where('t.direction', 'IN')
      .where('e.reference_type', 'Bill')
      .select(
        't.transaction_id as billId',
        'b.bill_number as billNo',
        'b.exchange_rate as billRate',
        't.entry_id as entryId',
        't.item_id as itemId',
        'i.name as itemName',
        't.quantity as quantity',
        't.rate as rate',
        'e.quantity as entryQuantity',
        'e.rate as entryRate',
        'e.discount as discount',
        'e.discount_type as discountType',
        'e.tax_rate as taxRate',
        'e.is_inclusive_tax as isInclusiveTax',
      )
      .orderBy(['t.transaction_id', 't.entry_id']);

    rows.forEach((row) => {
      const quantity = num(row.quantity);
      if (quantity <= 0 || num(row.entryQuantity) <= 0) return;
      const line = calcLineMoney({
        quantity: num(row.entryQuantity),
        rate: num(row.entryRate),
        discount: num(row.discount),
        discountType: row.discountType || 'percentage',
        taxRate: num(row.taxRate),
        isInclusiveTax: !!Number(row.isInclusiveTax),
      });
      const lineCost = roundMoney(
        line.totalExcludingTax * num(row.billRate || 1),
      );
      // A movement may carry part of the line (it is per line and item).
      const expected = roundMoney(
        (lineCost * quantity) / num(row.entryQuantity),
      );
      const stored = roundMoney(num(row.rate) * quantity);
      if (Math.abs(toCents(stored) - toCents(expected)) <= 1) return;

      const hasTax = !!Number(row.isInclusiveTax) && num(row.taxRate) > 0;
      result.push({
        source,
        billId: row.billId,
        billNo: row.billNo || `#${row.billId}`,
        entryId: row.entryId,
        itemId: row.itemId,
        itemName: row.itemName || `#${row.itemId}`,
        quantity,
        stored,
        expected,
        reason: hasTax
          ? 'vat_included'
          : num(row.discount) > 0
            ? 'discount_ignored'
            : 'other',
      });
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Run, verdict, output.
// ---------------------------------------------------------------------------

/**
 * Runs the data health check on the given tenant database.
 * @param {Knex} knex - Tenant database connection.
 * @param {string} baseCurrency - The tenant base currency.
 * @param {object} system - The system database and the tenant id, for H7 and H9.
 * @returns {Promise<IDataHealthResult>}
 */
export const checkDataHealth = async (
  knex: Knex,
  baseCurrency: string,
  system?: { systemKnex: Knex; tenantId: number },
): Promise<IDataHealthResult> => {
  const rateOneDocuments = await getRateOneDocuments(knex, baseCurrency);
  const lockedDocuments = await getLockedDocuments(knex);
  const adjustmentStockLeft = await getAdjustmentStockLeft(knex);
  const stockTotals = await getStockTotalDifferences(knex);
  const unpostedDecreases = await getUnpostedDecreases(knex);
  const numbers = await getDuplicateNumbers(knex);
  const ownerMemberships = system
    ? await getOwnerMemberships(knex, system.systemKnex, system.tenantId)
    : null;
  const untaggedLandedCosts = await getUntaggedLandedCosts(knex);
  const landedCostsWithoutCashSet = await getLandedCostsWithoutCashSet(knex);
  const lotCostDifferences = await getLotCostDifferences(knex);
  const round3 = await checkRound3DataHealth(knex, baseCurrency, system);

  return {
    rateOneDocuments,
    lockedDocuments,
    adjustmentStockLeft,
    stockTotalDifferences: stockTotals.differences,
    warehousesChecked: stockTotals.warehousesChecked,
    unpostedDecreases,
    duplicateNumbers: numbers.duplicates,
    blankNumbers: numbers.blanks,
    numberTypesChecked: numbers.checked,
    ownerMemberships,
    untaggedLandedCosts,
    landedCostsWithoutCashSet,
    lotCostDifferences,
    ...round3,
  };
};

/**
 * H6. Login emails used by more than one login, ignoring case. Read from
 * the system database once for all companies. Deleted logins are included:
 * a unique index counts them too.
 * @param {Knex} systemKnex
 * @returns {Promise<IDataHealthSystemResult>}
 */
export const checkSystemDataHealth = async (
  systemKnex: Knex,
): Promise<IDataHealthSystemResult> => {
  const groups: any[] = await systemKnex
    .queryBuilder()
    .from('users')
    .whereNotNull('email')
    .groupByRaw('LOWER(??)', ['email'])
    .havingRaw('COUNT(*) > 1')
    .select(systemKnex.raw('LOWER(??) as ??', ['email', 'email_key']))
    .orderByRaw('LOWER(??)', ['email']);
  if (groups.length === 0) return { duplicateLoginEmails: [] };

  const keys = groups.map((row) => String(pick(row, 'email_key')));
  const users: any[] = await systemKnex
    .queryBuilder()
    .from('users')
    .whereRaw(`LOWER(??) IN (${keys.map(() => '?').join(', ')})`, [
      'email',
      ...keys,
    ])
    .select('id', 'email', 'tenant_id as tenantId', 'deleted_at as deletedAt')
    .orderBy('id');

  return {
    duplicateLoginEmails: keys.map((key) => ({
      email: key,
      users: users
        .filter((user) => String(user.email).toLowerCase() === key)
        .map((user) => ({
          id: user.id,
          email: user.email,
          tenantId: user.tenantId ?? null,
          deleted: !!user.deletedAt,
        })),
    })),
  };
};

/**
 * Whether the company's data is clean. H2 is a list to look at, not a
 * problem (documents in a locked period are normally there), and so are
 * empty document numbers.
 * @param {IDataHealthResult} result
 * @returns {boolean}
 */
export const isDataHealthClean = (result: IDataHealthResult) =>
  (result.rateOneDocuments ?? []).length === 0 &&
  result.adjustmentStockLeft.length === 0 &&
  result.stockTotalDifferences.length === 0 &&
  result.unpostedDecreases.length === 0 &&
  result.duplicateNumbers.length === 0 &&
  (result.ownerMemberships ?? []).length === 0 &&
  result.untaggedLandedCosts.length === 0 &&
  result.landedCostsWithoutCashSet.length === 0 &&
  result.lotCostDifferences.length === 0 &&
  isRound3DataHealthClean(result);

/** Whether the system data is clean (H6). */
export const isSystemDataHealthClean = (result: IDataHealthSystemResult) =>
  result.duplicateLoginEmails.length === 0;

const signed = (value: number) => (value > 0 ? `+${qty(value)}` : qty(value));
const warehouse = (id: number | null) => (id ? ` in warehouse #${id}` : '');

/**
 * Formats the company result as printable lines (H1–H5, H7–H16).
 * @param {IDataHealthResult} result
 * @param {string} baseCurrency
 * @returns {string[]}
 */
export const formatDataHealth = (
  result: IDataHealthResult,
  baseCurrency: string,
): string[] => {
  const lines: string[] = [];

  if (result.rateOneDocuments === null) {
    lines.push(
      '  H1 Foreign currency documents saved at exchange rate 1: not checked (no base currency)',
    );
  } else {
    section(
      lines,
      'H1 Foreign currency documents saved at exchange rate 1',
      result.rateOneDocuments.map(
        (row) =>
          `${label(row.documentType)} ${row.documentNo} (#${row.documentId}), ${row.date ?? 'no date'}: ${row.currencyCode} ${money(row.amount)} at rate ${row.exchangeRate ?? '1 (empty)'} (base ${baseCurrency})`,
      ),
    );
  }

  lines.push(
    `  H2 Published documents dated in a locked period (listed only, not counted as problems): ${result.lockedDocuments.length}`,
  );
  lines.push(
    `${INDENT}The app doesn't store when a period was locked, so this can't tell whether each was published before or after the lock. "after the lock date" marks ones published on a later day than the date the period is locked to.`,
  );
  if (result.lockedDocuments.length === 0) lines.push(`${INDENT}none`);
  result.lockedDocuments.forEach((row) =>
    lines.push(
      `${INDENT}${label(row.documentType)} ${row.documentNo} (#${row.documentId}), ${moment(row.date).format('D MMM YYYY')}, period locked to ${moment(row.lockedTo).format('D MMM YYYY')}` +
        (row.publishedAt === null
          ? ' (publish time not stored)'
          : `, published ${moment(row.publishedAt).format('D MMM YYYY')}${row.publishedAfterLockDate ? ' (after the lock date)' : ''}`),
    ),
  );

  section(
    lines,
    'H3 Stock left by deleted or draft adjustments',
    result.adjustmentStockLeft.map(
      (row) =>
        `Adjustment #${row.adjustmentId} (${row.status}): item ${row.itemName} (#${row.itemId}) ${signed(row.quantity)}${warehouse(row.warehouseId)}`,
    ),
  );
  section(
    lines,
    `H3 Stock totals different from the stock movements (${result.warehousesChecked ? 'per item and per warehouse' : 'per item; multi-warehouse is off'})`,
    result.stockTotalDifferences.map(
      (row) =>
        `Item ${row.itemName} (#${row.itemId})${warehouse(row.warehouseId)}: stock shows ${qty(row.stored)}, movements add up to ${qty(row.fromMovements)}`,
    ),
  );

  section(
    lines,
    'H4 Published decrease adjustments with no ledger entry',
    result.unpostedDecreases.map(
      (row) =>
        `Adjustment #${row.adjustmentId}${row.referenceNo ? ` (${row.referenceNo})` : ''}, ${row.date}: -${qty(row.quantity)} units, ` +
        (row.cost === null
          ? 'cost not worked out yet'
          : `${money(row.cost)} cost`) +
        ', no ledger entry',
    ),
  );

  section(
    lines,
    'H5 Duplicate document numbers',
    result.duplicateNumbers.map(
      (row) =>
        `${label(row.documentType)} ${row.number} is used by ${row.count} documents (${ids(row.documentIds)})`,
    ),
  );
  result.blankNumbers.forEach((row) =>
    lines.push(
      `${INDENT}${label(row.documentType)}: ${row.count} documents have an empty number (not a problem, but see below)`,
    ),
  );
  const blocked = new Set([
    ...result.duplicateNumbers.map((row) => row.documentType),
    ...result.blankNumbers.map((row) => row.documentType),
  ]);
  const free = result.numberTypesChecked.filter((type) => !blocked.has(type));
  lines.push(
    `${INDENT}Unique number index (P3, D5): ` +
      (blocked.size === 0
        ? `can be added for all ${free.length} document types`
        : `can be added for ${free.length} of ${result.numberTypesChecked.length} types; not yet for ${[...blocked].map(label).join(', ')}` +
          (result.blankNumbers.length > 0
            ? ' (empty numbers have to be stored as NULL first)'
            : '')),
  );

  if (result.ownerMemberships === null) {
    lines.push(
      '  H7 Owners who did not create the company: not checked (no system database)',
    );
  } else {
    const reasons = {
      invited: 'joined by invite',
      not_a_user: 'not a user of the company',
      second_owner: 'another owner was a user of the company first',
    };
    section(
      lines,
      'H7 Owners who did not create the company',
      result.ownerMemberships.map(
        (row) =>
          `${row.email ?? 'no email'} (login #${row.userId}): owner, ${reasons[row.reason]}`,
      ),
    );
  }

  section(
    lines,
    'H8 Landed costs from bills posted before the inventory fix (untagged, on both bases; run the cash basis rebuild)',
    result.untaggedLandedCosts.map(
      (row) =>
        `Landed cost #${row.landedCostId}: ${money(row.amount)} from bill ${row.fromBillNo} (#${row.fromBillId}) onto bill ${row.billNo} (#${row.billId}), ${row.date ?? 'no date'}: ${row.rows} untagged ledger rows`,
    ),
  );
  section(
    lines,
    'H8 Landed costs from paid bills with no cash basis entries (run the cash basis rebuild)',
    result.landedCostsWithoutCashSet.map(
      (row) =>
        `Landed cost #${row.landedCostId}: ${money(row.amount)} from bill ${row.fromBillNo} (#${row.fromBillId}) onto bill ${row.billNo} (#${row.billId}), ${row.date ?? 'no date'}`,
    ),
  );
  const reasons = {
    vat_included: 'VAT included',
    discount_ignored: 'discount ignored',
    other: 'raw price',
  };
  section(
    lines,
    'H8 Bill stock costed at the raw line price',
    result.lotCostDifferences.map(
      (row) =>
        `Bill ${row.billNo} (#${row.billId}) line #${row.entryId}, item ${row.itemName} (#${row.itemId}), ${qty(row.quantity)} units: ${row.source === 'lot' ? 'cost lot' : 'stock movement'} ${money(row.stored)}, books ${money(row.expected)} (${reasons[row.reason]})`,
    ),
  );
  lines.push(...formatRound3DataHealth(result, baseCurrency));
  return lines;
};

/**
 * Formats the system result as printable lines (H6).
 * @param {IDataHealthSystemResult} result
 * @returns {string[]}
 */
export const formatSystemDataHealth = (
  result: IDataHealthSystemResult,
): string[] => {
  const lines: string[] = [];
  section(
    lines,
    'H6 Login emails used by more than one login (case ignored)',
    result.duplicateLoginEmails.map(
      (row) =>
        `${row.email} is used by ${row.users.length} logins (` +
        row.users
          .map(
            (user) =>
              `#${user.id} ${user.email}${user.deleted ? ' [deleted]' : ''}`,
          )
          .join(', ') +
        ')',
    ),
  );
  lines.push(
    `${INDENT}Unique login email index (S1, D5): ` +
      (result.duplicateLoginEmails.length === 0
        ? 'can be added'
        : `not yet: ${result.duplicateLoginEmails.length} emails are shared`),
  );
  return lines;
};
