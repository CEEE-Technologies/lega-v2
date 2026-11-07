import * as moment from 'moment';

/**
 * Helpers shared by the data health check sections (DataHealthCheck.ts,
 * H1–H8, and DataHealthCheckRound3.ts, H9–H16).
 */

const LABELS: Record<string, string> = {
  SaleInvoice: 'Invoice',
  SaleEstimate: 'Estimate',
  SaleReceipt: 'Receipt',
  PaymentReceive: 'Payment received',
  CreditNote: 'Credit note',
  RefundCreditNote: 'Credit note refund',
  Bill: 'Bill',
  BillPayment: 'Bill payment',
  VendorCredit: 'Vendor credit',
  RefundVendorCredit: 'Vendor credit refund',
  Expense: 'Expense',
  ManualJournal: 'Manual journal',
  Journal: 'Manual journal',
  BankTransaction: 'Bank transaction',
  CashflowTransaction: 'Bank transaction',
  WarehouseTransfer: 'Warehouse transfer',
  InventoryAdjustment: 'Inventory adjustment',
  LandedCost: 'Landed cost on bill',
  CustomerOpeningBalance: 'Customer opening balance',
  VendorOpeningBalance: 'Supplier opening balance',
};
export const label = (type: string) => LABELS[type] || type;

/** Reads a raw alias whether the mapper camel cased it or not. */
export const pick = (row: any, key: string) =>
  row[key] ?? row[key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())];

export const day = (value: any): string | null =>
  value ? moment(value).format('YYYY-MM-DD') : null;

export const num = (value: any) => Number(value || 0);

/** Quantities are stored with 3 decimals. */
export const QUANTITY_NOISE = 0.0005;
/** Drops float noise from a quantity sum (they aren't money). */
export const roundQuantity = (value: number) =>
  Number(Number(value).toPrecision(12));

export const money = (value: number) =>
  Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
export const qty = (value: number) => `${roundQuantity(value)}`;

/** The ids as #1, #2, ...; long lists are cut (the JSON has them all). */
export const ids = (list: number[], max = 10) =>
  list
    .slice(0, max)
    .map((id) => `#${id}`)
    .join(', ') + (list.length > max ? ` and ${list.length - max} more` : '');

export const INDENT = '      ';

/** A titled section: "  <title>: <count>", then one line each or "none". */
export const section = (lines: string[], title: string, items: string[]) => {
  lines.push(`  ${title}: ${items.length}`);
  if (items.length === 0) lines.push(`${INDENT}none`);
  items.forEach((item) => lines.push(`${INDENT}${item}`));
};

/** Whether a `settings` value turns a feature on (stored as text). */
export const isSettingOn = (value: any) =>
  !['', '0', 'false'].includes(String(value ?? ''));
