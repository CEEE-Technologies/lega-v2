import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app, AuthorizationHeader, orgainzationId } from '../init-app-test';
import { getTenantKnex } from './money-matrix';

/**
 * Bank fixtures for the banking e2e specs, so they don't depend on records
 * (bank line 1, rule 1, ...) another spec may or may not have made.
 */
const api = () => ({
  get: (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader),
  post: (url: string) =>
    request(app.getHttpServer())
      .post(url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader),
});

/** A new bank account in the base currency. */
export const createTestBankAccount = async (): Promise<number> => {
  const res = await api()
    .post('/accounts')
    .send({
      name: `E2E bank ${faker.string.alphanumeric(8)}`,
      code: `B${faker.string.numeric(5)}`,
      accountType: 'bank',
    });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `POST /accounts: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.id;
};

/** Inserts a bank-feed line on the account, as the bank feed would. */
export const insertBankLine = async (
  accountId: number,
  amount: number,
  date = '2026-04-10',
): Promise<number> => {
  const db = getTenantKnex();
  const account = await db('accounts').where({ id: accountId }).first();
  const [id] = await db('uncategorized_cashflow_transactions').insert({
    date,
    accountId,
    amount,
    currencyCode: account.currencyCode,
    description: `E2E line ${faker.string.alphanumeric(8)}`,
    categorized: false,
  });
  await db('accounts')
    .where({ id: accountId })
    .increment('uncategorizedTransactions', 1);
  return id as number;
};

/** The id of the first account of the given type. */
export const accountIdOfType = async (accountType: string): Promise<number> =>
  (await getTenantKnex()('accounts').where({ accountType }).first('id')).id;
