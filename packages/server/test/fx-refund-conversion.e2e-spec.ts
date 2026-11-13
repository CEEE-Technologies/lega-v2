import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * Refunds of foreign currency credit notes and vendor credits were posted
 * without converting to the base currency: a EUR 65.18 refund at 1.23 was
 * posted as USD 65.18 instead of 80.17, on the A/R (A/P) line and the bank
 * line, accrual and cash basis. The credit note refund also debited the
 * base currency A/R account, not the EUR one the credit note credited.
 *
 * The `tenants:repair-refund-journals` repair lists and rewrites the
 * refunds posted the old way. Runs in a new company (base USD).
 */
jest.retryTimes(0);

const round = (n: number) => Math.round(n * 100) / 100;

const openDb = (organizationId: string): Knex => {
  const config = app.get(ConfigService).get('tenantDatabase');
  return knexFactory({
    client: config.client,
    connection: {
      host: config.host,
      port: Number(config.port),
      user: config.user,
      password: config.password,
      database: `${config.dbNamePrefix}${organizationId}`,
      charset: 'utf8',
      dateStrings: ['DATE'] as unknown as boolean,
    },
    pool: { min: 0, max: 2 },
    ...knexSnakeCaseMappers({ upperCase: true }),
  });
};

/** Runs the work inside the company's tenant context (as the CLI does). */
const inTenant = async <T>(company: Company, work: () => Promise<T>) => {
  const cls = app.get(ClsService);
  return cls.run(async () => {
    cls.set('organizationId', company.organizationId);
    cls.set('userId', company.owner.systemUserId);
    await cls.resolveProxyProviders();
    return work();
  });
};

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

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

const sumOf = (rows: any[], column: 'debit' | 'credit') =>
  round(rows.reduce((sum, row) => sum + Number(row[column]), 0));

