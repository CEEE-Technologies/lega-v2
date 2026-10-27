/**
 * Lets payments apply money to the contact opening balance as an explicit
 * open item:
 * - `entry_type` on the payment entries: 'invoice' lines (an invoice or a
 *   bill) keep their document id, 'opening_balance' lines have none.
 * - `opening_balance_payment_amount` on the contacts: how much of the
 *   opening balance the payments paid (like a document's payment amount).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.table('payment_receives_entries', (table) => {
    table.string('entry_type', 30).notNullable().defaultTo('invoice');
  });
  await knex.schema.table('bills_payments_entries', (table) => {
    table.string('entry_type', 30).notNullable().defaultTo('invoice');
  });
  await knex.schema.table('contacts', (table) => {
    table
      .decimal('opening_balance_payment_amount', 13, 3)
      .notNullable()
      .defaultTo(0);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.table('payment_receives_entries', (table) => {
    table.dropColumn('entry_type');
  });
  await knex.schema.table('bills_payments_entries', (table) => {
    table.dropColumn('entry_type');
  });
  await knex.schema.table('contacts', (table) => {
    table.dropColumn('opening_balance_payment_amount');
  });
};
