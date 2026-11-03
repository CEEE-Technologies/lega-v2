/**
 * The unique index on each document type's number (D5 / P3), added by the
 * tenant migration `20261103120100_unique_document_numbers`. Every index
 * name ends with `_doc_number_unique` so a duplicate-number error can be
 * told apart from other unique indexes.
 */
export const DOCUMENT_NUMBER_INDEX_SUFFIX = '_doc_number_unique';

export const DOCUMENT_NUMBER_INDEXES: Record<string, string> = {
  sales_invoices: 'Invoice',
  sales_estimates: 'Estimate',
  sales_receipts: 'Receipt',
  payment_receives: 'Payment received',
  credit_notes: 'Credit note',
  bills: 'Bill',
  bills_payments: 'Bill payment',
  vendor_credits: 'Vendor credit',
  manual_journals: 'Manual journal',
  warehouses_transfers: 'Warehouse transfer',
  cashflow_transactions: 'Bank transaction',
};

/**
 * The document label of a document number index name ('' when the name is
 * not one of them). Index names come back upper case from the database.
 * @param {string} constraint - e.g. `CREDIT_NOTES_DOC_NUMBER_UNIQUE`.
 */
export const getDocumentNumberIndexLabel = (constraint?: string): string => {
  const name = String(constraint || '').toLowerCase();
  if (!name.endsWith(DOCUMENT_NUMBER_INDEX_SUFFIX)) return '';
  const table = name.slice(0, -DOCUMENT_NUMBER_INDEX_SUFFIX.length);
  return DOCUMENT_NUMBER_INDEXES[table] || '';
};
