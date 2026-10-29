/**
 * Stores the transaction currency amounts of every ledger row next to the
 * base currency ones. Foreign balances (contacts and accounts in another
 * currency) add these up; dividing the cent-rounded base amounts by the rate
 * drifted (a EUR 0.02 invoice at 1.5 paid as 2 x 0.01 left -0.0067 EUR).
 *
 * Backfill: a row at rate 1 is in the base currency, so its foreign amounts
 * are its base amounts. A row at another rate keeps NULL: its document
 * currency amount can't be recovered from the rounded base amount (the
 * division is the bug, and for a rate below 1 several amounts round to the
 * same base amount). Those rows are read as before (base / rate) until the
 * transaction is posted again.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('accounts_transactions', (table) => {
    table.decimal('foreign_credit', 13, 2).nullable().after('debit');
    table.decimal('foreign_debit', 13, 2).nullable().after('foreign_credit');
  });
  await knex('accounts_transactions')
    .where((builder) =>
      builder.where('exchange_rate', 1).orWhereNull('exchange_rate'),
    )
    .update({
      foreign_credit: knex.ref('credit'),
      foreign_debit: knex.ref('debit'),
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('accounts_transactions', (table) => {
    table.dropColumn('foreign_debit');
    table.dropColumn('foreign_credit');
  });
};
