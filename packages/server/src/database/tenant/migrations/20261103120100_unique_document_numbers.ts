/**
 * Repairs duplicate document numbers (health check H5) and then adds a
 * unique index on each document type's number (decisions D5 / P3).
 *
 * 1. Empty numbers ('') become NULL. An empty number isn't a number, and a
 *    unique index allows many NULLs but only one ''. The app now saves an
 *    empty number as NULL too (BaseModel.blankAsNullColumns).
 * 2. Broken numbers (`{}` or `[object ...]`, saved by the old F4 bug when a
 *    credit note or journal was created without a number) get a proper
 *    number: the next numbers of the company's auto-increment settings for
 *    that document type (the setting is moved on past them), or
 *    `<prefix><id>` (for example `CN-123`) when auto-increment is off.
 * 3. Other numbers used by more than one document: the oldest document
 *    (lowest id) keeps it, the others get `-2`, `-3`, ... added, skipping
 *    any number already in use.
 * 4. Every place that copied the old number is updated too: the ledger rows
 *    of the document (and of its landed costs and credit applications) and
 *    the stock movement details. Only copies that still hold the old number
 *    are changed.
 * 5. The unique index is added to each document table.
 *
 * Numbers count as the same the way the unique index compares them (the
 * column's collation: case and trailing spaces ignored), as health check H5
 * does. Every change is printed.
 *
 * Safe to re-run: a clean company has nothing to rename, and an index that
 * already exists is skipped.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

interface DocumentKind {
  documentType: string;
  table: string;
  column: string;
  /** Numbering settings group (auto-increment), if the type has one. */
  settingsGroup?: string;
  /** Prefix used for broken numbers when there are no settings. */
  defaultPrefix: string;
  /** Ledger `reference_type`s whose `reference_id` is the document id. */
  ledgerTypes: string[];
  /** Ledger rows that point at child rows of the document. */
  childLedgerRows?: Array<{
    referenceType: string;
    childTable: string;
    parentColumn: string;
  }>;
  /** `inventory_transactions.transaction_type` of the document. */
  inventoryType?: string;
}

const KINDS: DocumentKind[] = [
  {
    documentType: 'SaleInvoice',
    table: 'sales_invoices',
    column: 'invoice_no',
    settingsGroup: 'sales_invoices',
    defaultPrefix: 'INV-',
    ledgerTypes: ['SaleInvoice', 'InvoiceWriteOff'],
    inventoryType: 'SaleInvoice',
  },
  {
    documentType: 'SaleEstimate',
    table: 'sales_estimates',
    column: 'estimate_number',
    settingsGroup: 'sales_estimates',
    defaultPrefix: 'EST-',
    ledgerTypes: [],
  },
  {
    documentType: 'SaleReceipt',
    table: 'sales_receipts',
    column: 'receipt_number',
    settingsGroup: 'sales_receipts',
    defaultPrefix: 'REC-',
    ledgerTypes: ['SaleReceipt'],
    inventoryType: 'SaleReceipt',
  },
  {
    documentType: 'PaymentReceive',
    table: 'payment_receives',
    column: 'payment_receive_no',
    settingsGroup: 'payment_receives',
    defaultPrefix: 'PAY-',
    ledgerTypes: ['PaymentReceive'],
  },
  {
    documentType: 'CreditNote',
    table: 'credit_notes',
    column: 'credit_note_number',
    settingsGroup: 'credit_note',
    defaultPrefix: 'CN-',
    ledgerTypes: ['CreditNote'],
    childLedgerRows: [
      {
        referenceType: 'CreditNoteApplyInvoice',
        childTable: 'credit_note_applied_invoice',
        parentColumn: 'credit_note_id',
      },
    ],
    inventoryType: 'CreditNote',
  },
  {
    documentType: 'Bill',
    table: 'bills',
    column: 'bill_number',
    defaultPrefix: 'BILL-',
    ledgerTypes: ['Bill'],
    childLedgerRows: [
      {
        referenceType: 'LandedCost',
        childTable: 'bill_located_costs',
        parentColumn: 'bill_id',
      },
    ],
    inventoryType: 'Bill',
  },
  {
    documentType: 'BillPayment',
    table: 'bills_payments',
    column: 'payment_number',
    defaultPrefix: 'BP-',
    ledgerTypes: ['BillPayment'],
  },
  {
    documentType: 'VendorCredit',
    table: 'vendor_credits',
    column: 'vendor_credit_number',
    settingsGroup: 'vendor_credit',
    defaultPrefix: 'VC-',
    ledgerTypes: ['VendorCredit'],
    childLedgerRows: [
      {
        referenceType: 'VendorCreditApplyBill',
        childTable: 'vendor_credit_applied_bill',
        parentColumn: 'vendor_credit_id',
      },
    ],
    inventoryType: 'VendorCredit',
  },
  {
    documentType: 'ManualJournal',
    table: 'manual_journals',
    column: 'journal_number',
    settingsGroup: 'manual_journals',
    defaultPrefix: 'J-',
    ledgerTypes: ['Journal'],
  },
  {
    documentType: 'WarehouseTransfer',
    table: 'warehouses_transfers',
    column: 'transaction_number',
    settingsGroup: 'warehouse_transfers',
    defaultPrefix: 'WT-',
    ledgerTypes: [],
    inventoryType: 'WarehouseTransfer',
  },
  {
    documentType: 'BankTransaction',
    table: 'cashflow_transactions',
    column: 'transaction_number',
    settingsGroup: 'cashflow',
    defaultPrefix: 'CF-',
    ledgerTypes: ['CashflowTransaction'],
  },
];

