/**
 * Stores the transaction currency amounts of every ledger row next to the
 * base currency ones. Foreign balances (contacts and accounts in another
 * currency) add these up; dividing the cent-rounded base amounts by the rate
 * drifted (a EUR 0.02 invoice at 1.5 paid as 2 x 0.01 left -0.0067 EUR).
 *
 * Backfill: a row in the base currency (or with no currency) at rate 1 has
 * its base amounts as its foreign amounts, when they are whole cents. Every
 * other row keeps NULL and is read as before (base / rate) until it is
 * posted again:
 * - a row in another currency, even at rate 1 (EUR at 1): its document
 *   amount can't be recovered from the rounded base amount, and a legacy
 *   0.333 would be cut to 0.33 by the 2-decimal column;
 * - a base row with more decimals than a cent (from before the rounding
 *   fixes), for the same reason.
 * The base currency is the one of the seeded Accounts Receivable account
 * (the tenant metadata lives in the system database); without it only the
 * rows with no currency are filled.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('accounts_transactions', (table) => {
    table.decimal('foreign_credit', 13, 2).nullable().after('debit');
    table.decimal('foreign_debit', 13, 2).nullable().after('foreign_credit');
  });
  const receivable = await knex('accounts')
    .where('slug', 'accounts-receivable')
    .whereNotNull('currency_code')
    .first('currency_code');
  const baseCurrency = receivable?.currencyCode ?? receivable?.currency_code;

  await knex('accounts_transactions')
    .where((builder) =>
      builder.where('exchange_rate', 1).orWhereNull('exchange_rate'),
    )
    .where((builder) => {
      builder.whereNull('currency_code');
      if (baseCurrency) builder.orWhere('currency_code', baseCurrency);
    })
    .whereRaw('ROUND(??, 2) = ??', ['credit', 'credit'])
    .whereRaw('ROUND(??, 2) = ??', ['debit', 'debit'])
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
