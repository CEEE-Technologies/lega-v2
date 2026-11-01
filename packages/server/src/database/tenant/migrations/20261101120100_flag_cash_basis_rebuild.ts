/**
 * Marks the company as needing the cash basis rebuild.
 *
 * The cash basis update tagged the old ledger rows `accrual`
 * (20261025120000_backfill_documents_basis), but the matching cash rows of
 * the old payments and refunds are written by the rebuild, which had to be
 * run by hand. Until it ran, the cash basis reports missed every payment
 * made before the deploy.
 *
 * The server now queues the rebuild on startup for every company with this
 * flag, and clears it once the rebuild checks clean
 * (CashBasisAutoRebuild.service). A company with no payments or refunds has
 * nothing to rebuild and isn't flagged.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const GROUP = 'accounting_basis';
const KEY = 'cash_rebuild_needed';

const DOCUMENT_TABLES = [
  'payment_receives',
  'bills_payments',
  'refund_credit_note_transactions',
  'refund_vendor_credit_transactions',
];

exports.up = async function (knex) {
  let hasDocuments = false;

  for (const table of DOCUMENT_TABLES) {
    const row = await knex(table).first('id');
    if (row) {
      hasDocuments = true;
      break;
    }
  }
  if (!hasDocuments) return;

  const existing = await knex('settings')
    .where({ group: GROUP, key: KEY })
    .first('id');

  if (existing) {
    await knex('settings').where('id', existing.id).update({ value: 'true' });
  } else {
    await knex('settings').insert({ group: GROUP, key: KEY, value: 'true' });
  }
};

/**
 * Removes the flag.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex('settings').where({ group: GROUP, key: KEY }).delete();
};
