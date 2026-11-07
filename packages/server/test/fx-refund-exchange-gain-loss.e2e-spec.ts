import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * A credit note (vendor credit) in EUR at 1.20 credits A/R (debits A/P) at
 * USD 120 for EUR 100. Refunded at 1.23, the bank pays USD 123: the refund
 * used to put the whole 123 on A/R, so USD 3 stayed on the customer's A/R
 * for good. Like a payment relieves A/R at the invoice rate, the refund now
 * relieves A/R (A/P) at the credit note's (vendor credit's) rate and posts
 * the difference to exchange gain/loss.
 *
 * The cash basis has no A/R: it reverses the income (expense) at the refund
 * rate, as a payment recognizes it at the payment rate, so there is no
 * difference to post there.
 *
 * Runs in a new company (base USD).
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

describe('Foreign currency refunds post the exchange gain/loss (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);

  let accounts: {
    bank: number;
    income: number;
    cogs: number;
    gainLoss: number;
  };
  let eurAR: number;
  let eurAP: number;
  let itemId: number;
  let eurCustomerId: number;
  let eurVendorId: number;

  const accrualRows = (referenceType: string, referenceId: number) =>
    db('accounts_transactions')
      .where({ referenceType, referenceId })
      .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'))
      .select(
        'id',
        'accountId',
        'contactId',
        'debit',
        'credit',
        'foreignDebit',
        'foreignCredit',
        'currencyCode',
      );

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

  const creditNoteBody = (
    customerId: number,
    amount: number,
    rate: number,
    number: string,
  ) => ({
    customerId,
    creditNoteDate: '2026-05-01',
    creditNoteNumber: number,
    exchangeRate: rate,
    open: true,
    entries: [{ index: 1, itemId, quantity: 1, rate: amount }],
  });

  const createCreditNote = async (amount: number, rate: number) => {
    const number = `GL-CN-${faker.string.alphanumeric(8)}`;
    const id = ok(
      await api()
        .post('/credit-notes')
        .send(creditNoteBody(eurCustomerId, amount, rate, number)),
    ).body.id as number;
    return { id, number };
  };

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
          referenceNo: `GL-R-${faker.string.alphanumeric(6)}`,
          description: 'FX refund',
          ...body,
        }),
    );
    return (await db('refund_credit_note_transactions')
      .where({ creditNoteId })
      .orderBy('id', 'desc')
      .first()) as any;
  };

  const createVendorCredit = async (amount: number, rate: number) =>
    ok(
      await api()
        .post('/vendor-credits')
        .send({
          vendorId: eurVendorId,
          vendorCreditDate: '2026-05-01',
          vendorCreditNumber: `GL-VC-${faker.string.alphanumeric(8)}`,
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
          referenceNo: `GL-R-${faker.string.alphanumeric(6)}`,
          description: 'FX refund',
          ...body,
        }),
    );
    return (await db('refund_vendor_credit_transactions')
      .where({ vendorCreditId })
      .orderBy('id', 'desc')
      .first()) as any;
  };

  /** What the document and its refunds leave on the contact's A/R (A/P). */
  const leftOnAccount = async (
    accountId: number,
    contactId: number,
    references: Array<[string, number]>,
  ) => {
    const rows = await db('accounts_transactions')
      .where({ accountId, contactId })
      .where((b) => b.whereNull('basis').orWhere('basis', 'accrual'))
      .where((b) => {
        references.forEach(([referenceType, referenceId]) =>
          b.orWhere({ referenceType, referenceId }),
        );
      })
      .select('debit', 'credit');
    return round(
      rows.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0),
    );
  };

  beforeAll(async () => {
    company = await createCompany(app, 'r3fxgl');
    db = openDb(company.organizationId);
    // So a run can be looked at afterwards.
    console.log(
      `fx-refund-exchange-gain-loss company: ${company.organizationId}`,
    );

    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      bank: await byType('bank'),
      income: await byType('income'),
      cogs: await byType('cost-of-goods-sold'),
      gainLoss: (
        await db('accounts').where({ slug: 'exchange-grain-loss' }).first('id')
      ).id,
    };
    // A new company may already have EUR (CURRENCY_CODE_EXISTS is fine).
    await api()
      .post('/currencies')
      .send({ currencyCode: 'EUR', currencyName: 'Euro', currencySign: '€' });
    itemId = ok(
      await api()
        .post('/items')
        .send({
          name: `FX GL service ${tag}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts.income,
          costAccountId: accounts.cogs,
          sellPrice: 100,
          costPrice: 100,
        }),
    ).body.id;
    eurCustomerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `FX GL customer EUR ${tag}`,
          customerType: 'business',
          currencyCode: 'EUR',
        }),
    ).body.id;
    eurVendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `FX GL vendor EUR ${tag}`, currencyCode: 'EUR' }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  describe('credit note refunds', () => {
    it('credit at 1.20 refunded at 1.23: A/R back to zero, USD 3 exchange loss', async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      const refund = await refundCreditNote(creditNoteId, {
        amount: 100,
        exchangeRate: 1.23,
      });
      eurAR = await accountOf('accounts-receivable', 'EUR');

      const accrual = await accrualRows('RefundCreditNote', refund.id);
      const net = netByAccount(accrual);
      expect(net[accounts.bank]).toBe(-123);
      expect(net[eurAR]).toBe(120);
      expect(net[accounts.gainLoss]).toBe(3);
      expect(sumOf(accrual, 'debit')).toBe(sumOf(accrual, 'credit'));

      // Nothing is left on the customer's A/R by the credit note and its refund.
      expect(
        await leftOnAccount(eurAR, eurCustomerId, [
          ['CreditNote', creditNoteId],
          ['RefundCreditNote', refund.id],
        ]),
      ).toBe(0);
      // The EUR amounts still add up to the EUR refund.
      expect(
        round(
          accrual
            .filter((r) => r.accountId === eurAR)
            .reduce((s, r) => s + Number(r.foreignDebit || 0), 0),
        ),
      ).toBe(100);

      // Cash basis: no A/R; the income goes back at the refund rate.
      const cash = await cashRows('RefundCreditNote', refund.id);
      const cashNet = netByAccount(cash);
      expect(cashNet[accounts.bank]).toBe(-123);
      expect(cashNet[accounts.income]).toBe(123);
      expect(cashNet[eurAR]).toBeUndefined();
      expect(cashNet[accounts.gainLoss]).toBeUndefined();
      expect(sumOf(cash, 'debit')).toBe(sumOf(cash, 'credit'));
    });

    it('refunded at a lower rate posts a gain', async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      const refund = await refundCreditNote(creditNoteId, {
        amount: 100,
        exchangeRate: 1.15,
      });
      const net = netByAccount(
        await accrualRows('RefundCreditNote', refund.id),
      );
      expect(net[accounts.bank]).toBe(-115);
      expect(net[eurAR]).toBe(120);
      expect(net[accounts.gainLoss]).toBe(-5);
    });

    it('refunded in parts at different rates: A/R ends at the credit note', async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      const first = await refundCreditNote(creditNoteId, {
        amount: 65.18,
        exchangeRate: 1.23,
        date: '2026-06-01',
      });
      const second = await refundCreditNote(creditNoteId, {
        amount: 34.82,
        exchangeRate: 1.25,
        date: '2026-06-02',
      });
      const firstNet = netByAccount(
        await accrualRows('RefundCreditNote', first.id),
      );
      const secondNet = netByAccount(
        await accrualRows('RefundCreditNote', second.id),
      );
      // 65.18 x 1.20 = 78.216 -> 78.22; 120 - 78.22 = 41.78.
      expect(firstNet[eurAR]).toBe(78.22);
      expect(firstNet[accounts.gainLoss]).toBe(1.95); // 80.17 - 78.22
      expect(secondNet[eurAR]).toBe(41.78);
      expect(secondNet[accounts.gainLoss]).toBe(1.75); // 43.53 - 41.78
      expect(
        await leftOnAccount(eurAR, eurCustomerId, [
          ['CreditNote', creditNoteId],
          ['RefundCreditNote', first.id],
          ['RefundCreditNote', second.id],
        ]),
      ).toBe(0);
    });

    it('deleting an earlier refund moves the later refund to its own relief', async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      const first = await refundCreditNote(creditNoteId, {
        amount: 33.33,
        exchangeRate: 1.3,
        date: '2026-06-01',
      });
      const second = await refundCreditNote(creditNoteId, {
        amount: 33.33,
        exchangeRate: 1.3,
        date: '2026-06-02',
      });
      // Running total: 66.66 x 1.20 = 79.99, less 40.00 before it.
      expect(
        netByAccount(await accrualRows('RefundCreditNote', second.id))[eurAR],
      ).toBe(39.99);

      ok(await api().delete(`/credit-notes/refunds/${first.id}`));

      const secondNet = netByAccount(
        await accrualRows('RefundCreditNote', second.id),
      );
      // Now the first refund of the credit note: 33.33 x 1.20 = 40.00.
      expect(secondNet[eurAR]).toBe(40);
      expect(secondNet[accounts.bank]).toBe(-43.33);
      expect(secondNet[accounts.gainLoss]).toBe(3.33);
    });

    it('editing the credit note rate moves its refunds to the new rate', async () => {
      const { id: creditNoteId, number } = await createCreditNote(100, 1.2);
      const refund = await refundCreditNote(creditNoteId, {
        amount: 50,
        exchangeRate: 1.23,
      });
      ok(
        await api()
          .put(`/credit-notes/${creditNoteId}`)
          .send(creditNoteBody(eurCustomerId, 100, 1.21, number)),
      );
      const net = netByAccount(
        await accrualRows('RefundCreditNote', refund.id),
      );
      // 50 x 1.21 = 60.50 off A/R; the bank still pays 50 x 1.23 = 61.50.
      expect(net[eurAR]).toBe(60.5);
      expect(net[accounts.bank]).toBe(-61.5);
      expect(net[accounts.gainLoss]).toBe(1);
    });

    it('editing the credit note rate to 1 (refund at 1) drops the gain/loss', async () => {
      // EUR 100 at 1.2, refunded at 1: a USD 10 gain on the refund of 50.
      const { id: creditNoteId, number } = await createCreditNote(100, 1.2);
      const refund = await refundCreditNote(creditNoteId, {
        amount: 50,
        exchangeRate: 1,
      });
      expect(
        netByAccount(await accrualRows('RefundCreditNote', refund.id))[
          accounts.gainLoss
        ],
      ).toBe(-10);

      ok(
        await api()
          .put(`/credit-notes/${creditNoteId}`)
          .send(creditNoteBody(eurCustomerId, 100, 1, number)),
      );
      const net = netByAccount(
        await accrualRows('RefundCreditNote', refund.id),
      );
      expect(net[eurAR]).toBe(50);
      expect(net[accounts.gainLoss] ?? 0).toBe(0);
    });

    it('at the credit note rate there is no gain/loss line', async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      const refund = await refundCreditNote(creditNoteId, { amount: 40 });
      const accrual = await accrualRows('RefundCreditNote', refund.id);
      expect(accrual).toHaveLength(2);
      expect(netByAccount(accrual)[eurAR]).toBe(48);
    });
  });

  describe('vendor credit refunds', () => {
    it('credit at 1.20 refunded at 1.23: A/P back to zero, USD 3 exchange gain', async () => {
      const vendorCreditId = await createVendorCredit(100, 1.2);
      const refund = await refundVendorCredit(vendorCreditId, {
        amount: 100,
        exchangeRate: 1.23,
      });
      eurAP = await accountOf('accounts-payable', 'EUR');

      const accrual = await accrualRows('RefundVendorCredit', refund.id);
      const net = netByAccount(accrual);
      expect(net[accounts.bank]).toBe(123);
      expect(net[eurAP]).toBe(-120);
      expect(net[accounts.gainLoss]).toBe(-3);
      expect(sumOf(accrual, 'debit')).toBe(sumOf(accrual, 'credit'));

      expect(
        await leftOnAccount(eurAP, eurVendorId, [
          ['VendorCredit', vendorCreditId],
          ['RefundVendorCredit', refund.id],
        ]),
      ).toBe(0);

      const cash = await cashRows('RefundVendorCredit', refund.id);
      const cashNet = netByAccount(cash);
      expect(cashNet[accounts.bank]).toBe(123);
      expect(cashNet[accounts.cogs]).toBe(-123);
      expect(cashNet[eurAP]).toBeUndefined();
      expect(cashNet[accounts.gainLoss]).toBeUndefined();
      expect(sumOf(cash, 'debit')).toBe(sumOf(cash, 'credit'));
    });

    it('refunded in parts at different rates: A/P ends at the vendor credit', async () => {
      const vendorCreditId = await createVendorCredit(100, 1.2);
      const first = await refundVendorCredit(vendorCreditId, {
        amount: 65.18,
        exchangeRate: 1.23,
        date: '2026-06-01',
      });
      const second = await refundVendorCredit(vendorCreditId, {
        amount: 34.82,
        exchangeRate: 1.15,
        date: '2026-06-02',
      });
      const secondNet = netByAccount(
        await accrualRows('RefundVendorCredit', second.id),
      );
      // 34.82 x 1.15 = 40.04 in the bank, 41.78 off A/P: a 1.74 loss.
      expect(secondNet[eurAP]).toBe(-41.78);
      expect(secondNet[accounts.gainLoss]).toBe(1.74);
      expect(
        await leftOnAccount(eurAP, eurVendorId, [
          ['VendorCredit', vendorCreditId],
          ['RefundVendorCredit', first.id],
          ['RefundVendorCredit', second.id],
        ]),
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Refunds posted before this fix (A/R or A/P at the refund rate, no gain/
  // loss line) are found and rewritten by tenants:repair-refund-journals.
  // -------------------------------------------------------------------------
  describe('tenants:repair-refund-journals', () => {
    let creditRefundId: number;
    let vendorRefundId: number;

    const repairService = () =>
      require('../src/modules/AccountingBasis/RefundJournalsRepair.service')
        .RefundJournalsRepairService;

    const withService = <T>(work: (service: any) => Promise<T>) =>
      inTenant(company, async () =>
        work(await app.resolve(repairService(), undefined, { strict: false })),
      );

    const keyOf = (item: any) => `${item.referenceType}#${item.referenceId}`;

    /**
     * Writes the refund's accrual rows back the way the previous code posted
     * them: no gain/loss pair, the A/R (A/P) line at the refund rate.
     */
    const postWithoutGainLoss = async (
      referenceType: string,
      referenceId: number,
    ) => {
      await db('accounts_transactions')
        .where({ referenceType, referenceId })
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
    };

    beforeAll(async () => {
      const { id: creditNoteId } = await createCreditNote(100, 1.2);
      creditRefundId = (
        await refundCreditNote(creditNoteId, {
          amount: 65.18,
          exchangeRate: 1.23,
        })
      ).id;
      await postWithoutGainLoss('RefundCreditNote', creditRefundId);

      const vendorCreditId = await createVendorCredit(100, 1.2);
      vendorRefundId = (
        await refundVendorCredit(vendorCreditId, {
          amount: 65.18,
          exchangeRate: 1.23,
        })
      ).id;
      await postWithoutGainLoss('RefundVendorCredit', vendorRefundId);
    }, 120000);

    it('lists them with the A/R (A/P) and gain/loss differences', async () => {
      // As posted before the fix.
      expect(
        netByAccount(await accrualRows('RefundCreditNote', creditRefundId))[
          eurAR
        ],
      ).toBe(80.17);

      const found: any[] = await withService((s) => s.scan());
      const keys = found.map(keyOf);
      expect(keys).toEqual(
        expect.arrayContaining([
          `RefundCreditNote#${creditRefundId}`,
          `RefundVendorCredit#${vendorRefundId}`,
        ]),
      );
      // Everything else in the company was posted by the fixed code.
      expect(keys).toHaveLength(2);

      const credit = found.find(
        (f) => keyOf(f) === `RefundCreditNote#${creditRefundId}`,
      );
      expect(credit.differences).toEqual(
        [
          {
            basis: 'accrual',
            accountId: eurAR,
            stored: 80.17,
            expected: 78.22,
          },
          {
            basis: 'accrual',
            accountId: accounts.gainLoss,
            stored: 0,
            expected: 1.95,
          },
        ].sort((a, b) => a.accountId - b.accountId),
      );
      const vendor = found.find(
        (f) => keyOf(f) === `RefundVendorCredit#${vendorRefundId}`,
      );
      expect(vendor.differences).toEqual(
        [
          {
            basis: 'accrual',
            accountId: eurAP,
            stored: -80.17,
            expected: -78.22,
          },
          {
            basis: 'accrual',
            accountId: accounts.gainLoss,
            stored: 0,
            expected: -1.95,
          },
        ].sort((a, b) => a.accountId - b.accountId),
      );
    });

    it('rewrites them with the gain/loss, and a second scan finds nothing', async () => {
      const result: any = await withService((s) => s.repair());
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.repaired.map(keyOf).sort()).toEqual(
        [
          `RefundCreditNote#${creditRefundId}`,
          `RefundVendorCredit#${vendorRefundId}`,
        ].sort(),
      );

      const credit = netByAccount(
        await accrualRows('RefundCreditNote', creditRefundId),
      );
      expect(credit[accounts.bank]).toBe(-80.17);
      expect(credit[eurAR]).toBe(78.22);
      expect(credit[accounts.gainLoss]).toBe(1.95);

      const vendor = netByAccount(
        await accrualRows('RefundVendorCredit', vendorRefundId),
      );
      expect(vendor[accounts.bank]).toBe(80.17);
      expect(vendor[eurAP]).toBe(-78.22);
      expect(vendor[accounts.gainLoss]).toBe(-1.95);

      expect(await withService((s) => s.scan())).toEqual([]);
    });
  });
});
