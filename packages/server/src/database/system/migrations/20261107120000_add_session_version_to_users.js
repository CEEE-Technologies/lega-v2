/**
 * Adds a session version to each login. Every sign-in token carries the
 * version it was made with, and a token with an older version is refused.
 * A password reset raises the version, which ends every older session.
 *
 * Existing tokens carry no version and count as version 0, so nobody is
 * signed out by this migration.
 *
 * Safe to re-run: each step checks the current columns first.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('users', 'session_version'))) {
    await knex.schema.alterTable('users', (table) => {
      table.integer('session_version').unsigned().notNullable().defaultTo(0);
    });
  }
};

/**
 * Removes the column. Tokens made after the migration carry a version that
 * is then ignored, so they keep working until they expire.
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  if (await knex.schema.hasColumn('users', 'session_version')) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('session_version');
    });
  }
};