describe('Foreign currency refunds are posted in the base currency (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);

  let accounts: {
    bank: number;
    income: number;
    cogs: number;
    baseAR: number;
    gainLoss: number;
  };
  let itemId: number;
  let eurCustomerId: number;
  let eurVendorId: number;
  let usdCustomerId: number;

  const accrualRows = (referenceType: string, referenceId: number) =>
    db('accounts_transactions')
      .where({ referenceType, referenceId })
      .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'))
      .select('accountId', 'debit', 'credit', 'foreignDebit', 'foreignCredit');

  const cashRows = (referenceType: string, referenceId: number) =>
    db('accounts_transactions')
      .where({ referenceType, referenceId, basis: 'cash' })
      .select('accountId', 'debit', 'credit');

  const accountOf = async (accountType: string, currencyCode: string) =>
    (
      await db('accounts')
        .where({ accountType, currencyCode })
        .orderBy('id')
        .first('id')
    )?.id;

  const createCreditNote = async (
    customerId: number,
    amount: number,
    rate: number,
    date = '2026-05-01',
  ) =>
    ok(
      await api()
        .post('/credit-notes')
        .send({
          customerId,
          creditNoteDate: date,
          creditNoteNumber: `FX-CN-${faker.string.alphanumeric(8)}`,
          exchangeRate: rate,
          open: true,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    ).body.id as number;

  const refundCreditNote = async (
    creditNoteId: number,
    body: Record<string, any>,
  ) => {
    ok(
      await api()
        .post(`/credit-notes/${creditNoteId}/refunds`)
        .send({
          fromAccountId: accounts.bank,
          date: '2026-06-01',
          referenceNo: `FX-R-${faker.string.alphanumeric(6)}`,
          description: 'FX refund',
          ...body,
        }),
    );
    return (await db('refund_credit_note_transactions')
      .where({ creditNoteId })
      .orderBy('id', 'desc')
      .first()) as any;
  };

  const createVendorCredit = async (
    vendorId: number,
    amount: number,
    rate: number,
  ) =>
    ok(
      await api()
        .post('/vendor-credits')
        .send({
          vendorId,
          vendorCreditDate: '2026-05-01',
          vendorCreditNumber: `FX-VC-${faker.string.alphanumeric(8)}`,
          exchangeRate: rate,
          open: true,
          entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
        }),
    ).body.id as number;

  const refundVendorCredit = async (
    vendorCreditId: number,
    body: Record<string, any>,
  ) => {
    ok(
      await api()
        .post(`/vendor-credits/${vendorCreditId}/refund`)
        .send({
          depositAccountId: accounts.bank,
          date: '2026-06-01',
          referenceNo: `FX-R-${faker.string.alphanumeric(6)}`,
          description: 'FX refund',
          ...body,
        }),
    );
    return (await db('refund_vendor_credit_transactions')
      .where({ vendorCreditId })
      .orderBy('id', 'desc')
      .first()) as any;
  };

  beforeAll(async () => {
    company = await createCompany(app, 'r3fx');
    db = openDb(company.organizationId);
    // So a run can be looked at afterwards (and repaired by hand).
    console.log(`fx-refund-conversion company: ${company.organizationId}`);

    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      bank: await byType('bank'),
      income: await byType('income'),
      cogs: await byType('cost-of-goods-sold'),
      baseAR: (
        await db('accounts').where({ slug: 'accounts-receivable' }).first('id')
      ).id,
      gainLoss: (
        await db('accounts').where({ slug: 'exchange-grain-loss' }).first('id')
      ).id,
    };
    await api()
      .post('/currencies')
      .send({ currencyCode: 'EUR', currencyName: 'Euro', currencySign: '€' });

    itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `FX service ${tag}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts.income,
          costAccountId: accounts.cogs,
          sellPrice: 100,
          costPrice: 100,
        }),
    ).body.id;
    const customer = (currencyCode: string) =>
      api()
        .post('/customers')
        .send({
          displayName: `FX customer ${currencyCode} ${tag}`,
          customerType: 'business',
          currencyCode,
        });
    eurCustomerId = ok(await customer('EUR')).body.id;
    usdCustomerId = ok(await customer('USD')).body.id;
    eurVendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `FX vendor EUR ${tag}`, currencyCode: 'EUR' }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  describe('posting', () => {
    it('a EUR credit note refund: bank at amount x the refund rate, A/R at the credit note rate', async () => {
      const creditNoteId = await createCreditNote(eurCustomerId, 100, 1.2);
      const refund = await refundCreditNote(creditNoteId, {
        amount: 65.18,
        exchangeRate: 1.23,
      });
      const eurAR = await accountOf('accounts-receivable', 'EUR');
      expect(eurAR).toBeTruthy();

      const accrual = await accrualRows('RefundCreditNote', refund.id);
      const net = netByAccount(accrual);
      // 65.18 x 1.23 = 80.17 from the bank; 65.18 x 1.20 = 78.22 off the
      // EUR A/R the credit note credited; 1.95 exchange loss.
      expect(net[accounts.bank]).toBe(-80.17);
      expect(net[eurAR]).toBe(78.22);
      expect(net[accounts.gainLoss]).toBe(1.95);
      expect(net[accounts.baseAR]).toBeUndefined();
      expect(sumOf(accrual, 'debit')).toBe(sumOf(accrual, 'credit'));
      const arRow = accrual.find(
        (row) => row.accountId === eurAR && Number(row.foreignDebit) > 0,
      );
      expect(Number(arRow.foreignDebit)).toBe(65.18);

      // The credit note's EUR A/R is relieved by the refund at its rate.
      const creditNoteNet = netByAccount(
        await accrualRows('CreditNote', creditNoteId),
      );
      expect(creditNoteNet[eurAR]).toBe(-120);

      const cash = await cashRows('RefundCreditNote', refund.id);
      const cashNet = netByAccount(cash);
      expect(cashNet[accounts.bank]).toBe(-80.17);
      expect(cashNet[accounts.income]).toBe(80.17);
      expect(sumOf(cash, 'debit')).toBe(sumOf(cash, 'credit'));
    });

    it('a EUR vendor credit refund: bank at amount x the refund rate, A/P at the vendor credit rate', async () => {
      const vendorCreditId = await createVendorCredit(eurVendorId, 100, 1.2);
      const refund = await refundVendorCredit(vendorCreditId, {
        amount: 65.18,
        exchangeRate: 1.23,
      });
      const eurAP = await accountOf('accounts-payable', 'EUR');
      expect(eurAP).toBeTruthy();

      const accrual = await accrualRows('RefundVendorCredit', refund.id);
      const net = netByAccount(accrual);
      expect(net[accounts.bank]).toBe(80.17);
      expect(net[eurAP]).toBe(-78.22);
      expect(net[accounts.gainLoss]).toBe(-1.95);
      expect(sumOf(accrual, 'debit')).toBe(sumOf(accrual, 'credit'));

      const cash = await cashRows('RefundVendorCredit', refund.id);
      const cashNet = netByAccount(cash);
      // Was converted at the vendor credit rate (78.22), off the accrual line.
      expect(cashNet[accounts.bank]).toBe(80.17);
      expect(cashNet[accounts.cogs]).toBe(-80.17);
      expect(sumOf(cash, 'debit')).toBe(sumOf(cash, 'credit'));
    });

    it('a foreign refund sent without a rate takes the credit note rate', async () => {
      const creditNoteId = await createCreditNote(eurCustomerId, 50, 1.2);
      const refund = await refundCreditNote(creditNoteId, { amount: 10 });
      expect(Number(refund.exchangeRate)).toBe(1.2);
      const net = netByAccount(
        await accrualRows('RefundCreditNote', refund.id),
      );
      expect(net[accounts.bank]).toBe(-12);

      const vendorCreditId = await createVendorCredit(eurVendorId, 50, 1.2);
      const vendorRefund = await refundVendorCredit(vendorCreditId, {
        amount: 10,
      });
      expect(Number(vendorRefund.exchangeRate)).toBe(1.2);
    });

    it('a base currency refund is posted as before', async () => {
      const creditNoteId = await createCreditNote(usdCustomerId, 50, 1);
      const refund = await refundCreditNote(creditNoteId, { amount: 20.01 });
      expect(Number(refund.exchangeRate)).toBe(1);

      const net = netByAccount(
        await accrualRows('RefundCreditNote', refund.id),
      );
      expect(net[accounts.bank]).toBe(-20.01);
      expect(net[accounts.baseAR]).toBe(20.01);
      const cashNet = netByAccount(
        await cashRows('RefundCreditNote', refund.id),
      );
      expect(cashNet[accounts.bank]).toBe(-20.01);
    });
  });

  // -------------------------------------------------------------------------
  // The repair of refunds posted the old way.
  // -------------------------------------------------------------------------
  describe('tenants:repair-refund-journals', () => {
    let creditRefundId: number;
    let lockedRefundId: number;
    let vendorRefundId: number;
    let usdRefundId: number;
    let rateOneRefundId: number;
    let eurAR: number;
    let eurAP: number;

    // Loaded lazily, so the posting tests run on a branch without it.
    const repairService = () =>
      require('../src/modules/AccountingBasis/RefundJournalsRepair.service')
        .RefundJournalsRepairService;

    const withService = <T>(work: (service: any) => Promise<T>) =>
      inTenant(company, async () =>
        work(await app.resolve(repairService(), undefined, { strict: false })),
      );

    /**
     * Writes the refund's rows back the way the old code posted them: the
     * amount unconverted, and (credit note) on the base A/R account.
     */
    const postTheOldWay = async (
      referenceType: string,
      refund: { id: number; amount: number },
      arapAccountId?: number,
    ) => {
      const rows = db('accounts_transactions').where({
        referenceType,
        referenceId: refund.id,
      });
      // The old code wrote no exchange gain/loss pair.
      await rows
        .clone()
        .where((b) =>
          b
            .where('accountId', accounts.gainLoss)
            .orWhere((c) =>
              c
                .whereIn('accountId', [eurAR, eurAP])
                .where('foreignDebit', 0)
                .where('foreignCredit', 0),
            ),
        )
        .delete();
      await rows
        .clone()
        .where('debit', '>', 0)
        .update({ debit: refund.amount });
      await rows
        .clone()
        .where('credit', '>', 0)
        .update({ credit: refund.amount });
      if (arapAccountId) {
        await rows
          .clone()
          .where('accountId', arapAccountId)
          .update({ accountId: accounts.baseAR });
      }
    };

    beforeAll(async () => {
      eurAR = await accountOf('accounts-receivable', 'EUR');
      eurAP = await accountOf('accounts-payable', 'EUR');

      const creditNoteId = await createCreditNote(eurCustomerId, 100, 1.2);
      creditRefundId = (
        await refundCreditNote(creditNoteId, {
          amount: 65.18,
          exchangeRate: 1.23,
        })
      ).id;
      await postTheOldWay(
        'RefundCreditNote',
        { id: creditRefundId, amount: 65.18 },
        eurAR,
      );

      // Dated in the period locked below.
      const lockedNoteId = await createCreditNote(
        eurCustomerId,
        100,
        1.2,
        '2026-04-01',
      );
      lockedRefundId = (
        await refundCreditNote(lockedNoteId, {
          amount: 40,
          exchangeRate: 1.25,
          date: '2026-05-10',
        })
      ).id;
      await postTheOldWay(
        'RefundCreditNote',
        { id: lockedRefundId, amount: 40 },
        eurAR,
      );

      const vendorCreditId = await createVendorCredit(eurVendorId, 100, 1.2);
      vendorRefundId = (
        await refundVendorCredit(vendorCreditId, {
          amount: 65.18,
          exchangeRate: 1.23,
        })
      ).id;
      await postTheOldWay('RefundVendorCredit', {
        id: vendorRefundId,
        amount: 65.18,
      });

      // A EUR refund at the rate 1, posted the old way (base A/R).
      const rateOneNoteId = await createCreditNote(eurCustomerId, 100, 1.2);
      rateOneRefundId = (
        await refundCreditNote(rateOneNoteId, { amount: 30, exchangeRate: 1 })
      ).id;
      await postTheOldWay(
        'RefundCreditNote',
        { id: rateOneRefundId, amount: 30 },
        eurAR,
      );

      const usdNoteId = await createCreditNote(usdCustomerId, 50, 1);
      usdRefundId = (await refundCreditNote(usdNoteId, { amount: 20 })).id;
    }, 120000);

    const keyOf = (item: any) => `${item.referenceType}#${item.referenceId}`;

    it('the dry run lists the old refunds and changes nothing', async () => {
      const before = await db('accounts_transactions')
        .select('id', 'accountId', 'debit', 'credit')
        .orderBy('id');
      const found: any[] = await withService((s) => s.scan());
      const keys = found.map(keyOf);

      expect(keys).toEqual(
        expect.arrayContaining([
          `RefundCreditNote#${creditRefundId}`,
          `RefundCreditNote#${lockedRefundId}`,
          `RefundVendorCredit#${vendorRefundId}`,
        ]),
      );
      // Posted right (by the fixed code): not listed.
      expect(keys).not.toContain(`RefundCreditNote#${usdRefundId}`);
      // A foreign refund at the rate 1 is listed apart, never rewritten.
      expect(keys).not.toContain(`RefundCreditNote#${rateOneRefundId}`);
      const atRateOne: any[] = await withService((s) =>
        s.foreignRefundsAtRateOne(),
      );
      expect(atRateOne.map(keyOf)).toContain(
        `RefundCreditNote#${rateOneRefundId}`,
      );
      const credit = found.find(
        (f) => keyOf(f) === `RefundCreditNote#${creditRefundId}`,
      );
      expect(credit.locked).toBe(false);
      expect(credit.differences).toEqual(
        expect.arrayContaining([
          {
            basis: 'accrual',
            accountId: accounts.bank,
            stored: -65.18,
            expected: -80.17,
          },
          {
            basis: 'accrual',
            accountId: eurAR,
            stored: 0,
            expected: 78.22,
          },
        ]),
      );
      const after = await db('accounts_transactions')
        .select('id', 'accountId', 'debit', 'credit')
        .orderBy('id');
      expect(after).toEqual(before);
    });

    it('a real run rewrites them, skips the locked period, and a second scan finds nothing else', async () => {
      ok(
        await api().put('/transactions-locking/lock').send({
          module: 'all',
          lockToDate: '2026-05-15',
          reason: 'fx refund repair test',
        }),
      );
      let result: any;
      try {
        result = await withService((s) => s.repair());
      } finally {
        ok(
          await api()
            .put('/transactions-locking/cancel-lock')
            .send({ module: 'all', reason: 'fx refund repair test' }),
        );
      }
      expect(result.failed).toEqual([]);
      expect(result.skipped.map(keyOf)).toEqual([
        `RefundCreditNote#${lockedRefundId}`,
      ]);
      expect(result.repaired.map(keyOf)).toEqual(
        expect.arrayContaining([
          `RefundCreditNote#${creditRefundId}`,
          `RefundVendorCredit#${vendorRefundId}`,
        ]),
      );

      const credit = netByAccount(
        await accrualRows('RefundCreditNote', creditRefundId),
      );
      expect(credit[accounts.bank]).toBe(-80.17);
      expect(credit[eurAR]).toBe(78.22);
      expect(credit[accounts.gainLoss]).toBe(1.95);
      expect(credit[accounts.baseAR]).toBeUndefined();
      const creditCash = netByAccount(
        await cashRows('RefundCreditNote', creditRefundId),
      );
      expect(creditCash[accounts.bank]).toBe(-80.17);

      const vendor = netByAccount(
        await accrualRows('RefundVendorCredit', vendorRefundId),
      );
      expect(vendor[accounts.bank]).toBe(80.17);
      expect(vendor[eurAP]).toBe(-78.22);
      expect(vendor[accounts.gainLoss]).toBe(-1.95);

      // The one at the rate 1 keeps its rows.
      const rateOne = netByAccount(
        await accrualRows('RefundCreditNote', rateOneRefundId),
      );
      expect(rateOne[accounts.baseAR]).toBe(30);

      // The locked one keeps its old rows.
      const locked = netByAccount(
        await accrualRows('RefundCreditNote', lockedRefundId),
      );
      expect(locked[accounts.bank]).toBe(-40);

      const again: any[] = await withService((s) => s.scan());
      expect(again.map(keyOf)).toEqual([`RefundCreditNote#${lockedRefundId}`]);
    });
  });
});
