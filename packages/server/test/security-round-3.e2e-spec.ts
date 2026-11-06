import request = require('supertest');
import { createHash, createHmac } from 'crypto';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Knex } from 'knex';
import { ConfigService } from '@nestjs/config';
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
  getTenantUserId,
  inviteAndAccept,
  signin,
  systemKnex,
  tenantKnex,
  uniqueEmail,
} from './_utils/security';
import { StripePaymentService } from '../src/modules/StripePayment/StripePaymentService';
import { SocketGateway } from '../src/modules/Socket/Socket.gateway';

// The socket client is a webapp dependency; the server tests borrow it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { io: ioClient } = require(
  require.resolve('socket.io-client', {
    paths: [path.join(__dirname, '../../webapp')],
  }),
);

// The Stripe webhook secret is empty in the local .env; set one for this file.
const STRIPE_SECRET = 'whsec_e2e_security_round_3';
const previousStripeSecret = process.env.STRIPE_PAYMENT_WEBHOOKS_SECRET;
process.env.STRIPE_PAYMENT_WEBHOOKS_SECRET = STRIPE_SECRET;
afterAll(() => {
  process.env.STRIPE_PAYMENT_WEBHOOKS_SECRET = previousStripeSecret;
});

// These tests change state, so a retry would not test the same thing.
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signs a Stripe webhook body the way Stripe does. */
const stripeSignature = (payload: string) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', STRIPE_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
};

const sendStripeEvent = (event: Record<string, any>) => {
  const payload = JSON.stringify(event);
  return request(app.getHttpServer())
    .post('/webhooks/stripe')
    .set('stripe-signature', stripeSignature(payload))
    .set('Content-Type', 'application/json')
    .send(payload);
};

/**
 * Package 3 (security round 3). Everything runs in new companies:
 * - Company A: owner Priya; Ana (Admin); Manny (can manage users);
 *   Rory (can edit roles); Nina (no report access); Kasun (balance sheet).
 * - Company M: owner Mo; Mallory (Admin in M, but A is her sign-up company).
 */
