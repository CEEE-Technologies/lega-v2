import { Knex } from 'knex';

/**
 * The records that point at a contact. A contact with any of them can't be
 * deleted: most have a foreign key to `contacts`, so the delete used to
 * fail with a raw database error (a 500), and journal lines and projects
 * have none, so the delete used to leave them pointing at nothing.
 *
 * The contact's own opening balance is not listed: deleting the contact
 * removes it.
 */
const CONTACT_TRANSACTIONS: Record<
  'customer' | 'vendor',
  Array<{ kind: string; table: string; column: string }>
> = {
  customer: [
    { kind: 'invoices', table: 'sales_invoices', column: 'customer_id' },
    { kind: 'receipts', table: 'sales_receipts', column: 'customer_id' },
    { kind: 'estimates', table: 'sales_estimates', column: 'customer_id' },
    { kind: 'payments', table: 'payment_receives', column: 'customer_id' },
    { kind: 'credit_notes', table: 'credit_notes', column: 'customer_id' },
    { kind: 'expenses', table: 'expenses_transactions', column: 'payee_id' },
    {
      kind: 'manual_journals',
      table: 'manual_journals_entries',
      column: 'contact_id',
    },
    { kind: 'projects', table: 'projects', column: 'contact_id' },
  ],
  vendor: [
    { kind: 'bills', table: 'bills', column: 'vendor_id' },
    { kind: 'payments', table: 'bills_payments', column: 'vendor_id' },
    { kind: 'vendor_credits', table: 'vendor_credits', column: 'vendor_id' },
    { kind: 'expenses', table: 'expenses_transactions', column: 'payee_id' },
    {
      kind: 'manual_journals',
      table: 'manual_journals_entries',
      column: 'contact_id',
    },
  ],
};

/**
 * The kinds of records that point at the contact (for example
 * `['invoices', 'payments']`); empty when it can be deleted.
 * @param {Knex} knex - The tenant connection or transaction.
 * @param {'customer' | 'vendor'} contactService
 * @param {number} contactId
 */
export const getContactTransactionKinds = async (
  knex: Knex,
  contactService: 'customer' | 'vendor',
  contactId: number,
): Promise<string[]> => {
  const kinds: string[] = [];
  for (const { kind, table, column } of CONTACT_TRANSACTIONS[contactService]) {
    const found = await knex
      .queryBuilder()
      .from(table)
      .where(column, contactId)
      .first('id');
    if (found) kinds.push(kind);
  }
  return kinds;
};

/**
 * The message for a contact that has transactions, naming their kinds
 * (e.g. "Vendor has transactions: bills, vendor credits.").
 * @param {string} label - "Customer" or "Vendor".
 * @param {string[]} kinds - From `getContactTransactionKinds`.
 */
export const contactHasTransactionsMessage = (label: string, kinds: string[]) =>
  `${label} has transactions: ${kinds.map((kind) => kind.replace(/_/g, ' ')).join(', ')}.`;
