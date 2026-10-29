import { moneyGt, moneyLt, roundMoney } from '@bigcapital/utils';
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
 * Finds the first document (invoice or bill) listed on more than one
 * document line of a payment, with the indexes of those lines.
 * @param {T[]} entries - Payment entries.
 * @param {string} documentIdKey - `invoiceId` or `billId`.
 * @returns {{ id: number; indexes: number[] } | null}
 */
export const findDuplicateDocument = <T extends { entryType?: string | null }>(
  entries: T[],
  documentIdKey: keyof T & string,
): { id: number; indexes: number[] } | null => {
  const linesById = new Map<number, number[]>();
  (entries || []).forEach((entry, index) => {
    const id = entry[documentIdKey] as unknown as number | null | undefined;
    if (!isDocumentEntry(entry) || id === null || id === undefined) return;
    linesById.set(Number(id), [...(linesById.get(Number(id)) || []), index]);
  });
  for (const [id, indexes] of linesById) {
    if (indexes.length > 1) return { id, indexes };
  }
  return null;
};

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
  const paid = roundMoney(paidAmount);
  const balance = roundMoney(openingBalance);

  if (moneyGt(paid, 0) && moneyLt(balance, paid)) {
    throw new ServiceError(
      OPENING_BALANCE_ERRORS.OPENING_BALANCE_BELOW_PAID,
      `Payments already paid ${paid} of the opening balance; it can't be set to ${balance}.`,
      { paidAmount: paid },
    );
  }
};
