/**
 * Password reset tokens are now stored as SHA-256 hashes (`token_hash`)
 * instead of plain text (`token`), so someone who can read the database
 * can't use a pending reset link.
 *
 * A plain token can't be turned into a usable hash row here without keeping
 * the plain token, so the pending reset requests are deleted. They expire
 * within a day anyway; anyone with an open link just asks for a new one.
 *
 * Safe to re-run: each step checks the current columns first.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const hasColumn = async (knex, column) => {
  const [rows] = await knex.raw('SHOW COLUMNS FROM ?? LIKE ?', [
    'password_resets',
    column.toUpperCase(),
  ]);
  return rows.length > 0;
};

exports.up = async function (knex) {
  const deleted = await knex('password_resets').delete();
  if (deleted > 0) {
    console.log(
      `[hash_password_reset_tokens] deleted ${deleted} pending reset request(s); users can request a new link.`,
    );
  }
  if (!(await hasColumn(knex, 'token_hash'))) {
    await knex.schema.alterTable('password_resets', (table) => {
      table.string('token_hash', 64).nullable().unique();
    });
  }
  if (await hasColumn(knex, 'token')) {
    // Dropping the column drops its index too.
    await knex.schema.alterTable('password_resets', (table) => {
      table.dropColumn('token');
    });
  }
};

/**
 * Puts the plain `token` column back. Pending (hashed) requests can't be
 * turned back into plain tokens, so they are deleted.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex('password_resets').delete();
  if (!(await hasColumn(knex, 'token'))) {
    await knex.schema.alterTable('password_resets', (table) => {
      table.string('token').index();
    });
  }
  if (await hasColumn(knex, 'token_hash')) {
    await knex.schema.alterTable('password_resets', (table) => {
      table.dropColumn('token_hash');
    });
  }
};
