import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * F19: a transaction on a foreign-currency bank account (categorizing a
 * bank line, money in/out, a transaction made from the matching panel)
 * needs its rate. The amount is in the account's currency and the books
 * get amount × rate, so a missing rate used to post at 1. A base-currency
 * account always posts at 1.
 */
jest.retryTimes(0);

const DATE = '2026-06-12';

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

const errorTypes = (res: any) =>
  (res.body?.errors ?? []).map((e: any) => e.type);

describe('F19: rates on foreign-currency bank accounts (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let eurBankId: number;
  let usdBankId: number;
  let equityId: number;

  const bankLine = async (
    accountId: number,
    amount: number,
    currency: string,
  ) => {
    const [id] = await db('uncategorized_cashflow_transactions').insert({
      date: DATE,
      accountId,
      amount,
      currencyCode: currency,
      description: `F19 line ${faker.string.alphanumeric(6)}`,
      categorized: false,
    });
    await db('accounts')
      .where({ id: accountId })
      .increment('uncategorizedTransactions', 1);
    return id as number;
  };

  /** Debit - credit the transaction posted on the account (accrual). */
  const posted = async (accountId: number, referenceId: number) => {
    const rows = await db('accounts_transactions')
      .where({ accountId, referenceType: 'CashflowTransaction', referenceId })
      .where((q) => q.where('basis', 'accrual').orWhereNull('basis'));
    return rows.reduce((sum, r) => sum + Number(r.debit) - Number(r.credit), 0);
  };

  const moneyIn = (cashflowAccountId: number, extra: Record<string, any>) =>
    api()
      .post('/banking/transactions')
      .send({
        date: DATE,
        transactionType: 'owner_contribution',
        amount: 100,
        cashflowAccountId,
        creditAccountId: equityId,
        description: `F19 money in ${faker.string.alphanumeric(6)}`,
        publish: true,
        ...extra,
      });

  beforeAll(async () => {
    company = await createCompany(app, 'r4fx');
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
      pool: { min: 0, max: 2 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    await api()
      .post('/currencies')
      .send({ currencyCode: 'EUR', currencyName: 'Euro', currencySign: '€' });
    equityId = (await db('accounts').where('accountType', 'equity').first('id'))
      .id;
    const newBank = async (name: string, currencyCode: string) =>
      ok(
        await api()
          .post('/accounts')
          .send({
            name: `${name} ${tag}`,
            code: `X${faker.string.numeric(5)}`,
            accountType: 'bank',
            currencyCode,
          }),
      ).body.id as number;
    eurBankId = await newBank('F19 EUR Bank', 'EUR');
    usdBankId = await newBank('F19 USD Bank', 'USD');
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('categorizing a EUR bank line needs the rate, and posts amount × rate', async () => {
    const lineId = await bankLine(eurBankId, 100, 'EUR');
    const categorize = (extra: Record<string, any>) =>
      api()
        .post('/banking/categorize')
        .send({
          uncategorizedTransactionIds: [lineId],
          date: DATE,
          transactionType: 'OwnerContribution',
          creditAccountId: equityId,
          ...extra,
        });

    const refused = await categorize({});
    expect(refused.status).toBe(400);
    expect(errorTypes(refused)).toContain('EXCHANGE_RATE_REQUIRED');
    const line = await db('uncategorized_cashflow_transactions')
      .where({ id: lineId })
      .first();
    expect(Number(line.categorized)).toBe(0);

    ok(await categorize({ exchangeRate: 1.1 }));
    const categorized = await db('uncategorized_cashflow_transactions')
      .where({ id: lineId })
      .first();
    const deposit = await db('cashflow_transactions')
      .where({ id: categorized.categorizeRefId })
      .first();
    expect(Number(deposit.exchangeRate)).toBe(1.1);
    expect(await posted(eurBankId, deposit.id)).toBeCloseTo(110, 2);
  });

  it('money in on a EUR account needs the rate', async () => {
    const refused = await moneyIn(eurBankId, {});
    expect(refused.status).toBe(400);
    expect(errorTypes(refused)).toContain('EXCHANGE_RATE_REQUIRED');

    const res = ok(await moneyIn(eurBankId, { exchangeRate: 1.2 }));
    const id = res.body.id ?? res.body.data?.id;
    expect(await posted(eurBankId, id)).toBeCloseTo(120, 2);
  });

  it('a base-currency account always posts at 1', async () => {
    const res = ok(await moneyIn(usdBankId, { exchangeRate: 3.67 }));
    const id = res.body.id ?? res.body.data?.id;
    const [transaction] = await db('cashflow_transactions').where({ id });
    expect(Number(transaction.exchangeRate)).toBe(1);
    expect(await posted(usdBankId, id)).toBeCloseTo(100, 2);

    // And without a rate.
    ok(await moneyIn(usdBankId, {}));
  });
});