describe('Security round 3 (e2e)', () => {
  let companyA: Company;
  let companyM: Company;
  let dbA: Knex;
  let dbM: Knex;
  let priya: Session;
  let ana: Session;
  let manny: Session;
  let rory: Session;
  let nina: Session;
  let kasun: Session;
  let mallory: Session;
  let balanceSheetRoleId: number;
  let noReportsRoleId: number;
  let managerRoleId: number;
  let roleEditorRoleId: number;
  const ids: Record<string, number> = {};

  const inA = (session: Pick<Session, 'token'>) =>
    as(app, session, companyA.organizationId);
  const inM = (session: Pick<Session, 'token'>) =>
    as(app, session, companyM.organizationId);
  const sys = () => systemKnex(app);

  beforeAll(async () => {
    companyA = await createCompany(app, 'r3a');
    companyM = await createCompany(app, 'r3m');
    dbA = tenantKnex(app, companyA);
    dbM = tenantKnex(app, companyM);
    priya = companyA.owner;

    balanceSheetRoleId = await createRole(app, companyA, 'BalanceSheet', [
      { subject: 'Report', ability: 'read-balance-sheet' },
    ]);
    noReportsRoleId = await createRole(app, companyA, 'NoReports', [
      { subject: 'Customer', ability: 'View' },
    ]);
    managerRoleId = await createRole(app, companyA, 'Manager', [
      { subject: 'User', ability: 'Manage' },
    ]);
    roleEditorRoleId = await createRole(app, companyA, 'RoleEditor', [
      { subject: 'Role', ability: 'View' },
      { subject: 'Role', ability: 'Edit' },
    ]);
    const invite = (label: string, roleId: number) =>
      inviteAndAccept(app, companyA, priya, uniqueEmail(label), roleId);

    ana = await invite('ana', ADMIN_ROLE_ID);
    manny = await invite('manny', managerRoleId);
    rory = await invite('rory', roleEditorRoleId);
    nina = await invite('nina', noReportsRoleId);
    kasun = await invite('kasun', balanceSheetRoleId);
    // Mallory's first company is A, so A is her sign-up company.
    mallory = await invite('mallory', noReportsRoleId);
    // Company M then makes her an Admin there.
    await inviteAndAccept(
      app,
      companyM,
      companyM.owner,
      mallory.email,
      ADMIN_ROLE_ID,
    );
    for (const [name, session] of Object.entries({
      priya,
      ana,
      manny,
      rory,
      nina,
      kasun,
      mallory,
    })) {
      ids[name] = await getTenantUserId(app, companyA, session.systemUserId);
    }
  }, 600000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await dbA?.destroy();
    await dbM?.destroy();
  });

  // ---------------------------------------------------------------------
  // S6. Invites go to the company they were sent from
  // ---------------------------------------------------------------------
  describe('S6: an invite lands in the company it was sent from', () => {
    it('an invite from M is recorded against M, and accepting it joins M only', async () => {
      const [login] = await sys()('users').where({ id: mallory.systemUserId });
      expect(login.tenantId).toBe(companyA.tenantId);

      const sockEmail = uniqueEmail('sock');
      const invite = await inM(mallory)
        .patch('/invite')
        .send({ email: sockEmail, roleId: ADMIN_ROLE_ID });
      expect(invite.status).toBe(200);

      const rows = await sys()('user_invites').where({ email: sockEmail });
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(companyM.tenantId);

      const accept = await request(app.getHttpServer())
        .post(`/invite/accept/${rows[0].token}`)
        .send({ firstName: 'Sock', lastName: 'Puppet', password: PASSWORD });
      expect(accept.status).toBeLessThan(300);

      const [sock] = await sys()('users').where({ email: sockEmail });
      const memberships = await sys()('user_tenants').where({
        userId: sock.id,
      });
      expect(memberships.map((m) => m.tenantId)).toEqual([companyM.tenantId]);

      // M's Users page shows them as accepted; A doesn't know them.
      const usersM = await inM(companyM.owner).get('/users');
      const sockInM = usersM.body.find((u: any) => u.email === sockEmail);
      expect(sockInM?.system_user_id).toBe(sock.id);
      expect(sockInM?.invite_accepted_at).toBeTruthy();
      expect(await dbA('users').where({ email: sockEmail })).toHaveLength(0);
    });

    it('a resend from M is recorded against M too', async () => {
      const email = uniqueEmail('resend');
      const invite = await inM(mallory)
        .patch('/invite')
        .send({ email, roleId: ADMIN_ROLE_ID });
      expect(invite.status).toBe(200);
      const userId = invite.body.data?.id ?? invite.body.id;
      const tenantUser = await dbM('users').where({ email }).first();
      // Resends are throttled to one every 5 minutes.
      await dbM('users')
        .where({ id: tenantUser.id })
        .update({ invitedAt: new Date(Date.now() - 10 * 60 * 1000) });

      const resend = await inM(mallory).post(
        `/invite/users/${userId ?? tenantUser.id}/resend`,
      );
      expect(resend.status).toBeLessThan(300);

      const rows = await sys()('user_invites').where({ email });
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(companyM.tenantId);
    });

    it('an old invite to a company with no user record is refused and adds nobody', async () => {
      const email = uniqueEmail('stale');
      const invite = await inM(mallory)
        .patch('/invite')
        .send({ email, roleId: ADMIN_ROLE_ID });
      expect(invite.status).toBe(200);
      // An invite sent before the fix points at the sender's first company.
      await sys()('user_invites')
        .where({ email })
        .update({ tenantId: companyA.tenantId });
      const [row] = await sys()('user_invites').where({ email });

      const accept = await request(app.getHttpServer())
        .post(`/invite/accept/${row.token}`)
        .send({ firstName: 'Stale', lastName: 'Invite', password: PASSWORD });
      expect(accept.status).toBe(400);
      expect(errorType(accept)).toBe('INVITE_TOKEN_INVALID');

      const [login] = await sys()('users').where({ email });
      const memberships = await sys()('user_tenants').where({
        userId: login.id,
      });
      expect(memberships).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------
  // S7. Stripe payment notices
  // ---------------------------------------------------------------------
  describe('S7: the Stripe payment notice is checked before it is recorded', () => {
    const ACCOUNT_A = 'acct_e2e_company_a';
    let invoiceId: number;
    let checkout: { id: string; metadata: Record<string, any> };

    const completedEvent = (overrides: {
      account?: string;
      currency?: string;
      metadata?: Record<string, any>;
      id?: string;
    }) => ({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      object: 'event',
      type: 'checkout.session.completed',
      account: overrides.account ?? ACCOUNT_A,
      data: {
        object: {
          id: overrides.id ?? checkout.id,
          object: 'checkout.session',
          amount_total: 1500,
          currency: overrides.currency ?? 'usd',
          payment_status: 'paid',
          metadata: overrides.metadata ?? checkout.metadata,
        },
      },
    });
    const paidAmount = async () => {
      const res = await inA(priya).get(`/sale-invoices/${invoiceId}`);
      return Number(res.body.payment_amount ?? res.body.paymentAmount);
    };

    beforeAll(async () => {
      const [integrationId] = await dbA('payment_integrations').insert({
        name: 'Stripe A',
        service: 'Stripe',
        accountId: ACCOUNT_A,
        paymentEnabled: true,
        payoutEnabled: true,
      });
      const income = await dbA('accounts')
        .where('accountType', 'income')
        .first('id');
      const customer = await inA(priya)
        .post('/customers')
        .send({
          displayName: `Stripe customer ${Date.now()}`,
          customerType: 'business',
          currencyCode: 'USD',
        });
      const item = await inA(priya)
        .post('/items')
        .send({
          name: `Stripe service ${Date.now()}`,
          type: 'service',
          sellable: true,
          sellAccountId: income.id,
          sellPrice: 15,
        });
      const invoice = await inA(priya)
        .post('/sale-invoices')
        .send({
          customerId: customer.body.id,
          invoiceDate: '2026-11-01',
          dueDate: '2026-11-30',
          delivered: true,
          entries: [{ index: 1, itemId: item.body.id, quantity: 1, rate: 15 }],
          paymentMethods: [
            { paymentIntegrationId: integrationId, enable: true },
          ],
        });
      expect({ status: invoice.status, body: invoice.body }).toMatchObject({
        status: 201,
      });
      invoiceId = invoice.body.id;

      // The customer opens the payment link and starts a checkout.
      const link = await inA(priya).post(
        `/sale-invoices/${invoiceId}/generate-link`,
      );
      const linkId = link.body.link.split('/payment/')[1];
      const sessions = app.get(StripePaymentService).stripe.checkout.sessions;
      const create = jest
        .spyOn(sessions, 'create')
        .mockImplementation(async (params: any) => {
          checkout = { id: 'cs_test_e2e_round3', metadata: params.metadata };
          return { id: checkout.id, url: 'https://checkout.example' } as any;
        });
      const started = await inA(priya).post(
        `/payment-links/${linkId}/stripe_checkout_session`,
      );
      create.mockRestore();
      expect(started.status).toBeLessThan(300);
      expect(checkout.metadata.saleInvoiceId).toBe(invoiceId);

      // The Stripe clearing account exists already. When the payment has to
      // create it, the save fails today: that is B7, fixed in Package 2.
      const clearing = await dbA('accounts')
        .where({ slug: 'stripe-clearing' })
        .first();
      if (!clearing) {
        await dbA('accounts').insert({
          name: 'Stripe Clearing',
          slug: 'stripe-clearing',
          accountType: 'other-current-asset',
          code: '100020',
          currencyCode: 'USD',
          active: true,
          index: 1,
          predefined: true,
        });
      }
    });

    it('a notice from another Stripe account is ignored', async () => {
      const res = await sendStripeEvent(
        completedEvent({ account: 'acct_someone_else' }),
      );
      expect(res.status).toBe(200);
      expect(await paidAmount()).toBe(0);
    });

    it('a checkout this invoice never started is ignored', async () => {
      const forged = {
        saleInvoiceId: invoiceId,
        tenantId: companyA.tenantId,
        resource: 'SaleInvoice',
      };
      const res = await sendStripeEvent(
        completedEvent({ id: 'cs_forged', metadata: forged }),
      );
      expect(res.status).toBe(200);
      expect(await paidAmount()).toBe(0);
    });

    it('a notice in the wrong currency is ignored', async () => {
      const res = await sendStripeEvent(completedEvent({ currency: 'eur' }));
      expect(res.status).toBe(200);
      expect(await paidAmount()).toBe(0);
    });

    it('the real notice is recorded once', async () => {
      const event = completedEvent({});
      const res = await sendStripeEvent(event);
      expect(res.status).toBe(200);
      expect(await paidAmount()).toBe(15);

      // Stripe sends the same notice again when unsure it arrived.
      const again = await sendStripeEvent(event);
      expect(again.status).toBe(200);
      expect(await paidAmount()).toBe(15);
    });
  });

  // ---------------------------------------------------------------------
  // S8. Stripe connect state
  // ---------------------------------------------------------------------
  describe('S8: connecting Stripe needs the state the link was made with', () => {
    let oauthToken: jest.SpyInstance;
    let accountsRetrieve: jest.SpyInstance;

    const stateOf = (url: string) => new URL(url).searchParams.get('state');

    beforeAll(() => {
      const stripe = app.get(StripePaymentService).stripe;
      oauthToken = jest
        .spyOn(stripe.oauth, 'token')
        .mockResolvedValue({ stripe_user_id: 'acct_connected_e2e' } as any);
      accountsRetrieve = jest
        .spyOn(stripe.accounts, 'retrieve')
        .mockResolvedValue({
          business_profile: { name: 'Connected e2e' },
          charges_enabled: true,
          payouts_enabled: true,
        } as any);
    });
    afterAll(() => {
      oauthToken.mockRestore();
      accountsRetrieve.mockRestore();
    });
    beforeEach(() => oauthToken.mockClear());

    const callback = (session: Session, body: Record<string, any>) =>
      inA(session).post('/stripe/callback').send(body);

    it('the link carries a state', async () => {
      const link = await inA(priya).get('/stripe/link');
      expect(link.status).toBe(200);
      expect(stateOf(link.body.url)).toBeTruthy();
    });

    it('a callback with no state or a wrong state is refused', async () => {
      for (const body of [
        { code: 'ac_attacker' },
        { code: 'ac_attacker', state: 'not-a-state' },
      ]) {
        const res = await callback(priya, body);
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('STRIPE_CONNECT_STATE_INVALID');
        expect(res.body.errors[0].message).toBe(
          "This Stripe connection wasn't started from your account.",
        );
      }
      expect(oauthToken).not.toHaveBeenCalled();
    });

    it("another user's or another company's state is refused", async () => {
      const anaLink = await inA(ana).get('/stripe/link');
      const res = await callback(priya, {
        code: 'ac_attacker',
        state: stateOf(anaLink.body.url),
      });
      expect(res.status).toBe(400);

      const mLink = await inM(companyM.owner).get('/stripe/link');
      // Mallory is an Admin in M and a member of A.
      const malloryLink = await inM(mallory).get('/stripe/link');
      const cross = await inA(mallory)
        .post('/stripe/callback')
        .send({ code: 'ac_x', state: stateOf(malloryLink.body.url) });
      expect(cross.status).toBeGreaterThanOrEqual(400);
      expect(mLink.status).toBe(200);
      expect(oauthToken).not.toHaveBeenCalled();
    });

    it('the normal flow connects the account, once', async () => {
      const link = await inA(priya).get('/stripe/link');
      const state = stateOf(link.body.url);
      const res = await callback(priya, { code: 'ac_good', state });
      expect(res.status).toBeLessThan(300);
      expect(oauthToken).toHaveBeenCalledTimes(1);
      const row = await dbA('payment_integrations')
        .where({ accountId: 'acct_connected_e2e' })
        .first();
      expect(row).toBeDefined();

      const replay = await callback(priya, { code: 'ac_again', state });
      expect(replay.status).toBe(400);
      expect(oauthToken).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // S9. Workspace totals
  // ---------------------------------------------------------------------
  describe('S9: workspace totals only for people who may see them', () => {
    const totalsInA = async (session: Session) => {
      const res = await request(app.getHttpServer())
        .get('/workspaces')
        .set('Authorization', `Bearer ${session.token}`)
        .set('organization-id', companyA.organizationId);
      expect(res.status).toBe(200);
      const a = res.body.find(
        (w: any) =>
          (w.organization_id ?? w.organizationId) === companyA.organizationId,
      );
      expect(a).toBeDefined();
      return a.total_assets ?? a.totalAssets;
    };

    it('an Admin and a balance-sheet user see the totals', async () => {
      expect(await totalsInA(ana)).toEqual(expect.any(Number));
      expect(await totalsInA(kasun)).toEqual(expect.any(Number));
    });

    it('a user with no report access sees no totals', async () => {
      expect(await totalsInA(nina)).toBeUndefined();
    });

    it('a deactivated user sees no totals', async () => {
      const off = await inA(priya).put(`/users/${ids.kasun}/inactivate`);
      expect(off.status).toBe(200);
      try {
        expect(await totalsInA(kasun)).toBeUndefined();
      } finally {
        await inA(priya).put(`/users/${ids.kasun}/activate`);
      }
    });
  });

  // ---------------------------------------------------------------------
  // S10. Sessions end on password reset
  // ---------------------------------------------------------------------
  describe('S10: a password reset ends older sessions', () => {
    it('the old session is refused and a new sign-in works', async () => {
      const tara = await inviteAndAccept(
        app,
        companyA,
        priya,
        uniqueEmail('tara'),
        balanceSheetRoleId,
      );
      expect((await inA(tara).get('/users')).status).toBe(200);

      const token = 'a'.repeat(32) + Date.now().toString(16);
      await sys()('password_resets').insert({
        email: tara.email,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        createdAt: new Date(),
      });
      const newPassword = 'Secur1ty-Reset-Pass';
      const reset = await request(app.getHttpServer())
        .post(`/auth/reset_password/${token}`)
        .send({ password: newPassword });
      expect(reset.status).toBeLessThan(300);

      expect((await inA(tara).get('/users')).status).toBe(401);

      const fresh = await signin(app, tara.email, newPassword);
      expect(fresh.status).toBe(201);
      const again = await inA({ token: fresh.body.access_token }).get('/users');
      expect(again.status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------
  // S11. Only admins give the Admin role
  // ---------------------------------------------------------------------
  describe('S11: only the owner and admins can give or edit the Admin role', () => {
    const adminOnly = (res: request.Response) => {
      expect({
        status: res.status,
        type: errorType(res),
        body: res.body,
      }).toMatchObject({ status: 400, type: 'ADMIN_ONLY' });
      expect(res.body.errors[0].message).toBe('Only an admin can do this.');
    };

    it('a user manager cannot invite someone as Admin', async () => {
      const email = uniqueEmail('sock2');
      adminOnly(
        await inA(manny)
          .patch('/invite')
          .send({ email, roleId: ADMIN_ROLE_ID }),
      );
      expect(await dbA('users').where({ email })).toHaveLength(0);
    });

    it('a user manager can still invite someone with another role', async () => {
      const res = await inA(manny)
        .patch('/invite')
        .send({ email: uniqueEmail('viewer'), roleId: balanceSheetRoleId });
      expect(res.status).toBe(200);
    });

    it('a user manager cannot bulk-invite someone as Admin', async () => {
      const email = uniqueEmail('bulk');
      const res = await inA(manny)
        .post('/invite/bulk')
        .send({ invites: [{ email, roleId: ADMIN_ROLE_ID }] });
      expect(await dbA('users').where({ email })).toHaveLength(0);
      expect(JSON.stringify(res.body)).toContain('Only an admin can do this.');
    });

    it('a user manager cannot make someone an Admin, or change an Admin', async () => {
      const promote = await inA(manny).put(`/users/${ids.nina}`).send({
        firstName: 'Nina',
        lastName: 'N',
        email: nina.email,
        roleId: ADMIN_ROLE_ID,
      });
      adminOnly(promote);

      const demote = await inA(manny).put(`/users/${ids.ana}`).send({
        firstName: 'Ana',
        lastName: 'A',
        email: ana.email,
        roleId: noReportsRoleId,
      });
      adminOnly(demote);
    });

    it('an Admin can make someone an Admin', async () => {
      const res = await inA(ana)
        .patch('/invite')
        .send({ email: uniqueEmail('admin2'), roleId: ADMIN_ROLE_ID });
      expect(res.status).toBe(200);
    });

    const roleBody = async (roleId: number, extra: any[] = []) => {
      const role = await inA(priya).get(`/roles/${roleId}`);
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

    it('nobody but an admin can change their own role', async () => {
      const body = await roleBody(roleEditorRoleId, [
        { subject: 'User', ability: 'Manage', value: true },
      ]);
      const res = await inA(rory).put(`/roles/${roleEditorRoleId}`).send(body);
      adminOnly(res);
      const perms = await dbA('role_permissions').where({
        roleId: roleEditorRoleId,
        subject: 'User',
      });
      expect(perms).toHaveLength(0);
    });

    it('a role editor cannot edit the Admin role', async () => {
      const body = await roleBody(ADMIN_ROLE_ID, [
        { subject: 'Customer', ability: 'View', value: true },
      ]);
      adminOnly(await inA(rory).put(`/roles/${ADMIN_ROLE_ID}`).send(body));
    });

    it('a role editor can still edit another role', async () => {
      const body = await roleBody(noReportsRoleId);
      const res = await inA(rory).put(`/roles/${noReportsRoleId}`).send(body);
      expect({ status: res.status, body: res.body }).toMatchObject({
        status: 200,
      });
    });
  });

  // ---------------------------------------------------------------------
  // S12. Attachments are private
  // ---------------------------------------------------------------------
  describe('S12: attachments are stored as private files', () => {
    it('downloads work through the app; the stored address does not', async () => {
      const content = `private attachment ${Date.now()}`;
      const upload = await inA(priya)
        .post('/attachments')
        .attach('file', Buffer.from(content), {
          filename: 'private.txt',
          contentType: 'text/plain',
        });
      expect(upload.status).toBe(200);
      const key = upload.body.data.key;

      const presigned = await inA(priya).get(
        `/attachments/${encodeURIComponent(key)}/presigned-url`,
      );
      expect(presigned.status).toBe(200);
      const url = presigned.body.presignedUrl ?? presigned.body.presigned_url;
      const viaApp = await fetch(url);
      expect(viaApp.status).toBe(200);
      expect(await viaApp.text()).toBe(content);

      const s3 = app.get(ConfigService).get('s3');
      const direct = await fetch(`${s3.endpoint}/${s3.bucket}/${key}`);
      expect(direct.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ---------------------------------------------------------------------
  // S13. Live updates need a session
  // ---------------------------------------------------------------------
  describe('S13: live-update connections need a session', () => {
    let url: string;
    let server: any;

    beforeAll(async () => {
      server = app.getHttpServer();
      if (!server.listening) {
        await new Promise<void>((resolve) => server.listen(0, resolve));
      }
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    const connect = (auth?: Record<string, any>) =>
      new Promise<{ socket: any; error?: Error }>((resolve) => {
        const socket = ioClient(url, {
          path: '/socket',
          transports: ['websocket'],
          reconnection: false,
          auth,
        });
        socket.on('connect', () => resolve({ socket }));
        socket.on('connect_error', (error: Error) =>
          resolve({ socket, error }),
        );
      });

    it('a connection without a session is refused', async () => {
      const { socket, error } = await connect();
      socket.close();
      expect(error).toBeDefined();

      const bad = await connect({ token: 'nope' });
      bad.socket.close();
      expect(bad.error).toBeDefined();
    });

    it("members get their own company's events only", async () => {
      const inCompanyA = await connect({
        token: ana.token,
        organizationId: companyA.organizationId,
      });
      expect(inCompanyA.error).toBeUndefined();
      const received: string[] = [];
      inCompanyA.socket.on('NEW_TRANSACTIONS_DATA', () => received.push('tx'));
      // A company the user isn't a member of is refused.
      const notMember = await connect({
        token: ana.token,
        organizationId: companyM.organizationId,
      });
      notMember.socket.close();
      expect(notMember.error).toBeDefined();

      const gateway = app.get(SocketGateway) as any;
      gateway.emitNewTransactionsData(companyM.organizationId);
      await sleep(300);
      expect(received).toEqual([]);

      gateway.emitNewTransactionsData(companyA.organizationId);
      await sleep(300);
      expect(received).toEqual(['tx']);
      inCompanyA.socket.close();
    });
  });

  // ---------------------------------------------------------------------
  // S14. Print files are not written to the public folder
  // ---------------------------------------------------------------------
  describe('S14: making a PDF writes nothing to the public folder', () => {
    it('the PDF is made from a private temporary file', async () => {
      const writeFile = jest.spyOn(fsPromises, 'writeFile');
      try {
        const customer = await inA(priya)
          .post('/customers')
          .send({
            displayName: `PDF customer ${Date.now()}`,
            customerType: 'business',
            currencyCode: 'USD',
          });
        const income = await dbA('accounts')
          .where('accountType', 'income')
          .first('id');
        const item = await inA(priya)
          .post('/items')
          .send({
            name: `PDF service ${Date.now()}`,
            type: 'service',
            sellable: true,
            sellAccountId: income.id,
            sellPrice: 10,
          });
        const invoice = await inA(priya)
          .post('/sale-invoices')
          .send({
            customerId: customer.body.id,
            invoiceDate: '2026-11-01',
            dueDate: '2026-11-30',
            delivered: true,
            entries: [
              { index: 1, itemId: item.body.id, quantity: 1, rate: 10 },
            ],
          });
        const pdf = await inA(priya)
          .get(`/sale-invoices/${invoice.body.id}`)
          .set('Accept', 'application/pdf')
          .buffer(true)
          .parse((res, cb) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => cb(null, Buffer.concat(chunks)));
          });
        expect(pdf.status).toBe(200);
        expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

        const publicDir = path.resolve((global as any).__public_dirname ?? '');
        const written = writeFile.mock.calls.map((c) => String(c[0]));
        expect(written.length).toBeGreaterThan(0);
        for (const file of written) {
          expect(path.resolve(file).startsWith(publicDir)).toBe(false);
          expect(file).not.toContain(`${path.sep}public${path.sep}pdf`);
        }
      } finally {
        writeFile.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------
  // S15. Setup jobs
  // ---------------------------------------------------------------------
  describe('S15: only the user who started a setup job can read it', () => {
    it('the creator sees the status; another user gets 404', async () => {
      const jobId = companyM.buildJobId;
      expect(jobId).toBeDefined();
      const asUser = (session: Session) =>
        request(app.getHttpServer())
          .get(`/workspaces/build/${jobId}`)
          .set('Authorization', `Bearer ${session.token}`);

      expect((await asUser(companyM.owner)).status).toBe(200);
      expect((await asUser(priya)).status).toBe(404);

      // The organization route is the same: an Admin of A can't read M's job.
      const viaOrg = await inA(priya).get(`/organization/build/${jobId}`);
      expect(viaOrg.status).toBe(404);
    });
  });
});
