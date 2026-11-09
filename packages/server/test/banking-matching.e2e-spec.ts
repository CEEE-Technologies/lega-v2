import request = require('supertest');
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';
import {
  accountIdOfType,
  createTestBankAccount,
  insertBankLine,
} from './_utils/banking';
import { getTenantKnex } from './_utils/money-matrix';

describe('Banking Matching (e2e)', () => {
  let bankId: number;
  let expenseAccountId: number;

  const call = (method: 'get' | 'post' | 'patch', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);

  const createExpense = async (amount: number) => {
    const res = await call('post', '/expenses').send({
      paymentDate: '2026-04-10',
      paymentAccountId: bankId,
      referenceNo: `E2E-${Date.now()}`,
      publish: true,
      categories: [{ index: 1, expenseAccountId, amount }],
    });
    expect(res.status).toBe(201);
    return res.body.id as number;
  };

  beforeAll(async () => {
    bankId = await createTestBankAccount();
    expenseAccountId = await accountIdOfType('expense');
  });

  it('/banking/matching/matched (GET) lists the expense paid from the bank', async () => {
    const expenseId = await createExpense(64.5);
    const lineId = await insertBankLine(bankId, -64.5);
    const res = await call('get', '/banking/matching/matched').query({
      uncategorizedTransactionIds: [lineId],
    });
    expect(res.status).toBe(200);
    const all = [
      ...(res.body.perfectMatches ?? res.body.perfect_matches ?? []),
      ...(res.body.possibleMatches ?? res.body.possible_matches ?? []),
    ];
    expect(
      all.some(
        (m) =>
          (m.referenceType ?? m.reference_type) === 'Expense' &&
          (m.referenceId ?? m.reference_id) === expenseId,
      ),
    ).toBe(true);
  });

  it('/banking/matching/match (POST) and unmatch (PATCH)', async () => {
    const expenseId = await createExpense(41);
    const lineId = await insertBankLine(bankId, -41);
    const matched = await call('post', '/banking/matching/match').send({
      uncategorizedTransactions: [lineId],
      matchedTransactions: [
        { referenceType: 'Expense', referenceId: expenseId },
      ],
    });
    expect(matched.status).toBe(201);
    const matches = () =>
      getTenantKnex()('matched_bank_transactions').where({
        uncategorizedTransactionId: lineId,
      });
    expect(await matches()).toHaveLength(1);

    expect(
      (await call('patch', `/banking/matching/unmatch/${lineId}`)).status,
    ).toBe(200);
    expect(await matches()).toEqual([]);
  });
});