/** Same suffix as `DOCUMENT_NUMBER_INDEX_SUFFIX` in the app. */
const indexName = (table: string) => `${table}_doc_number_unique`;

/** Numbers saved by the F4 bug: a serialized promise. */
const isBrokenNumber = (value: unknown) =>
  /^\s*(\{\}|\[object [A-Za-z]*\])\s*$/.test(String(value ?? ''));

/** Same as `transactionIncrement` in the app: '00041' -> '00042'. */
const increment = (value: string) =>
  value.replace(/([0-8]|\d?9+)?$/, (match) => String(Number(match) + 1));

const isOn = (value: unknown) =>
  ['1', 'true', 'yes'].includes(String(value ?? '').toLowerCase());

const tableExists = async (knex: any, table: string) => {
  const [rows] = await knex.raw('SHOW TABLES LIKE ?', [table.toUpperCase()]);
  return rows.length > 0;
};

const indexExists = async (knex: any, table: string, name: string) => {
  const [rows] = await knex.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [
    table,
    name.toUpperCase(),
  ]);
  return rows.length > 0;
};

const numberInUse = async (knex: any, kind: DocumentKind, value: string) =>
  !!(await knex(kind.table).where(kind.column, value).first('id'));

const getSettings = async (knex: any, group?: string) => {
  if (!group) return null;
  const rows: any[] = await knex('settings')
    .where({ group })
    .whereIn('key', ['auto_increment', 'number_prefix', 'next_number'])
    .orderBy('id');
  const get = (key: string) => rows.find((row) => row.key === key)?.value;
  return {
    autoIncrement: isOn(get('auto_increment')),
    prefix: String(get('number_prefix') ?? ''),
    nextNumber: get('next_number'),
    hasNextNumberRow: rows.some((row) => row.key === 'next_number'),
  };
};

/**
 * Writes the new number on the document and on every copy of the old one.
 */
const renameDocument = async (
  knex: any,
  kind: DocumentKind,
  id: number,
  oldNumber: string,
  newNumber: string,
) => {
  await knex(kind.table)
    .where('id', id)
    .update({ [kind.column]: newNumber });

  const sameOldNumber = (query: any) =>
    oldNumber === null
      ? query.whereNull('transaction_number')
      : query.where('transaction_number', oldNumber);

  if (kind.ledgerTypes.length > 0) {
    await sameOldNumber(
      knex('accounts_transactions')
        .whereIn('reference_type', kind.ledgerTypes)
        .where('reference_id', id),
    ).update({ transaction_number: newNumber });
  }
  for (const child of kind.childLedgerRows || []) {
    if (!(await tableExists(knex, child.childTable))) continue;
    await sameOldNumber(
      knex('accounts_transactions')
        .where('reference_type', child.referenceType)
        .whereIn(
          'reference_id',
          knex(child.childTable).where(child.parentColumn, id).select('id'),
        ),
    ).update({ transaction_number: newNumber });
  }
  if (kind.inventoryType) {
    await sameOldNumber(
      knex('inventory_transaction_meta').whereIn(
        'inventory_transaction_id',
        knex('inventory_transactions')
          .where('transaction_type', kind.inventoryType)
          .where('transaction_id', id)
          .select('id'),
      ),
    ).update({ transaction_number: newNumber });
  }
};

