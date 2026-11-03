/**
 * Fixes the old landed costs from bills on the cash basis.
 *
 * A landed cost from a bill now writes an accrual set at the bill date and
 * a cash set that follows the payments of the bill it comes from. The ones
 * posted before that have untagged (NULL basis) entries, which count on both
 * bases (20261025120000_backfill_documents_basis left landed costs as they
 * were). Once one of their source bill's payments changed, a cash set was
 * written next to the untagged entries and the cost counted twice on the
 * cash basis.
 *
 * - Landed costs that already have a cash set (counted twice): their
 *   untagged entries are the accrual set, so they are tagged `accrual` here.
 *   That only removes the second count.
 * - The other old landed costs from bills (untagged, no cash set yet) are
 *   left as they are: they still count once on the cash basis (at the bill
 *   date). The cash basis rebuild (CashBasisRebuild.service) tags them and
 *   writes their cash set, unless that would change a locked period; then
 *   they stay untagged, and the company stays flagged until a rebuild can
 *   do them (CashBasisRebuild.processor), so unlocking the period and
 *   restarting finishes them. Tagging them here would drop them from the
 *   cash basis until then.
 *
 * Landed costs from an expense stay untagged: the expense is paid already,
 * so they count the same on both bases (that's how they are still posted).
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
// The flag of 20261101120100_flag_cash_basis_rebuild (CashBasisAutoRebuild).
const LANDED_COSTS_REBUILD_FLAG = {
  group: 'accounting_basis',
  key: 'cash_rebuild_needed',
};

const billLandedCostsIds = (knex) =>
  knex('bill_located_costs')
    .where('from_transaction_type', 'Bill')
    .select('id');

exports.up = async function (knex) {
  // Counted twice: untagged entries next to a cash set. (Read first: MySQL
  // can't update a table while selecting from it.)
  const withCashSet = (
    await knex('accounts_transactions')
      .where('reference_type', 'LandedCost')
      .where('basis', 'cash')
      .whereIn('reference_id', billLandedCostsIds(knex))
      .distinct('reference_id as id')
  ).map((row) => row.id);

  for (let i = 0; i < withCashSet.length; i += 500) {
    await knex('accounts_transactions')
      .where('reference_type', 'LandedCost')
      .whereNull('basis')
      .whereIn('reference_id', withCashSet.slice(i, i + 500))
      .update({ basis: 'accrual' });
  }

  // The others are done by the cash basis rebuild.
  const pending = await knex('accounts_transactions')
    .where('reference_type', 'LandedCost')
    .whereNull('basis')
    .whereIn('reference_id', billLandedCostsIds(knex))
    .first('id');

  if (!pending) return;

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
