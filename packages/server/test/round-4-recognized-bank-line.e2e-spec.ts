import { faker } from '@faker-js/faker';
import { Knex } from 'knex';
import { app } from './init-app-test';
import { as, Company, createCompany, tenantKnex } from './_utils/security';

/**
 * F11: opening a bank line that no rule recognized answered 500 (the
 * transformer read the missing recognition). It is now 404; a recognized
 * line answers 200 with its rule, account and payee.
 */
jest.retryTimes(0);

const ok = (res: any, status = [200, 201]) => {
  if (!status.includes(res.status)) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res;
};

describe('F11: recognized bank line (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  let bankId: number;
  let incomeId: number;

  const bankLine = async (description: string) => {
    const [id] = await db('uncategorized_cashflow_transactions').insert({
      date: '2026-06-01',
      accountId: bankId,
      amount: 120,
      currencyCode: 'USD',
      description,
      categorized: false,
    });
    return id as number;
  };

  beforeAll(async () => {
    company = await createCompany(app, 'r4recog');
    db = tenantKnex(app, company);
    bankId = (await db('accounts').where('accountType', 'bank').first('id')).id;
    incomeId = (await db('accounts').where('accountType', 'income').first('id'))
      .id;
  }, 300000);

  afterAll(async () => {
    await db?.destroy();
  });

  it('a bank line no rule recognized: 404', async () => {
    const lineId = await bankLine(`F11 plain ${faker.string.alphanumeric(6)}`);
    const res = await api().get(`/banking/recognized/${lineId}`);
    expect(res.status).toBe(404);
  });

  it('an unknown id: 404', async () => {
    const res = await api().get('/banking/recognized/987654');
    expect(res.status).toBe(404);
  });

  it('a recognized bank line: 200 with the rule, the account and the payee', async () => {
    const ruleId = ok(
      await api()
        .post('/banking/rules')
        .send({
          name: `F11 rule ${faker.string.alphanumeric(6)}`,
          order: 1,
          applyIfAccountId: bankId,
          applyIfTransactionType: 'deposit',
          conditions: [
            { field: 'description', comparator: 'contains', value: 'F11' },
          ],
          assignCategory: 'Deposit',
          assignAccountId: incomeId,
          assignPayee: 'F11 Payee Ltd',
          assignMemo: 'F11 memo',
        }),
    ).body.id;
    const lineId = await bankLine(
      `F11 recognized ${faker.string.alphanumeric(6)}`,
    );
    // What the bank rules job writes when the rule matches.
    const [recognizedId] = await db('recognized_bank_transactions').insert({
      uncategorizedTransactionId: lineId,
      bankRuleId: ruleId,
      assignedCategory: 'Deposit',
      assignedAccountId: incomeId,
      assignedPayee: 'F11 Payee Ltd',
      assignedMemo: 'F11 memo',
    });
    await db('uncategorized_cashflow_transactions')
      .where({ id: lineId })
      .update({ recognizedTransactionId: recognizedId });

    const res = ok(await api().get(`/banking/recognized/${lineId}`));
    const body = res.body;
    const field = (camel: string, snake: string) => body[camel] ?? body[snake];
    expect(field('assignedAccountId', 'assigned_account_id')).toBe(incomeId);
    expect(field('bankRuleId', 'bank_rule_id')).toBe(ruleId);
    expect(field('assignedPayee', 'assigned_payee')).toBe('F11 Payee Ltd');
  });
});
