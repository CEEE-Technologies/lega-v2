import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany, uniqueEmail } from './_utils/security';
import * as TransactionsHooks from '../src/modules/Tenancy/TenancyDB/TransactionsHooks';
import { InvoiceGLEntriesSubscriber } from '../src/modules/SaleInvoices/subscribers/InvoiceGLEntriesSubscriber';
import InviteSendMainNotificationSubscribe from '../src/modules/UsersModule/subscribers/InviteSendMailNotification.subscriber';
import { PLAID_CLIENT } from '../src/modules/Plaid/Plaid.module';

/**
 * Package 1 (round 3): handler errors stop the save, and dry runs leave
 * nothing behind.
 * - E1: a check or ledger write that fails in a handler undoes the save;
 *   a failing side effect (the invite mail) does not.
 * - E2: bulk-delete dry runs and import previews run no after-save work.
 * - E3: a bulk-delete dry run doesn't disconnect the Plaid bank feed.
 * - E4: an accounts import preview creates no accounts.
 * - E5: a failed preview or import gives its database connection back.
 * - E7: an import preview leaves the "cost computing" flag off.
 * - E8: invoice tax rows are deleted inside the delete.
 * Runs in a new company, so nothing shared is touched.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rowsOf = (body: any) =>
  body?.data ?? body?.sales_invoices ?? body?.accounts ?? body ?? [];

describe('Handler errors and dry runs (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  const tag = faker.string.alphanumeric(6).toLowerCase();

  let accounts: {
    bank: number;
    income: number;
    expense: number;
    cogs: number;
    inventory: number;
    equity: number;
  };
  let customerId: number;
  let serviceItemId: number;
  let inventoryItemId: number;
  let taxRateId: number;

  const ok = (res: any, status = [200, 201]) => {
    if (!status.includes(res.status)) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res;
  };

  const createInvoice = async (extra: Record<string, any> = {}) => {
    const res = ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: '2026-03-10',
          dueDate: '2026-03-31',
          invoiceNo: `P1-${faker.string.alphanumeric(10)}`,
          delivered: true,
          entries: [
            { index: 1, itemId: serviceItemId, quantity: 1, rate: 100 },
          ],
          ...extra,
        }),
    );
    return res.body.id as number;
  };

  const invoiceIds = async () =>
    (await db('sales_invoices').select('id')).map((r) => r.id as number);

  const taxRows = (invoiceId: number) =>
    db('tax_rate_transactions')
      .where({ referenceType: 'SaleInvoice', referenceId: invoiceId })
      .count({ n: '*' })
      .first()
      .then((r: any) => Number(r.n));

  /** Records the after-commit work registered while `fn` runs. */
  const trackAfterCommitWork = async (fn: () => Promise<void>) => {
    const original = TransactionsHooks.runAfterTransaction;
    let registered = 0;
    let ran = 0;
    const spy = jest
      .spyOn(TransactionsHooks, 'runAfterTransaction')
      .mockImplementation((trx, callback) => {
        registered += 1;
        return original(trx, () => {
          ran += 1;
          return callback();
        });
      });
    try {
      await fn();
      // Let rolled-back or committed transactions settle their hooks.
      await sleep(500);
    } finally {
      spy.mockRestore();
    }
    return { registered, ran };
  };

  const uploadAndMap = async (
    resource: string,
    csv: string,
    mapping: Array<{ from: string; to: string; group?: string }> | null,
  ) => {
    const upload = ok(
      await api()
        .post('/import/file')
        .field('resource', resource)
        .attach('file', Buffer.from(csv), `${resource}.csv`),
    );
    const importId =
      upload.body.import?.import_id ??
      upload.body.import?.importId ??
      upload.body.import_id ??
      upload.body.importId;
    expect(importId).toBeTruthy();
    if (mapping) {
      ok(await api().post(`/import/${importId}/mapping`).send({ mapping }));
    }
    return importId as string;
  };

  beforeAll(async () => {
    // The import files are stored under the static folder main.ts sets.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lega-p1-import-'));
    fs.mkdirSync(path.join(dir, 'imports'), { recursive: true });
    (global as any).__static_dirname = dir;

    company = await createCompany(app, 'p1dry');
    const config = app.get(ConfigService).get('tenantDatabase');
    db = knexFactory({
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
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      bank: await byType('bank'),
      income: await byType('income'),
      expense: await byType('expense'),
      cogs: await byType('cost-of-goods-sold'),
      inventory: await byType('inventory'),
      equity: await byType('equity'),
    };

    customerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `P1 customer ${tag}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id;
    serviceItemId = ok(
      await api()
        .post('/items')
        .send({
          name: `P1 service ${tag}`,
          type: 'service',
          sellable: true,
          sellAccountId: accounts.income,
          sellPrice: 100,
        }),
    ).body.id;
    inventoryItemId = ok(
      await api()
        .post('/items')
        .send({
          name: `P1 stock ${tag}`,
          type: 'inventory',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts.income,
          costAccountId: accounts.cogs,
          inventoryAccountId: accounts.inventory,
          sellPrice: 50,
          costPrice: 20,
        }),
    ).body.id;
    taxRateId = ok(
      await api()
        .post('/tax-rates')
        .send({
          name: `P1 VAT ${tag}`,
          code: `P1${tag}`,
          rate: 10,
          active: true,
        }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await api()
      .put('/transactions-locking/cancel-lock')
      .send({ reason: 'p1 e2e cleanup' });
    await db?.destroy();
  });

  describe('E1: handler errors stop the save', () => {
    it('a failing invoice ledger write leaves no invoice', async () => {
      // The handlers are request scoped (a new instance per event), so the
      // spy goes on the class.
      const spy = jest
        .spyOn(
          InvoiceGLEntriesSubscriber.prototype,
          'handleWriteJournalEntriesOnInvoiceCreated',
        )
        .mockRejectedValueOnce(new Error('ledger write timed out'));
      const before = await invoiceIds();
      try {
        const res = await api()
          .post('/sale-invoices')
          .send({
            customerId,
            invoiceDate: '2026-03-10',
            dueDate: '2026-03-31',
            invoiceNo: `P1-FAIL-${tag}`,
            delivered: true,
            entries: [
              { index: 1, itemId: serviceItemId, quantity: 1, rate: 1000 },
            ],
          });
        expect(res.status).toBeGreaterThanOrEqual(500);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await invoiceIds()).toEqual(before);
      const orphanLedger = await db('accounts_transactions')
        .where('referenceType', 'SaleInvoice')
        .whereNotIn('referenceId', before.length ? before : [0]);
      expect(orphanLedger).toEqual([]);
    });

    it('a failing invite mail still saves the invite', async () => {
      const spy = jest
        .spyOn(
          InviteSendMainNotificationSubscribe.prototype,
          'sendMailNotification',
        )
        .mockRejectedValue(new Error('mail queue down'));
      const email = uniqueEmail('p1-invitee');
      try {
        const res = await api().patch('/invite').send({ email, roleId: 2 });
        expect(res.status).toBe(200);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      const invited = await db('users').where({ email }).first();
      expect(invited).toBeDefined();
    });

    describe('a document matched to a bank line cannot be deleted', () => {
      const match = (referenceType: string, referenceId: number) =>
        db('matched_bank_transactions').insert({
          referenceType,
          referenceId,
          amount: 100,
        });

      const expectMatchedRefusal = (res: any) => {
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.body)).toContain(
          'CANNOT_DELETE_TRANSACTION_MATCHED',
        );
      };

      it('expense', async () => {
        const id = ok(
          await api()
            .post('/expenses')
            .send({
              paymentDate: '2026-03-12',
              paymentAccountId: accounts.bank,
              referenceNo: `P1-${tag}`,
              publish: true,
              categories: [
                {
                  index: 1,
                  expenseAccountId: accounts.expense,
                  amount: 100,
                },
              ],
            }),
        ).body.id;
        await match('Expense', id);
        expectMatchedRefusal(await api().delete(`/expenses/${id}`));
        expect(await db('expenses_transactions').where({ id })).toHaveLength(1);
      });

      it('manual journal', async () => {
        const id = ok(
          await api()
            .post('/manual-journals')
            .send({
              date: '2026-03-12',
              journalNumber: `P1-MJ-${tag}`,
              publish: true,
              entries: [
                { index: 1, debit: 100, credit: 0, accountId: accounts.bank },
                {
                  index: 2,
                  debit: 0,
                  credit: 100,
                  accountId: accounts.equity,
                },
              ],
            }),
        ).body.id;
        await match('ManualJournal', id);
        expectMatchedRefusal(await api().delete(`/manual-journals/${id}`));
        expect(await db('manual_journals').where({ id })).toHaveLength(1);
      });

      it('payment received', async () => {
        const invoiceId = await createInvoice();
        const id = ok(
          await api()
            .post('/payments-received')
            .send({
              customerId,
              paymentDate: '2026-03-12',
              depositAccountId: accounts.bank,
              paymentReceiveNo: `P1-PR-${tag}`,
              entries: [{ index: 1, invoiceId, paymentAmount: 100 }],
            }),
        ).body.id;
        await match('PaymentReceive', id);
        expectMatchedRefusal(await api().delete(`/payments-received/${id}`));
        expect(await db('payment_receives').where({ id })).toHaveLength(1);
      });

      it('bank deposit', async () => {
        const id = ok(
          await api()
            .post('/banking/transactions')
            .send({
              date: '2026-03-12',
              transactionNumber: `P1-DEP-${tag}`,
              transactionType: 'owner_contribution',
              description: 'P1 deposit',
              amount: 100,
              creditAccountId: accounts.equity,
              cashflowAccountId: accounts.bank,
              publish: true,
            }),
        ).body.id;
        await match('CashflowTransaction', id);
        expectMatchedRefusal(await api().delete(`/banking/transactions/${id}`));
        expect(await db('cashflow_transactions').where({ id })).toHaveLength(1);
      });
    });
  });

  describe('E2/E8: invoice bulk-delete dry run', () => {
    it('runs no after-save work and keeps the tax rows', async () => {
      const ids = [
        await createInvoice({
          entries: [
            {
              index: 1,
              itemId: inventoryItemId,
              quantity: 2,
              rate: 50,
              taxRateId,
            },
          ],
        }),
        await createInvoice({
          entries: [
            {
              index: 1,
              itemId: serviceItemId,
              quantity: 1,
              rate: 100,
              taxRateId,
            },
          ],
        }),
      ];
      await sleep(500);
      const taxBefore = await Promise.all(ids.map(taxRows));
      expect(taxBefore.every((n) => n > 0)).toBe(true);

      const work = await trackAfterCommitWork(async () => {
        const res = ok(
          await api().post('/sale-invoices/validate-bulk-delete').send({ ids }),
        );
        expect(res.body.deletableCount ?? res.body.deletable_count).toBe(2);
      });
      expect(work.registered).toBeGreaterThan(0);
      expect(work.ran).toBe(0);

      expect(await Promise.all(ids.map(taxRows))).toEqual(taxBefore);
      expect(await db('sales_invoices').whereIn('id', ids)).toHaveLength(2);
    });
  });

  describe('E8: invoice tax rows follow the delete', () => {
    it('a delete refused by a locked period keeps the tax rows; a real delete removes them', async () => {
      const id = await createInvoice({
        invoiceDate: '2026-02-10',
        dueDate: '2026-02-20',
        entries: [
          {
            index: 1,
            itemId: serviceItemId,
            quantity: 1,
            rate: 200,
            taxRateId,
          },
        ],
      });
      const before = await taxRows(id);
      expect(before).toBeGreaterThan(0);

      ok(
        await api()
          .put('/transactions-locking/lock')
          .send({ module: 'all', lockToDate: '2026-02-28', reason: 'p1 e2e' }),
      );
      try {
        const refused = await api().delete(`/sale-invoices/${id}`);
        expect(refused.status).toBe(400);
        expect(await taxRows(id)).toBe(before);
      } finally {
        ok(
          await api()
            .put('/transactions-locking/cancel-lock')
            .send({ reason: 'p1 e2e' }),
        );
      }

      ok(await api().delete(`/sale-invoices/${id}`));
      expect(await taxRows(id)).toBe(0);
    });
  });

  describe('E3: Plaid disconnect only after a real delete', () => {
    it('a dry run keeps the bank feed; the real delete disconnects it once', async () => {
      const plaid = app.get(PLAID_CLIENT, { strict: false });
      const itemRemove = jest
        .spyOn(plaid, 'itemRemove')
        .mockResolvedValue({ data: {} } as any);
      try {
        const accountId = ok(
          await api()
            .post('/accounts')
            .send({
              name: `P1 Plaid bank ${tag}`,
              code: faker.string.numeric(6),
              accountType: 'bank',
            }),
        ).body.id;
        const plaidItemId = `p1-item-${tag}`;
        await db('plaid_items').insert({
          plaidItemId,
          plaidAccessToken: 'access-sandbox-p1',
          plaidInstitutionId: 'ins_1',
        });
        await db('accounts')
          .where({ id: accountId })
          .update({ plaidItemId, plaidAccountId: `p1-acc-${tag}` });

        const dry = ok(
          await api()
            .post('/accounts/validate-bulk-delete')
            .send({ ids: [accountId] }),
        );
        expect(dry.body.deletableCount ?? dry.body.deletable_count).toBe(1);
        await sleep(500);
        expect(itemRemove).not.toHaveBeenCalled();
        expect(
          await db('plaid_items').where({ plaidItemId }).first(),
        ).toBeDefined();

        ok(await api().delete(`/accounts/${accountId}`));
        await sleep(500);
        expect(itemRemove).toHaveBeenCalledTimes(1);
        expect(await db('plaid_items').where({ plaidItemId })).toEqual([]);
      } finally {
        itemRemove.mockRestore();
      }
    });
  });

  describe('E4: accounts import preview', () => {
    it('the preview creates no accounts; the import creates them once', async () => {
      const names = [1, 2, 3].map((n) => `P1 imported ${tag} ${n}`);
      const csv = [
        'Account Name,Account Code,Type,Active',
        ...names.map(
          (name, i) => `${name},${faker.string.numeric(5)}${i},Expense,T`,
        ),
      ].join('\n');
      const mapping = [
        { from: 'Account Name', to: 'name' },
        { from: 'Account Code', to: 'code' },
        { from: 'Type', to: 'accountType' },
        { from: 'Active', to: 'active' },
      ];
      const importId = await uploadAndMap('accounts', csv, mapping);
      const count = async () =>
        (await db('accounts').whereIn('name', names)).length;

      const preview = ok(await api().get(`/import/${importId}/preview`));
      expect(preview.body.createdCount ?? preview.body.created_count).toBe(3);
      expect(await count()).toBe(0);

      const result = ok(await api().post(`/import/${importId}/import`));
      expect(result.body.createdCount ?? result.body.created_count).toBe(3);
      expect(await count()).toBe(3);
    });
  });

  describe('E2/E7: sale receipt import preview', () => {
    it('runs no after-save work and leaves the cost-computing flag off', async () => {
      const flag = () =>
        db('settings')
          .where({ group: 'inventory', key: 'cost_compute_running' })
          .first();
      await db('settings')
        .where({ group: 'inventory', key: 'cost_compute_running' })
        .delete();

      const csv = [
        'Receipt Date,Customer,Deposit Account,Receipt Number,Closed,Item,Quantity,Rate',
        `2026-03-15,P1 customer ${tag},${(await db('accounts').where({ id: accounts.bank }).first()).name},P1-R-${tag},T,P1 stock ${tag},1,50`,
      ].join('\n');
      const importId = await uploadAndMap('sale_receipt', csv, [
        { from: 'Receipt Date', to: 'receiptDate' },
        { from: 'Customer', to: 'customerId' },
        { from: 'Deposit Account', to: 'depositAccountId' },
        { from: 'Receipt Number', to: 'receiptNumber' },
        { from: 'Closed', to: 'closed' },
        { from: 'Item', to: 'itemId', group: 'entries' },
        { from: 'Quantity', to: 'quantity', group: 'entries' },
        { from: 'Rate', to: 'rate', group: 'entries' },
      ]);

      const work = await trackAfterCommitWork(async () => {
        const preview = ok(await api().get(`/import/${importId}/preview`));
        expect(preview.body.createdCount ?? preview.body.created_count).toBe(1);
      });
      expect(work.registered).toBeGreaterThan(0);
      expect(work.ran).toBe(0);

      const flagRow = await flag();
      expect(['0', 'false', undefined, null]).toContain(flagRow?.value);
      expect(
        await db('sales_receipts').where({ receiptNumber: `P1-R-${tag}` }),
      ).toEqual([]);
    });
  });

  describe('E5: failed previews and imports give their connection back', () => {
    it('20 failed previews and imports in a row, then the company still answers', async () => {
      const importId = await uploadAndMap(
        'accounts',
        'Account Name,Type\nNever mapped,Expense',
        null,
      );
      for (let i = 0; i < 10; i++) {
        const preview = await api()
          .get(`/import/${importId}/preview`)
          .timeout(15000);
        expect(preview.status).toBe(400);
        const commit = await api()
          .post(`/import/${importId}/import`)
          .timeout(15000);
        expect(commit.status).toBe(400);
      }
      const res = await api().get('/accounts').timeout(15000);
      expect(res.status).toBe(200);
      expect(rowsOf(res.body).length).toBeGreaterThan(0);
    }, 240000);
  });
});
