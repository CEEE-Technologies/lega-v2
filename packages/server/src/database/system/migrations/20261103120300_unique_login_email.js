/**
 * Health check H6 / decision D5 (S1): one login per email.
 *
 * Sign-up, invites and email changes already check that no other login has
 * the email, but two requests at the same moment could still both pass the
 * check. The unique index on `users.email` closes that gap. It compares the
 * way the column's collation does (case and trailing spaces ignored), like
 * health check H6. Deleted logins count too.
 *
 * The index can only be added when no two logins share an email. This
 * migration never deletes or merges logins: if duplicates exist it prints
 * them with a warning and skips the index, so the deploy still succeeds.
 * After the duplicates are sorted out by hand, add the index with:
 *
 *   ALTER TABLE USERS ADD UNIQUE INDEX USERS_EMAIL_UNIQUE (EMAIL);
 *
 * Safe to re-run: an existing index is left as it is.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const INDEX = 'users_email_unique';
const TAG = '[unique_login_email]';

const indexExists = async (knex) => {
  const [rows] = await knex.raw('SHOW INDEX FROM ?? WHERE Key_name = ?', [
    'users',
    INDEX.toUpperCase(),
  ]);
  return rows.length > 0;
};

exports.up = async function (knex) {
  if (await indexExists(knex)) return;

  // Only the duplicated emails; each one's logins are read separately (a
  // GROUP_CONCAT id list can be cut at `group_concat_max_len`).
  const emails = await knex('users')
    .whereNotNull('email')
    .groupBy('email')
    .havingRaw('COUNT(*) > 1')
    .select('email')
    .orderBy('email');
  const duplicates = [];
  for (const { email } of emails) {
    const logins = await knex('users')
      .where('email', email)
      .orderBy('id')
      .select('id');
    duplicates.push({ email, ids: logins.map((login) => login.id) });
  }

  if (duplicates.length > 0) {
    console.warn(
      `${TAG} WARNING: the unique login email index was NOT added: ${duplicates.length} email(s) are used by more than one login. ` +
        `Nothing was changed. Sort these out (health check H6), then run: ` +
        `ALTER TABLE USERS ADD UNIQUE INDEX USERS_EMAIL_UNIQUE (EMAIL);\n  ` +
        duplicates
          .map((row) => `${row.email}: logins #${row.ids.join(', #')}`)
          .join('\n  '),
    );
    return;
  }
  await knex.raw('ALTER TABLE ?? ADD UNIQUE INDEX ?? (??)', [
    'users',
    INDEX,
    'email',
  ]);
};

/**
 * Drops the unique index (logins are not changed).
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  if (!(await indexExists(knex))) return;
  await knex.raw('ALTER TABLE ?? DROP INDEX ??', ['users', INDEX]);
};
