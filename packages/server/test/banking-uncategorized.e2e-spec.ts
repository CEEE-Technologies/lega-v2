import request = require('supertest');
import { app, AuthorizationHeader, orgainzationId } from './init-app-test';
import { createTestBankAccount, insertBankLine } from './_utils/banking';

describe('Banking Uncategorized Transactions (e2e)', () => {
  let bankId: number;
  let lineId: number;

  const get = (url: string) =>
    request(app.getHttpServer())
      .get(url)
      .set('organization-id', orgainzationId)
      .set('Authorization', AuthorizationHeader);

  beforeAll(async () => {
    bankId = await createTestBankAccount();
    lineId = await insertBankLine(bankId, 75.25);
  });

  it('/banking/uncategorized/:uncategorizedTransactionId (GET)', async () => {
    const res = await get(`/banking/uncategorized/${lineId}`);
    expect(res.status).toBe(200);
    const line = res.body.data ?? res.body;
    expect(Number(line.amount)).toBe(75.25);
  });

  it('/banking/uncategorized/accounts/:accountId (GET)', async () => {
    const res = await get(`/banking/uncategorized/accounts/${bankId}`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(String(lineId));
  });

  it('/banking/uncategorized/autofill (GET)', async () => {
    const res = await get('/banking/uncategorized/autofill').query({
      uncategorizedTransactionIds: [lineId],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBe(75.25);
  });
});
