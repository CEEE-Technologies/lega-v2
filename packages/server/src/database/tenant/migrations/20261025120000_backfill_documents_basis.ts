/**
 * Tags the GL entries written before the accounting basis column existed.
 *
 * These documents now write an accrual set (and the payments and refunds a
 * cash set besides). Their old entries were stored untagged (NULL), and an
 * untagged entry counts on both bases, so for example the income of an old
 * invoice was reported on the cash basis too, before it was paid.
 *
 * The old entries are the accrual composition of those documents, so they
 * are tagged `accrual`. The cash sets of the old payments and refunds are
 * then written by `tenants:rebuild-cash-basis`.
 *
 * Entries of the other documents (expenses, manual journals, receipts, bank
 * transactions, inventory adjustments, landed costs...) stay untagged: they
 * are cash or non-cash the same way on both bases.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function (knex) {
  return knex('accounts_transactions')
    .whereIn('reference_type', [
      'SaleInvoice',
      'InvoiceWriteOff',
      'CreditNote',
      'RefundCreditNote',
      'PaymentReceive',
      'CustomerOpeningBalance',
      'Bill',
      'VendorCredit',
      'RefundVendorCredit',
      'BillPayment',
      'VendorOpeningBalance',
    ])
    .whereNull('basis')
    .update({ basis: 'accrual' });
};

/**
 * Cannot safely reverse a backfill.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function (_knex) {
  return Promise.resolve();
};
