import request = require('supertest');
import * as path from 'path';
import { createHash } from 'crypto';
import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import {
  as,
  Company,
  createCompany,
  PASSWORD,
  signin,
  systemKnex,
  uniqueEmail,
} from './_utils/security';
import { MailTransporter } from '../src/modules/Mail/MailTransporter.service';

/**
 * High-severity fixes (2 Nov):
 * - a failing invite mail no longer stops the server;
 * - password reset tokens are stored as hashes;
 * - document numbers are unique (index added by migration
 *   20261103120100), a duplicate typed number is refused with 409, and an
 *   empty number is saved as NULL;
 * - a save is committed before its request answers (UnitOfWork).
 * Runs in a new company, so nothing shared is touched.
 */
jest.retryTimes(0);

// Set by main.ts in the real server; the mail templates read them.
const staticDir = path.join(__dirname, '../static');
global.__static_dirname = global.__static_dirname || staticDir;
global.__views_dirname =
  global.__views_dirname || path.join(staticDir, '/views');
global.__images_dirname =
  global.__images_dirname || path.join(staticDir, '/images');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (check: () => boolean, ms = 20000) => {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting.');
    await sleep(100);
  }
};

describe('High-severity fixes (e2e)', () => {
  let company: Company;
  let tenantDb: Knex;
  const inCompany = () => as(app, company.owner, company.organizationId);

  beforeAll(async () => {
    company = await createCompany(app, 'highfix');
    const config = app.get(ConfigService).get('tenantDatabase');
    tenantDb = knexFactory({
      client: config.client,
      connection: {
        host: config.host,
        port: Number(config.port),
        user: config.user,
        password: config.password,
        database: `${config.dbNamePrefix}${company.organizationId}`,
        charset: 'utf8',
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
  }, 300000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await tenantDb?.destroy();
  });

  describe('Invite mail with the mail server down', () => {
    it('the invite answers normally, the job fails, the server stays up', async () => {
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      const smtpDown = new Error('connect ECONNREFUSED 127.0.0.1:587');
      const send = jest
        .spyOn(MailTransporter.prototype, 'send')
        .mockRejectedValue(smtpDown);
      const errorLog = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      try {
        const invite = await inCompany()
          .patch('/invite')
          .send({ email: uniqueEmail('smtp'), roleId: 1 });
        expect(invite.status).toBe(200);

        // The queue job sends the mail and fails.
        await waitFor(() => send.mock.calls.length > 0);
        await sleep(1000);
        expect(unhandled).not.toHaveBeenCalled();

        // The server still answers.
        expect((await inCompany().get('/users')).status).toBe(200);
      } finally {
        process.off('unhandledRejection', unhandled);
        send.mockRestore();
        errorLog.mockRestore();
      }
    });
  });

  describe('Password reset tokens are stored as hashes', () => {
    it('request -> mail -> reset works; the raw token is not in the database', async () => {
      const email = company.owner.email;
      const mails: any[] = [];
      const send = jest
        .spyOn(MailTransporter.prototype, 'send')
        .mockImplementation(async (mail: any) => {
          mails.push(mail);
          return {} as any;
        });
      try {
        const res = await request(app.getHttpServer())
          .post('/auth/send_reset_password')
          .send({ email });
        expect(res.status).toBeLessThan(300);
        await waitFor(() => mails.length > 0);
      } finally {
        send.mockRestore();
      }
      const html = JSON.stringify(mails[0]);
      const token = html.match(/reset_password\/([0-9a-f]{64})/)?.[1];
      expect(token).toBeDefined();

      const rows = await systemKnex(app)('password_resets').where({ email });
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(JSON.stringify(rows)).not.toContain(token);

      // The stored hash is not a valid link.
      const withHash = await request(app.getHttpServer())
        .post(`/auth/reset_password/${rows[0].tokenHash}`)
        .send({ password: 'Brand-New-Passw0rd!' });
      expect(withHash.status).toBeGreaterThanOrEqual(400);

      const reset = await request(app.getHttpServer())
        .post(`/auth/reset_password/${token}`)
        .send({ password: 'Brand-New-Passw0rd!' });
      expect(reset.status).toBeLessThan(300);
      // The reset ends the owner's older sessions (S10, round 3).
      expect((await inCompany().get('/users')).status).toBe(401);
      const fresh = await signin(app, email, 'Brand-New-Passw0rd!');
      expect(fresh.status).toBe(201);
      company.owner.token = fresh.body.access_token;
      expect((await inCompany().get('/users')).status).toBe(200);
      expect((await signin(app, email, PASSWORD)).status).not.toBe(201);

      // Used once: the link no longer works.
      const again = await request(app.getHttpServer())
        .post(`/auth/reset_password/${token}`)
        .send({ password: 'Another-Passw0rd!' });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Unique document numbers', () => {
    let customerId: number;
    let itemId: number;

    const creditNote = (creditNoteNumber?: string) =>
      inCompany()
        .post('/credit-notes')
        .send({
          customerId,
          creditNoteDate: '2026-10-15',
          ...(creditNoteNumber !== undefined && { creditNoteNumber }),
          entries: [{ index: 1, itemId, quantity: 1, rate: 10 }],
        });

    beforeAll(async () => {
      const customer = await inCompany()
        .post('/customers')
        .send({
          displayName: `HF customer ${faker.string.alphanumeric(5)}`,
          customerType: 'business',
          currencyCode: 'USD',
        });
      customerId = customer.body.id;
      const item = await inCompany()
        .post('/items')
        .send({
          name: `HF item ${faker.string.alphanumeric(5)}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: 1026,
          costAccountId: 1019,
          costPrice: 10,
          sellPrice: 10,
        });
      itemId = parseInt(item.body.id, 10);
    });

    it('the company has the unique index on every document number', async () => {
      const [rows] = await tenantDb.raw(
        "SELECT TABLE_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE '%DOC_NUMBER_UNIQUE' AND NON_UNIQUE = 0",
      );
      expect(rows.map((row: any) => row.TABLE_NAME).sort()).toEqual(
        [
          'BILLS',
          'BILLS_PAYMENTS',
          'CASHFLOW_TRANSACTIONS',
          'CREDIT_NOTES',
          'MANUAL_JOURNALS',
          'PAYMENT_RECEIVES',
          'SALES_ESTIMATES',
          'SALES_INVOICES',
          'SALES_RECEIPTS',
          'VENDOR_CREDITS',
          'WAREHOUSES_TRANSFERS',
        ].sort(),
      );
    });

    it('a typed number already used is refused with 409', async () => {
      const number = `CN-HF-${faker.string.alphanumeric(6)}`;
      expect((await creditNote(number)).status).toBe(201);

      const second = await creditNote(number.toLowerCase());
      expect(second.status).toBe(409);
      expect(second.body.errors[0].type).toBe('DOCUMENT_NUMBER_EXISTS');
      expect(
        await tenantDb('credit_notes')
          .where('credit_note_number', number)
          .count('* as count')
          .first(),
      ).toEqual({ count: 1 });
    });

    it('with auto-numbering off, two credit notes without a number both save (NULL)', async () => {
      const setAuto = (value: boolean) =>
        inCompany()
          .put('/settings')
          .send({
            options: [{ group: 'credit_note', key: 'auto_increment', value }],
          });
      expect((await setAuto(false)).status).toBe(200);
      try {
        const first = await creditNote('');
        const second = await creditNote('');
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);

        const rows = await tenantDb('credit_notes')
          .whereIn('id', [first.body.id, second.body.id])
          .select('credit_note_number as number');
        expect(rows.map((row: any) => row.number)).toEqual([null, null]);
      } finally {
        await setAuto(true);
      }
    });
  });

  describe('A save is committed before the request answers', () => {
    it('another connection sees the new customer as soon as the request returns', async () => {
      for (let i = 0; i < 5; i++) {
        const name = `HF committed ${faker.string.alphanumeric(8)}`;
        const res = await inCompany().post('/customers').send({
          displayName: name,
          customerType: 'business',
          currencyCode: 'USD',
        });
        expect(res.status).toBe(201);
        // A separate connection only sees committed rows (READ COMMITTED).
        const row: any = await tenantDb.transaction(
          async (trx) =>
            trx('contacts').where('display_name', name).first('id'),
          { isolationLevel: 'read committed' },
        );
        expect(row?.id).toBe(res.body.id);
      }
    });
  });
});
