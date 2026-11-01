/**
 * Tags the GL entries of the old landed costs from bills `accrual`.
 *
 * A landed cost from a bill now writes an accrual set at the bill date and
 * a cash set that follows the payments of the bill it comes from. The ones
 * posted before that have untagged (NULL basis) entries, which count on both
 * bases (20261025120000_backfill_documents_basis left landed costs as they
 * were). Once one of their source bill's payments changed, a cash set was
 * written next to the untagged entries and the cost counted twice on the
 * cash basis.
 *
 * Their old entries are the accrual composition, so they are tagged
 * `accrual`. Landed costs from an expense stay untagged: the expense is paid
 * already, so they count the same on both bases (that's how they are still
 * posted).
 *
 * The cash sets of the old landed costs whose source bill has payments are
 * written by the cash basis rebuild (CashBasisRebuild.service), so the
 * company is flagged for it and the server queues it on startup
 * (CashBasisAutoRebuild.service).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
// The flag of 20261101120100_flag_cash_basis_rebuild (CashBasisAutoRebuild).
const LANDED_COSTS_REBUILD_FLAG = {
  group: 'accounting_basis',
  key: 'cash_rebuild_needed',
};

exports.up = async function (knex) {
  const tagged = await knex('accounts_transactions')
    .where('reference_type', 'LandedCost')
    .whereNull('basis')
    .whereIn(
      'reference_id',
      knex('bill_located_costs')
        .where('from_transaction_type', 'Bill')
        .select('id'),
    )
    .update({ basis: 'accrual' });

  if (!tagged) return;

  const paidSource = await knex('bill_located_costs as lc')
    .join('bills_payments_entries as e', 'e.bill_id', 'lc.from_transaction_id')
    .where('lc.from_transaction_type', 'Bill')
    .first('lc.id');

  if (!paidSource) return;

  const existing = await knex('settings')
    .where(LANDED_COSTS_REBUILD_FLAG)
    .first('id');

  if (existing) {
    await knex('settings').where('id', existing.id).update({ value: 'true' });
  } else {
    await knex('settings').insert({
      ...LANDED_COSTS_REBUILD_FLAG,
      value: 'true',
    });
  }
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
