import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { CashBasisAutoRebuildService } from '../src/modules/AccountingBasis/CashBasisAutoRebuild.service';
import { CASH_BASIS_REBUILD_QUEUE } from '../src/modules/AccountingBasis/AccountingBasis.constants';
import { checkDataHealth } from '../src/modules/AccountingBasis/DataHealthCheck';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tagOldLandedCosts = require('../src/database/tenant/migrations/20261102120000_tag_old_landed_costs_accrual');

/**
 * Three Codex review findings, in a new company of their own:
 * 1. Landed costs posted before the basis tagging (NULL basis) counted twice
 *    on the cash basis once a payment of their source bill wrote a cash set
 *    next to them.
 * 2. A foreign opening balance paid at another rate relieved A/R (A/P) at
 *    the payment rate, with no exchange gain or loss.
 * 3. Two deletes of the same payment at the same time both reverted it, so
 *    the paid opening balance went below zero.
 */
jest.retryTimes(0);

const DATE = '2026-06-01';
const PAY_DATE = '2026-06-15';
const FLAG = { group: 'accounting_basis', key: 'cash_rebuild_needed' };

const round = (value: number) => Math.round(value * 100) / 100;

describe('Codex open findings (e2e)', () => {
  let company: Company;
  let db: Knex;
  let api: ReturnType<typeof as>;
  const tag = faker.string.alphanumeric(6).toLowerCase();
  const accounts: Record<string, number> = {};

  beforeAll(async () => {
    company = await createCompany(app, 'codexfix');
    api = as(app, company.owner, company.organizationId);

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
        dateStrings: ['DATE'] as unknown as boolean,
      },
      pool: { min: 0, max: 2 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    for (const slug of [
      'bank-account',
      'cost-of-goods-sold',
      'other-expenses',
      'sales-of-service-income',
      'exchange-grain-loss',
    ]) {
      accounts[slug] = (await db('accounts').where({ slug }).first('id')).id;
    }
    await api
      .post('/currencies')
      .send({ currencyCode: 'EUR', currencyName: 'Euro', currencySign: '€' });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  const created = (res: any) => {
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body.id as number;
  };

  const createVendor = async (extra: Record<string, any> = {}) =>
    created(
      await api.post('/vendors').send({
        displayName: `Codex vendor ${tag} ${faker.string.alphanumeric(6)}`,
        currencyCode: 'USD',
        ...extra,
      }),
    );

  const createCustomer = async (extra: Record<string, any> = {}) =>
    created(
      await api.post('/customers').send({
        displayName: `Codex customer ${tag} ${faker.string.alphanumeric(6)}`,
        customerType: 'business',
        currencyCode: 'USD',
        ...extra,
      }),
    );

  /** Net (debit - credit) of the rows, by account. */
  const netByAccount = (rows: any[]) =>
    rows.reduce(
      (acc, row) => {
        acc[row.accountId] = round(
          (acc[row.accountId] || 0) + Number(row.debit) - Number(row.credit),
        );
        return acc;
      },
      {} as Record<number, number>,
    );

  // -------------------------------------------------------------------------
  // 1. Old landed costs on the cash basis.
  // -------------------------------------------------------------------------
  describe('1. landed costs posted before the basis tagging', () => {
    let vendorId: number;
    let itemId: number;
    let goodsBillId: number;
    let itemEntryId: number;

    const createBill = async (amount: number) =>
      created(
        await api.post('/bills').send({
          vendorId,
          billDate: DATE,
          dueDate: DATE,
          billNumber: `CDX-${tag}-${faker.string.alphanumeric(6)}`,
          exchangeRate: 1,
          open: true,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
      );

    const payBill = async (billId: number, amount: number) =>
      created(
        await api.post('/bill-payments').send({
          vendorId,
          paymentDate: PAY_DATE,
          amount,
          exchangeRate: 1,
          paymentAccountId: accounts['bank-account'],
          paymentNumber: `CDX-PAY-${faker.string.alphanumeric(8)}`,
          entries: [{ index: 1, billId, paymentAmount: amount }],
        }),
      );

    /**
     * A landed cost as the old code left it: allocated onto the goods bill,
     * with its ledger rows untagged (NULL basis) and no cash set.
     */
    const insertOldLandedCost = async (
      fromTransactionType: 'Bill' | 'Expense',
      fromTransactionId: number,
      amount: number,
      basis: string | null = null,
    ) => {
      const [id] = await db('bill_located_costs').insert({
        amount,
        currencyCode: 'USD',
        exchangeRate: 1,
        fromTransactionId,
        fromTransactionType,
        allocationMethod: 'value',
        costAccountId: accounts['other-expenses'],
        billId: goodsBillId,
        description: `Codex ${tag}`,
      });
      await db('bill_located_cost_entries').insert({
        cost: amount,
        entryId: itemEntryId,
        billLocatedCostId: id,
      });
      for (const [accountId, debit, credit, index] of [
        [accounts['cost-of-goods-sold'], amount, 0, 1],
        [accounts['other-expenses'], 0, amount, 2],
      ]) {
        await db('accounts_transactions').insert({
          referenceType: 'LandedCost',
          referenceId: id,
          accountId,
          debit,
          credit,
          date: DATE,
          currencyCode: 'USD',
          exchangeRate: 1,
          index,
          basis,
        });
      }
      return id as number;
    };

    const rowsOf = (landedCostId: number) =>
      db('accounts_transactions')
        .where({ referenceType: 'LandedCost', referenceId: landedCostId })
        .select('accountId', 'debit', 'credit', 'basis');

    /** What the cash basis reports see: untagged and cash rows. */
    const cashBasisNet = async (landedCostId: number) =>
      netByAccount(
        (await rowsOf(landedCostId)).filter(
          (row) => row.basis === null || row.basis === 'cash',
        ),
      );

    /** The bases of its rows, accrual/untagged first. */
    const basesOf = async (landedCostId: number) =>
      (await rowsOf(landedCostId))
        .map((row) => row.basis)
        .sort((a, b) => (a ?? '').localeCompare(b ?? ''));

    const net = (amount: number) => ({
      [accounts['cost-of-goods-sold']]: amount,
      [accounts['other-expenses']]: -amount,
    });

    /** A cash set as the code before this fix wrote it next to old rows. */
    const insertCashSet = async (landedCostId: number, amount: number) => {
      for (const [accountId, debit, credit, index] of [
        [accounts['cost-of-goods-sold'], amount, 0, 1],
        [accounts['other-expenses'], 0, amount, 1],
      ]) {
        await db('accounts_transactions').insert({
          referenceType: 'LandedCost',
          referenceId: landedCostId,
          accountId,
          debit,
          credit,
          date: PAY_DATE,
          currencyCode: 'USD',
          exchangeRate: 1,
          index,
          basis: 'cash',
        });
      }
    };

    const rebuildQueue = () =>
      app.get<Queue>(getQueueToken(CASH_BASIS_REBUILD_QUEUE));

    /** Queues the startup rebuild and waits for the job to finish. */
    const runRebuildOnce = async (autoRebuild: CashBasisAutoRebuildService) => {
      await autoRebuild.queueRebuild(company.organizationId);
      const jobId = `cash-basis-auto-rebuild-${company.organizationId}`;
      const started = Date.now();
      while (await rebuildQueue().getJob(jobId)) {
        if (Date.now() - started > 120000) throw new Error('rebuild timed out');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };

    const rebuildUntilFlagCleared = async (
      autoRebuild: CashBasisAutoRebuildService,
    ) => {
      await runRebuildOnce(autoRebuild);
      expect(await autoRebuild.isFlagged(company.organizationId)).toBe(false);
    };

    beforeAll(async () => {
      vendorId = await createVendor();
      itemId = created(
        await api.post('/items').send({
          name: `Codex item ${tag}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts['sales-of-service-income'],
          costAccountId: accounts['cost-of-goods-sold'],
          costPrice: 100,
          sellPrice: 100,
        }),
      );
      goodsBillId = await createBill(1000);
      itemEntryId = (
        await db('items_entries')
          .where({ referenceType: 'Bill', referenceId: goodsBillId })
          .first('id')
      ).id;
    });

    it('a payment of the source bill tags the old entries before writing the cash set', async () => {
      const freightBillId = await createBill(100);
      const landedCostId = await insertOldLandedCost(
        'Bill',
        freightBillId,
        100,
      );

      // Before: the untagged rows count on the cash basis already.
      expect(await cashBasisNet(landedCostId)).toEqual({
        [accounts['cost-of-goods-sold']]: 100,
        [accounts['other-expenses']]: -100,
      });

      await payBill(freightBillId, 100);

      const rows = await rowsOf(landedCostId);
      expect(rows.filter((row) => row.basis === null)).toHaveLength(0);
      expect(rows.filter((row) => row.basis === 'accrual')).toHaveLength(2);
      expect(rows.filter((row) => row.basis === 'cash').length).toBeGreaterThan(
        0,
      );
      // Counted once on the cash basis (it was 200 / -200 before the fix).
      expect(await cashBasisNet(landedCostId)).toEqual({
        [accounts['cost-of-goods-sold']]: 100,
        [accounts['other-expenses']]: -100,
      });
    });

    it('the migration tags only double-counted ones; the rebuild does the rest', async () => {
      const autoRebuild = app.get(CashBasisAutoRebuildService);
      await db('settings').where(FLAG).delete();

      // Counted twice: a payment wrote a cash set next to the untagged rows.
      const doubleBillId = await createBill(50);
      await payBill(doubleBillId, 50);
      const doubleId = await insertOldLandedCost('Bill', doubleBillId, 50);
      await insertCashSet(doubleId, 50);
      // Paid before the release: no cash set was ever written for it.
      const paidBillId = await createBill(80);
      await payBill(paidBillId, 80);
      const paidId = await insertOldLandedCost('Bill', paidBillId, 80);
      // Not paid yet: nothing on the cash basis once done.
      const unpaidBillId = await createBill(60);
      const unpaidId = await insertOldLandedCost('Bill', unpaidBillId, 60);
      // An expense is paid already: it counts the same on both bases.
      const expenseId = await insertOldLandedCost('Expense', 999999, 30);

      expect(await cashBasisNet(doubleId)).toEqual(net(100));

      await tagOldLandedCosts.up(db);

      expect(await basesOf(doubleId)).toEqual([
        'accrual',
        'accrual',
        'cash',
        'cash',
      ]);
      expect(await cashBasisNet(doubleId)).toEqual(net(50));
      // Left for the rebuild: still counted once, never dropped.
      expect(await basesOf(paidId)).toEqual([null, null]);
      expect(await cashBasisNet(paidId)).toEqual(net(80));
      expect(await basesOf(unpaidId)).toEqual([null, null]);
      expect(await basesOf(expenseId)).toEqual([null, null]);
      expect((await db('settings').where(FLAG).first())?.value).toBe('true');

      // Running it again changes nothing.
      await tagOldLandedCosts.up(db);
      expect(await basesOf(paidId)).toEqual([null, null]);
      expect(await basesOf(expenseId)).toEqual([null, null]);

      // The startup rebuild (queued as on a deploy) tags them, writes their
      // cash sets and clears the flag.
      await rebuildUntilFlagCleared(autoRebuild);

      expect(await basesOf(paidId)).toEqual([
        'accrual',
        'accrual',
        'cash',
        'cash',
      ]);
      expect(await cashBasisNet(paidId)).toEqual(net(80));
      expect(await basesOf(unpaidId)).toEqual(['accrual', 'accrual']);
      expect(await cashBasisNet(unpaidId)).toEqual({});
      expect(await cashBasisNet(doubleId)).toEqual(net(50));
      expect(await basesOf(expenseId)).toEqual([null, null]);
    });

    it('one paid in a locked period stays untagged and keeps the flag until the period opens', async () => {
      const autoRebuild = app.get(CashBasisAutoRebuildService);
      await db('settings').where(FLAG).delete();

      const billId = await createBill(70);
      await payBill(billId, 70);
      const landedCostId = await insertOldLandedCost('Bill', billId, 70);
      await tagOldLandedCosts.up(db);
      expect((await db('settings').where(FLAG).first())?.value).toBe('true');

      await api
        .put('/transactions-locking/lock')
        .send({ module: 'all', lockToDate: '2026-06-30', reason: 'codex e2e' })
        .expect(200);
      try {
        await runRebuildOnce(autoRebuild);

        // Left as it was: counted once on the cash basis, still flagged.
        expect(await basesOf(landedCostId)).toEqual([null, null]);
        expect(await cashBasisNet(landedCostId)).toEqual(net(70));
        expect(await autoRebuild.isFlagged(company.organizationId)).toBe(true);
      } finally {
        await api
          .put('/transactions-locking/cancel-lock')
          .send({ module: 'all', reason: 'codex e2e' })
          .expect(200);
      }

      // Once the period opens the next (startup) rebuild finishes it.
      await rebuildUntilFlagCleared(autoRebuild);
      expect(await basesOf(landedCostId)).toEqual([
        'accrual',
        'accrual',
        'cash',
        'cash',
      ]);
      expect(await cashBasisNet(landedCostId)).toEqual(net(70));
    });

    it('the health check lists a landed cost from a paid bill with no cash set', async () => {
      const billId = await createBill(40);
      await payBill(billId, 40);
      // Tagged accrual, but its cash set is missing.
      const landedCostId = await insertOldLandedCost(
        'Bill',
        billId,
        40,
        'accrual',
      );

      const result = await checkDataHealth(db, 'USD');
      expect(
        result.landedCostsWithoutCashSet.map((row) => row.landedCostId),
      ).toEqual([landedCostId]);
      expect(result.untaggedLandedCosts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Foreign opening balance paid at another rate.
  // -------------------------------------------------------------------------
  describe('2. foreign opening balance paid at another rate', () => {
    const openingBalance = {
      currencyCode: 'EUR',
      openingBalance: 100,
      openingBalanceAt: DATE,
      openingBalanceExchangeRate: 1.2,
    };

    /** The rows of the contact's opening balance and the given payments. */
    const ledgerOf = (
      openingBalanceType: string,
      contactId: number,
      paymentType: string,
      paymentIds: number[],
    ) =>
      db('accounts_transactions')
        .where((b) =>
          b
            .where({
              referenceType: openingBalanceType,
              referenceId: contactId,
            })
            .orWhere((w) =>
              w
                .where('referenceType', paymentType)
                .whereIn('referenceId', paymentIds),
            ),
        )
        .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'))
        .select('accountId', 'debit', 'credit', 'basis');

    const arapAccountOf = async (accountType: string) =>
      (
        await db('accounts')
          .where({ accountType, currencyCode: 'EUR' })
          .first('id')
      ).id as number;

    it('a customer opening balance at 1.2 paid at 1.3 posts a gain of 10 and clears A/R', async () => {
      const customerId = await createCustomer(openingBalance);
      const paymentId = created(
        await api.post('/payments-received').send({
          customerId,
          paymentDate: PAY_DATE,
          amount: 100,
          exchangeRate: 1.3,
          depositAccountId: accounts['bank-account'],
          paymentReceiveNo: `CDX-PR-${faker.string.alphanumeric(8)}`,
          entries: [
            { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
          ],
        }),
      );
      const net = netByAccount(
        await ledgerOf('CustomerOpeningBalance', customerId, 'PaymentReceive', [
          paymentId,
        ]),
      );
      const ar = await arapAccountOf('accounts-receivable');
      expect(net[ar]).toBe(0);
      expect(net[accounts['bank-account']]).toBe(130);
      expect(net[accounts['exchange-grain-loss']]).toBe(-10);

      const contact = await db('contacts').where({ id: customerId }).first();
      expect(Number(contact.openingBalancePaymentAmount)).toBe(100);
    });

    it('paid in two parts at different rates, A/R still ends at zero', async () => {
      const customerId = await createCustomer(openingBalance);
      const pay = async (amount: number, rate: number, date: string) =>
        created(
          await api.post('/payments-received').send({
            customerId,
            paymentDate: date,
            amount,
            exchangeRate: rate,
            depositAccountId: accounts['bank-account'],
            paymentReceiveNo: `CDX-PR-${faker.string.alphanumeric(8)}`,
            entries: [
              { index: 1, entryType: 'opening_balance', paymentAmount: amount },
            ],
          }),
        );
      const first = await pay(33.33, 1.3, PAY_DATE);
      const second = await pay(66.67, 1.25, '2026-06-20');

      const net = netByAccount(
        await ledgerOf('CustomerOpeningBalance', customerId, 'PaymentReceive', [
          first,
          second,
        ]),
      );
      const ar = await arapAccountOf('accounts-receivable');
      expect(net[ar]).toBe(0);
      // 33.33 x 1.3 + 66.67 x 1.25 = 43.33 + 83.34 = 126.67 received for
      // 120 owed: a gain of 6.67.
      expect(net[accounts['exchange-grain-loss']]).toBe(-6.67);
    });

    it('a vendor opening balance at 1.2 paid at 1.3 posts a loss of 10 and clears A/P', async () => {
      const vendorId = await createVendor(openingBalance);
      const paymentId = created(
        await api.post('/bill-payments').send({
          vendorId,
          paymentDate: PAY_DATE,
          amount: 100,
          exchangeRate: 1.3,
          paymentAccountId: accounts['bank-account'],
          paymentNumber: `CDX-BP-${faker.string.alphanumeric(8)}`,
          entries: [
            { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
          ],
        }),
      );
      const net = netByAccount(
        await ledgerOf('VendorOpeningBalance', vendorId, 'BillPayment', [
          paymentId,
        ]),
      );
      const ap = await arapAccountOf('accounts-payable');
      expect(net[ap]).toBe(0);
      expect(net[accounts['bank-account']]).toBe(-130);
      expect(net[accounts['exchange-grain-loss']]).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Two deletes of the same payment at the same time.
  // -------------------------------------------------------------------------
  describe('3. concurrent deletes of an opening balance payment', () => {
    const sides = [
      {
        label: 'payment received',
        path: '/payments-received',
        createContact: () =>
          createCustomer({ openingBalance: 100, openingBalanceAt: DATE }),
        body: (contactId: number) => ({
          customerId: contactId,
          paymentDate: PAY_DATE,
          amount: 100,
          exchangeRate: 1,
          depositAccountId: accounts['bank-account'],
          paymentReceiveNo: `CDX-PR-${faker.string.alphanumeric(8)}`,
          entries: [
            { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
          ],
        }),
        referenceType: 'PaymentReceive',
      },
      {
        label: 'bill payment',
        path: '/bill-payments',
        createContact: () =>
          createVendor({ openingBalance: 100, openingBalanceAt: DATE }),
        body: (contactId: number) => ({
          vendorId: contactId,
          paymentDate: PAY_DATE,
          amount: 100,
          exchangeRate: 1,
          paymentAccountId: accounts['bank-account'],
          paymentNumber: `CDX-BP-${faker.string.alphanumeric(8)}`,
          entries: [
            { index: 1, entryType: 'opening_balance', paymentAmount: 100 },
          ],
        }),
        referenceType: 'BillPayment',
      },
    ];

    it.each(sides)(
      '$label: one delete wins, the other gets 404, the paid opening balance goes back to 0',
      async (side) => {
        const contactId = await side.createContact();
        const paymentId = created(
          await api.post(side.path).send(side.body(contactId)),
        );
        const paid = async () =>
          Number(
            (await db('contacts').where({ id: contactId }).first())
              .openingBalancePaymentAmount,
          );
        expect(await paid()).toBe(100);

        const responses = await Promise.all([
          api.delete(`${side.path}/${paymentId}`),
          api.delete(`${side.path}/${paymentId}`),
        ]);
        expect(responses.map((res) => res.status).sort()).toEqual([200, 404]);

        // Reverted once (it went to -100 before the fix).
        expect(await paid()).toBe(0);
        expect(
          await db('accounts_transactions').where({
            referenceType: side.referenceType,
            referenceId: paymentId,
          }),
        ).toHaveLength(0);
      },
    );
  });
});
