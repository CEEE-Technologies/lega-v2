import request = require('supertest');
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from './init-app-test';
import {
  ADMIN_ROLE_ID,
  Company,
  PASSWORD,
  Session,
  as,
  createCompany,
  createRole,
  errorType,
  getInviteToken,
  getTenantUserId,
  inviteAndAccept,
  signin,
  systemKnex,
  uniqueEmail,
} from './_utils/security';

// The webhook secret is empty in the local .env; set one for this file.
const LEMON_SECRET = 'e2e-lemon-webhook-secret';
const previousLemonSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
process.env.LEMONSQUEEZY_WEBHOOK_SECRET = LEMON_SECRET;
afterAll(() => {
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = previousLemonSecret;
});

/**
 * Package 1 (security). Every scenario runs in two new companies, so nothing
 * shared is touched:
 * - Company A: owner Priya; Ana (Admin); Nimal (Viewer: balance sheet only);
 *   Kasun (Viewer) and Ruwan (Admin), who also work in Company B.
 * - Company B: owner Bob; Kasun and Ruwan (Staff).
 */
describe('Security and permissions (e2e)', () => {
  let companyA: Company;
  let companyB: Company;
  let priya: Session;
  let ana: Session;
  let nimal: Session;
  let kasun: Session;
  let ruwan: Session;
  let viewerRoleId: number;
  const ids: Record<string, number> = {};

  const inA = (session: Session) => as(app, session, companyA.organizationId);
  const inB = (session: Session) => as(app, session, companyB.organizationId);
  const loginsWithEmail = (email: string) =>
    systemKnex(app)('users').where({ email });

  beforeAll(async () => {
    companyA = await createCompany(app, 'a');
    companyB = await createCompany(app, 'b');
    priya = companyA.owner;

    viewerRoleId = await createRole(app, companyA, 'Viewer', [
      { subject: 'Report', ability: 'read-balance-sheet' },
    ]);
    ana = await inviteAndAccept(
      app,
      companyA,
      priya,
      uniqueEmail('ana'),
      ADMIN_ROLE_ID,
    );
    nimal = await inviteAndAccept(
      app,
      companyA,
      priya,
      uniqueEmail('nimal'),
      viewerRoleId,
    );
    kasun = await inviteAndAccept(
      app,
      companyA,
      priya,
      uniqueEmail('kasun'),
      viewerRoleId,
    );
    ruwan = await inviteAndAccept(
      app,
      companyA,
      priya,
      uniqueEmail('ruwan'),
      ADMIN_ROLE_ID,
    );

    // Kasun and Ruwan already have logins: Company B links them (S1).
    await inviteAndAccept(app, companyB, companyB.owner, kasun.email, 2);
    await inviteAndAccept(app, companyB, companyB.owner, ruwan.email, 2);

    for (const [name, session] of Object.entries({
      priya,
      ana,
      nimal,
      kasun,
      ruwan,
    })) {
      ids[name] = await getTenantUserId(app, companyA, session.systemUserId);
    }
  }, 600000);

  // ---------------------------------------------------------------------
  // S1. User management
  // ---------------------------------------------------------------------
  describe('S1: only "Manage users" can manage users', () => {
    it('a Viewer is refused on every user route', async () => {
      const editPriya = await inA(nimal).put(`/users/${ids.priya}`).send({
        firstName: 'Taken',
        lastName: 'Over',
        email: nimal.email,
        roleId: ADMIN_ROLE_ID,
      });
      expect(editPriya.status).toBe(403);

      const calls = [
        () => inA(nimal).delete(`/users/${ids.priya}`),
        () => inA(nimal).put(`/users/${ids.kasun}/inactivate`),
        () => inA(nimal).put(`/users/${ids.kasun}/activate`),
        () =>
          inA(nimal)
            .patch('/invite')
            .send({ email: uniqueEmail('x'), roleId: 1 }),
        () => inA(nimal).post(`/invite/users/${ids.kasun}/resend`),
        () =>
          inA(nimal)
            .post('/invite/bulk')
            .send({ invites: [{ email: uniqueEmail('y'), roleId: 1 }] }),
      ];
      for (const call of calls) {
        expect((await call()).status).toBe(403);
      }
      // Priya's login is untouched, so a reset link still goes to her.
      const [login] = await loginsWithEmail(priya.email);
      expect(login?.id).toBe(priya.systemUserId);
      expect((await signin(app, priya.email)).status).toBe(201);
    });

    it('a Viewer can still list users', async () => {
      const res = await inA(nimal).get('/users');
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(5);
    });

    it("an Admin can change another user's role but not their email", async () => {
      const changeRole = await inA(ana).put(`/users/${ids.kasun}`).send({
        firstName: 'Kasun',
        lastName: 'P',
        email: kasun.email,
        roleId: 2,
      });
      expect(changeRole.status).toBe(200);

      const changeEmail = await inA(ana)
        .put(`/users/${ids.kasun}`)
        .send({
          firstName: 'Kasun',
          lastName: 'P',
          email: uniqueEmail('k2'),
          roleId: 2,
        });
      expect(changeEmail.status).toBe(400);
      expect(errorType(changeEmail)).toBe('CANNOT_CHANGE_OTHER_USER_EMAIL');
      expect(changeEmail.body.errors[0].message).toBe(
        'You can only change your own email.',
      );
      expect((await loginsWithEmail(kasun.email)).length).toBe(1);

      // Edge: the same email in other letter case is not a change.
      const sameEmail = await inA(ana).put(`/users/${ids.kasun}`).send({
        firstName: 'Kasun',
        lastName: 'P',
        email: kasun.email.toUpperCase(),
        roleId: viewerRoleId,
      });
      expect(sameEmail.status).toBe(200);
      const user = await inA(ana).get(`/users/${ids.kasun}`);
      expect(user.body.email).toBe(kasun.email);
      expect(user.body.role_id).toBe(viewerRoleId);
    });

    it("an Admin's edit of another user doesn't reach their shared login", async () => {
      await inA(ana).put(`/users/${ids.kasun}`).send({
        firstName: 'Renamed',
        lastName: 'InA',
        email: kasun.email,
        roleId: viewerRoleId,
      });
      const [login] = await loginsWithEmail(kasun.email);
      expect(login.firstName).not.toBe('Renamed');
    });

    it('a user can change their own email; it must be unique', async () => {
      const taken = await inA(ana).put(`/users/${ids.ana}`).send({
        firstName: 'Ana',
        lastName: 'A',
        email: kasun.email,
        roleId: ADMIN_ROLE_ID,
      });
      expect(taken.status).toBe(400);
      expect(errorType(taken)).toBe('EMAIL_ALREADY_EXISTS');

      const newEmail = uniqueEmail('ana-new');
      const own = await inA(ana).put(`/users/${ids.ana}`).send({
        firstName: 'Ana',
        lastName: 'A',
        email: newEmail,
        roleId: ADMIN_ROLE_ID,
      });
      expect(own.status).toBe(200);
      expect((await signin(app, newEmail)).status).toBe(201);
      ana.email = newEmail;
    });

    it('nobody but the owner can edit, deactivate or remove the owner', async () => {
      const edit = await inA(ana).put(`/users/${ids.priya}`).send({
        firstName: 'X',
        lastName: 'Y',
        email: priya.email,
        roleId: ADMIN_ROLE_ID,
      });
      expect(edit.status).toBe(400);
      expect(errorType(edit)).toBe('CANNOT_MUTATE_OWNER');

      const deactivate = await inA(ana).put(`/users/${ids.priya}/inactivate`);
      expect(deactivate.status).toBe(400);
      expect(errorType(deactivate)).toBe('CANNOT_MUTATE_OWNER');

      const remove = await inA(ana).delete(`/users/${ids.priya}`);
      expect(remove.status).toBe(400);
      expect(errorType(remove)).toBe('CANNOT_MUTATE_OWNER');

      // The owner can edit themselves.
      const self = await inA(priya).put(`/users/${ids.priya}`).send({
        firstName: 'Priya',
        lastName: 'Owner',
        email: priya.email,
        roleId: ADMIN_ROLE_ID,
      });
      expect(self.status).toBe(200);
    });

    it('nobody can remove themselves', async () => {
      const res = await inA(ana).delete(`/users/${ids.ana}`);
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('USER_SAME_THE_AUTHORIZED_USER');
    });

    it('inviting an email that already has a login links that login', async () => {
      // Kasun was invited to Company B with his existing login.
      expect((await loginsWithEmail(kasun.email)).length).toBe(1);
      const memberships = await systemKnex(app)('user_tenants').where({
        userId: kasun.systemUserId,
      });
      expect(memberships.map((m) => m.tenantId).sort()).toEqual(
        [companyA.tenantId, companyB.tenantId].sort(),
      );
      // His password didn't change.
      expect((await signin(app, kasun.email, PASSWORD)).status).toBe(201);
    });

    it('accepting an invite for an existing login needs its current password', async () => {
      const company = await createCompany(app, 'c');
      const invite = await as(app, company.owner, company.organizationId)
        .patch('/invite')
        .send({ email: nimal.email, roleId: 2 });
      expect(invite.status).toBe(200);
      const token = await getInviteToken(app, nimal.email, company.tenantId);

      const wrong = await request(app.getHttpServer())
        .post(`/invite/accept/${token}`)
        .send({ firstName: 'N', lastName: 'N', password: 'Wrong-Passw0rd!' });
      expect(wrong.status).toBe(400);
      expect(errorType(wrong)).toBe('EXISTING_LOGIN_PASSWORD_MISMATCH');

      const right = await request(app.getHttpServer())
        .post(`/invite/accept/${token}`)
        .send({ firstName: 'N', lastName: 'N', password: PASSWORD });
      expect(right.status).toBe(201);
      expect((await loginsWithEmail(nimal.email)).length).toBe(1);
      expect((await signin(app, nimal.email, PASSWORD)).status).toBe(201);
    });

    it('inviting someone who is already a member is refused', async () => {
      const res = await inA(priya)
        .patch('/invite')
        .send({ email: kasun.email.toUpperCase(), roleId: 2 });
      expect(res.status).toBe(400);
    });

    it('removing a user removes them from this company only', async () => {
      const res = await inA(ana).delete(`/users/${ids.kasun}`);
      expect(res.status).toBe(200);

      // The login stays, with Company B.
      expect((await loginsWithEmail(kasun.email)).length).toBe(1);
      const memberships = await systemKnex(app)('user_tenants').where({
        userId: kasun.systemUserId,
      });
      expect(memberships.map((m) => m.tenantId)).toEqual([companyB.tenantId]);

      const signedIn = await signin(app, kasun.email);
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.organization_id).toBe(companyB.organizationId);
      expect((await inB(kasun).get('/users')).status).toBe(200);
      expect((await inA(kasun).get('/users')).status).toBe(401);

      // Inviting him again links the same login.
      const again = await inviteAndAccept(
        app,
        companyA,
        priya,
        kasun.email,
        viewerRoleId,
      );
      expect(again.systemUserId).toBe(kasun.systemUserId);
      ids.kasun = await getTenantUserId(app, companyA, kasun.systemUserId);
    });
  });

  // ---------------------------------------------------------------------
  // P5. Roles that don't exist
  // ---------------------------------------------------------------------
  describe('P5: a role that does not exist is refused', () => {
    it('invite with a missing role is refused and nothing is saved', async () => {
      const email = uniqueEmail('norole');
      const res = await inA(priya)
        .patch('/invite')
        .send({ email, roleId: 999 });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('ROLE_NOT_FOUND');
      expect(res.body.errors[0].message).toBe('Role not found.');

      const users = await inA(priya).get('/users');
      expect(users.body.find((u) => u.email === email)).toBeUndefined();
      expect((await loginsWithEmail(email)).length).toBe(0);
    });

    it('bulk invite reports the missing role and invites the rest', async () => {
      const good = uniqueEmail('bulk-ok');
      const bad = uniqueEmail('bulk-bad');
      const res = await inA(priya)
        .post('/invite/bulk')
        .send({
          invites: [
            { email: good, roleId: 2 },
            { email: bad, roleId: 999 },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.failed_invites.map((f) => f.email)).toEqual([bad]);
      expect(res.body.invited_users.map((u) => u.email)).toEqual([good]);
    });

    it('edit with a missing role is refused', async () => {
      const res = await inA(priya).put(`/users/${ids.kasun}`).send({
        firstName: 'K',
        lastName: 'K',
        email: kasun.email,
        roleId: 999,
      });
      expect(res.status).toBe(400);
      expect(errorType(res)).toBe('ROLE_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------
  // S2. Route permissions
  // ---------------------------------------------------------------------
  describe('S2: routes check the role', () => {
    let customer: request.Response;
    let vendor: request.Response;

    it('a Viewer is refused on the dangerous routes', async () => {
      customer = await inA(priya).post('/customers').send({
        displayName: 'Acme',
        customerType: 'business',
        currencyCode: 'USD',
      });
      vendor = await inA(priya)
        .post('/vendors')
        .send({ displayName: 'Supplies Co', currencyCode: 'USD' });
      expect(customer.status).toBe(201);
      expect(vendor.status).toBe(201);

      const calls: Array<[string, () => request.Test]> = [
        [
          'unlock period',
          () => inA(nimal).put('/transactions-locking/cancel-lock').send({}),
        ],
        [
          'lock period',
          () => inA(nimal).put('/transactions-locking/lock').send({}),
        ],
        [
          'delete bank transaction',
          () => inA(nimal).delete('/banking/transactions/1'),
        ],
        ['bank rules', () => inA(nimal).get('/banking/rules')],
        [
          'organization settings',
          () => inA(nimal).put('/organization').send({}),
        ],
        ['import', () => inA(nimal).post('/import/file')],
        [
          'import mapping',
          () => inA(nimal).post('/import/abc/mapping').send({}),
        ],
        ['export', () => inA(nimal).get('/export')],
        ['create receipt', () => inA(nimal).post('/sale-receipts').send({})],
        ['edit receipt', () => inA(nimal).put('/sale-receipts/1').send({})],
        ['delete receipt', () => inA(nimal).delete('/sale-receipts/1')],
        ['close receipt', () => inA(nimal).post('/sale-receipts/1/close')],
        [
          'bulk delete receipts',
          () =>
            inA(nimal)
              .post('/sale-receipts/bulk-delete')
              .send({ ids: [1] }),
        ],
        [
          'create API key',
          () => inA(nimal).post('/api-keys/generate').send({ name: 'mine' }),
        ],
        ['list API keys', () => inA(nimal).get('/api-keys')],
        ['subscription', () => inA(nimal).post('/subscription/cancel')],
        ['create branch', () => inA(nimal).post('/branches').send({})],
        ['edit currency', () => inA(nimal).put('/currencies/1').send({})],
        [
          'send invoice mail',
          () => inA(nimal).post('/sale-invoices/1/mail').send({}),
        ],
        [
          'transactions by reference',
          () => inA(nimal).get('/reports/transactions-by-reference'),
        ],
        [
          'deactivate customer',
          () => inA(nimal).patch(`/contacts/${customer.body.id}/inactivate`),
        ],
        [
          'deactivate vendor',
          () => inA(nimal).patch(`/contacts/${vendor.body.id}/inactivate`),
        ],
        [
          'customer details',
          () => inA(nimal).get(`/contacts/${customer.body.id}`),
        ],
      ];
      const allowed: string[] = [];
      for (const [name, call] of calls) {
        const res = await call();
        if (res.status !== 403) allowed.push(`${name}: ${res.status}`);
      }
      expect(allowed).toEqual([]);
    });

    it('a Viewer can still read what every screen needs, and their reports', async () => {
      for (const url of [
        '/currencies',
        '/dashboard/boot',
        '/settings',
        '/organization/current',
        '/views/resource/SaleInvoice',
        '/branches',
        '/warehouses',
        '/reports/balance-sheet',
      ]) {
        const res = await inA(nimal).get(url);
        expect([url, res.status]).toEqual([url, 200]);
      }
    });

    it('an Admin can still use them', async () => {
      const key = await inA(ana)
        .post('/api-keys/generate')
        .send({ name: 'ana' });
      expect(key.status).toBe(201);
      expect((await inA(ana).get('/api-keys')).status).toBe(200);

      const lock = await inA(ana)
        .put('/transactions-locking/lock')
        .send({ module: 'all', lockToDate: '2020-01-31', reason: 'Closed' });
      expect(lock.status).toBe(200);
      const unlock = await inA(ana)
        .put('/transactions-locking/cancel-lock')
        .send({ module: 'all', reason: 'Reopen' });
      expect(unlock.status).toBe(200);

      // Past the permission check (refused by validation, not by role).
      expect((await inA(ana).post('/sale-receipts').send({})).status).toBe(400);
      expect((await inA(ana).get('/banking/rules')).status).toBe(200);
    });

    it('contacts check the customer or vendor permission, whichever it is', async () => {
      const roleId = await createRole(app, companyA, 'Vendors', [
        { subject: 'Vendor', ability: 'View' },
        { subject: 'Vendor', ability: 'Edit' },
      ]);
      const buyer = await inviteAndAccept(
        app,
        companyA,
        priya,
        uniqueEmail('buyer'),
        roleId,
      );
      const vendorRes = await inA(buyer).patch(
        `/contacts/${vendor.body.id}/inactivate`,
      );
      expect(vendorRes.status).toBe(200);
      const customerRes = await inA(buyer).patch(
        `/contacts/${customer.body.id}/inactivate`,
      );
      expect(customerRes.status).toBe(403);
      expect(
        (await inA(ana).patch(`/contacts/${customer.body.id}/inactivate`))
          .status,
      ).toBe(200);
    });

    it('a role saved with Cash flow permissions can use banking', async () => {
      const roleId = await createRole(app, companyA, 'Banking', [
        { subject: 'Cashflow', ability: 'View' },
        { subject: 'Cashflow', ability: 'Create' },
      ]);
      const teller = await inviteAndAccept(
        app,
        companyA,
        priya,
        uniqueEmail('teller'),
        roleId,
      );
      expect((await inA(teller).get('/banking/rules')).status).toBe(200);
      expect((await inA(teller).get('/banking/accounts')).status).toBe(200);
      // Past the permission check (refused by validation, not by role).
      expect((await inA(teller).post('/banking/rules').send({})).status).toBe(
        400,
      );
      // No Cash flow delete.
      expect((await inA(teller).delete('/banking/rules/1')).status).toBe(403);
      expect((await inA(nimal).get('/banking/rules')).status).toBe(403);
    });

    it('a role saved with Warehouses edit can edit a warehouse', async () => {
      expect(
        (await inA(priya).post('/warehouses/activate')).status,
      ).toBeLessThan(300);
      const warehouses = await inA(priya).get('/warehouses');
      const warehouse = warehouses.body[0];
      expect(warehouse?.id).toBeTruthy();

      const roleId = await createRole(app, companyA, 'Stores', [
        { subject: 'Warehouse', ability: 'View' },
        { subject: 'Warehouse', ability: 'Edit' },
      ]);
      const keeper = await inviteAndAccept(
        app,
        companyA,
        priya,
        uniqueEmail('keeper'),
        roleId,
      );
      const edit = await inA(keeper)
        .put(`/warehouses/${warehouse.id}`)
        .send({ name: 'Main store', code: warehouse.code || 'MAIN' });
      expect(edit.status).toBe(200);
      expect(
        (await inA(keeper).delete(`/warehouses/${warehouse.id}`)).status,
      ).toBe(403);
      expect(
        (await inA(nimal).put(`/warehouses/${warehouse.id}`).send({})).status,
      ).toBe(403);
    });

    it('every permission a guarded route needs can be saved on a role', async () => {
      const roleId = await createRole(app, companyA, 'Everything', [
        { subject: 'Cashflow', ability: 'Delete' },
        { subject: 'Preferences', ability: 'Mutate' },
        { subject: 'Warehouse', ability: 'Delete' },
        { subject: 'TaxRate', ability: 'View' },
        { subject: 'SaleInvoice', ability: 'Writeoff' },
        { subject: 'SaleInvoice', ability: 'NotifyBySms' },
        { subject: 'SaleEstimate', ability: 'NotifyBySms' },
        { subject: 'SaleReceipt', ability: 'NotifyBySms' },
        { subject: 'PaymentReceive', ability: 'NotifyBySms' },
        { subject: 'User', ability: 'Manage' },
      ]);
      expect(roleId).toBeTruthy();
    });

    it('a role with only receipt permissions can use receipts', async () => {
      const roleId = await createRole(app, companyA, 'Receipts', [
        { subject: 'SaleReceipt', ability: 'View' },
        { subject: 'SaleReceipt', ability: 'Create' },
      ]);
      const clerk = await inviteAndAccept(
        app,
        companyA,
        priya,
        uniqueEmail('clerk'),
        roleId,
      );
      expect((await inA(clerk).get('/sale-receipts')).status).toBe(200);
      expect((await inA(clerk).post('/sale-receipts').send({})).status).toBe(
        400,
      );
      expect((await inA(clerk).delete('/sale-receipts/1')).status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------
  // S3. Deactivated users
  // ---------------------------------------------------------------------
  describe('S3: a deactivated user is blocked in that company only', () => {
    let apiKey: string;

    beforeAll(async () => {
      const res = await inA(ruwan)
        .post('/api-keys/generate')
        .send({ name: 'ruwan' });
      apiKey = res.body.key;
    });
    const withApiKey = (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${apiKey}`);

    it('works before deactivation, also with an API key', async () => {
      expect(apiKey).toBeTruthy();
      expect((await inA(ruwan).get('/users')).status).toBe(200);
      expect((await withApiKey('/users')).status).toBe(200);
    });

    it('after deactivation every request to that company is refused', async () => {
      expect(
        (await inA(ana).put(`/users/${ids.ruwan}/inactivate`)).status,
      ).toBe(200);

      const res = await inA(ruwan).get('/users');
      expect(res.status).toBe(401);
      expect(res.body.message).toBe(
        'Your access to this organization has been deactivated.',
      );
      expect((await withApiKey('/users')).status).toBe(401);
      expect((await withApiKey('/items')).status).toBe(401);

      // The shared login stays active (D4).
      const [login] = await loginsWithEmail(ruwan.email);
      expect(Boolean(login.active)).toBe(true);
    });

    it('other companies still work, and sign-in opens one of them', async () => {
      expect((await inB(ruwan).get('/users')).status).toBe(200);
      const signedIn = await signin(app, ruwan.email);
      expect(signedIn.status).toBe(201);
      expect(signedIn.body.organization_id).toBe(companyB.organizationId);
    });

    it('reactivating restores access', async () => {
      expect((await inA(ana).put(`/users/${ids.ruwan}/activate`)).status).toBe(
        200,
      );
      expect((await inA(ruwan).get('/users')).status).toBe(200);
      expect((await withApiKey('/users')).status).toBe(200);
      const signedIn = await signin(app, ruwan.email);
      expect(signedIn.body.organization_id).toBe(companyA.organizationId);
    });

    it('a removed user cannot use their API key any more', async () => {
      expect((await inA(ana).delete(`/users/${ids.ruwan}`)).status).toBe(200);
      expect((await withApiKey('/users')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------
  // S5. Import mapping is separated by company
  // ---------------------------------------------------------------------
  describe('S5: import mappings are separated by company', () => {
    let importIdB: string;

    beforeAll(async () => {
      // main.ts sets the static folder; the test app doesn't.
      const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lega-e2e-'));
      fs.mkdirSync(path.join(staticDir, 'imports'));
      (global as any).__static_dirname ??= staticDir;

      const upload = await inB(companyB.owner)
        .post('/import/file')
        .field('resource', 'customers')
        .attach(
          'file',
          Buffer.from('Display Name,Email\nAcme,acme@example.com\n'),
          'customers.csv',
        );
      importIdB = upload.body.import.import_id;
    });

    it("another company's import reference is not found", async () => {
      expect(importIdB).toBeTruthy();
      const res = await inA(priya)
        .post(`/import/${importIdB}/mapping`)
        .send({ mapping: [{ from: 'Display Name', to: 'displayName' }] });
      expect(res.status).toBe(404);

      const row = await systemKnex(app)('imports')
        .where({ importId: importIdB })
        .first();
      expect(row.mapping).toBeFalsy();
    });

    it('the owning company can still map its import', async () => {
      const res = await inB(companyB.owner)
        .post(`/import/${importIdB}/mapping`)
        .send({ mapping: [] });
      expect(res.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // P9. Lemon Squeezy webhooks
  // ---------------------------------------------------------------------
  describe('P9: Lemon Squeezy payment notices', () => {
    const sign = (body: string) =>
      createHmac('sha256', LEMON_SECRET).update(body).digest('hex');
    const send = (body: string, signature?: string) => {
      const req = request(app.getHttpServer())
        .post('/webhooks/lemon')
        .set('Content-Type', 'application/json');
      if (signature !== undefined) req.set('X-Signature', signature);
      return req.send(body);
    };
    const paymentEvent = (tenantId: number) =>
      JSON.stringify({
        meta: {
          event_name: 'subscription_payment_success',
          custom_data: { tenant_id: String(tenantId), user_id: '1' },
        },
        data: { id: '1', attributes: { status: 'paid' } },
      });
    const paymentStatus = async (tenantId: number) =>
      (
        await systemKnex(app)('subscription_plan_subscriptions')
          .where({ tenantId, slug: 'main' })
          .first()
      )?.paymentStatus;

    it('is refused without a valid signature', async () => {
      const body = paymentEvent(companyA.tenantId);
      expect((await send(body)).status).toBe(400);
      expect((await send(body, 'a'.repeat(64))).status).toBe(400);
      const short = await send(body, 'abc');
      expect(short.status).toBe(400);
      expect(short.body.message).toBe('Invalid signature');
    });

    it('a signed notice is processed for the right company', async () => {
      const before = await paymentStatus(companyB.tenantId);
      const body = paymentEvent(companyA.tenantId);
      const res = await send(body, sign(body));
      expect(res.status).toBe(200);
      expect(await paymentStatus(companyA.tenantId)).toBe('succeed');
      expect(await paymentStatus(companyB.tenantId)).toBe(before);
    });

    it('a signed notice for an unknown company is refused', async () => {
      const body = paymentEvent(999999999);
      expect((await send(body, sign(body))).status).toBe(400);
    });

    it('signed notices that need no change are acknowledged', async () => {
      const body = JSON.stringify({
        meta: { event_name: 'order_created' },
        data: {},
      });
      expect((await send(body, sign(body))).status).toBe(200);
    });
  });
});
