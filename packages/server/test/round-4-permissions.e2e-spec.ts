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
 *
 * F7: anyone but the owner and admins may only give permissions they hold
 * themselves: Rory (can view and edit roles) and Carl (can create roles and
 * manage users) can't build a near-admin role, and Manny can't give a role
 * with more than he has.
 */
jest.retryTimes(0);

describe('Round 4 users and roles (e2e)', () => {
  let company: Company;
  let db: Knex;
  let priya: Session;
  let ana: Session;
  let manny: Session;
  let rory: Session;
  let carl: Session;
  let staffRoleId: number;
  let managerRoleId: number;
  let roleEditorRoleId: number;
  let roleCreatorRoleId: number;
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
    roleEditorRoleId = await createRole(app, company, 'RoleEditor', [
      { subject: 'Role', ability: 'View' },
      { subject: 'Role', ability: 'Edit' },
    ]);
    roleCreatorRoleId = await createRole(app, company, 'RoleCreator', [
      { subject: 'Role', ability: 'View' },
      { subject: 'Role', ability: 'Create' },
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
      rory: (rory = await invite('rory', roleEditorRoleId)),
      carl: (carl = await invite('carl', roleCreatorRoleId)),
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

  describe('F7: a non-admin may only give permissions they hold themselves', () => {
    const notHeld = (res: request.Response) => {
      expect({ status: res.status, type: errorType(res) }).toEqual({
        status: 400,
        type: 'PERMISSIONS_NOT_HELD',
      });
      expect(res.body.errors[0].message).toBe(
        'You can only give permissions you have yourself.',
      );
    };

    /** The role as the edit form sends it, with extra permissions. */
    const roleBody = async (roleId: number, extra: any[] = []) => {
      const role = await by(priya).get(`/roles/${roleId}`);
      return {
        roleName: role.body.name,
        roleDescription: role.body.description ?? '',
        permissions: [
          ...(role.body.permissions || []).map((p: any) => ({
            permissionId: p.id,
            subject: p.subject,
            ability: p.ability,
            value: !!p.value,
          })),
          ...extra,
        ],
      };
    };

    const permissionsOf = async (roleId: number) =>
      (await db('role_permissions').where({ roleId, value: true }))
        .map((p) => `${p.subject}:${p.ability}`)
        .sort();

    it('a role editor cannot add a permission they lack to another role', async () => {
      const body = await roleBody(staffRoleId, [
        { subject: 'User', ability: 'Manage', value: true },
        { subject: 'Role', ability: 'Edit', value: true },
      ]);
      notHeld(await by(rory).put(`/roles/${staffRoleId}`).send(body));
      expect(await permissionsOf(staffRoleId)).toEqual(['Customer:View']);
    });

    it('a role editor can still edit a role, keeping the permissions it has', async () => {
      const body = await roleBody(staffRoleId);
      body.roleDescription = 'Staff (edited by Rory)';
      const res = await by(rory).put(`/roles/${staffRoleId}`).send(body);
      expect(res.status).toBe(200);
      expect(await permissionsOf(staffRoleId)).toEqual(['Customer:View']);
    });

    it('a role editor can add a permission they hold', async () => {
      const body = await roleBody(staffRoleId, [
        { subject: 'Role', ability: 'View', value: true },
      ]);
      const res = await by(rory).put(`/roles/${staffRoleId}`).send(body);
      expect(res.status).toBe(200);
      expect(await permissionsOf(staffRoleId)).toEqual([
        'Customer:View',
        'Role:View',
      ]);
    });

    it('a role creator cannot create a role with permissions they lack', async () => {
      const roleName = `Everything ${Date.now()}`;
      notHeld(
        await by(carl)
          .post('/roles')
          .send({
            roleName,
            roleDescription: 'near-admin',
            permissions: [
              { subject: 'User', ability: 'Manage', value: true },
              { subject: 'Bill', ability: 'Delete', value: true },
              { subject: 'Role', ability: 'Edit', value: true },
            ],
          }),
      );
      expect(await db('roles').where({ name: roleName })).toHaveLength(0);
    });

    it('a role creator can create a role with permissions they hold', async () => {
      const res = await by(carl)
        .post('/roles')
        .send({
          roleName: `Helper ${Date.now()}`,
          roleDescription: 'subset',
          permissions: [{ subject: 'User', ability: 'Manage', value: true }],
        });
      expect(res.status).toBe(201);
    });

    it('a user manager cannot invite someone with a role that has more than they do', async () => {
      const email = uniqueEmail('wider');
      notHeld(
        await by(manny)
          .patch('/invite')
          .send({ email, roleId: roleCreatorRoleId }),
      );
      expect(await db('users').where({ email })).toHaveLength(0);
    });

    it('a user manager can invite someone with a role within what they have', async () => {
      const res = await by(manny)
        .patch('/invite')
        .send({ email: uniqueEmail('within'), roleId: managerRoleId });
      expect(res.status).toBe(200);
    });

    it('a user manager cannot change someone to a role with more than they have', async () => {
      const sam = await db('users').where({ id: ids.sam }).first();
      notHeld(
        await by(manny)
          .put(`/users/${ids.sam}`)
          .send({
            firstName: sam.firstName ?? 'Sam',
            lastName: sam.lastName ?? 'S',
            email: sam.email,
            roleId: roleCreatorRoleId,
          }),
      );
      expect((await db('users').where({ id: ids.sam }).first()).roleId).toBe(
        staffRoleId,
      );
    });

    it('an admin can create any role and give it', async () => {
      const res = await by(ana)
        .post('/roles')
        .send({
          roleName: `Wide ${Date.now()}`,
          roleDescription: 'by an admin',
          permissions: [
            { subject: 'Bill', ability: 'Delete', value: true },
            { subject: 'User', ability: 'Manage', value: true },
          ],
        });
      expect(res.status).toBe(201);
      const invite = await by(ana)
        .patch('/invite')
        .send({ email: uniqueEmail('wide'), roleId: res.body.data.id });
      expect(invite.status).toBe(200);
    });
  });

  // F28: a user manager without Role View still gets the role list (they
  // pick a role when inviting); staff with neither permission don't.
  describe('F28: the role list for user managers', () => {
    it('a user manager without Role View lists the roles', async () => {
      const res = await by(manny).get('/roles');
      expect(res.status).toBe(200);
      const roles = Array.isArray(res.body) ? res.body : res.body.data;
      expect(roles.map((role: any) => role.id)).toEqual(
        expect.arrayContaining([staffRoleId, managerRoleId]),
      );
    });

    it('a role viewer lists the roles', async () => {
      expect((await by(rory).get('/roles')).status).toBe(200);
    });

    it('staff with neither permission are refused', async () => {
      // Its own role: the F7 tests add permissions to the Staff role.
      const viewerRoleId = await createRole(app, company, 'CustomerViewer', [
        { subject: 'Customer', ability: 'View' },
      ]);
      const sam = await inviteAndAccept(
        app,
        company,
        priya,
        uniqueEmail('sam2'),
        viewerRoleId,
      );
      expect((await by(sam).get('/roles')).status).toBe(403);
    });
  });
});
