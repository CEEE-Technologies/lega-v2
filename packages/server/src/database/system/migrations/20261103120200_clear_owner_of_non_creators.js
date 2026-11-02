/**
 * Health check H7: the March backfill (20260320000002) made every login
 * with a `tenant_id` an owner of that company, invited members too. Owners
 * are protected from being edited or removed and can delete the workspace.
 *
 * This keeps the owner role only for the person who created each company
 * and makes the others ordinary members, using the same rules as H7
 * (`getOwnerMemberships` in AccountingBasis/DataHealthCheck.ts):
 * - an owner whose user in the company has an invite time was invited;
 * - of the others, the one whose user in the company came first (lowest
 *   id) created the company; an owner with no user in the company comes
 *   last.
 * Every company keeps one owner: if all of its owners look invited, the
 * first of them stays owner (and H7 still lists it, to look at by hand).
 *
 * Only companies with more than one owner can change, so only their
 * databases are opened. A company whose database can't be read is skipped
 * with a warning. No users or memberships are deleted.
 *
 * Safe to re-run: a clean system database changes nothing.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const Knex = require('knex');
const { knexSnakeCaseMappers } = require('objection');

const TAG = '[clear_owner_of_non_creators]';

const tenantKnex = (organizationId) =>
  Knex({
    client: 'mysql',
    connection: {
      host: process.env.TENANT_DB_HOST || process.env.DB_HOST,
      port: process.env.TENANT_DB_PORT || process.env.DB_PORT || 3306,
      user: process.env.TENANT_DB_USER || process.env.DB_USER,
      password: process.env.TENANT_DB_PASSWORD || process.env.DB_PASSWORD,
      database: `${process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_'}${organizationId}`,
      charset: 'utf8',
    },
    pool: { min: 0, max: 1 },
    ...knexSnakeCaseMappers({ upperCase: true }),
  });

/**
 * Which owner created the company: the same order as health check H7.
 * @returns {{ keep: object, clear: object[], allInvited: boolean }}
 */
const pickCreator = (owners, tenantUserBySystemId) => {
  const tenantUserId = (owner) =>
    Number(tenantUserBySystemId.get(owner.userId)?.id ?? Infinity);
  const byFirstUser = (a, b) =>
    tenantUserId(a) - tenantUserId(b) || a.userId - b.userId;

  const candidates = owners
    .filter((owner) => !tenantUserBySystemId.get(owner.userId)?.invitedAt)
    .sort(byFirstUser);
  const allInvited = candidates.length === 0;
  const keep = allInvited ? [...owners].sort(byFirstUser)[0] : candidates[0];

  return {
    keep,
    clear: owners.filter((owner) => owner !== keep),
    allInvited,
  };
};

exports.up = async function (knex) {
  const tenants = await knex('user_tenants')
    .where('role', 'owner')
    .groupBy('tenant_id')
    .havingRaw('COUNT(*) > 1')
    .select('tenant_id as tenantId');

  for (const { tenantId } of tenants) {
    const tenant = await knex('tenants').where('id', tenantId).first();
    if (!tenant?.organizationId) continue;

    const owners = await knex('user_tenants as ut')
      .join('users as u', 'u.id', 'ut.user_id')
      .where('ut.tenant_id', tenantId)
      .where('ut.role', 'owner')
      .select('ut.user_id as userId', 'u.email as email')
      .orderBy('ut.id');
    if (owners.length < 2) continue;

    const tenantDb = tenantKnex(tenant.organizationId);
    let tenantUsers;
    try {
      tenantUsers = await tenantDb('users')
        .whereIn(
          'system_user_id',
          owners.map((owner) => owner.userId),
        )
        .select(
          'id',
          'system_user_id as systemUserId',
          'invited_at as invitedAt',
        );
    } catch (error) {
      console.warn(
        `${TAG} company ${tenant.organizationId} (#${tenantId}) skipped, its database can't be read: ${error.message}`,
      );
      continue;
    } finally {
      await tenantDb.destroy();
    }
    const tenantUserBySystemId = new Map(
      tenantUsers.map((row) => [row.systemUserId, row]),
    );
    const { keep, clear, allInvited } = pickCreator(
      owners,
      tenantUserBySystemId,
    );
    if (clear.length === 0) continue;

    await knex('user_tenants')
      .where('tenant_id', tenantId)
      .where('role', 'owner')
      .whereIn(
        'user_id',
        clear.map((owner) => owner.userId),
      )
      .update({ role: 'member' });

    console.log(
      `${TAG} company ${tenant.organizationId} (#${tenantId}): owner kept ${keep.email} (#${keep.userId}); made members: ${clear
        .map((owner) => `${owner.email} (#${owner.userId})`)
        .join(', ')}`,
    );
    if (allInvited) {
      console.warn(
        `${TAG} company ${tenant.organizationId} (#${tenantId}): every owner looked invited; kept the first one. Check it by hand.`,
      );
    }
  }
};

exports.down = function () {
  // Not reversible: which memberships were changed is only in the log.
  return Promise.resolve();
};

exports.pickCreator = pickCreator;
