import request = require('supertest');
import { Knex } from 'knex';
import { app } from './init-app-test';
import {
  ADMIN_ROLE_ID,
  Company,
  Session,
  as,
  createCompany,
  createRole,
  errorType,
  getTenantUserId,
  inviteAndAccept,
  tenantKnex,
  uniqueEmail,
} from './_utils/security';

/**
 * Round 4, users and roles. Everything runs in a new company:
 * owner Priya; Ana and Bea (Admin); Manny (can manage users); Sam and Tom
 * (staff, customer view only).
 *
 * F6: only the owner and admins can deactivate, reactivate or remove an
 * admin. Manny can still do it to staff.
 */
jest.retryTimes(0);

describe('Round 4 users and roles (e2e)', () => {
  let company: Company;
  let db: Knex;
  let priya: Session;
  let ana: Session;
  let manny: Session;
  let staffRoleId: number;
  let managerRoleId: number;
  const ids: Record<string, number> = {};

  const by = (session: Pick<Session, 'token'>) =>
    as(app, session, company.organizationId);

  const adminOnly = (res: request.Response) => {
    expect({ status: res.status, type: errorType(res) }).toEqual({
      status: 400,
      type: 'ADMIN_ONLY',
    });
    expect(res.body.errors[0].message).toBe('Only an admin can do this.');
  };

  const isActive = async (userId: number) =>
    Boolean((await db('users').where({ id: userId }).first())?.active);

  beforeAll(async () => {
    company = await createCompany(app, 'r4perm');
    db = tenantKnex(app, company);
    priya = company.owner;

    staffRoleId = await createRole(app, company, 'Staff', [
      { subject: 'Customer', ability: 'View' },
    ]);
    managerRoleId = await createRole(app, company, 'Manager', [
      { subject: 'User', ability: 'Manage' },
    ]);
    const invite = (label: string, roleId: number) =>
      inviteAndAccept(app, company, priya, uniqueEmail(label), roleId);

    const sessions = {
      ana: (ana = await invite('ana', ADMIN_ROLE_ID)),
      bea: await invite('bea', ADMIN_ROLE_ID),
      manny: (manny = await invite('manny', managerRoleId)),
      sam: await invite('sam', staffRoleId),
      tom: await invite('tom', staffRoleId),
    };
    for (const [name, session] of Object.entries(sessions)) {
      ids[name] = await getTenantUserId(app, company, session.systemUserId);
    }
  }, 600000);

  afterAll(async () => {
    await db?.destroy();
  });

  describe('F6: only the owner and admins can deactivate, reactivate or remove an admin', () => {
    it('a user manager cannot deactivate an admin', async () => {
      adminOnly(await by(manny).put(`/users/${ids.ana}/inactivate`).send());
      expect(await isActive(ids.ana)).toBe(true);
    });

    it('a user manager cannot remove an admin', async () => {
      adminOnly(await by(manny).delete(`/users/${ids.ana}`).send());
      expect(await db('users').where({ id: ids.ana })).toHaveLength(1);
    });

    it('a user manager can deactivate and reactivate staff', async () => {
      const off = await by(manny).put(`/users/${ids.sam}/inactivate`).send();
      expect(off.status).toBe(200);
      expect(await isActive(ids.sam)).toBe(false);
      const on = await by(manny).put(`/users/${ids.sam}/activate`).send();
      expect(on.status).toBe(200);
      expect(await isActive(ids.sam)).toBe(true);
    });

    it('the owner can deactivate an admin; a user manager cannot reactivate them; an admin can', async () => {
      const off = await by(priya).put(`/users/${ids.bea}/inactivate`).send();
      expect(off.status).toBe(200);
      expect(await isActive(ids.bea)).toBe(false);

      adminOnly(await by(manny).put(`/users/${ids.bea}/activate`).send());
      expect(await isActive(ids.bea)).toBe(false);

      const on = await by(ana).put(`/users/${ids.bea}/activate`).send();
      expect(on.status).toBe(200);
      expect(await isActive(ids.bea)).toBe(true);
    });

    it('an admin can deactivate another admin', async () => {
      const off = await by(ana).put(`/users/${ids.bea}/inactivate`).send();
      expect(off.status).toBe(200);
      await by(ana).put(`/users/${ids.bea}/activate`).send();
    });

    it('a user manager can remove staff', async () => {
      const res = await by(manny).delete(`/users/${ids.tom}`).send();
      expect(res.status).toBe(200);
      expect(await db('users').where({ id: ids.tom })).toHaveLength(0);
    });
  });
});