const repairKind = async (knex: any, kind: DocumentKind, log: string[]) => {
  const { table, column } = kind;

  // 1. Empty numbers become NULL.
  const blanks = await knex(table)
    .whereRaw('TRIM(??) = ?', [column, ''])
    .update({ [column]: null });
  if (blanks > 0) {
    log.push(`${kind.documentType}: ${blanks} empty number(s) set to NULL`);
  }

  // 2. Broken numbers get a proper one.
  const candidates: any[] = await knex(table)
    .where((builder: any) =>
      builder.where(column, '{}').orWhere(column, 'like', '[object %'),
    )
    .select('id', knex.raw('?? as ??', [column, 'number']))
    .orderBy('id');
  const broken = candidates.filter((row) => isBrokenNumber(row.number));

  if (broken.length > 0) {
    const settings = await getSettings(knex, kind.settingsGroup);
    const useSequence =
      !!settings?.autoIncrement &&
      /\d$/.test(String(settings?.nextNumber ?? ''));
    let next = String(settings?.nextNumber ?? '');

    for (const row of broken) {
      let newNumber: string;
      if (useSequence) {
        newNumber = `${settings.prefix}${next}`;
        while (await numberInUse(knex, kind, newNumber)) {
          next = increment(next);
          newNumber = `${settings.prefix}${next}`;
        }
        next = increment(next);
      } else {
        const prefix = settings?.prefix || kind.defaultPrefix;
        newNumber = `${prefix}${row.id}`;
        let suffix = 2;
        while (await numberInUse(knex, kind, newNumber)) {
          newNumber = `${prefix}${row.id}-${suffix++}`;
        }
      }
      await renameDocument(knex, kind, row.id, row.number, newNumber);
      log.push(
        `${kind.documentType} #${row.id}: "${row.number}" -> "${newNumber}"`,
      );
    }
    if (useSequence) {
      const update = knex('settings').where({
        group: kind.settingsGroup,
        key: 'next_number',
      });
      if (settings.hasNextNumberRow) {
        await update.update({ value: next });
      }
      log.push(
        `${kind.documentType}: next number setting moved on to "${settings.prefix}${next}"`,
      );
    }
  }

  // 3. Other duplicates: the oldest keeps the number.
  const groups: any[] = await knex(table)
    .whereNotNull(column)
    .groupBy(column)
    .havingRaw('COUNT(*) > 1')
    .select(
      knex.raw('GROUP_CONCAT(?? ORDER BY ?? SEPARATOR ?) as ??', [
        'id',
        'id',
        ',',
        'ids',
      ]),
    );
  for (const group of groups) {
    const ids = String(group.ids).split(',').map(Number);
    const rows: any[] = await knex(table)
      .whereIn('id', ids)
      .select('id', knex.raw('?? as ??', [column, 'number']))
      .orderBy('id');
    const [, ...others] = rows;
    let suffix = 2;

    for (const row of others) {
      const base = String(row.number).replace(/\s+$/, '');
      let newNumber = `${base}-${suffix++}`;
      while (await numberInUse(knex, kind, newNumber)) {
        newNumber = `${base}-${suffix++}`;
      }
      await renameDocument(knex, kind, row.id, row.number, newNumber);
      log.push(
        `${kind.documentType} #${row.id}: "${row.number}" -> "${newNumber}" (#${rows[0].id} keeps "${rows[0].number}")`,
      );
    }
  }
};

exports.up = async function (knex: any) {
  const database = knex.client?.config?.connection?.database || 'tenant';
  const log: string[] = [];

  for (const kind of KINDS) {
    if (!(await tableExists(knex, kind.table))) continue;
    await repairKind(knex, kind, log);
  }
  for (const kind of KINDS) {
    if (!(await tableExists(knex, kind.table))) continue;
    const name = indexName(kind.table);
    if (await indexExists(knex, kind.table, name)) continue;

    await knex.raw('ALTER TABLE ?? ADD UNIQUE INDEX ?? (??)', [
      kind.table,
      name,
      kind.column,
    ]);
  }
  if (log.length > 0) {
    console.log(
      `[unique_document_numbers] ${database}: ${log.length} change(s)\n  ${log.join('\n  ')}`,
    );
  }
};

/**
 * Drops the unique indexes. The renumbering is not undone: the old numbers
 * were duplicates or broken (`{}`), and each change was printed when the
 * migration ran.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex: any) {
  for (const kind of KINDS) {
    if (!(await tableExists(knex, kind.table))) continue;
    const name = indexName(kind.table);
    if (!(await indexExists(knex, kind.table, name))) continue;
    await knex.raw('ALTER TABLE ?? DROP INDEX ??', [kind.table, name]);
  }
};
