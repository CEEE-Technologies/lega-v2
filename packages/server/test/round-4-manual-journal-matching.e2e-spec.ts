import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';

/**
 * F5: a bank line can be matched to a manual journal on that bank account.
 * The account used to be hard-coded as 1000, and the journal's amount as
 * matched was always 0 (its lines weren't loaded), so the match was refused.
 * The amount is what the journal moves on the bank account.
 */
jest.retryTimes(0);

const DATE = '2026-06-10';

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

const errorTypes = (res: any) =>
  (res.body?.errors ?? []).map((e: any) => e.type);

describe('F5: match a bank line to a manual journal (e2e)', () => {
  const tag = faker.string.alphanumeric(6).toLowerCase();
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let bankId: number;
  let otherBankId: number;
  let incomeId: number;
  let expenseId: number;

  const journal = async (
    entries: Array<{ accountId: number; debit?: number; credit?: number }>,
  ) =>
    ok(
      await api()
        .post('/manual-journals')
        .send({
          date: DATE,
          journalNumber: `F5-${faker.string.alphanumeric(8)}`,
          publish: true,
          entries: entries.map((entry, i) => ({
            index: i + 1,
            debit: 0,
            credit: 0,
            ...entry,
          })),
        }),
    ).body.id as number;

  const bankLine = async (accountId: number, amount: number) => {
    const [id] = await db('uncategorized_cashflow_transactions').insert({
      date: DATE,
      accountId,
      amount,
      currencyCode: 'USD',
      description: `F5 line ${faker.string.alphanumeric(6)}`,
      categorized: false,
    });
    await db('accounts')
      .where({ id: accountId })
      .increment('uncategorizedTransactions', 1);
    return id as number;
  };

  const journalMatches = async (lineId: number) => {
    const res = ok(
      await api()
        .get('/banking/matching/matched')
        .query({ uncategorizedTransactionIds: [lineId] }),
    );
    return [
      ...(res.body.perfectMatches ?? res.body.perfect_matches ?? []),
      ...(res.body.possibleMatches ?? res.body.possible_matches ?? []),
    ].filter((m) => (m.referenceType ?? m.reference_type) === 'ManualJournal');
  };

  const match = (lineId: number, journalId: number) =>
    api()
      .post('/banking/matching/match')
      .send({
        uncategorizedTransactions: [lineId],
        matchedTransactions: [
          { referenceType: 'ManualJournal', referenceId: journalId },
        ],
      });

  beforeAll(async () => {
    company = await createCompany(app, 'r4mj');
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
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    incomeId = await byType('income');
    expenseId = await byType('expense');
    const newBank = async (name: string) =>
      ok(
        await api()
          .post('/accounts')
          .send({
            name: `${name} ${tag}`,
            code: `F${faker.string.numeric(5)}`,
            accountType: 'bank',
            currencyCode: 'USD',
          }),
      ).body.id as number;
    bankId = await newBank('F5 Business Checking');
    otherBankId = await newBank('F5 Savings');
    expect(bankId).not.toBe(1000);
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('a +500 deposit lists the journal that debits the bank 500, and matches it', async () => {
    const journalId = await journal([
      { accountId: bankId, debit: 500 },
      { accountId: incomeId, credit: 500 },
    ]);
    const lineId = await bankLine(bankId, 500);

    const found = (await journalMatches(lineId)).filter(
      (m) => (m.referenceId ?? m.reference_id) === journalId,
    );
    expect(found).toHaveLength(1);
    expect(Number(found[0].amount)).toBe(500);
    expect(found[0].transactionNormal ?? found[0].transaction_normal).toBe(
      'debit',
    );

    ok(await match(lineId, journalId));
    const matched = await db('matched_bank_transactions').where({
      uncategorizedTransactionId: lineId,
    });
    expect(matched.map((m) => [m.referenceType, m.referenceId])).toEqual([
      ['ManualJournal', journalId],
    ]);
    // Once matched it is no longer offered.
    const another = await bankLine(bankId, 500);
    expect(
      (await journalMatches(another)).map(
        (m) => m.referenceId ?? m.reference_id,
      ),
    ).not.toContain(journalId);
  });

  it('a -300 withdrawal matches a journal that credits the bank 300', async () => {
    const journalId = await journal([
      { accountId: expenseId, debit: 300 },
      { accountId: bankId, credit: 300 },
    ]);
    const lineId = await bankLine(bankId, -300);
    const found = (await journalMatches(lineId)).filter(
      (m) => (m.referenceId ?? m.reference_id) === journalId,
    );
    expect(found).toHaveLength(1);
    expect(found[0].transactionNormal ?? found[0].transaction_normal).toBe(
      'credit',
    );
    ok(await match(lineId, journalId));
  });

  it('a journal on another bank account is neither listed nor matched', async () => {
    const journalId = await journal([
      { accountId: otherBankId, debit: 200 },
      { accountId: incomeId, credit: 200 },
    ]);
    const lineId = await bankLine(bankId, 200);
    expect(
      (await journalMatches(lineId)).map(
        (m) => m.referenceId ?? m.reference_id,
      ),
    ).not.toContain(journalId);

    const res = await match(lineId, journalId);
    expect(res.status).toBe(400);
    expect(
      await db('matched_bank_transactions').where({
        uncategorizedTransactionId: lineId,
      }),
    ).toEqual([]);
  });

  it('the amount filters use the amount on the bank account', async () => {
    // Moves 150 on the bank, 400 in total on its lines.
    const journalId = await journal([
      { accountId: bankId, debit: 150 },
      { accountId: expenseId, debit: 250 },
      { accountId: incomeId, credit: 400 },
    ]);
    const lineId = await bankLine(bankId, 150);
    const listed = async (minAmount: number, maxAmount: number) => {
      const res = ok(
        await api()
          .get('/banking/matching/matched')
          .query({
            uncategorizedTransactionIds: [lineId],
            minAmount,
            maxAmount,
          }),
      );
      return [
        ...(res.body.perfectMatches ?? res.body.perfect_matches ?? []),
        ...(res.body.possibleMatches ?? res.body.possible_matches ?? []),
      ]
        .filter(
          (m) => (m.referenceType ?? m.reference_type) === 'ManualJournal',
        )
        .map((m) => m.referenceId ?? m.reference_id);
    };
    expect(await listed(100, 200)).toContain(journalId);
    expect(await listed(300, 500)).not.toContain(journalId);
    ok(await match(lineId, journalId));
  });

  it('a draft journal is not offered', async () => {
    const res = ok(
      await api()
        .post('/manual-journals')
        .send({
          date: DATE,
          journalNumber: `F5-${faker.string.alphanumeric(8)}`,
          publish: false,
          entries: [
            { index: 1, accountId: bankId, debit: 75, credit: 0 },
            { index: 2, accountId: incomeId, debit: 0, credit: 75 },
          ],
        }),
    );
    const lineId = await bankLine(bankId, 75);
    expect(
      (await journalMatches(lineId)).map(
        (m) => m.referenceId ?? m.reference_id,
      ),
    ).not.toContain(res.body.id);
    expect(errorTypes(await match(lineId, res.body.id)).length).toBeGreaterThan(
      0,
    );
  });
});
