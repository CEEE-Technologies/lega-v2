import { ServiceError } from '@/modules/Items/ServiceError';

/**
 * The kinds of payment entry lines. An `invoice` line pays a document (an
 * invoice on a payment received, a bill on a payment made); an
 * `opening_balance` line pays the contact opening balance and has no document.
 */
export const PaymentEntryTypes = {
  Invoice: 'invoice',
  OpeningBalance: 'opening_balance',
} as const;

export type PaymentEntryType =
  (typeof PaymentEntryTypes)[keyof typeof PaymentEntryTypes];

/**
 * Determines whether the given payment entry pays the opening balance.
 */
export const isOpeningBalanceEntry = (entry: {
  entryType?: string | null;
}): boolean => entry?.entryType === PaymentEntryTypes.OpeningBalance;

/**
 * Determines whether the given payment entry pays a document.
 */
export const isDocumentEntry = (entry: {
  entryType?: string | null;
}): boolean => !isOpeningBalanceEntry(entry);

/**
 * Stores the entry type explicitly and clears the document id of opening
 * balance lines.
 * @param {T} entry - Payment entry DTO.
 * @param {string} documentIdKey - `invoiceId` or `billId`.
 */
export const normalizePaymentEntryType = <T extends { entryType?: string }>(
  entry: T,
  documentIdKey: 'invoiceId' | 'billId',
): T => {
  const isOpeningBalance = isOpeningBalanceEntry(entry);

  return {
    ...entry,
    entryType: isOpeningBalance
      ? PaymentEntryTypes.OpeningBalance
      : PaymentEntryTypes.Invoice,
    ...(isOpeningBalance ? { [documentIdKey]: null } : {}),
  };
};

/**
 * Opening balance errors shared by the customer and vendor sides.
 */
export const OPENING_BALANCE_ERRORS = {
  OPENING_BALANCE_NOT_FOUND: 'OPENING_BALANCE_NOT_FOUND',
  OPENING_BALANCE_PAYMENT_EXCEEDS_DUE: 'OPENING_BALANCE_PAYMENT_EXCEEDS_DUE',
  OPENING_BALANCE_ENTRY_DUPLICATE: 'OPENING_BALANCE_ENTRY_DUPLICATE',
  OPENING_BALANCE_BELOW_PAID: 'OPENING_BALANCE_BELOW_PAID',
};

/**
 * Validates a new opening balance is not below what payments already paid
 * of it (those payments would otherwise pay more than is owed).
 * @param {number} openingBalance - The new opening balance.
 * @param {number} paidAmount - The paid part of the opening balance.
 * @throws {ServiceError(OPENING_BALANCE_BELOW_PAID)}
 */
export const validateOpeningBalanceNotBelowPaid = (
  openingBalance: number,
  paidAmount: number,
) => {
  const paid = Math.round(Number(paidAmount || 0) * 1000) / 1000;
  const balance = Math.round(Number(openingBalance || 0) * 1000) / 1000;

  if (paid > 0 && balance < paid) {
    throw new ServiceError(
      OPENING_BALANCE_ERRORS.OPENING_BALANCE_BELOW_PAID,
      `Payments already paid ${paid} of the opening balance; it can't be set to ${balance}.`,
      { paidAmount: paid },
    );
  }
};
