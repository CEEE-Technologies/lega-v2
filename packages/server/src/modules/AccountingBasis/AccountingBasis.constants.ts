export const CASH_BASIS_REBUILD_QUEUE = 'cash-basis-rebuild';
export const CASH_BASIS_REBUILD_JOB = 'rebuild-cash-basis';

/**
 * The documents that write a cash basis set besides the accrual set, by the
 * GL reference type, with their table.
 */
export const CASH_BASIS_DOCUMENTS = [
  { referenceType: 'PaymentReceive', table: 'payment_receives' },
  { referenceType: 'BillPayment', table: 'bills_payments' },
  {
    referenceType: 'RefundCreditNote',
    table: 'refund_credit_note_transactions',
  },
  {
    referenceType: 'RefundVendorCredit',
    table: 'refund_vendor_credit_transactions',
  },
] as const;

export type CashBasisReferenceType =
  (typeof CASH_BASIS_DOCUMENTS)[number]['referenceType'];

export interface ICashBasisRebuildJobPayload {
  organizationId: string;
  userId?: number;
}

export interface ICashBasisRebuildResult {
  organizationId: string;
  rebuilt: Record<CashBasisReferenceType, number>;
  orphansRemoved: number;
  failures: { referenceType: string; referenceId: number; error: string }[];
}
